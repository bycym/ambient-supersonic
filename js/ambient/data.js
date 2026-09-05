// Static data tables ported 1:1 from ambient_zero_sc.scd (see spec_ambient_zero.md
// §3 "Layer Parameters", §2.6 "FX Chain", §4 "Wavetable / Structure Generation",
// §10.5 "LED color palette"). Line numbers below refer to the original .scd file.

export const LAYERS = ["DRONE", "PAD", "ATMOS", "NOISE"];
export const STRUCTURES = ["DRONE 1", "DRONE 2", "PAD 1", "PAD 2", "ATMOS 1", "ATMOS 2"];
export const MOD_SHAPES = ["SINE", "SQAR", "TRI", "SAW", "R.SAW", "RAND", "S.RND", "LOG", "R.LOG", "PL.10"];
export const FILTER_NAMES = ["LPF", "BPF", "HPF"];
export const LFO_DESTS = ["PITCH", "CUTOFF", "HARMONIC", "LEVEL", "PAN", "MOD"];

export const WAVE_NAMES = [
	"GLAS", "MIST", "EMBR", "DUSK", "HOLL", "VEIL", "IRON", "REED",
	"SLIT", "BREA", "PWM.", "FOLD", "PURE", "BOWL", "WARM", "BLOW",
	"BELL", "TINE", "CHIM", "GONG", "VOWL", "AHH.", "OOH.", "THRO",
	"PIPE", "DRAW", "CHOR", "OCTA", "DUST", "SNOW", "STAR", "VOID",
];

export const NOISE_SRC_NAMES = ["RAIN", "WIND", "OCEAN", "STREAM", "FIRE", "FOREST", "THUNDER", "NIGHT", "LINE IN", "WAV FILE"];

// note dropdown: index 0..60 -> MIDI 12..72 (C0..C5)
export const NOTE_NAMES = (() => {
	const pc = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
	const out = [];
	for (let i = 0; i <= 60; i++) {
		const midi = i + 12;
		const oct = Math.floor(midi / 12) - 1;
		out.push(pc[midi % 12] + oct);
	}
	return out;
})();
export function midiFromNoteIndex(i) { return i + 12; }
export function noteIndexFromMidi(m) { return Math.max(0, Math.min(60, m - 12)); }

export const SCALE_NAMES = ["MAJOR", "MINOR", "DORIAN", "PHRYG", "LYDIAN", "MIXO", "HARM MIN", "MIN PENT", "MAJ PENT", "WHOLE"];
export const SCALES = [
	[0, 2, 4, 5, 7, 9, 11],
	[0, 2, 3, 5, 7, 8, 10],
	[0, 2, 3, 5, 7, 9, 10],
	[0, 1, 3, 5, 7, 8, 10],
	[0, 2, 4, 6, 7, 9, 11],
	[0, 2, 4, 5, 7, 9, 10],
	[0, 2, 3, 5, 7, 8, 11],
	[0, 3, 5, 7, 10],
	[0, 2, 4, 7, 9],
	[0, 2, 4, 6, 8, 10],
];
export const ROOT_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

// ---- Sequencer clock divisions (line 1167) ----
export const SEQ_DIVS = [0.25, 0.5, 1, 1.5, 2, 3, 4, 6, 8];
export const SEQ_DIV_NAMES = ["1/1", "1/2", "1/4", "1/4.", "1/8", "1/8t", "1/16", "1/16t", "1/32"];

