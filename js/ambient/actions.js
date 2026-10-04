// Central state-mutating functions (spec §10.7 "GUI/Launchpad synchronization
// principle"): every HTML control and every Launchpad button call the SAME
// function here, so the on-screen GUI and the physical controller can never
// desync, and side effects (p-lock recording, voice-stopping on mute, etc.)
// apply no matter which input path triggered them.

import { SPEC_BY_ID, activeEngineSpecs, slotDefaults, SCALES } from "./data.js";
import { newStep } from "./sequencer.js";

export function createActions({ state, engine, sequencer, refresh }) {
	const R = () => refresh && refresh();
	const arpTimers = Array(4).fill(null);
	const arpVoices = Array(4).fill(null);
	const arpCursors = Array(4).fill(0);
	const arpWays = ["UP", "DOWN", "UP/DOWN", "PLAYED", "RANDOM"];
	const arpRates = [4, 8, 16, 32];

	function arpNotes(layer) {
		const cfg = state.padArp[layer];
		const held = state.padLatched.filter((note) => note.layer === layer);
		if (cfg.way === 0) held.sort((a, b) => a.pitch - b.pitch);
		if (cfg.way === 1) held.sort((a, b) => b.pitch - a.pitch);
		const notes = [];
		for (let octave = 0; octave < cfg.octaves; octave++) {
			for (const note of held) notes.push({ pitch: note.pitch + octave * 12, vel: note.vel ?? 0.8 });
		}
		for (let i = notes.length - 1; i >= 0; i--) if (notes[i].pitch > 127) notes.splice(i, 1);
		if (cfg.way === 2 && notes.length > 2) {
			const upDown = notes.slice(0, -1).concat(notes.slice().reverse().slice(0, -1));
			return upDown;
		}
		return notes;
	}

	function stopArp(layer) {
		if (arpTimers[layer]) clearTimeout(arpTimers[layer]);
		arpTimers[layer] = null;
		if (arpVoices[layer] != null) engine.noteOff(layer, arpVoices[layer]);
		arpVoices[layer] = null;
	}

	function syncArp(layer) {
		const cfg = state.padArp[layer];
		const wasArping = arpTimers[layer] != null || arpVoices[layer] != null;
		stopArp(layer);
		const notes = arpNotes(layer);
		if (!cfg.enabled || notes.length < 2 || state.muted[layer]) {
			if (wasArping && !state.muted[layer]) {
				for (const note of state.padLatched.filter((item) => item.layer === layer)) playNoteMomentary(layer, note.pitch, note.vel);
			}
			return;
		}
		for (const note of state.padLatched.filter((item) => item.layer === layer)) engine.noteOff(layer, note.pitch);
		const period = 60000 / Math.max(20, state.tempoBpm) * (4 / cfg.rate);
		const tick = () => {
			let index = arpCursors[layer]++;
			if (cfg.way === 4) index = Math.floor(Math.random() * notes.length);
			const note = notes[index % notes.length];
			if (arpVoices[layer] != null) engine.noteOff(layer, arpVoices[layer]);
			playNoteMomentary(layer, note.pitch, note.vel);
			arpVoices[layer] = note.pitch;
			arpTimers[layer] = setTimeout(tick, period);
		};
		arpCursors[layer] = 0;
		tick();
	}

	function setArp(layer, key, value) {
		const cfg = state.padArp[layer];
		cfg[key] = value;
		if (key === "enabled") arpCursors[layer] = 0;
		syncArp(layer);
		R();
	}

	function selectLayer(layer) {
		state.layerSel = layer;
		R();
	}

	function unlatchAllOn(layer) {
		for (let i = state.padLatched.length - 1; i >= 0; i--) {
			if (state.padLatched[i].layer === layer) state.padLatched.splice(i, 1);
		}
		for (const [k, v] of [...state.padHeld.entries()]) {
			if (v.layer === layer) state.padHeld.delete(k);
		}
		syncArp(layer);
	}

	function toggleMute(layer) {
		state.muted[layer] = !state.muted[layer];
		if (state.muted[layer]) { engine.layerOff(layer); unlatchAllOn(layer); }
		R();
	}

	async function setStructure(layer, structIdx) {
		try { await engine.loadEngineFor(layer, structIdx); }
		catch (error) {
			console.error("Engine SynthDef could not load:", error);
			alert(`Could not load ${layer === 3 ? ["NOISE TEXTURE", "CLOUDS", "GRAINTOPIA"][structIdx - 7] : ["DRONE 1", "DRONE 2", "PAD 1", "PAD 2", "ATMOS 1", "ATMOS 2", "VONGON REPLAY"][structIdx]}: ${error.message}`);
			R();
			return;
		}
		state.structure[layer] = structIdx;
		for (const row of activeEngineSpecs(layer, structIdx)) {
			if (state.lp[layer][row[1]] == null) state.lp[layer][row[1]] = row[5];
		}
		engine.layerOff(layer);
		R();
	}

	function setGrainSource(srcIdx) {
		state.grainSrc = srcIdx ? 1 : 0;
		engine.setGrainSource(state.grainSrc);
		engine.layerOff(3);
		R();
	}

	async function setWave(layer, wave) {
		if (state.curWave[layer] === wave) return;
		await engine.loadWave(layer, wave);
		state.curWave[layer] = wave;
		R();
	}

	async function setNoiseSrc(srcIdx) {
		state.noiseSrc = srcIdx;
		engine.layerOff(3);
		R();
	}

	function setLayerParam(layer, id, value) {
		const row = SPEC_BY_ID[id];
		if (!row) return;
		state.lp[layer][row[1]] = value;
		// REC-armed live knob-move also writes a p-lock (spec §7.3 path 2)
		const track = state.seq[layer];
		if (state.recArm && track.selectedStep != null) {
			track.steps[track.selectedStep].locks[id] = value;
		}
		R();
	}

	function setLayerExtra(layer, key, value) {
		state.lp[layer][key] = value;
		R();
	}

	function setMaxVoices(n) {
		state.maxVoices = Math.max(1, Math.min(16, n | 0));
		engine.setMaxVoices(state.maxVoices);
		R();
	}

	function setTempo(bpm) {
		state.tempoBpm = Math.max(20, Math.min(400, bpm));
		sequencer.setTempo(state.tempoBpm);
		for (let layer = 0; layer < 4; layer++) if (state.padArp[layer].enabled) syncArp(layer);
		R();
	}

	function setVol(v) {
		state.vol = Math.max(0, Math.min(1, v));
		engine.setVol(state.vol);
		R();
	}

	function playToggle() {
		if (state.playing) {
			state.playing = false;
			sequencer.stop();
			// force-release all voices + clear latched notes (spec §7.2 stopSeq)
			for (let l = 0; l < 4; l++) engine.layerOff(l);
			state.padLatched.length = 0;
			state.padHeld.clear();
		} else {
			state.playing = true;
			sequencer.start();
		}
		R();
	}

	// ---- sequencer step editing (spec §9.4) ------------------------------

	function selectedNoteFor(layer) {
		return state.seqNote[layer] ?? 60;
	}

	function clickStep(layer, idx, defaultNote) {
		const track = state.seq[layer];
		if (idx >= track.length) return;
		const step = track.steps[idx];
		if (!step.on) {
			step.on = true;
			step.notes = [defaultNote != null ? defaultNote : selectedNoteFor(layer)];
		}
		track.selectedStep = idx;
		state.seqNote[layer] = step.notes[0] ?? selectedNoteFor(layer);
		R();
	}

	function setSelectedStepNote(layer, note) {
		state.seqNote[layer] = note;
		const track = state.seq[layer];
		if (track.selectedStep != null) {
			const step = track.steps[track.selectedStep];
			step.notes = [note, ...step.notes.slice(1)];
		}
		R();
	}

	function setTrackLength(layer, len) {
		state.seq[layer].length = Math.max(1, Math.min(64, len | 0));
		R();
	}

	function setTrackDiv(layer, divIdx) {
		state.seq[layer].div = divIdx;
		R();
	}

	function toggleRecArm() {
		state.recArm = !state.recArm;
		R();
	}

	function randomizeTrack(layer) {
		const track = state.seq[layer];
		const base = selectedNoteFor(layer);
		const jumps = [0, 3, 5, 7, 10];
		for (let i = 0; i < track.length; i++) {
			if (Math.random() < 0.3) {
				track.steps[i] = Object.assign(newStep(), {
					on: true,
					notes: [base + 12 + jumps[(Math.random() * jumps.length) | 0]],
				});
			} else {
				track.steps[i].on = false;
			}
		}
		track.selectedStep = null;
		R();
	}

	function delStep(layer) {
		const track = state.seq[layer];
		if (track.selectedStep == null) return;
		track.steps[track.selectedStep].on = false;
		R();
	}

	function clrTrack(layer) {
		state.seq[layer] = Object.assign({ steps: Array.from({ length: 64 }, newStep), length: state.seq[layer].length, div: state.seq[layer].div, pos: -1, stepTime: 0, mute: false, selectedStep: null });
		R();
	}

	// ---- p-lock panel (spec §9.5 / §7.3) ---------------------------------

	function setLock(layer, specId, value) {
		const track = state.seq[layer];
		if (track.selectedStep == null) return;
		track.steps[track.selectedStep].locks[specId] = value;
		R();
	}

	function clrLock(layer, specId) {
		const track = state.seq[layer];
		if (track.selectedStep == null) return;
		delete track.steps[track.selectedStep].locks[specId];
		R();
	}

	// ---- FX chain (spec §6.1 / §9.6) -------------------------------------

	async function setSlotType(slotIdx, typeIdx) {
		state.slotType[slotIdx] = typeIdx;
		await engine.setSlotType(slotIdx, typeIdx);
		state.slotParams[slotIdx] = slotDefaults(typeIdx);
		for (const k in state.slotParams[slotIdx]) engine.setSlotParam(slotIdx, k, state.slotParams[slotIdx][k]);
		R();
	}

	function setSlotParam(slotIdx, key, value) {
		state.slotParams[slotIdx][key] = value;
		engine.setSlotParam(slotIdx, key, value);
		R();
	}

	function toggleSlotActive(slotIdx) {
		const p = state.slotParams[slotIdx];
		p.active = p.active ? 0 : 1;
		engine.setSlotParam(slotIdx, "active", p.active);
		R();
	}

	function setRevShimParam(key, value) {
		state.revShimParams[key] = value;
		engine.setRevShimParam(key, value);
		R();
	}
	function toggleRevShimActive() {
		state.revShimParams.active = state.revShimParams.active ? 0 : 1;
		engine.setRevShimParam("active", state.revShimParams.active);
		R();
	}
	function setMasterParam(key, value) {
		state.masterParams[key] = value;
		engine.setMasterParam(key, value);
		R();
	}
	function toggleMasterActive() {
		state.masterParams.active = state.masterParams.active ? 0 : 1;
		engine.setMasterParam("active", state.masterParams.active);
		R();
	}

	// ---- KEYS mode note trigger (both physical Launchpad + any future
	// on-screen keyboard) — spec §7.4 real-time recording + momentary play.

	function keyDegreeToPitch(col, row) {
		const scale = SCALES[state.keyScale];
		const scaleSize = scale.length;
		const degree = ((7 - row) * scaleSize) + col;
		return state.padKeyBase + state.keyRoot + Math.floor(degree / scaleSize) * 12 + scale[degree % scaleSize];
	}

	function playNoteMomentary(layer, pitch, velocity = 0.8) {
		if (state.muted[layer]) return;
		engine.noteOn(layer, pitch, velocity, state.lp[layer], state.structure[layer], state.noiseSrc, null, state.muted[layer]);
	}
	function stopNoteMomentary(layer, pitch) {
		engine.noteOff(layer, pitch);
	}

	function recordStepNote(layer, idx, pitch) {
		const track = state.seq[layer];
		state.seqNote[layer] = pitch;
		if (!state.playing) {
			track.selectedStep = idx;
		}
		const step = track.steps[idx];
		const joining = track.steps[idx].on && state.padHeld.size > 0 &&
			[...state.padHeld.values()].some((h) => h.layer === layer && h.step === idx);
		step.on = true;
		if (joining) {
			if (!step.notes.includes(pitch)) step.notes.push(pitch);
		} else {
			step.notes = [pitch];
		}
		R();
		return idx;
	}

	function recordStepLength(layer, idx, secs) {
		const track = state.seq[layer];
		const dur = sequencer.stepDurSeconds(layer);
		const lenUnits = Math.max(0.1, Math.min(8.0, secs / dur));
		track.steps[idx].len = lenUnits;
		R();
	}

	// ---- patch/sample helpers exposed for gui.js -------------------------

	async function loadSampleFile(file) {
		const res = await engine.loadSampleFile(file);
		state.usrChans = res.numChannels;
		state.noiseSrc = 9;
		R();
	}
	async function loadGrainSampleFile(file) {
		await engine.loadGrainSampleFile(file);
		setGrainSource(1);
	}

	return {
		selectLayer, toggleMute, setStructure, setWave, setNoiseSrc, setGrainSource,
		setLayerParam, setLayerExtra, setMaxVoices, setTempo, setVol, playToggle,
		clickStep, setSelectedStepNote, setTrackLength, setTrackDiv, toggleRecArm,
		randomizeTrack, delStep, clrTrack, setLock, clrLock,
		setSlotType, setSlotParam, toggleSlotActive,
		setRevShimParam, toggleRevShimActive, setMasterParam, toggleMasterActive,
		setArp, arpWays, arpRates, syncArp,
		playNoteMomentary, stopNoteMomentary, recordStepNote, recordStepLength,
		keyDegreeToPitch,
		loadSampleFile, loadGrainSampleFile,
		selectedNoteFor,
	};
}
