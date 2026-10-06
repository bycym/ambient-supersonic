// OSC-level engine wiring: buses, groups, buffers, voice management, FX slot
// instantiation, wavetable upload, sample loading. Everything here talks to
// SuperSonic via plain OSC exactly as spec §1-§2, §5-§6 describe — no HTML,
// no Launchpad, no sequencer scheduling (that's sequencer.js).

import { SuperSonic } from "../../vendor/supersonic/dist/supersonic.js";
import { N_TABLES, SPEC_BY_ID, activeEngineSpecs, SLOT_DEFS, slotDefaults } from "./data.js";
import { tablesForWave } from "./wavetables.js";

const BANK_BUFNUM = [0, N_TABLES, N_TABLES * 2]; // 0-63, 64-127, 128-191
const REC_BUFNUM = 192;
const USR_BUFNUM = 193;
const GRAIN_REC_BUFNUM = 194;
const GRAIN_USR_BUFNUM = 195;
const GRAIN_HEAD_BUS = 0;

export function createEngine(sonic) {
	// Private audio buses start right after in+out hardware channels
	// (numOutputBusChannels + numInputBusChannels = 2 + 2, per the loader's
	// scsynthOptions in supersonic-loader.js).
	const busBase = 4;
	const bus = {
		mix: busBase,
		slot: [busBase + 2, busBase + 4, busBase + 6],
		rev: busBase + 8,
	};

	const grp = {};
	const slotSynthId = [null, null, null];
	const revShimId = { id: null };
	const masterId = { id: null };

	// voices[layer] : Map<midiNote, nodeId>   held[layer]: [midiNote,...] oldest-first
	const voices = [new Map(), new Map(), new Map(), new Map()];
	const oneShotVoices = [new Map(), new Map(), new Map(), new Map()];
	const held = [[], [], [], []];
	let maxVoices = 6;

	let usrChans = 2;
	let usrLoaded = false;
	let lineInLoaded = false;
	let grainHeadTimer = null;
	let grainDuration = 8;
	const loadedEngineDefs = new Set();

	async function init() {
		await sonic.send("/notify", 1);

		grp.root = sonic.nextNodeId();
		await sonic.send("/g_new", grp.root, 1, 0);
		grp.layer = [];
		for (let i = 0; i < 4; i++) {
			const id = sonic.nextNodeId();
			await sonic.send("/g_new", id, 1, grp.root);
			grp.layer.push(id);
		}
		grp.slot = [];
		for (let i = 0; i < 3; i++) {
			const id = sonic.nextNodeId();
			await sonic.send("/g_new", id, 1, grp.root);
			grp.slot.push(id);
		}
		grp.revShim = sonic.nextNodeId();
		await sonic.send("/g_new", grp.revShim, 1, grp.root);
		grp.master = sonic.nextNodeId();
		await sonic.send("/g_new", grp.master, 1, grp.root);

		// wavetable banks: 3 layers x 64 mono buffers, 1024 frames each (tableSize*2)
		for (let layer = 0; layer < 3; layer++) {
			for (let i = 0; i < N_TABLES; i++) {
				await sonic.send("/b_alloc", BANK_BUFNUM[layer] + i, 1024, 1);
			}
		}
		const sr = sonic.audioContext ? sonic.audioContext.sampleRate : 48000;
		await sonic.send("/b_alloc", REC_BUFNUM, Math.round(sr * 8), 2);
		await sonic.send("/b_alloc", USR_BUFNUM, Math.round(sr * 8), 2);
		await sonic.send("/b_alloc", GRAIN_REC_BUFNUM, Math.round(sr * 8), 1);
		await sonic.send("/b_alloc", GRAIN_USR_BUFNUM, Math.round(sr * 8), 1);
		// /b_alloc runs asynchronously. Do not start uploading wavetable data
		// until scsynth confirms all banks exist; otherwise the initial /b_setn
		// messages can race allocation and get discarded.
		await sonic.sync();

		sonic.on("in", (msg) => {
			if (msg[0] === "/n_end") onVoiceEnded(msg[1]);
		});
		const startedAt = performance.now();
		grainHeadTimer = setInterval(() => {
			const duration = sonic.audioContext ? sonic.audioContext.currentTime : (performance.now() - startedAt) / 1000;
			sonic.send("/c_set", GRAIN_HEAD_BUS, (duration / grainDuration) % 1);
		}, 50);
	}

	function onVoiceEnded(nodeId) {
		for (let layer = 0; layer < 4; layer++) {
			for (const [note, id] of voices[layer]) {
					if (id === nodeId) {
						voices[layer].delete(note);
						oneShotVoices[layer].delete(note);
					const hi = held[layer].indexOf(note);
					if (hi >= 0) held[layer].splice(hi, 1);
				}
			}
		}
	}

	function defFor(layer, structure, noiseSrc) {
		if (layer <= 2) return structure === 6 ? "az_vogon" : "az_str" + structure;
		if (structure === 8) return "az_clouds";
		if (structure === 9) return "az_graintopia";
		if (structure === 10) return "az_keinseier";
		if (noiseSrc < 8) return "az_noise" + noiseSrc;
		const chans = noiseSrc === 9 ? usrChans : 2;
		return "az_noisebuf" + chans;
	}

	async function loadEngineFor(layer, structure) {
		const name = layer <= 2
			? (structure === 6 ? "az_vogon" : null)
			: structure === 8 ? "az_clouds" : structure === 9 ? "az_graintopia" : structure === 10 ? "az_keinseier" : null;
		if (!name || loadedEngineDefs.has(name)) return;
		const url = new URL(`../../synthdefs/ambient/${name}.scsyndef`, import.meta.url).href;
		await sonic.loadSynthDef(url);
		loadedEngineDefs.add(name);
	}

	// ---- Voice management (spec §1.8) ----------------------------------

	function setMaxVoices(n) { maxVoices = n; }

	function noteOn(layer, note, vel, lp, structure, noiseSrc, locks, muted) {
		if (muted) return;
		if (layer === 3 && structure < 8 && noiseSrc === 9 && !usrLoaded) return; // no sample loaded yet
		if (layer === 3 && structure < 8 && noiseSrc === 8 && !lineInLoaded) {
			// original always has a (silent) recBuf allocated; we do too, so this
			// still "plays" — just silence until something is recorded.
		}
		const hz = 440 * Math.pow(2, (note - 69) / 12);
		if (voices[layer].has(note)) noteOff(layer, note);
		while (held[layer].length >= maxVoices) {
			const oldest = held[layer].shift();
			const id = voices[layer].get(oldest);
			if (id != null && !oneShotVoices[layer].get(oldest)) sonic.send("/n_set", id, "gate", 0);
			voices[layer].delete(oldest);
			oneShotVoices[layer].delete(oldest);
		}
		const args = ["out", bus.mix, "revB", bus.rev, "hz", hz, "vel", vel, "gate", 1];
		const activeRows = activeEngineSpecs(layer, structure);
		for (const row of activeRows) {
			if (lp[row[1]] != null) args.push(row[1], lp[row[1]]);
		}
		if (structure <= 5 || structure === 7) {
			for (const k of ["ftype", "modShape", "l1dest", "l2dest"]) args.push(k, lp[k]);
		}
		if (locks) {
			for (const specId in locks) {
				const row = SPEC_BY_ID[specId];
				if (row && activeRows.some((active) => active[0] === specId)) args.push(row[1], locks[specId]);
			}
		}
		if (layer <= 2 && structure !== 6) {
			args.push("bank", BANK_BUFNUM[layer]);
		} else if (layer === 3 && structure < 8) {
			args.push("buf", noiseSrc === 9 ? USR_BUFNUM : REC_BUFNUM);
		} else if (layer === 3 && (structure === 8 || structure === 9)) {
			args.push("buf", stateGrainSource === 1 ? GRAIN_USR_BUFNUM : GRAIN_REC_BUFNUM);
			if (structure === 8) args.push("headBus", GRAIN_HEAD_BUS);
		}
		const id = sonic.nextNodeId();
		sonic.send("/s_new", defFor(layer, structure, noiseSrc), id, 1, grp.layer[layer], ...args);
		voices[layer].set(note, id);
		oneShotVoices[layer].set(note, structure === 10);
		held[layer].push(note);
		return id;
	}

	function noteOff(layer, note) {
		const id = voices[layer].get(note);
		if (id != null && !oneShotVoices[layer].get(note)) sonic.send("/n_set", id, "gate", 0);
		voices[layer].delete(note);
		oneShotVoices[layer].delete(note);
		const hi = held[layer].indexOf(note);
		if (hi >= 0) held[layer].splice(hi, 1);
	}

	function layerOff(layer) {
		for (const [note, id] of voices[layer]) {
			if (!oneShotVoices[layer].get(note)) sonic.send("/n_set", id, "gate", 0);
		}
		voices[layer].clear();
		oneShotVoices[layer].clear();
		held[layer].length = 0;
	}

	// ---- Wavetable upload (spec §4.3) -----------------------------------

	async function loadWave(layer, wave) {
		if (layer > 2) return;
		const tables = tablesForWave(wave);
		const base = BANK_BUFNUM[layer];
		// batch in groups of 8 via one OSC bundle per batch, mirroring the
		// original's s.sendBundle(nil, *msgs) perf fix (spec §4.3).
		for (let start = 0; start < N_TABLES; start += 8) {
			const end = Math.min(start + 8, N_TABLES);
			const packets = [];
			for (let i = start; i < end; i++) {
				packets.push(["/b_setn", base + i, 0, tables[i].length, ...tables[i]]);
			}
			const bundle = SuperSonic.osc.encodeBundle(1, packets);
			sonic.sendOSC(bundle);
		}
		// Ensure a newly selected wave is ready before loadWave resolves and
		// callers can trigger notes against its buffers.
		await sonic.sync();
	}

	// ---- FX slots (spec §6.1) -------------------------------------------

	async function setSlotType(slotIdx, typeIdx) {
		if (slotSynthId[slotIdx] != null) {
			sonic.send("/n_free", slotSynthId[slotIdx]);
		}
		const inBus = slotIdx === 0 ? bus.mix : bus.slot[slotIdx - 1];
		const outBus = bus.slot[slotIdx];
		const id = sonic.nextNodeId();
		sonic.send("/s_new", SLOT_DEFS[typeIdx], id, 0, grp.slot[slotIdx], "in", inBus, "out", outBus);
		slotSynthId[slotIdx] = id;
		return id;
	}

	function setSlotParam(slotIdx, key, value) {
		if (slotSynthId[slotIdx] != null) sonic.send("/n_set", slotSynthId[slotIdx], key, value);
	}

	async function initFixedSynths(defaults) {
		revShimId.id = sonic.nextNodeId();
		sonic.send("/s_new", "az_master_revshim", revShimId.id, 0, grp.revShim,
			"in", bus.rev, "out", bus.slot[2], ...flattenParams(defaults.revShim));
		masterId.id = sonic.nextNodeId();
		sonic.send("/s_new", "az_master_complim", masterId.id, 0, grp.master,
			"in", bus.slot[2], "out", 0, ...flattenParams(defaults.master));
	}

	function flattenParams(obj) {
		const out = [];
		for (const k in obj) out.push(k, obj[k]);
		return out;
	}

	function setRevShimParam(key, value) { if (revShimId.id != null) sonic.send("/n_set", revShimId.id, key, value); }
	function setMasterParam(key, value) { if (masterId.id != null) sonic.send("/n_set", masterId.id, key, value); }
	function setVol(sliderVal) {
		// linlin(0,1, 0,2): slider 0.5 = unity gain
		const amp = sliderVal * 2;
		setMasterParam("amp", amp);
	}

	// ---- NOISE layer sample loading (spec §5.3, browser equivalent) -----

	async function loadSampleFile(file) {
		const result = await sonic.loadSample(USR_BUFNUM, file);
		usrChans = Math.min(2, result.numChannels);
		usrLoaded = true;
		layerOff(3);
		return { numChannels: usrChans, duration: result.duration };
	}

	let stateGrainSource = 0;
	async function loadGrainSampleFile(file) {
		const bytes = await file.arrayBuffer();
		const decoded = await sonic.audioContext.decodeAudioData(bytes.slice(0));
		const mono = new Float32Array(decoded.length);
		for (let ch = 0; ch < decoded.numberOfChannels; ch++) {
			const input = decoded.getChannelData(ch);
			for (let i = 0; i < mono.length; i++) mono[i] += input[i] / decoded.numberOfChannels;
		}
		await sonic.send("/b_free", GRAIN_USR_BUFNUM);
		await sonic.send("/b_alloc", GRAIN_USR_BUFNUM, mono.length, 1);
		await sonic.sync();
		for (let start = 0; start < mono.length; start += 4096) {
			const chunk = mono.subarray(start, Math.min(start + 4096, mono.length));
			await sonic.send("/b_setn", GRAIN_USR_BUFNUM, start, chunk.length, ...chunk);
		}
		await sonic.sync();
		stateGrainSource = 1;
		grainDuration = decoded.duration;
		layerOff(3);
		return { duration: decoded.duration };
	}

	async function startGrainCapture(onStop) {
		const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
		const rec = new MediaRecorder(stream);
		const chunks = [];
		rec.ondataavailable = (e) => chunks.push(e.data);
		const stopTimer = setTimeout(() => { if (rec.state === "recording") rec.stop(); }, 8000);
		rec.onstop = async () => {
			clearTimeout(stopTimer);
			stream.getTracks().forEach((t) => t.stop());
			try {
				const blob = new Blob(chunks, { type: rec.mimeType });
				const bytes = await blob.arrayBuffer();
				const decoded = await sonic.audioContext.decodeAudioData(bytes.slice(0));
				const mono = new Float32Array(decoded.length);
				for (let ch = 0; ch < decoded.numberOfChannels; ch++) {
					const input = decoded.getChannelData(ch);
					for (let i = 0; i < mono.length; i++) mono[i] += input[i] / decoded.numberOfChannels;
				}
				await sonic.send("/b_free", GRAIN_REC_BUFNUM);
				await sonic.send("/b_alloc", GRAIN_REC_BUFNUM, mono.length, 1);
				await sonic.sync();
				for (let start = 0; start < mono.length; start += 4096) {
					const chunk = mono.subarray(start, Math.min(start + 4096, mono.length));
					await sonic.send("/b_setn", GRAIN_REC_BUFNUM, start, chunk.length, ...chunk);
				}
				await sonic.sync();
				stateGrainSource = 0;
				grainDuration = decoded.duration;
			} catch (err) { console.warn("Granular input capture failed:", err); }
			layerOff(3);
			onStop && onStop();
		};
		rec.start();
		return rec;
	}

	// Line-in capture: getUserMedia + MediaRecorder, then decode via loadSample
	// (browser equivalent of az_rec's SoundIn->RecordBuf, spec §2.5/§5.2/§11#7).
	let lineInStream = null;
	async function startLineInCapture(onStop) {
		lineInStream = await navigator.mediaDevices.getUserMedia({ audio: true });
		const rec = new MediaRecorder(lineInStream);
		const chunks = [];
		rec.ondataavailable = (e) => chunks.push(e.data);
		rec.onstop = async () => {
			lineInStream.getTracks().forEach((t) => t.stop());
			lineInStream = null;
			const blob = new Blob(chunks, { type: rec.mimeType });
			try {
				await sonic.loadSample(REC_BUFNUM, blob);
				lineInLoaded = true;
			} catch (err) {
				console.warn("Line-in decode failed:", err);
			}
			onStop && onStop();
		};
		rec.start();
		return rec; // caller calls .stop() after up to 8s
	}

	// ---- Master-output-to-file recording (spec §11 item 6) ---------------

	function startMasterRecording() {
		if (!sonic.node || !sonic.audioContext) return null;
		const dest = sonic.audioContext.createMediaStreamDestination();
		sonic.node.connect(dest);
		const rec = new MediaRecorder(dest.stream);
		const chunks = [];
		rec.ondataavailable = (e) => chunks.push(e.data);
		const donePromise = new Promise((resolve) => {
			rec.onstop = () => {
				try { sonic.node.disconnect(dest); } catch (e) { /* ignore */ }
				resolve(new Blob(chunks, { type: rec.mimeType }));
			};
		});
		rec.start();
		return { rec, donePromise };
	}

	function teardown() {
		if (grainHeadTimer) clearInterval(grainHeadTimer);
		try { sonic.send("/g_freeAll", grp.root); } catch (e) { /* ignore */ }
	}

	return {
		bus, grp,
		init, initFixedSynths,
		defFor, noteOn, noteOff, layerOff, setMaxVoices, loadEngineFor,
		loadWave,
		setSlotType, setSlotParam,
		setRevShimParam, setMasterParam, setVol,
		loadSampleFile, startLineInCapture, startMasterRecording,
		loadGrainSampleFile, startGrainCapture,
		setGrainSource(value) { stateGrainSource = value ? 1 : 0; layerOff(3); },
		teardown,
		get usrChans() { return usrChans; },
		bankBase: BANK_BUFNUM,
		recBufnum: REC_BUFNUM,
		usrBufnum: USR_BUFNUM,
	};
}
