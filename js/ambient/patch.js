// Patch serialize/load (spec §8). JSON shape mirrors §8.2 exactly (as a plain
// JSON mirror of the desktop's SC-Archive key structure, per patch-share.js's
// own doc comment) so a patch here could plausibly be hand-converted to/from
// the desktop .azpatch format.

import { listPatches, savePatch, loadPatch, deletePatch, exportAzpatchBlob, importAzpatchFile, buildShareUrl, readPatchFromUrl, renderShareQr } from "../shared/patch-share.js";
import { SLOT_SPECS, defaultLayerParams } from "./data.js";

const NS = "ambient";

export function serializePatch(state) {
	return {
		layerStruct: state.structure.slice(),
		layerWave: state.curWave.slice(),
		noiseSrc: state.noiseSrc,
		lp: state.lp.map((d) => Object.assign({}, d)),
		muted: state.muted.slice(),
		slotType: state.slotType.slice(),
		slotParams: state.slotParams.map((d) => Object.assign({}, d)),
		revShimParams: Object.assign({}, state.revShimParams),
		masterParams: Object.assign({}, state.masterParams),
		tempoBpm: state.tempoBpm,
		maxVoices: state.maxVoices,
		keyRoot: state.keyRoot,
		keyScale: state.keyScale,
		padKeyBase: state.padKeyBase,
		seq: state.seq.map((t) => ({
			steps: t.steps.map((s) => ({ on: s.on, notes: s.notes.slice(), vel: s.vel, len: s.len, locks: Object.assign({}, s.locks) })),
			length: t.length,
			div: t.div,
		})),
	};
}

// Applies a deserialized patch onto live state + engine. Handles legacy
// single-note migration (spec §8.3 step 9) and "missing key -> keep current"
// forward-compat fallback (spec §8.3 step 8).
export async function applyPatch(state, data, ctx) {
	const { engine, refreshAll } = ctx;

	for (let i = 0; i < 4; i++) {
		state.lp[i] = Object.assign(defaultLayerParams(i), data.lp && data.lp[i] ? data.lp[i] : {});
	}
	if (data.muted) state.muted = data.muted.slice();
	if (data.layerStruct) state.structure = data.layerStruct.slice();
	state.curWave = [-1, -1, -1]; // force resend even if value coincidentally matches
	if (data.noiseSrc != null) state.noiseSrc = data.noiseSrc;

	for (let i = 0; i < 3; i++) {
		const wave = (data.layerWave && data.layerWave[i]) || 0;
		await engine.loadWave(i, wave);
		state.curWave[i] = wave;
	}
	// Restored `lp[i]` values are picked up automatically the next time each
	// layer triggers a voice (every noteOn spreads the full current lp dict as
	// synth args, spec §1.8 step 5) — there's no persistent idle synth to `.set`
	// the way the original's always-live SynthDef groups required.

	if (data.slotType) {
		for (let i = 0; i < 3; i++) {
			const typeIdx = data.slotType[i];
			await engine.setSlotType(i, typeIdx);
			state.slotType[i] = typeIdx;
			const params = Object.assign({ active: 1 }, data.slotParams && data.slotParams[i] ? data.slotParams[i] : {});
			state.slotParams[i] = params;
			for (const k in params) engine.setSlotParam(i, k, params[k]);
		}
	}
	if (data.revShimParams) {
		state.revShimParams = Object.assign({}, state.revShimParams, data.revShimParams);
		for (const k in state.revShimParams) engine.setRevShimParam(k, state.revShimParams[k]);
	}
	if (data.masterParams) {
		state.masterParams = Object.assign({}, state.masterParams, data.masterParams);
		for (const k in state.masterParams) engine.setMasterParam(k, state.masterParams[k]);
	}
	if (data.tempoBpm) state.tempoBpm = data.tempoBpm;
	if (data.maxVoices) { state.maxVoices = data.maxVoices; engine.setMaxVoices(data.maxVoices); }
	state.keyRoot = data.keyRoot != null ? data.keyRoot : state.keyRoot;
	state.keyScale = data.keyScale != null ? data.keyScale : state.keyScale;
	state.padKeyBase = data.padKeyBase != null ? data.padKeyBase : state.padKeyBase;

	if (data.seq) {
		state.seq = data.seq.map((t) => ({
			steps: (t.steps || []).map((s) => ({
				on: !!s.on,
				notes: (s.notes || (s.note != null ? [s.note] : [60])).slice(),
				vel: s.vel != null ? s.vel : 0.8,
				len: s.len != null ? s.len : 0.9,
				locks: Object.assign({}, s.locks || {}),
			})),
			length: t.length || 16,
			div: t.div != null ? t.div : 7,
			pos: -1, stepTime: 0, mute: false,
		}));
		while (state.seq.length < 4) state.seq.push({ steps: Array.from({ length: 64 }, () => ({ on: false, notes: [60], vel: 0.8, len: 0.9, locks: {} })), length: 16, div: 7, pos: -1, stepTime: 0, mute: false });
	}

	refreshAll && refreshAll();
}

export { listPatches, savePatch, loadPatch, deletePatch, exportAzpatchBlob, importAzpatchFile, buildShareUrl, readPatchFromUrl, renderShareQr, NS };