// ---- The 25 layer-parameter specs (lines 423-449): [id, key, name, min, max, default, unit, warp] ----
export const SPECS = [
	["harmonic", "harmonic", "harmonic", 0, 1, 0.30, "", false],
	["balance", "balance", "balance", 0, 1, 0.50, "", false],
	["detune", "detune", "detune", -60, 60, 9, "ct", false],
	["pitch", "pitch", "pitch", -2400, 2400, 0, "ct", false],
	["ratio", "ratio", "op ratio", 0.5, 15.99, 2, "", false],
	["fm", "fmAmt", "fm amount", 0, 1, 0.30, "", false],
	["ring", "ringAmt", "ring mix", 0, 1, 0.50, "", false],
	["modrate", "modRate", "mod rate", 0, 1, 0.25, "", false],
	["moddepth", "modDepth", "mod depth", 0, 1, 0.20, "", false],
	["attack", "atk", "attack", 0.001, 20, 2.0, "s", true],
	["decay", "dec", "decay", 0.001, 20, 3.0, "s", true],
	["sustain", "sus", "sustain", 0, 1, 0.70, "", false],
	["release", "rel", "release", 0.01, 30, 6.0, "s", true],
	["cutoff", "cut", "cutoff", 40, 16000, 3500, "Hz", true],
	["res", "res", "resonance", 0, 0.95, 0.20, "", false],
	["egamt", "egAmt", "eg amount", -1, 1, 0.20, "", false],
	["l1rate", "l1rate", "lfo1 rate", 0, 1, 0.05, "", false],
	["l1depth", "l1depth", "lfo1 depth", 0, 1, 0.20, "", false],
	["l2rate", "l2rate", "lfo2 rate", 0, 1, 0.11, "", false],
	["l2depth", "l2depth", "lfo2 depth", 0, 1, 0.12, "", false],
	["level", "level", "level", 0, 1, 0.70, "", false],
	["pan", "pan", "pan", -1, 1, 0, "", false],
	["reverb", "revSend", "reverb snd", 0, 1, 0.30, "", false],
	["glide", "glide", "glide", 0, 5, 0, "s", false],
	["noisemix", "noiseMix", "noise mix", 0, 1, 0.15, "", false],
];
export const SPEC_BY_ID = Object.fromEntries(SPECS.map((s) => [s[0], s]));
export function specRow(id) { return SPEC_BY_ID[id]; }

// dropdown-backed per-layer extras (§1.6), stored alongside the 25 specs
export const EXTRA_KEYS = ["ftype", "modShape", "l1dest", "l2dest"];
export const EXTRA_DEFAULTS = { ftype: 0, modShape: 0, l1dest: 2, l2dest: 1 };
// NOISE layer's default l1dest/l2dest differ from tonal layers (line 624-625: l1dest=1,l2dest=4)
export const NOISE_EXTRA_DEFAULTS = { ftype: 0, modShape: 0, l1dest: 1, l2dest: 4 };

export function defaultLayerParams(layer) {
	const lp = {};
	for (const s of SPECS) lp[s[0]] = s[5];
	Object.assign(lp, layer === 3 ? NOISE_EXTRA_DEFAULTS : EXTRA_DEFAULTS);
	return lp;
}

// ---- FX slot types (lines 354-413) ----
export const SLOT_TYPE_NAMES = ["REVERB", "CHORUS", "FLANGER", "DELAY", "COMP/LIM", "TAPE DLY", "REV DLY", "OVERDRIVE", "CRUSH", "TILT EQ"];
export const SLOT_DEFS = ["az_slot_reverb", "az_end_chorus", "az_end_flanger", "az_end_delay", "az_slot_complim",
	"az_slot_tape", "az_slot_revdelay", "az_slot_drive", "az_slot_crush", "az_slot_tilt"];
// each row: [label, key, min, max, default, warp]
export const SLOT_SPECS = [
	[["size", "size", 0, 1, 0.7, false], ["decay", "decay", 0, 0.99, 0.72, false], ["damp", "damp", 0, 1, 0.35, false], ["shimmer", "shimmer", 0, 1, 0.3, false], ["mix", "mix", 0, 1, 0.5, false]],
	[["rate", "rate", 0, 1, 0.3, false], ["depth", "depth", 0, 1, 0.5, false], ["feedback", "feedback", 0, 0.9, 0.25, false], ["spread", "spread", 0, 1, 0.5, false], ["mix", "mix", 0, 1, 0.5, false]],
	[["rate", "rate", 0, 1, 0.2, false], ["depth", "depth", 0, 1, 0.7, false], ["feedback", "feedback", 0, 0.95, 0.5, false], ["delay base", "delayBase", 0.0003, 0.01, 0.003, true], ["mix", "mix", 0, 1, 0.5, false]],
	[["time L", "timeL", 0.02, 1.8, 0.375, true], ["time R", "timeR", 0.02, 1.8, 0.5, true], ["feedback", "feedback", 0, 0.9, 0.35, false], ["damp", "damp", 0, 1, 0.4, false], ["cross", "cross", 0, 1, 0.5, false], ["mix", "mix", 0, 1, 0.35, false]],
	[["threshold", "threshold", 0.005, 1, 0.15, true], ["ratio", "ratio", 1, 20, 4, true], ["attack", "attack", 0.0005, 0.2, 0.01, true], ["release", "release", 0.01, 1, 0.15, true], ["makeup", "makeup", 0.25, 8, 1, true], ["ceiling", "ceiling", 0.05, 1, 0.95, false], ["mix", "mix", 0, 1, 1.0, false]],
	[["time", "time", 0.02, 3, 0.375, true], ["feedback", "feedback", 0, 0.95, 0.45, false], ["tone", "tone", 300, 10000, 4000, true], ["wow", "wow", 0, 1, 0.3, false], ["mix", "mix", 0, 1, 0.4, false]],
	[["time", "time", 0.05, 3, 1.0, true], ["feedback", "feedback", 0, 0.9, 0.3, false], ["tone", "tone", 500, 12000, 6000, true], ["spread", "spread", 0, 1, 0.3, false], ["mix", "mix", 0, 1, 0.4, false]],
	[["drive", "drive", 0, 1, 0.4, false], ["tone", "tone", 300, 12000, 3000, true], ["bias", "bias", -0.3, 0.3, 0, false], ["out lvl", "outLevel", 0.2, 1.5, 1, false], ["mix", "mix", 0, 1, 0.7, false]],
	[["bits", "bits", 1, 16, 8, false], ["rate", "rate", 500, 22050, 8000, true], ["drive", "drive", 1, 4, 1, false], ["smooth", "smooth", 0, 1, 0.3, false], ["mix", "mix", 0, 1, 0.6, false]],
	[["tilt", "tilt", -1, 1, 0, false], ["freq", "freq", 200, 4000, 900, true], ["res", "res", 0.3, 2, 1, false], ["drive", "drive", 1, 3, 1, false], ["mix", "mix", 0, 1, 1.0, false]],
];
export function slotDefaults(typeIdx) {
	const p = { active: 1 };
	for (const row of SLOT_SPECS[typeIdx]) p[row[1]] = row[4];
	return p;
}

