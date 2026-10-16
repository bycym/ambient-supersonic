import { streamZip } from "./stem-zip.js";

export async function startStemExport({ context, source, saveHandle, selected, format, onStatus, onFinished }) {
	if (!context.audioWorklet || typeof AudioWorkletNode === "undefined") throw new Error("AudioWorklet is unavailable in this browser");
	if (!navigator.storage?.getDirectory) throw new Error("Origin private storage is unavailable in this browser");
	const sampleBytes = format === "float32" ? 4 : format === "pcm24" ? 3 : 2;
	const isZip = selected.length !== 1 || selected[0] !== "master";
	const archiveLimit = isZip ? Math.floor((0xffffffff - 65536) / (selected.length * 2 * sampleBytes)) : Infinity;
	const frameLimit = Math.min(Math.floor(context.sampleRate * 600), archiveLimit);
	if (frameLimit < context.sampleRate * 600) onStatus(`At ${context.sampleRate} Hz, ZIP size limits this take to ${(frameLimit / context.sampleRate / 60).toFixed(1)} minutes.`);
	const estimated = selected.length * frameLimit * 2 * sampleBytes;
	const storage = await navigator.storage.estimate();
	if (storage.quota && storage.quota - (storage.usage || 0) < estimated) {
		onStatus("Storage may fill before ten minutes; available audio will be saved as a partial take.");
	}
	await context.audioWorklet.addModule(new URL("./stem-capture-worklet.js", import.meta.url));
	const worker = new Worker(new URL("./stem-export-worker.js", import.meta.url), { type: "module" });
	let capture, silence, folder, stopped = false, finishing = false, partialReason = null, stopPromise = null;
	let readyResolve, readyReject, doneResolve, doneReject;
	const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
	const done = new Promise((resolve, reject) => { doneResolve = resolve; doneReject = reject; });
	done.catch(() => {}); // Worker can fail before the recorder has a stop listener.
	let doneSettled = false;
	const fail = (error) => {
		if (!doneSettled) { doneSettled = true; doneReject(error); }
		readyReject(error);
	};
	worker.onerror = (event) => fail(new Error(event.message || "Export worker failed"));
	worker.onmessage = ({ data }) => {
		if (data.type === "ready") { folder = data.folder; readyResolve(); }
		else if (data.type === "failure") { partialReason = data.message; onStatus("Storage full; finishing partial take…"); stop(); }
		else if (data.type === "error") fail(new Error(data.message));
		else if (data.type === "done") {
			if (!doneSettled) { doneSettled = true; doneResolve(data); }
		}
	};
	worker.postMessage({ type: "start", selected, format, sampleRate: context.sampleRate });
	try {
		await ready;
		capture = new AudioWorkletNode(context, "az-stem-capture", {
			numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
			channelCount: 18, channelCountMode: "explicit", channelInterpretation: "discrete",
		});
		silence = context.createGain(); silence.gain.value = 0;
		capture.connect(silence).connect(context.destination);
		capture.port.onmessage = ({ data }) => {
			if (data.type === "chunk") worker.postMessage({ type: "chunk", frames: data.frames, samples: data.data }, [data.data]);
			else if (data.type === "stopped" && !finishing) { finishing = true; worker.postMessage({ type: "stop" }); stop().catch((error) => onStatus("Export failed: " + error.message)); }
		};
		source.connect(capture);
		capture.port.postMessage({ type: "start", limit: frameLimit });
	} catch (error) {
		worker.terminate(); capture?.disconnect(); silence?.disconnect(); throw error;
	}
	function stop() {
		if (!stopPromise) stopPromise = finalize();
		return stopPromise;
	}
	async function finalize() {
		if (!stopped) { stopped = true; capture.port.postMessage("stop"); }
		try {
			const result = await done;
			const root = await navigator.storage.getDirectory();
			const dir = await root.getDirectoryHandle(folder);
			const entries = [];
			for (const name of selected) {
				const file = await dir.getFileHandle(name + ".wav");
				entries.push({ name: name + ".wav", blob: await file.getFile() });
			}
			const reason = partialReason || result.partial;
			if (reason && selected.length > 1) entries.push({ name: "PARTIAL_TAKE.txt", blob: new Blob(["Recording stopped early: " + reason + "\nFrames saved: " + result.frames + "\n"]) });
			const writable = await saveHandle.createWritable();
			try {
				if (selected.length === 1 && selected[0] === "master") {
					for await (const bytes of entries[0].blob.stream()) await writable.write(bytes);
				} else await streamZip(writable, entries);
				await writable.close();
			} catch (error) { await writable.abort(); throw error; }
			await root.removeEntry(folder, { recursive: true });
			onFinished({ frames: result.frames, partial: reason });
			return result;
		} catch (error) {
			onStatus("Export failed: " + error.message);
			throw error;
		} finally {
			try { source.disconnect(capture); } catch { /* already detached */ }
			capture.disconnect(); silence.disconnect(); worker.terminate();
		}
	}
	return { stop, frameLimit };
}
