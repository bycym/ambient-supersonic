import { STEM_PAIR, encodeStem, wavHeader } from "./stem-format.js";

let dir, handles, selected, format, sampleRate, frames = 0, failed = null;
const post = (type, extra = {}) => self.postMessage({ type, ...extra });

self.onmessage = async ({ data }) => {
	try {
		if (data.type === "start") {
			selected = data.selected; format = data.format; sampleRate = data.sampleRate;
			const root = await navigator.storage.getDirectory();
			const folder = "az_export_" + crypto.randomUUID();
			dir = await root.getDirectoryHandle(folder, { create: true });
			handles = [];
			for (const name of selected) {
				const file = await dir.getFileHandle(name + ".wav", { create: true });
				const handle = await file.createSyncAccessHandle();
				handle.write(wavHeader(0, sampleRate, format), { at: 0 });
				handles.push({ name, handle });
			}
			post("ready", { folder });
		} else if (data.type === "chunk" && !failed) {
			const samples = new Float32Array(data.samples);
			const bytes = format === "float32" ? 4 : format === "pcm24" ? 3 : 2;
			for (const { name, handle } of handles) {
				const encoded = encodeStem(samples, data.frames, STEM_PAIR[name], format);
				const count = handle.write(encoded, { at: 44 + frames * 2 * bytes });
				if (count !== encoded.byteLength) throw new Error("Short write to " + name + ".wav");
			}
			frames += data.frames;
		} else if (data.type === "stop") {
			const bytes = format === "float32" ? 4 : format === "pcm24" ? 3 : 2;
			let closeError = null;
			for (const { handle } of handles || []) {
				try {
					handle.truncate(44 + frames * 2 * bytes);
					handle.write(wavHeader(frames, sampleRate, format), { at: 0 });
					handle.flush();
				} catch (error) { closeError ||= error; }
				finally { try { handle.close(); } catch (error) { closeError ||= error; } }
			}
			if (closeError) post("error", { message: "Could not finalize a partial take: " + closeError.message });
			else post("done", { frames, partial: failed?.message || null });
		}
	} catch (error) {
		if (data.type === "chunk") { failed = error; post("failure", { message: error.message }); }
		else post("error", { message: error.message });
	}
};