// fixed reverb+shimmer / master boxes (§2.7 / §2.8)
export const REVSHIM_SPECS = [["size", "size", 0, 1, 0.7, false], ["decay", "decay", 0, 0.99, 0.72, false], ["damp", "damp", 0, 1, 0.35, false], ["shimmer", "shimmer", 0, 1, 0.3, false], ["mix", "mix", 0, 1, 1.0, false]];
export const MASTER_SPECS = [["threshold", "threshold", 0.005, 1, 0.15, true], ["ratio", "ratio", 1, 20, 4, true], ["attack", "attack", 0.0005, 0.2, 0.01, true], ["release", "release", 0.01, 1, 0.15, true], ["makeup", "makeup", 0.25, 8, 1, true], ["ceiling", "ceiling", 0.05, 1, 0.95, false]];

// ---- Warp formula (§3, identical for slot-fx and layer specs; lines 1646-1650 etc) ----
export function warpValue(lo, hi, n, warp) {
	n = Math.max(0, Math.min(1, n));
	if (warp) return lo * Math.pow(hi / lo, n);
	return lo + n * (hi - lo);
}
export function unwarpValue(lo, hi, v, warp) {
	if (warp) return Math.log(v / lo) / Math.log(hi / lo);
	return (v - lo) / (hi - lo);
}

// ---- Launchpad LED color palette, 0-63 per channel (§10.5, lines 2400-2440) ----
export const PAD_C = {
	cOff: [0, 0, 0],
	cDim: [1, 1, 1],
	cStepOn: [0, 28, 50],
	cStepLock: [45, 34, 0],
	cStepSel: [63, 55, 0],
	cStepChord: [0, 50, 32],
	cKeyRoot: [63, 63, 63],
	cOctBtn: [20, 14, 40],
	cPlayhead: [63, 63, 63],
	cEngine: [[0, 45, 12], [50, 22, 0], [0, 8, 55], [40, 0, 45]],
	cFx: [0, 50, 48],
	cFxDim: [0, 7, 7],
	cFxFill: [0, 32, 30],
	cMuteOn: [55, 0, 0],
	cMuteOff: [7, 1, 1],
	cShiftOn: [63, 63, 63],
	cPlayOn: [0, 55, 10],
	cPlayDim: [0, 10, 2],
	cPlayOff: [55, 0, 0],
	cHoldOn: [0, 55, 20],
	cHoldOff: [4, 8, 4],
	cKeyLatch: [63, 34, 0],
	cFill: [0, 30, 30],
	cTip: [63, 63, 63],
	cModeOn: [0, 50, 20],
	cModeOff: [3, 8, 5],
	cRecOn: [55, 0, 0],
	cRecOff: [8, 2, 2],
	cPageOn: [30, 20, 50],
	cPageOff: [4, 3, 6],
	cWarn: [50, 18, 0],
};

export const N_TABLES = 64;
export const TABLE_SIZE = 512;
