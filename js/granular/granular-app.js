// granular_zero_sc web port — CLOUDS / GRAINTOPIA / CHEAT CODES granular
// engine, ported from supercollider_standalone/granular_zero_sc.scd per
// webport/spec_granular_zero.md. All ~gz.* line references in comments below
// refer to that spec / the original .scd file.
//
// Architecture: one GZEngine instance owns all audio/sequencer/RND state and
// exposes methods that mirror the original ~gz.* functions 1:1 (setParam,
// editParam, trigger, randomize, ...). The web GUI, the Launchpad driver and
// the debug console (window.gz) all call into this same layer, never touch
// state directly -- exactly the "one state, multiple views" pattern the
// spec's §6 calls out in the original's own Qt GUI.

import { bootEngine, teardownEngine } from "../shared/supersonic-loader.js";
import { Launchpad, padGidx, padRight, padLeft, padTop, padBottom } from "../shared/launchpad.js";
import {
	listPatches, savePatch, loadPatch, deletePatch,
	exportAzpatchBlob, importAzpatchFile,
	buildShareUrl, readPatchFromUrl, renderShareQr,
} from "../shared/patch-share.js";

// ============================================================================
// 1. Parameter spec tables — ported verbatim from ~gz.specsClouds /
//    ~gz.specsVoice / ~gz.specsPad / ~gz.specsSrc / ~gz.specsFx
//    (granular_zero_sc.scd lines 148-255). Shape: {id, arg, label, min, max,
//    def, unit, exp}. `arg==='lang'` means language-layer only, never sent
//    to a synth (rnd amount, step probability, morph time IS sent though).
// ============================================================================

function S(id, arg, label, min, max, def, unit, exp) { return { id, arg, label, min, max, def, unit, exp: !!exp }; }

export const SPECS_CLOUDS = [
	S("pos", "pos", "position", 0, 1, 0.10, "", false),
	S("gsize", "gsize", "size", 0, 1, 0.40, "", false),
	S("dens", "dens", "density", 0, 1, 0.45, "", false),
	S("tex", "tex", "texture", 0, 1, 0.50, "", false),
	S("pitch", "pitch", "pitch", -24, 24, 0, "st", false),
	S("spread", "spread", "spread", 0, 1, 0.45, "", false),
	S("jit", "jit", "jitter", 0, 1, 0.15, "", false),
	S("fb", "fb", "feedback", 0, 0.9, 0.15, "", false),
	S("blend", "blend", "in blend", 0, 1, 0.0, "", false),
	S("ingain", "inGain", "in gain", 0, 2, 1.0, "", false),
	S("lofi", "lofi", "lo-fi", 0, 1, 0.0, "", false),
	S("cut", "cut", "cutoff", 40, 16000, 14000, "Hz", true),
	S("res", "res", "resonance", 0, 0.9, 0.10, "", false),
	S("atk", "atk", "attack", 0.005, 8, 0.05, "s", true),
	S("rel", "rel", "release", 0.01, 16, 1.2, "s", true),
	S("level", "level", "level", 0, 1, 0.80, "", false),
	S("pan", "pan", "pan", -1, 1, 0, "", false),
	S("send", "send", "reverb snd", 0, 1, 0.35, "", false),
	S("dsend", "dsend", "delay snd", 0, 1, 0.10, "", false),
	S("morph", "mt", "morph time", 0.01, 20, 0.05, "s", true),
	S("rnd", "lang", "rnd amount", 0, 1, 0.40, "", false),
];

export const SPECS_VOICE = [
	S("pos", "pos", "seek", 0, 1, 0.20, "", false),
	S("speed", "speed", "scan speed", -2, 2, 0.20, "", false),
	S("gsize", "gsize", "size", 0, 1, 0.40, "", false),
	S("dens", "dens", "density", 0, 1, 0.50, "", false),
	S("jit", "jit", "jitter", 0, 1, 0.10, "", false),
	S("spread", "spread", "spread", 0, 1, 0.50, "", false),
	S("pitch", "pitch", "pitch", -24, 24, 0, "st", false),
	S("rnd", "lang", "rnd amount", 0, 1, 0.40, "", false),
	S("cut", "cut", "cutoff", 40, 16000, 12000, "Hz", true),
	S("res", "res", "resonance", 0, 0.9, 0.15, "", false),
	S("lofi", "lofi", "lo-fi", 0, 1, 0.0, "", false),
	S("pan", "pan", "pan", -1, 1, 0, "", false),
	S("level", "level", "level", 0, 1, 0.70, "", false),
	S("send", "send", "reverb snd", 0, 1, 0.30, "", false),
	S("dsend", "dsend", "delay snd", 0, 1, 0.15, "", false),
	S("morph", "mt", "morph time", 0.01, 20, 2.0, "s", true),
];

export const SPECS_PAD = [
	S("start", "start", "start", 0, 0.999, 0, "", false),
	S("slen", "slen", "length", 0.002, 1, 0.125, "", true),
	S("rate", "rate", "rate", -2, 2, 1, "", false),
	S("fine", "fine", "fine", -100, 100, 0, "ct", false),
	S("bend", "bend", "bend", -1, 1, 0, "", false),
	S("jit", "jit", "jitter", 0, 1, 0, "", false),
	S("atk", "atk", "attack", 0.001, 2, 0.003, "s", true),
	S("rel", "rel", "release", 0.005, 8, 0.20, "s", true),
	S("cut", "cut", "cutoff", 40, 16000, 16000, "Hz", true),
	S("res", "res", "resonance", 0, 0.9, 0.10, "", false),
	S("lofi", "lofi", "lo-fi", 0, 1, 0.0, "", false),
	S("pan", "pan", "pan", -1, 1, 0, "", false),
	S("level", "level", "level", 0, 1, 0.80, "", false),
	S("send", "send", "reverb snd", 0, 1, 0.20, "", false),
	S("dsend", "dsend", "delay snd", 0, 1, 0.25, "", false),
	S("loopm", "loop", "loop", 0, 1, 0, "", false),
	S("prob", "lang", "probability", 0, 1, 1, "", false),
	S("rnd", "lang", "rnd amount", 0, 1, 0.35, "", false),
];

export const SPECS_SRC = [
	S("ingain", "gain", "in gain", 0, 2, 1.0, "", false),
	S("monitor", "monitor", "monitor", 0, 1, 0.0, "", false),
	S("wavrate", "rate", "wav rate", -2, 2, 1.0, "", false),
	S("wavlvl", "wavLvl", "wav level", 0, 2, 1.0, "", false),
	S("grablen", "lang", "grab length", 0.25, 16, 4.0, "s", true),
	S("textone", "tone", "tex tone", 0, 1, 0.5, "", false),
	S("texmot", "motion", "tex motion", 0, 1, 0.3, "", false),
	S("texlvl", "texLvl", "tex level", 0, 2, 1.0, "", false),
];

export const SPECS_FX = [
	[ // DELAY
		S("dtime", "dtime", "time", 0.02, 4, 0.375, "s", true),
		S("fb", "fb", "feedback", 0, 0.95, 0.45, "", false),
		S("tone", "tone", "tone", 200, 16000, 6000, "Hz", true),
		S("cross", "cross", "ping-pong", 0, 1, 0.60, "", false),
		S("mix", "mix", "level", 0, 1, 0.70, "", false),
	],
	[ // REVERB
		S("rsize", "rsize", "size", 0, 1, 0.72, "", false),
		S("decay", "decay", "decay", 0, 1, 0.75, "", false),
		S("damp", "damp", "damping", 0, 1, 0.35, "", false),
		S("shimmer", "shimmer", "shimmer", 0, 1, 0.25, "", false),
		S("mix", "mix", "level", 0, 1, 0.80, "", false),
	],
	[ // SHAPE
		S("drive", "drive", "drive", 1, 12, 1.0, "", false),
		S("tilt", "tilt", "tilt", -1, 1, 0, "", false),
		S("bits", "bits", "bits", 2, 24, 24, "bit", false),
		S("width", "width", "width", 0, 2, 1.0, "", false),
		S("mix", "mix", "mix", 0, 1, 1.0, "", false),
	],
	[ // MASTER
		S("threshold", "threshold", "threshold", 0.02, 1, 0.20, "", false),
		S("ratio", "ratio", "ratio", 1, 20, 4, ":1", false),
		S("attack", "attack", "attack", 0.001, 0.5, 0.01, "s", true),
		S("release", "release", "release", 0.01, 2, 0.15, "s", true),
		S("makeup", "makeup", "makeup", 0.5, 6, 2.0, "", false),
		S("ceiling", "ceiling", "ceiling", 0.1, 1, 0.95, "", false),
		S("amp", "amp", "out level", 0, 1.5, 0.9, "", false),
	],
];

export const ENG_NAMES = ["CLOUDS", "GRAINTOPIA", "CHEAT CODES"];
export const SRC_NAMES = ["NONE", "MIC", "LINE", "WAV"];
export const CLOUD_MODES = ["GRANULAR", "STRETCH", "LOOP DLY", "SPECTRAL"];
export const FX_NAMES = ["DELAY", "REVERB", "SHAPE", "MASTER"];
export const SCALE_NAMES = ["MAJOR", "MINOR", "DORIAN", "PHRYG", "LYDIAN", "MIXO",
	"HARM MIN", "PENT MAJ", "PENT MIN", "BLUES", "WHOLE", "CHROM"];
export const SCALES = [
	[0, 2, 4, 5, 7, 9, 11], [0, 2, 3, 5, 7, 8, 10], [0, 2, 3, 5, 7, 9, 10],
	[0, 1, 3, 5, 7, 8, 10], [0, 2, 4, 6, 7, 9, 11], [0, 2, 4, 5, 7, 9, 10],
	[0, 2, 3, 5, 7, 8, 11], [0, 2, 4, 7, 9], [0, 3, 5, 7, 10],
	[0, 3, 5, 6, 7, 10], [0, 2, 4, 6, 8, 10], [0, 1, 2, 3, 4, 5, 6, 7],
];
export const ROOT_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
export const DIVS = [4, 2, 1, 1.5, 0.5, 1 / 3, 0.25, 1 / 6, 0.125];
export const DIV_NAMES = ["1/1", "1/2", "1/4", "1/4.", "1/8", "1/8t", "1/16", "1/16t", "1/32"];
export const RND_SKIP = ["level", "morph", "rnd", "prob"];

// Launchpad Pro RGB palette (0-63/channel), ported verbatim from ~gz.gc
// (granular_zero_sc.scd lines 2673-2711).
export const GC = {
	cOff: [0, 0, 0], cDim: [1, 1, 1],
	cStepOn: [0, 28, 50], cStepLock: [45, 34, 0], cStepSel: [63, 55, 0],
	cStepChord: [0, 50, 32], cPlayhead: [63, 63, 63],
	cEngine: [[55, 28, 0], [0, 45, 12], [45, 0, 40]],
	cSrc: [0, 20, 55], cSrcDim: [0, 3, 8],
	cFx: [0, 50, 48], cFxDim: [0, 7, 7], cFxFill: [0, 32, 30], cFill: [0, 30, 30],
	cTip: [63, 63, 63],
	cMuteOn: [55, 0, 0], cMuteOff: [7, 1, 1],
	cShiftOn: [63, 63, 63],
	cPlayOn: [0, 55, 10], cPlayDim: [0, 10, 2], cPlayOff: [55, 0, 0],
	cHoldOn: [0, 55, 20], cHoldOff: [4, 8, 4],
	cFrzOn: [0, 40, 63], cKeyLatch: [63, 34, 0],
	cModeOn: [0, 50, 20], cModeOff: [3, 8, 5],
	cRecOn: [55, 0, 0], cRecOff: [8, 2, 2],
	cPageOn: [30, 20, 50], cPageOff: [4, 3, 6],
	cOctBtn: [20, 14, 40], cWarn: [50, 18, 0], cGrab: [63, 0, 0],
};

// ---- small numeric helpers -------------------------------------------------
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function rrand(lo, hi) { return lo + Math.random() * (hi - lo); }
function toNorm(sp, v) {
	v = clamp(v, sp.min, sp.max);
	if (sp.exp) {
		const lo = Math.max(sp.min, 0.0001);
		return (Math.log(v <= 0 ? lo : v) - Math.log(lo)) / (Math.log(sp.max) - Math.log(lo));
	}
	return (v - sp.min) / (sp.max - sp.min || 1);
}
function fromNorm(sp, n) {
	n = clamp(n, 0, 1);
	if (sp.exp) {
		const lo = Math.max(sp.min, 0.0001);
		return Math.exp(Math.log(lo) + n * (Math.log(sp.max) - Math.log(lo)));
	}
	return sp.min + n * (sp.max - sp.min);
}
function dbToUnit(amp) {
	const db = 20 * Math.log10(Math.max(amp, 1e-6));
	return clamp((db - -60) / (0 - -60), 0, 1);
}
function midiName(note) {
	const names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
	return names[((note % 12) + 12) % 12] + (Math.floor(note / 12) - 1);
}

// ============================================================================
// 2. Fixed buffer / bus layout (§2.2/§2.4 of the spec). SuperSonic's default
//    scsynthOptions from supersonic-loader.js reserve channels 0-1 as
//    hardware out and 2-3 as hardware in, so the first free audio bus is 4.
// ============================================================================
const BUF_LIVE = 0, BUF_SRC = 1;
const BUF_SLOT = [2, 3, 4, 5];
const BUF_BANK = [6, 7, 8, 9, 10, 11, 12, 13];
const AUDIO_BUS_BASE = 4;

// ============================================================================
// 3. GZEngine — all audio/sequencer/RND state + logic. Mirrors ~gz 1:1.
// ============================================================================
class GZEngine {
	constructor(sonic) {
		this.sonic = sonic;
		this.log = (...a) => { this._logLines = (this._logLines || []).concat([a.join(" ")]).slice(-40); this._onLog && this._onLog(); console.log("[granular_zero]", ...a); };

		// ---- buses ----
		this.srcBus = AUDIO_BUS_BASE;
		this.mixBus = AUDIO_BUS_BASE + 2;
		this.revBus = AUDIO_BUS_BASE + 4;
		this.dlyBus = AUDIO_BUS_BASE + 6;
		this.shapeBus = AUDIO_BUS_BASE + 8;
		this.headBus = 0; // control bus

		// ---- names/state ----
		this.engIdx = 0; this.focus = "eng"; this.fxIdx = 0; this.srcIdx = 0;
		this.cloudMode = 0; this.frz = false;
		this.voiceSel = 0; this.voiceSlot = [0, 1];
		this.bank = 0; this.padSel = 0;
		this.muted = [false, false, false];
		this.fxBypass = [false, false, false, false];
		this.recArm = false;
		this.bpm = 110;
		this.keyRoot = 0; this.keyScale = 1; this.keyBase = 48;
		this.padPage = 0; this.padMode = 0; // 0 STEP / 1 PARAM / 2 KEYS
		this.padScaleEdit = false;
		this.running = false;
		this.wavName = "-"; this.wavFiles = []; this.wavIdx = 0;
		this.grabbing = false;
		this.meterIn = 0; this.meterOut = 0;

		this.initParams();

		// ---- sequencer ----
		this.trk = [0, 1, 2].map(() => this.newTrack());
		this.selStep = [null, null, null];
		this.lastVal = [60, 60, 0];

		// ---- voice bookkeeping (JS mirror of NodeWatcher, spec §3.4/§7) ----
		this.voices = [new Map(), new Map(), new Map()]; // eng -> val -> nodeId
		this.held = [[], [], []];
		this.padVoices = []; // {bank,pad,nodeId,loop}
		this.liveNodes = new Set();
		this.maxVoices = 10;
		this.rndUndo = [null, null, null];

		this._nextSync = 1;
		this._syncWaiters = new Map();

		this.groups = {};
		this.fxSyn = [null, null, null, null];
		this.srcSyn = null; this.thruSyn = null; this.capSyn = null; this.cloudSyn = null;
		this.topiaSyn = [null, null];

		this._micStream = null;

		this._onVoicesChanged = null;

		sonic.on("in", (msg) => this._onOsc(msg));
	}

	// -------------------------------------------------------------- boot ----
	async boot() {
		const s = this.sonic;
		s.send("/notify", 1);

		this.groups.root = s.nextNodeId(); s.send("/g_new", this.groups.root, 1, 0);
		this.groups.src = s.nextNodeId(); s.send("/g_new", this.groups.src, 1, this.groups.root);
		this.groups.eng0 = s.nextNodeId(); s.send("/g_new", this.groups.eng0, 1, this.groups.root);
		this.groups.eng1 = s.nextNodeId(); s.send("/g_new", this.groups.eng1, 1, this.groups.root);
		this.groups.v0 = s.nextNodeId(); s.send("/g_new", this.groups.v0, 1, this.groups.eng1);
		this.groups.v1 = s.nextNodeId(); s.send("/g_new", this.groups.v1, 1, this.groups.eng1);
		this.groups.eng2 = s.nextNodeId(); s.send("/g_new", this.groups.eng2, 1, this.groups.root);
		this.groups.send = s.nextNodeId(); s.send("/g_new", this.groups.send, 1, this.groups.root);
		this.groups.shape = s.nextNodeId(); s.send("/g_new", this.groups.shape, 1, this.groups.root);
		this.groups.master = s.nextNodeId(); s.send("/g_new", this.groups.master, 1, this.groups.root);
		this.vGrp = [this.groups.v0, this.groups.v1];
		this.engGrp = [this.groups.eng0, this.groups.eng1, this.groups.eng2];

		const sr = (s.audioContext && s.audioContext.sampleRate) || 48000;
		this.sampleRate = sr;
		const bufSecs = 8;
		s.send("/b_alloc", BUF_LIVE, Math.floor(sr * bufSecs), 1);
		s.send("/b_alloc", BUF_SRC, sr, 1);
		for (const b of BUF_SLOT) s.send("/b_alloc", b, Math.floor(sr * bufSecs), 1);
		for (const b of BUF_BANK) s.send("/b_alloc", b, Math.floor(sr * bufSecs), 1);
		await this.sync();

		this.startSource(this.srcIdx);
		this.thruSyn = s.nextNodeId();
		s.send("/s_new", "gz_thru", this.thruSyn, 1, this.groups.src, "in", this.srcBus, "out", this.mixBus, "monitor", this.pvSrc.monitor);
		this.capSyn = s.nextNodeId();
		s.send("/s_new", "gz_capture", this.capSyn, 1, this.groups.src, "in", this.srcBus, "buf", BUF_LIVE, "run", 1, "headBus", this.headBus);

		this.rebuildClouds();
		this.rebuildVoices();

		this.fxSyn[0] = s.nextNodeId();
		s.send("/s_new", "gz_fx_delay", this.fxSyn[0], 1, this.groups.send, "in", this.dlyBus, "out", this.mixBus);
		this.fxSyn[1] = s.nextNodeId();
		s.send("/s_new", "gz_fx_reverb", this.fxSyn[1], 1, this.groups.send, "in", this.revBus, "out", this.mixBus);
		this.fxSyn[2] = s.nextNodeId();
		s.send("/s_new", "gz_fx_shape", this.fxSyn[2], 1, this.groups.shape, "in", this.mixBus, "out", this.shapeBus);
		this.fxSyn[3] = s.nextNodeId();
		s.send("/s_new", "gz_fx_master", this.fxSyn[3], 1, this.groups.master, "in", this.shapeBus, "out", 0);
		for (let slot = 0; slot < 4; slot++) {
			SPECS_FX[slot].forEach((sp, i) => this.setFxParam(slot, i, this.getFxParam(slot, i)));
			this.setFxBypass(slot, this.fxBypass[slot]);
		}

		this.bpm = 110;
		this._startScheduler();
		this.log("engine ready.");
	}

	sync() {
		const id = this._nextSync++;
		return new Promise((resolve) => {
			this._syncWaiters.set(id, resolve);
			this.sonic.send("/sync", id);
			setTimeout(() => { if (this._syncWaiters.has(id)) { this._syncWaiters.delete(id); resolve(); } }, 2000);
		});
	}

	_onOsc(msg) {
		const addr = msg[0];
		if (addr === "/synced") {
			const w = this._syncWaiters.get(msg[1]);
			if (w) { this._syncWaiters.delete(msg[1]); w(); }
		} else if (addr === "/n_end") {
			this._onNodeEnd(msg[1]);
		} else if (addr === "/gz_meter") {
			this.meterIn = msg[msg.length - 2];
			this.meterOut = msg[msg.length - 1];
			this._onMeter && this._onMeter();
		}
	}

	_onNodeEnd(nodeId) {
		this.liveNodes.delete(nodeId);
		for (let eng = 0; eng < 3; eng++) {
			for (const [val, id] of this.voices[eng]) {
				if (id === nodeId) { this.voices[eng].delete(val); this.held[eng] = this.held[eng].filter((v) => v !== val); }
			}
		}
		this.padVoices = this.padVoices.filter((v) => v.nodeId !== nodeId);
		this._onVoicesChanged && this._onVoicesChanged();
	}

	alive(nodeId) { return nodeId != null && this.liveNodes.has(nodeId); }

	spawn(defName, args, group, addAction = 1) {
		const id = this.sonic.nextNodeId();
		this.sonic.send("/s_new", defName, id, addAction, group, ...args);
		this.liveNodes.add(id);
		return id;
	}
	nset(nodeId, ...kv) { if (nodeId != null) this.sonic.send("/n_set", nodeId, ...kv); }
	free(nodeId) { if (nodeId != null) { this.sonic.send("/n_free", nodeId); this.liveNodes.delete(nodeId); } }

	// -------------------------------------------------------- parameters ----
	initParams() {
		const fill = (specs) => { const d = {}; for (const sp of specs) d[sp.id] = sp.def; return d; };
		this.pvClouds = fill(SPECS_CLOUDS);
		this.pvVoice = [fill(SPECS_VOICE), fill(SPECS_VOICE)];
		this.pvVoice[1].pos = 0.6;
		this.pvVoice[0].pan = -0.35;
		this.pvVoice[1].pan = 0.35;
		this.pvVoice[1].speed = -0.15;
		this.pvSrc = fill(SPECS_SRC);
		this.fxP = SPECS_FX.map((specs) => fill(specs));
		this.padP = Array.from({ length: 8 }, () => Array.from({ length: 8 }, (_, p) => {
			const d = fill(SPECS_PAD);
			d.start = p / 8; d.slen = 1 / 8;
			return d;
		}));
	}

	specsFor(eng) { return eng === 0 ? SPECS_CLOUDS : eng === 1 ? SPECS_VOICE : SPECS_PAD; }

	paramStore(eng) {
		if (eng === 0) return this.pvClouds;
		if (eng === 1) return this.pvVoice[this.voiceSel];
		return this.padP[this.bank][this.padSel];
	}

	getParam(eng, idx) {
		const sp = this.specsFor(eng)[idx];
		if (!sp) return null;
		const v = this.paramStore(eng)[sp.id];
		return v === undefined ? sp.def : v;
	}

	pushParam(eng, idx, val) {
		const sp = this.specsFor(eng)[idx];
		if (!sp || sp.arg === "lang") return;
		if (eng === 0) this.nset(this.engGrp[0], sp.arg, val);
		else if (eng === 1) this.nset(this.vGrp[this.voiceSel], sp.arg, val);
		else {
			for (const v of this.padVoices) {
				if (v.bank === this.bank && v.pad === this.padSel && this.alive(v.nodeId)) this.nset(v.nodeId, sp.arg, val);
			}
		}
	}

	setParam(eng, idx, val) {
		const sp = this.specsFor(eng)[idx];
		if (!sp) return val;
		val = clamp(val, sp.min, sp.max);
		this.paramStore(eng)[sp.id] = val;
		this.pushParam(eng, idx, val);
		return val;
	}

	editParam(eng, idx, val) {
		this.setParam(eng, idx, val);
		if (this.recArm && this.selStep[eng] != null) this.setLock(eng, this.selStep[eng], idx, val);
	}

	getSrcParam(idx) { const sp = SPECS_SRC[idx]; const v = this.pvSrc[sp.id]; return v === undefined ? sp.def : v; }
	setSrcParam(idx, val) {
		const sp = SPECS_SRC[idx];
		val = clamp(val, sp.min, sp.max);
		this.pvSrc[sp.id] = val;
		if (sp.arg !== "lang") {
			if (sp.id === "monitor") this.nset(this.thruSyn, "monitor", val);
			else this.nset(this.srcSyn, sp.arg, val);
		}
		return val;
	}

	getFxParam(slot, idx) { const sp = SPECS_FX[slot][idx]; const v = this.fxP[slot][sp.id]; return v === undefined ? sp.def : v; }
	setFxParam(slot, idx, val) {
		const sp = SPECS_FX[slot][idx];
		val = clamp(val, sp.min, sp.max);
		this.fxP[slot][sp.id] = val;
		this.nset(this.fxSyn[slot], sp.arg, val);
		return val;
	}
	setFxBypass(slot, byp) { this.fxBypass[slot] = byp; this.nset(this.fxSyn[slot], "active", byp ? 0 : 1); }

	// -------------------------------------------------------- engine build --
	argsFor(eng, voiceIdx) {
		const amp = this.muted[eng] ? 0 : 1;
		const a = ["out", this.mixBus, "revB", this.revBus, "dlyB", this.dlyBus, "amp", amp];
		if (eng === 0) {
			a.push("inBus", this.srcBus, "buf", BUF_LIVE, "headBus", this.headBus, "frz", this.frz ? 1 : 0);
			for (const sp of SPECS_CLOUDS) if (sp.arg !== "lang") a.push(sp.arg, this.pvClouds[sp.id]);
		} else if (eng === 1) {
			const buf = BUF_SLOT[this.voiceSlot[voiceIdx]];
			a.push("buf", buf);
			for (const sp of SPECS_VOICE) if (sp.arg !== "lang") a.push(sp.arg, this.pvVoice[voiceIdx][sp.id]);
		} else {
			a.push("buf", BUF_BANK[this.bank]);
			for (const sp of SPECS_PAD) if (sp.arg !== "lang") a.push(sp.arg, this.padP[this.bank][this.padSel][sp.id]);
		}
		return a;
	}

	rebuildClouds() {
		if (this.cloudSyn != null) { this.free(this.cloudSyn); this.cloudSyn = null; }
		this.cloudSyn = this.spawn("gz_clouds" + this.cloudMode, [...this.argsFor(0), "gate", 1], this.engGrp[0]);
	}
	rebuildVoices() {
		for (const id of this.topiaSyn) if (id != null) this.free(id);
		this.topiaSyn = [0, 1].map((v) => this.spawn("gz_topia", [...this.argsFor(1, v), "gate", 1], this.vGrp[v]));
	}
	refreshVoiceBufs() { for (let v = 0; v < 2; v++) this.nset(this.vGrp[v], "buf", BUF_SLOT[this.voiceSlot[v]]); }

	setCloudMode(m) { this.cloudMode = clamp(m | 0, 0, 3); this.rebuildClouds(); this.log("CLOUDS mode:", CLOUD_MODES[this.cloudMode]); }
	setVoiceSlot(voice, slot) { this.voiceSlot[voice] = clamp(slot | 0, 0, 3); this.refreshVoiceBufs(); }
	setBank(b) { this.bank = clamp(b | 0, 0, 7); }
	setMute(eng, m) { this.muted[eng] = m; this.nset(this.engGrp[eng], "amp", m ? 0 : 1); }

	// ------------------------------------------------------------ trigger ---
	applyLocks(args, eng, locks) {
		if (!locks) return args;
		const specs = this.specsFor(eng);
		for (const id in locks) {
			const sp = specs.find((x) => x.id === id);
			if (sp && sp.arg !== "lang" && locks[id] != null) args = args.concat([sp.arg, locks[id]]);
		}
		return args;
	}

	steal(eng) {
		while (this.held[eng].length >= this.maxVoices) {
			const old = this.held[eng].shift();
			const id = this.voices[eng].get(old);
			if (this.alive(id)) this.nset(id, "gate", 0);
			this.voices[eng].delete(old);
		}
	}

	trigger(eng, val, vel = 0.8, locks) {
		if (this.muted[eng]) return null;
		let args, id;
		if (eng === 0) {
			if (this.voices[0].has(val)) this.stopVoice(0, val);
			this.steal(0);
			args = [...this.argsFor(0), "gate", 1, "amp", clamp(vel, 0.05, 1)];
			args.push("pitch", this.pvClouds.pitch + (val - 60));
			args = this.applyLocks(args, 0, locks);
			id = this.spawn("gz_clouds" + this.cloudMode, args, this.engGrp[0]);
			this.voices[0].set(val, id); this.held[0].push(val);
		} else if (eng === 1) {
			if (this.voices[1].has(val)) this.stopVoice(1, val);
			this.steal(1);
			args = [...this.argsFor(1, this.voiceSel), "gate", 1, "amp", clamp(vel, 0.05, 1)];
			args.push("pitch", this.pvVoice[this.voiceSel].pitch + (val - 60));
			args = this.applyLocks(args, 1, locks);
			id = this.spawn("gz_topia", args, this.vGrp[this.voiceSel]);
			this.voices[1].set(val, id); this.held[1].push(val);
		} else {
			const bank = clamp(Math.floor(val / 8), 0, 7);
			const pad = val % 8;
			const pd = this.padP[bank][pad];
			const buf = BUF_BANK[bank];
			args = ["out", this.mixBus, "revB", this.revBus, "dlyB", this.dlyBus, "buf", buf,
				"gate", 1, "vel", vel, "amp", this.muted[2] ? 0 : 1];
			for (const sp of SPECS_PAD) if (sp.arg !== "lang") args.push(sp.arg, pd[sp.id]);
			args = this.applyLocks(args, 2, locks);
			id = this.spawn("gz_slice", args, this.engGrp[2]);
			this.padVoices.push({ bank, pad, nodeId: id, loop: pd.loopm > 0.5 });
			if (this.padVoices.length > 24) { const oldest = this.padVoices.shift(); if (this.alive(oldest.nodeId)) this.nset(oldest.nodeId, "gate", 0); }
			this.voices[2].set(val, id);
		}
		this._onVoicesChanged && this._onVoicesChanged();
		return id;
	}

	stopVoice(eng, val) {
		const id = this.voices[eng].get(val);
		if (id != null) {
			if (this.alive(id)) this.nset(id, "gate", 0);
			this.voices[eng].delete(val);
			if (eng === 2) this.padVoices = this.padVoices.filter((v) => v.nodeId !== id);
		}
		this.held[eng] = this.held[eng].filter((v) => v !== val);
	}

	allOff() {
		for (let e = 0; e < 3; e++) {
			for (const id of this.voices[e].values()) if (this.alive(id)) this.nset(id, "gate", 0);
			this.voices[e] = new Map(); this.held[e] = [];
		}
		for (const v of this.padVoices) if (this.alive(v.nodeId)) this.nset(v.nodeId, "gate", 0);
		this.padVoices = [];
	}

	// -------------------------------------------------------- RND + undo ----
	rndAmount(eng) {
		if (eng === 0) return this.pvClouds.rnd ?? 0.4;
		if (eng === 1) return this.pvVoice[this.voiceSel].rnd ?? 0.4;
		return this.padP[this.bank][this.padSel].rnd ?? 0.4;
	}

	randomize(eng) {
		const specs = this.specsFor(eng);
		const amt = this.rndAmount(eng);
		this.rndUndo[eng] = specs.map((sp, i) => this.getParam(eng, i));
		specs.forEach((sp, i) => {
			if (!RND_SKIP.includes(sp.id)) {
				const cur = this.getParam(eng, i);
				const target = rrand(sp.min, sp.max);
				this.setParam(eng, i, cur + (target - cur) * amt);
			}
		});
		this.log(ENG_NAMES[eng] + ": randomised (amount " + amt.toFixed(2) + ")");
	}

	undoRandom(eng) {
		if (!this.rndUndo[eng]) return;
		this.rndUndo[eng].forEach((v, i) => this.setParam(eng, i, v));
		this.log(ENG_NAMES[eng] + ": back to the previous set");
	}

	// SOURCE/FX "RND" — direct jitter, no undo (spec §3.7, line 3366-3371)
	jitterFocused() {
		const n = this.gridCount();
		for (let c = 0; c < n; c++) this.setGridNorm(c, clamp(this.getGridNorm(c) + rrand(-0.35, 0.35), 0, 1));
	}

	// context-dispatched RND (STEP page -> track fill; engine focus -> param
	// randomize; SOURCE/FX focus -> direct jitter). Shared by the GUI button
	// and Launchpad SHIFT+95.
	handleRnd() {
		if (this.focus === "eng" && this.padMode === 0) this.rndTrack(this.engIdx);
		else if (this.focus === "eng") this.randomize(this.engIdx);
		else this.jitterFocused();
	}
	handleUndo() { if (this.focus === "eng") this.undoRandom(this.engIdx); }

	// -------------------------------------------------------- sequencer -----
	newStep() { return { on: false, notes: [60], vel: 0.8, len: 0.9, prob: 1, locks: {} }; }
	newTrack() { return { steps: Array.from({ length: 64 }, () => this.newStep()), length: 16, div: 6, pos: 0, stepTimeMs: 0, trackMute: false }; }

	stepBeats(t) { return DIVS[clamp(t.div, 0, DIVS.length - 1)]; }
	stepSeconds(t) { return (60 / this.bpm) * this.stepBeats(t); }

	trigStep(track, idx) {
		const t = this.trk[track];
		const st = t.steps[idx];
		if (!st.on || st.prob < Math.random()) return;
		const sec = this.stepSeconds(t);
		for (const v of st.notes) {
			this.trigger(track, v, st.vel, st.locks);
			const isLoopPad = track === 2 && this.padP[clamp(Math.floor(v / 8), 0, 7)][v % 8].loopm > 0.5;
			if (track < 2 || isLoopPad) {
				const gateMs = Math.max(10, sec * st.len * 1000);
				setTimeout(() => this.stopVoice(track, v), gateMs);
			}
		}
	}

	_startScheduler() {
		this._schedTick = () => {
			const now = performance.now();
			for (let i = 0; i < 3; i++) {
				const t = this.trk[i];
				if (!this.running || t.trackMute) { if (this.running) t._nextTime = now; continue; }
				if (t._nextTime == null) t._nextTime = now;
				while (t._nextTime < now + 100) {
					const fireAt = t._nextTime;
					const pos = t.pos;
					const delay = Math.max(0, fireAt - now);
					setTimeout(() => { if (this.running) this.trigStep(i, pos); }, delay);
					t.stepTimeMs = fireAt;
					t._nextTime += this.stepSeconds(t) * 1000;
					t.pos = (t.pos + 1) % Math.max(1, t.length);
					if (i === this.engIdx) {
						setTimeout(() => this._onSeqStep && this._onSeqStep(), delay);
					}
				}
			}
		};
		this._schedTimer = setInterval(this._schedTick, 25);
		this._blinkTimer = setInterval(() => {
			if (this.running) { this.padBlinkOn = !this.padBlinkOn; this._onBlink && this._onBlink(); }
			else if (!this.padBlinkOn) { this.padBlinkOn = true; this._onBlink && this._onBlink(); }
		}, Math.max(60, (30000 / this.bpm)));
	}

	setTempo(bpm) { this.bpm = clamp(bpm, 20, 300); }

	startSeq() {
		this.running = true;
		for (const t of this.trk) { t.pos = 0; t._nextTime = performance.now(); }
	}
	stopSeq() {
		this.running = false;
		this.allOff();
		this.padLatched = [];
	}
	togglePlay() { if (this.running) this.stopSeq(); else this.startSeq(); }

	stepPress(idx) {
		const t = this.trk[this.engIdx];
		const st = t.steps[idx];
		if (idx >= 64) return;
		if (!st.on) { st.on = true; st.notes = [this.lastVal[this.engIdx]]; st.vel = 0.8; }
		this.selStep[this.engIdx] = idx;
	}
	delStep() { const sel = this.selStep[this.engIdx]; if (sel != null) this.trk[this.engIdx].steps[sel] = this.newStep(); }
	deleteStepAt(idx) { if (idx < 64) this.trk[this.engIdx].steps[idx] = this.newStep(); }
	addSteps(delta, track) {
		track = track ?? this.engIdx;
		const t = this.trk[track];
		t.length = clamp(t.length + delta, 1, 64) | 0;
		if (this.selStep[track] != null && this.selStep[track] >= t.length) this.selStep[track] = null;
	}
	setKeyRoot(i) { this.keyRoot = clamp(i | 0, 0, 11); }
	setKeyScale(i) { this.keyScale = clamp(i | 0, 0, SCALES.length - 1); }
	clrTrack(track) { track = track ?? this.engIdx; this.trk[track].steps = Array.from({ length: 64 }, () => this.newStep()); this.selStep[track] = null; }

	rndTrack(track) {
		track = track ?? this.engIdx;
		const t = this.trk[track];
		const sc = SCALES[this.keyScale];
		const base = this.keyBase + this.keyRoot;
		for (let i = 0; i < t.length; i++) {
			const st = this.newStep();
			if (Math.random() < 0.34) {
				st.on = true;
				st.vel = rrand(0.5, 1.0);
				st.len = rrand(0.2, 1.4);
				st.prob = [1, 1, 1, 0.75, 0.5][Math.floor(Math.random() * 5)];
				st.notes = track === 2 ? [(this.bank * 8) + Math.floor(Math.random() * 8)]
					: [base + 12 * Math.floor(Math.random() * 3) + sc[Math.floor(Math.random() * sc.length)]];
			}
			t.steps[i] = st;
		}
		this.selStep[track] = null;
	}

	recordNote(val, vel) {
		const track = this.engIdx;
		const t = this.trk[track];
		let idx;
		if (this.running) {
			const secMs = this.stepSeconds(t) * 1000;
			const elapsed = performance.now() - t.stepTimeMs;
			idx = elapsed > secMs * 0.5 ? (t.pos + 1) % Math.max(1, t.length) : t.pos;
		} else idx = this.selStep[track] ?? 0;
		const st = t.steps[idx];
		if (st.on) { if (!st.notes.includes(val)) st.notes.push(val); }
		else { st.on = true; st.notes = [val]; }
		st.vel = vel;
		this.lastVal[track] = val;
		if (!this.running) this.selStep[track] = (idx + 1) % Math.max(1, t.length);
		return idx;
	}
	recordLength(track, idx, seconds) {
		if (idx == null) return;
		const t = this.trk[track];
		t.steps[idx].len = clamp(seconds / this.stepSeconds(t), 0.05, 8);
	}
	setLock(track, idx, specIdx, val) {
		const sp = this.specsFor(track)[specIdx];
		if (sp && idx != null) this.trk[track].steps[idx].locks[sp.id] = val;
	}
	clearLocks(track, idx) { if (idx != null) this.trk[track].steps[idx].locks = {}; }

	// -------------------------------------------------------- surface -------
	selectEngine(e) {
		this.focus = "eng"; this.engIdx = clamp(e | 0, 0, 2);
		const maxPage = Math.floor((this.specsFor(this.engIdx).length - 1) / 8);
		this.padPage = Math.min(this.padPage, maxPage);
	}
	selectFx(f) { this.focus = "fx"; this.fxIdx = clamp(f | 0, 0, 3); }
	selectSrc() { this.focus = "src"; }

	gridCount() {
		if (this.focus === "eng") return clamp(this.specsFor(this.engIdx).length - this.padPage * 8, 0, 8) | 0;
		if (this.focus === "src") return Math.min(SPECS_SRC.length, 8);
		return Math.min(SPECS_FX[this.fxIdx].length, 8);
	}
	gridSpec(col) {
		if (this.focus === "eng") return this.specsFor(this.engIdx)[this.padPage * 8 + col];
		if (this.focus === "src") return SPECS_SRC[col];
		return SPECS_FX[this.fxIdx][col];
	}
	getGridNorm(col) {
		const sp = this.gridSpec(col);
		if (!sp) return 0;
		const v = this.focus === "eng" ? this.getParam(this.engIdx, this.padPage * 8 + col)
			: this.focus === "src" ? this.getSrcParam(col) : this.getFxParam(this.fxIdx, col);
		return toNorm(sp, v);
	}
	setGridNorm(col, n) {
		const sp = this.gridSpec(col);
		if (!sp) return;
		const val = fromNorm(sp, n);
		if (this.focus === "eng") this.editParam(this.engIdx, this.padPage * 8 + col, val);
		else if (this.focus === "src") this.setSrcParam(col, val);
		else this.setFxParam(this.fxIdx, col, val);
	}

	subCount() {
		if (this.focus === "eng") return [4, 8, 8][this.engIdx];
		if (this.focus === "src") return 4;
		return 0;
	}
	subActive(col) {
		if (this.focus === "eng") {
			if (this.engIdx === 0) return col === this.cloudMode;
			if (this.engIdx === 1) return col < 2 ? col === this.voiceSel : (col >= 4 && (col - 4) === this.voiceSlot[this.voiceSel]);
			return col === this.bank;
		}
		if (this.focus === "src") return col === this.srcIdx;
		return false;
	}
	subPress(col) {
		if (this.focus === "eng") {
			if (this.engIdx === 0) this.setCloudMode(col);
			else if (this.engIdx === 1) { if (col < 2) this.voiceSel = col; else if (col >= 4) this.setVoiceSlot(this.voiceSel, col - 4); }
			else this.setBank(col);
		} else if (this.focus === "src") this.startSource(col);
	}

	toggleRecArm() { this.recArm = !this.recArm; }
	toggleMute(e) { this.setMute(e, !this.muted[e]); }
	toggleFxBypass(f) { this.setFxBypass(f, !this.fxBypass[f]); }
	toggleFreeze() { this.setFreeze(!this.frz); }

	// -------------------------------------------------------- input source --
	setFreeze(frz) {
		this.frz = frz;
		this.nset(this.capSyn, "run", frz ? 0 : 1);
		this.nset(this.cloudSyn, "frz", frz ? 1 : 0);
	}

	async startSource(idx) {
		this.srcIdx = clamp(idx | 0, 0, 3);
		if (this.srcSyn != null) { this.free(this.srcSyn); this.srcSyn = null; }
		const defName = ["gz_src_none", "gz_src_mic", "gz_src_line", "gz_src_wav"][this.srcIdx];
		let args = ["out", this.srcBus, "gain", this.pvSrc.ingain];
		if (this.srcIdx === 0) args = args.concat(["tone", this.pvSrc.textone, "motion", this.pvSrc.texmot, "texLvl", this.pvSrc.texlvl]);
		if (this.srcIdx === 3) args = args.concat(["buf", BUF_SRC, "rate", this.pvSrc.wavrate, "wavLvl", this.pvSrc.wavlvl]);
		if (this.srcIdx === 1 || this.srcIdx === 2) await this._ensureMic();
		this.srcSyn = this.spawn(defName, args, this.groups.src);
		this.log("input source:", SRC_NAMES[this.srcIdx] + (this.srcIdx === 3 ? " (" + this.wavName + ")" : ""));
	}
	cycleSource() { this.startSource((this.srcIdx + 1) % 4); }

	async _ensureMic() {
		if (this._micStream) return;
		try {
			this._micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
			const ctx = this.sonic.audioContext;
			const src = ctx.createMediaStreamSource(this._micStream);
			// Feed the mic into scsynth's hardware input bus via the worklet's
			// input node (gz_src_mic/gz_src_line read hardware input channels).
			src.connect(this.sonic.node.input);
		} catch (err) {
			this.log("microphone access failed:", err.message);
		}
	}

	// grab / sampling (SHIFT+SOURCE, SHIFT+pad) — spec §1.1 gz_grab, §3.6
	grab(buf, offsetFrames, dur) {
		if (this.grabbing || buf == null) return;
		this.grabbing = true;
		this.spawn("gz_grab", ["in", this.srcBus, "buf", buf, "offset", offsetFrames, "dur", dur, "gain", 1], this.groups.src);
		this.log("sampling", dur.toFixed(2) + "s from", SRC_NAMES[this.srcIdx] + "...");
		setTimeout(() => { this.grabbing = false; this._onVoicesChanged && this._onVoicesChanged(); this.log("sampling done."); }, (dur + 0.15) * 1000);
	}
	grabForEngine() {
		if (this.engIdx === 0) { this.setFreeze(false); return; }
		if (this.engIdx === 1) { this.grab(BUF_SLOT[this.voiceSlot[this.voiceSel]], 0, this.pvSrc.grablen); return; }
		const pd = this.padP[this.bank][this.padSel];
		const buf = BUF_BANK[this.bank];
		const off = Math.floor(pd.start * this.sampleRate * 8);
		const dur = this.pvSrc.grablen;
		this.grab(buf, off, dur);
		pd.slen = clamp(dur * this.sampleRate / (this.sampleRate * 8), 0.002, 1);
	}

	// ---- file loading: decode in-browser, extract channel 0, upload mono ---
	async loadFileToBuffer(file, bufnum, onName) {
		const arr = await file.arrayBuffer();
		const ctx = this.sonic.audioContext;
		const audioBuf = await ctx.decodeAudioData(arr.slice(0));
		const chan0 = audioBuf.getChannelData(0);
		const n = chan0.length;
		this.sonic.send("/b_alloc", bufnum, n, 1);
		await this.sync();
		const CHUNK = 4096;
		for (let i = 0; i < n; i += CHUNK) {
			const end = Math.min(n, i + CHUNK);
			const vals = Array.from(chan0.subarray(i, end));
			this.sonic.send("/b_setn", bufnum, i, vals.length, ...vals);
		}
		await this.sync();
		if (onName) onName(file.name);
		this.log("loaded", file.name, "-> buffer", bufnum);
	}
	async loadFileToSource(file) {
		await this.loadFileToBuffer(file, BUF_SRC, (n) => { this.wavName = n; });
		this.wavFiles.push(file); this.wavIdx = this.wavFiles.length - 1;
		if (this.srcIdx === 3) await this.startSource(3);
	}
	async loadFileToSlot(slot, file) { await this.loadFileToBuffer(file, BUF_SLOT[slot]); this.refreshVoiceBufs(); }
	async loadFileToBank(bank, file) {
		await this.loadFileToBuffer(file, BUF_BANK[bank]);
		for (let p = 0; p < 8; p++) { this.padP[bank][p].start = p / 8; this.padP[bank][p].slen = 1 / 8; }
	}
	stepWav(delta) {
		if (this.wavFiles.length === 0) { this.log("no sound files loaded yet -- use Load File."); return; }
		this.wavIdx = ((this.wavIdx + delta) % this.wavFiles.length + this.wavFiles.length) % this.wavFiles.length;
		this.loadFileToSource(this.wavFiles[this.wavIdx]);
	}

	// -------------------------------------------------------- patch --------
	serializePatch() {
		return {
			version: 1,
			engIdx: this.engIdx, focus: this.focus, fxIdx: this.fxIdx, srcIdx: this.srcIdx,
			cloudMode: this.cloudMode, frz: this.frz,
			voiceSel: this.voiceSel, voiceSlot: this.voiceSlot.slice(),
			bank: this.bank, padSel: this.padSel,
			muted: this.muted.slice(), fxBypass: this.fxBypass.slice(),
			recArm: this.recArm, tempoBpm: this.bpm,
			keyRoot: this.keyRoot, keyScale: this.keyScale, keyBase: this.keyBase,
			pvClouds: { ...this.pvClouds },
			pvVoice: this.pvVoice.map((v) => ({ ...v })),
			pvSrc: { ...this.pvSrc },
			fxP: this.fxP.map((f) => ({ ...f })),
			padP: this.padP.map((bank) => bank.map((p) => ({ ...p }))),
			tracks: this.trk.map((t) => ({
				steps: t.steps.map((st) => ({ on: st.on, notes: st.notes.slice(), vel: st.vel, len: st.len, prob: st.prob, locks: { ...st.locks } })),
				length: t.length, div: t.div,
			})),
		};
	}
	applyPatch(p) {
		if (!p) return;
		this.engIdx = p.engIdx ?? 0; this.focus = p.focus ?? "eng"; this.fxIdx = p.fxIdx ?? 0;
		this.cloudMode = p.cloudMode ?? 0; this.frz = !!p.frz;
		this.voiceSel = p.voiceSel ?? 0; this.voiceSlot = p.voiceSlot ?? [0, 1];
		this.bank = p.bank ?? 0; this.padSel = p.padSel ?? 0;
		this.muted = p.muted ?? [false, false, false];
		this.fxBypass = p.fxBypass ?? [false, false, false, false];
		this.recArm = !!p.recArm; this.bpm = p.tempoBpm ?? 110;
		this.keyRoot = p.keyRoot ?? 0; this.keyScale = p.keyScale ?? 1; this.keyBase = p.keyBase ?? 48;
		if (p.pvClouds) Object.assign(this.pvClouds, p.pvClouds);
		if (p.pvVoice) p.pvVoice.forEach((v, i) => Object.assign(this.pvVoice[i], v));
		if (p.pvSrc) Object.assign(this.pvSrc, p.pvSrc);
		if (p.fxP) p.fxP.forEach((f, i) => Object.assign(this.fxP[i], f));
		if (p.padP) p.padP.forEach((bank, bi) => bank.forEach((pad, pi) => Object.assign(this.padP[bi][pi], pad)));
		if (p.tracks) p.tracks.forEach((t, i) => {
			this.trk[i].length = t.length; this.trk[i].div = t.div;
			t.steps.forEach((st, si) => { this.trk[i].steps[si] = { on: st.on, notes: st.notes.slice(), vel: st.vel, len: st.len, prob: st.prob, locks: { ...st.locks } }; });
		});
		// push everything to the running synths
		this.rebuildClouds(); this.rebuildVoices();
		SPECS_CLOUDS.forEach((sp, i) => this.pushParam(0, i, this.getParam(0, i)));
		for (let v = 0; v < 2; v++) { this.voiceSelTemp = this.voiceSel; this.voiceSel = v; SPECS_VOICE.forEach((sp, i) => this.pushParam(1, i, this.getParam(1, i))); }
		this.voiceSel = p.voiceSel ?? 0;
		SPECS_PAD.forEach((sp, i) => this.pushParam(2, i, this.getParam(2, i)));
		for (let slot = 0; slot < 4; slot++) { SPECS_FX[slot].forEach((sp, i) => this.setFxParam(slot, i, this.getFxParam(slot, i))); this.setFxBypass(slot, this.fxBypass[slot]); }
		for (let e = 0; e < 3; e++) this.setMute(e, this.muted[e]);
		this.startSource(this.srcIdx);
	}
}

// ============================================================================
// 4. Launchpad Pro controller — full grid-mode dispatch per spec §5.
// ============================================================================
class GZPad {
	constructor(gz) {
		this.gz = gz;
		this.lp = new Launchpad({
			onNote: (n, v) => this._onNote(n, v),
			onCC: (cc, v) => this._onCC(cc, v),
			onLost: () => { this.connected = false; this._onStatus && this._onStatus(); },
		});
		this.connected = false;
		this.padShift = false; this.padShiftGrace = 0;
		this.padHeld = {}; // idx -> {pitch,vel,t0,step,eng}
		this.padLatched = []; // {pitch,vel,t0,step,eng}
		this.padLatchMode = [false, false, false];
		this._ccLast = new Map();
		this._redrawScheduled = false;

		gz._onBlink = () => this.scheduleRedraw();
		gz._onSeqStep = () => this.scheduleRedraw();
		gz._onVoicesChanged = () => this.scheduleRedraw();
	}

	async connect() {
		const ok = await this.lp.connect();
		this.connected = ok;
		this._onStatus && this._onStatus();
		if (ok) this.scheduleRedraw();
		return ok;
	}
	async disconnect() {
		this.padAllKeysOff();
		await this.lp.disconnect();
		this.connected = false;
		this._onStatus && this._onStatus();
	}

	padShiftOn() { return this.padShift || performance.now() < this.padShiftGrace; }

	scheduleRedraw() {
		if (this._redrawScheduled) return;
		this._redrawScheduled = true;
		setTimeout(() => { this._redrawScheduled = false; this.redraw(); }, 30);
	}

	// ---------------------------------------------------------- key logic --
	// Ported from ~gz.padKeyDegree/~gz.padKeyPitch (granular_zero_sc.scd
	// lines 2793-2800): row 0 = top in this col/row convention, so the
	// degree count is measured from the BOTTOM row (7-row), one scale
	// length per row, root-aligned at the bottom-left pad.
	padKeyPitch(col, row) {
		const sc = SCALES[this.gz.keyScale];
		const idx = (7 - row) * sc.length + col;
		return this.gz.keyBase + this.gz.keyRoot + Math.floor(idx / sc.length) * 12 + sc[idx % sc.length];
	}
	padFindLatched(eng, val) { return this.padLatched.find((e) => e.eng === eng && e.pitch === val) || null; }
	padUnlatch(e) {
		this.padLatched = this.padLatched.filter((x) => x !== e);
		this.gz.stopVoice(e.eng, e.pitch);
		if (e.step != null) this.gz.recordLength(e.eng, e.step, performance.now() - e.t0);
	}
	padKeyUp(idx) {
		const h = this.padHeld[idx];
		if (h) {
			delete this.padHeld[idx];
			this.gz.stopVoice(h.eng, h.pitch);
			if (h.step != null) this.gz.recordLength(h.eng, h.step, (performance.now() - h.t0) / 1000);
		}
	}
	padKeysOffMomentary() { for (const idx of Object.keys(this.padHeld)) this.padKeyUp(idx); }
	padUnlatchEngine(eng) { this.padLatched.filter((e) => e.eng === eng).forEach((e) => this.padUnlatch(e)); }
	padAllKeysOff() { this.padKeysOffMomentary(); this.padLatched.slice().forEach((e) => this.padUnlatch(e)); }

	padKeyDown(col, row, vel) {
		const gz = this.gz;
		const eng = gz.engIdx;
		const idx = row * 8 + col;
		let val, ok = true;
		const latch = (this.padLatchMode[Math.min(eng, 2)] || this.padShiftOn()) && eng !== 2;
		if (eng === 2) {
			val = row * 8 + col;
			gz.setBank(row);
			gz.padSel = col;
			if (this.padShiftOn()) { gz.grabForEngine(); ok = false; }
		} else {
			val = this.padKeyPitch(col, row);
			if (val > 127) ok = false;
		}
		if (!ok) return;
		const already = this.padFindLatched(eng, val);
		if (already) { this.padUnlatch(already); return; }
		if (this.padHeld[idx]) return;
		const v = clamp(vel / 127, 0.05, 1);
		gz.trigger(eng, val, v);
		gz.lastVal[eng] = val;
		let step = null;
		if (gz.recArm) step = gz.recordNote(val, v);
		const rec = { pitch: val, vel: v, t0: performance.now(), step, eng };
		if (latch) this.padLatched.push(rec); else this.padHeld[idx] = rec;
	}

	_onNote(note, vel) {
		if (!(note >= 11 && note <= 88 && (note % 10) >= 1 && (note % 10) <= 8)) return;
		const col = (note % 10) - 1;
		const row = 7 - (Math.floor(note / 10) - 1);
		const gz = this.gz;
		if (vel > 0) {
			if (gz.focus !== "eng") {
				if (col < gz.gridCount()) gz.setGridNorm(col, (7 - row) / 7);
			} else if (gz.padMode === 0) {
				gz.stepPress(row * 8 + col);
			} else if (gz.padMode === 1) {
				if (col < gz.gridCount()) gz.setGridNorm(col, (7 - row) / 7);
			} else if (gz.padMode === 2) {
				if (gz.padScaleEdit) this._scalePick(col, row);
				else this.padKeyDown(col, row, vel);
			}
		} else {
			const idx = row * 8 + col;
			if (this.padHeld[idx]) this.padKeyUp(idx);
		}
		this.scheduleRedraw();
	}

	_scalePick(col, row) {
		const gz = this.gz;
		if (row === 0 || row === 1) { const i = row * 8 + col; if (i < 12) gz.setKeyRoot(i); }
		else if (row === 3 || row === 4) { const i = (row - 3) * 8 + col; if (i < SCALE_NAMES.length) gz.setKeyScale(i); }
	}

	_onCC(cc, val) {
		const gz = this.gz;
		if (cc === 80) {
			if (val > 0) { this.padShift = true; this.padShiftGrace = 0; }
			else { this.padShift = false; this.padShiftGrace = performance.now() + 250; }
			this.scheduleRedraw();
			return;
		}
		const last = this._ccLast.get(cc) || 0;
		const pressed = val > 0 && last === 0;
		this._ccLast.set(cc, val);
		if (!pressed) return;

		// right column: engines / source / effects
		if ([19, 29, 39, 49, 59, 69, 79, 89].includes(cc)) {
			const row = 7 - (Math.floor(cc / 10) - 1);
			if (row < 3) {
				if (this.padShiftOn()) gz.toggleMute(row);
				else { this.padKeysOffMomentary(); gz.selectEngine(row); }
			} else if (row === 3) {
				if (this.padShiftOn()) gz.grabForEngine();
				else { this.padKeysOffMomentary(); gz.selectSrc(); }
			} else {
				if (this.padShiftOn()) gz.toggleFxBypass(row - 4);
				else { this.padKeysOffMomentary(); gz.selectFx(row - 4); }
			}
		}
		// left column
		else if ([10, 20, 30, 40, 50, 60, 70, 80].includes(cc)) {
			const row = 7 - (Math.floor(cc / 10) - 1);
			if (row === 7) gz.toggleRecArm();
			else if (row >= 1 && row <= 4) {
				const maxPage = Math.floor((gz.specsFor(gz.engIdx).length - 1) / 8);
				gz.padPage = Math.min(row - 1, maxPage);
				if (gz.focus === "eng") gz.padMode = 1;
			} else if (row === 5) {
				if (gz.focus === "src") gz.stepWav(1);
				else if (gz.padMode === 2) { if (gz.engIdx === 2) gz.setBank(gz.bank + 1); else gz.keyBase = Math.min(108, gz.keyBase + 12); }
			} else if (row === 6) {
				if (gz.focus === "src") gz.stepWav(-1);
				else if (gz.padMode === 2) { if (gz.engIdx === 2) gz.setBank(gz.bank - 1); else gz.keyBase = Math.max(12, gz.keyBase - 12); }
			}
		}
		// top row
		else if (cc >= 91 && cc <= 98) {
			const eng = gz.engIdx;
			const n = cc - 91;
			if (n === 0) gz.addSteps(this.padShiftOn() ? 8 : 1, eng);
			else if (n === 1) gz.addSteps(this.padShiftOn() ? -8 : -1, eng);
			else if (n === 2) { if (this.padShiftOn()) gz.clrTrack(eng); else gz.delStep(); }
			else if (n === 3) { if (this.padShiftOn()) gz.toggleFreeze(); else gz.togglePlay(); }
			else if (n === 4) {
				if (!this.padShiftOn()) { this.padKeysOffMomentary(); gz.padScaleEdit = false; gz.focus = "eng"; gz.padMode = 0; }
				else gz.handleRnd();
			} else if (n === 5) {
				gz.focus = "eng"; gz.padMode = 2;
				if (this.padShiftOn()) { gz.padScaleEdit = !gz.padScaleEdit; if (gz.padScaleEdit) this.padKeysOffMomentary(); }
				else gz.padScaleEdit = false;
			} else if (n === 6) {
				if (this.padShiftOn()) gz.handleUndo();
				else { this.padKeysOffMomentary(); gz.padScaleEdit = false; gz.focus = "eng"; gz.padMode = 1; }
			} else if (n === 7) {
				const e = Math.min(eng, 2);
				if (this.padShiftOn()) { this.padLatchMode = [false, false, false]; this.padAllKeysOff(); }
				else { this.padLatchMode[e] = !this.padLatchMode[e]; if (!this.padLatchMode[e]) this.padUnlatchEngine(e); }
			}
		}
		// bottom row
		else if (cc >= 1 && cc <= 8) {
			if (this.padShiftOn()) gz.subPress(cc - 1);
		}
		this.scheduleRedraw();
	}

	// ---------------------------------------------------------- LED draw ---
	redraw() {
		if (!this.connected) return;
		const gz = this.gz;
		const set = (idx, c) => this.lp.setLed(idx, c);

		// 8x8 grid
		for (let row = 0; row < 8; row++) {
			for (let col = 0; col < 8; col++) {
				set(padGidx(col, row), this._gridColor(col, row));
			}
		}
		// right column
		for (let row = 0; row < 8; row++) set(padRight(row), this._rightColor(row));
		// left column
		for (let row = 0; row < 8; row++) set(padLeft(row), this._leftColor(row));
		// top row
		for (let col = 0; col < 8; col++) set(padTop(col), this._topColor(col));
		// bottom row
		for (let col = 0; col < 8; col++) set(padBottom(col), this._bottomColor(col));
	}

	_gridColor(col, row) {
		const gz = this.gz;
		if (gz.focus !== "eng") return this._faderColor(col, row, gz.focus === "src" ? GC.cSrc : GC.cFxFill);
		if (gz.padMode === 0) {
			const t = gz.trk[gz.engIdx];
			const i = row * 8 + col;
			if (i >= t.length) return GC.cOff;
			const st = t.steps[i];
			const sel = gz.selStep[gz.engIdx];
			if (gz.running && i === t.pos) return GC.cPlayhead;
			if (i === sel) return GC.cStepSel;
			if (!st.on) return GC.cDim;
			if (Object.keys(st.locks).length) return GC.cStepLock;
			if (st.notes.length > 1) return GC.cStepChord;
			return GC.cStepOn;
		}
		if (gz.padMode === 1) return this._faderColor(col, row, GC.cFill);
		// KEYS/PADS mode
		if (gz.engIdx === 2) {
			const base = GC.cEngine[2];
			const playing = [...gz.voices[2].keys()].some((v) => v === row * 8 + col);
			if (playing) return GC.cTip;
			if (row === gz.bank && col === gz.padSel) return GC.cStepSel;
			return row === gz.bank ? base : base.map((c) => Math.max(1, Math.round(c / 6)));
		}
		if (gz.padScaleEdit) {
			if (row === 0 || row === 1) { const i = row * 8 + col; if (i < 12) return i === gz.keyRoot ? GC.cEngine[gz.engIdx] : GC.cDim; return GC.cOff; }
			if (row === 3 || row === 4) { const i = (row - 3) * 8 + col; if (i < SCALE_NAMES.length) return i === gz.keyScale ? GC.cModeOn : GC.cModeOff; return GC.cOff; }
			return GC.cOff;
		}
		const pitch = this.padKeyPitch(col, row);
		if (pitch > 127) return GC.cOff;
		const base = GC.cEngine[gz.engIdx];
		const idx = row * 8 + col;
		if (this.padHeld[idx]) return GC.cTip;
		if (this.padFindLatched(gz.engIdx, pitch)) return GC.cKeyLatch;
		const sc = SCALES[gz.keyScale];
		const degree = (7 - row) * sc.length + col;
		const isRoot = (degree % sc.length) === 0;
		return isRoot ? base : base.map((c) => Math.max(1, Math.round(c / 5)));
	}

	_faderColor(col, row, fillColor) {
		const gz = this.gz;
		if (col >= gz.gridCount()) return GC.cOff;
		const n = gz.getGridNorm(col);
		const lvl = Math.round(n * 7);
		const fromBottom = 7 - row;
		if (fromBottom === lvl) return GC.cTip;
		return fromBottom < lvl ? fillColor : GC.cDim;
	}

	_rightColor(row) {
		const gz = this.gz;
		if (this.padShiftOn()) {
			if (row < 3) return gz.muted[row] ? GC.cMuteOn : GC.cMuteOff;
			if (row === 3) return GC.cGrab;
			return gz.fxBypass[row - 4] ? GC.cMuteOn : GC.cMuteOff;
		}
		if (row < 3) return gz.focus === "eng" && gz.engIdx === row ? GC.cEngine[row] : GC.cEngine[row].map((c) => Math.round(c / 4));
		if (row === 3) return gz.focus === "src" ? GC.cSrc : GC.cSrcDim;
		return gz.focus === "fx" && gz.fxIdx === row - 4 ? GC.cFx : GC.cFxDim;
	}

	_leftColor(row) {
		const gz = this.gz;
		if (row === 0) return this.padShiftOn() ? GC.cShiftOn : GC.cDim;
		if (row >= 1 && row <= 4) {
			const specCount = gz.specsFor(gz.engIdx).length;
			const maxPage = Math.floor((specCount - 1) / 8);
			const p = row - 1;
			if (p > maxPage) return GC.cOff;
			return p === gz.padPage ? GC.cPageOn : GC.cPageOff;
		}
		const live = gz.focus === "src" || (gz.focus === "eng" && gz.padMode === 2);
		if (row === 5 || row === 6) return live ? GC.cOctBtn : GC.cOff;
		if (row === 7) return gz.recArm ? GC.cRecOn : GC.cRecOff;
		return GC.cOff;
	}

	_topColor(col) {
		const gz = this.gz;
		const n = col;
		if (n === 0) return gz.trk[gz.engIdx].length < 64 ? GC.cOctBtn : GC.cOff;
		if (n === 1) return gz.trk[gz.engIdx].length > 1 ? GC.cOctBtn : GC.cOff;
		if (n === 2) return this.padShiftOn() ? GC.cWarn : (gz.selStep[gz.engIdx] != null ? GC.cStepSel : GC.cDim);
		if (n === 3) return gz.running ? (gz.padBlinkOn ? GC.cPlayOn : GC.cPlayDim) : GC.cPlayOff;
		if (n === 4) return this.padShiftOn() ? GC.cFill : (gz.focus === "eng" && gz.padMode === 0 ? GC.cModeOn : GC.cModeOff);
		if (n === 5) return gz.padScaleEdit ? GC.cStepSel : (gz.focus === "eng" && gz.padMode === 2 ? GC.cModeOn : GC.cModeOff);
		if (n === 6) return gz.focus === "eng" && gz.padMode === 1 ? GC.cModeOn : GC.cModeOff;
		if (n === 7) return gz.frz ? GC.cFrzOn : (this.padLatchMode[Math.min(gz.engIdx, 2)] ? GC.cHoldOn : GC.cHoldOff);
		return GC.cOff;
	}

	_bottomColor(col) {
		const gz = this.gz;
		if (this.padShiftOn()) {
			const count = gz.subCount();
			if (col >= count) return GC.cOff;
			return gz.subActive(col) ? GC.cTip : GC.cFill;
		}
		const t = gz.trk[gz.engIdx];
		if (!gz.running) return GC.cDim;
		const cell = Math.floor((t.pos / Math.max(1, t.length)) * 8);
		return col === cell ? GC.cPlayhead : GC.cDim;
	}
}

// ============================================================================
// 5. UI builder — plain DOM, styled by css/granular.css.
// ============================================================================
function el(tag, props = {}, children = []) {
	const e = document.createElement(tag);
	for (const [k, v] of Object.entries(props)) {
		if (k === "class") e.className = v;
		else if (k === "text") e.textContent = v;
		else if (k.startsWith("on") && typeof v === "function") e.addEventListener(k.slice(2), v);
		else if (v !== undefined && v !== null) e.setAttribute(k, v);
	}
	for (const c of [].concat(children)) if (c) e.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
	return e;
}

function fmtVal(sp, v) {
	if (sp.unit === "ct" || sp.unit === "st") return v.toFixed(0) + sp.unit;
	if (sp.unit === "Hz") return v >= 1000 ? (v / 1000).toFixed(2) + "k" : v.toFixed(0) + "Hz";
	if (sp.unit === "bit" || sp.unit === ":1") return v.toFixed(0) + sp.unit;
	if (sp.max - sp.min > 4) return v.toFixed(2) + sp.unit;
	return v.toFixed(2) + sp.unit;
}

function buildUI(root, gz, pad) {
	root.innerHTML = "";
	const gzr = el("div", { id: "gz-root" });
	root.appendChild(gzr);

	// ---------------------------------------------------------- transport --
	const transport = el("div", { id: "gz-transport" });
	const playBtn = el("button", { text: "PLAY", onclick: () => { gz.togglePlay(); refreshAll(); } });
	const tempoIn = el("input", { type: "number", min: 20, max: 300, value: gz.bpm, onchange: (e) => gz.setTempo(+e.target.value) });
	const recBtn = el("button", { text: "REC", class: "danger", onclick: () => { gz.toggleRecArm(); refreshAll(); } });
	const frzBtn = el("button", { text: "FREEZE", onclick: () => { gz.toggleFreeze(); refreshAll(); } });
	const sampleBtn = el("button", { text: "SAMPLE", title: "grab live input into the focused engine's buffer", onclick: () => gz.grabForEngine() });
	const volIn = el("input", { type: "range", min: 0, max: 1.5, step: 0.01, value: gz.getFxParam(3, 6), oninput: (e) => gz.setFxParam(3, 6, +e.target.value) });
	const meterInBar = el("div", { class: "gz-meter" }, [el("i")]);
	const meterOutBar = el("div", { class: "gz-meter" }, [el("i")]);
	const lpDot = el("span", { class: "dot" });
	const lpStatus = el("div", { id: "gz-launchpad-status" }, [lpDot, el("span", { text: "Launchpad: not connected" })]);
	const lpBtn = el("button", { text: "Connect Launchpad", onclick: async () => {
		lpBtn.disabled = true; lpBtn.textContent = "Connecting…";
		const ok = await pad.connect();
		lpBtn.disabled = false; lpBtn.textContent = ok ? "Reconnect" : "Connect Launchpad";
		refreshAll();
	} });

	transport.append(
		playBtn,
		el("label", { text: "BPM" }), tempoIn,
		recBtn, frzBtn, sampleBtn,
		el("label", { text: "VOL" }), volIn,
		el("label", { text: "IN" }), meterInBar,
		el("label", { text: "OUT" }), meterOutBar,
		el("div", { class: "grow" }),
		lpStatus, lpBtn,
	);
	gzr.appendChild(transport);

	const body = el("div", { id: "gz-body" });
	const main = el("div", { id: "gz-main" });
	const side = el("div", { id: "gz-side" });
	body.append(main, side);
	gzr.appendChild(body);

	// ---------------------------------------------------------- engines ----
	const engPanel = el("div", { class: "gz-panel" });
	engPanel.appendChild(el("h3", { text: "Engine" }));
	const engRow = el("div", { id: "gz-engines" });
	ENG_NAMES.forEach((name, i) => {
		const wrap = el("div", { class: "eng-btn-wrap" });
		const dot = el("span", { class: "mute-dot" });
		const btn = el("button", { class: "eng-btn", onclick: (e) => { if (e.shiftKey) { gz.toggleMute(i); } else { gz.selectEngine(i); } refreshAll(); } });
		btn.append(el("b", { text: name }), dot);
		// Explicit, always-visible mute toggle -- shift+click on the engine
		// button above still works as a shortcut, but that gesture isn't
		// discoverable with a mouse alone, so give it a real button too.
		const muteBtn = el("button", {
			class: "eng-mute-btn", text: "M",
			title: "Mute " + name,
			onclick: (e) => { e.stopPropagation(); gz.toggleMute(i); refreshAll(); },
		});
		wrap.append(btn, muteBtn);
		engRow.appendChild(wrap);
	});
	engPanel.appendChild(engRow);
	const engCtrlRow = el("div", { class: "gz-row wrap", id: "gz-eng-ctrl" });
	engPanel.appendChild(engCtrlRow);
	main.appendChild(engPanel);

	// ---------------------------------------------------------- params -----
	const paramPanel = el("div", { class: "gz-panel" });
	const paramTitle = el("h3", { text: "Parameters" });
	const rndRow = el("div", { class: "gz-row" });
	const rndBtn = el("button", { text: "RND", onclick: () => { gz.handleRnd(); refreshAll(); } });
	const undoBtn = el("button", { text: "UNDO RND", onclick: () => { gz.handleUndo(); refreshAll(); } });
	rndRow.append(rndBtn, undoBtn);
	paramPanel.append(paramTitle, rndRow);
	const sliderGrid = el("div", { class: "gz-sliders" });
	paramPanel.appendChild(sliderGrid);
	main.appendChild(paramPanel);

	// ---------------------------------------------------------- sequencer --
	const seqPanel = el("div", { class: "gz-panel" });
	seqPanel.appendChild(el("h3", { text: "Sequencer (per-engine track)" }));
	const seqCtrl = el("div", { class: "gz-row wrap" });
	const lenIn = el("input", { type: "number", min: 1, max: 64, style: "width:56px" });
	const divSel = el("select", {}, DIV_NAMES.map((n, i) => el("option", { value: i, text: n })));
	const rndTrackBtn = el("button", { text: "RND FILL", onclick: () => { gz.rndTrack(gz.engIdx); refreshAll(); } });
	const clrTrackBtn = el("button", { text: "CLR TRACK", onclick: () => { gz.clrTrack(gz.engIdx); refreshAll(); } });
	const delStepBtn = el("button", { text: "DEL STEP", onclick: () => { gz.delStep(); refreshAll(); } });
	lenIn.addEventListener("change", () => { const t = gz.trk[gz.engIdx]; t.length = clamp(+lenIn.value | 0, 1, 64); refreshAll(); });
	divSel.addEventListener("change", () => { gz.trk[gz.engIdx].div = +divSel.value; refreshAll(); });
	seqCtrl.append(
		el("label", { text: "length" }), lenIn,
		el("label", { text: "div" }), divSel,
		rndTrackBtn, clrTrackBtn, delStepBtn,
	);
	seqPanel.appendChild(seqCtrl);
	const stepGrid = el("div", { class: "gz-steps" });
	seqPanel.appendChild(stepGrid);
	const stepInfo = el("div", { class: "gz-hint" });
	seqPanel.appendChild(stepInfo);
	main.appendChild(seqPanel);

	// ---------------------------------------------------------- source -----
	const srcPanel = el("div", { class: "gz-panel" });
	srcPanel.appendChild(el("h3", { text: "Input Source" }));
	const srcSel = el("div", { class: "gz-row gz-subpicker" });
	SRC_NAMES.forEach((n, i) => srcSel.appendChild(el("button", { text: n, onclick: () => { gz.startSource(i); refreshAll(); } })));
	srcPanel.appendChild(srcSel);
	const fileRow = el("div", { class: "gz-row" });
	const fileIn = el("input", { type: "file", accept: "audio/*" });
	fileIn.addEventListener("change", async () => { if (fileIn.files[0]) { await gz.loadFileToSource(fileIn.files[0]); refreshAll(); } });
	const wavLabel = el("span", { class: "gz-hint", text: gz.wavName });
	fileRow.append(fileIn, wavLabel);
	srcPanel.appendChild(fileRow);
	const srcSliders = el("div", { class: "gz-sliders" });
	srcPanel.appendChild(srcSliders);
	side.appendChild(srcPanel);

	// ---------------------------------------------------------- fx --------
	const fxPanel = el("div", { class: "gz-panel" });
	fxPanel.appendChild(el("h3", { text: "FX chain" }));
	const fxBoxes = [];
	FX_NAMES.forEach((name, slot) => {
		const box = el("div", { class: "gz-fxbox" });
		const byp = el("button", { text: "BYPASS", onclick: () => { gz.toggleFxBypass(slot); refreshAll(); } });
		box.appendChild(el("h4", {}, [el("span", { text: name }), byp]));
		const sliders = el("div", { class: "gz-sliders" });
		box.appendChild(sliders);
		fxBoxes.push({ box, byp, sliders });
		fxPanel.appendChild(box);
	});
	side.appendChild(fxPanel);

	// ---------------------------------------------------------- patch -----
	const patchPanel = el("div", { class: "gz-panel" });
	patchPanel.appendChild(el("h3", { text: "Patch" }));
	const nameIn = el("input", { type: "text", placeholder: "patch name", style: "width:100%;margin-bottom:6px" });
	const patchBtns = el("div", { class: "gz-row" });
	const saveBtn = el("button", { text: "Save", onclick: () => {
		const name = nameIn.value.trim() || "untitled";
		savePatch("granular", name, gz.serializePatch());
		refreshPatchList();
	} });
	const exportBtn = el("button", { text: "Export", onclick: () => {
		const blob = exportAzpatchBlob(gz.serializePatch());
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a"); a.href = url; a.download = (nameIn.value.trim() || "granular_patch") + ".azpatch.json";
		document.body.appendChild(a); a.click(); a.remove();
		setTimeout(() => URL.revokeObjectURL(url), 5000);
	} });
	const importIn = el("input", { type: "file", accept: "application/json", style: "display:none" });
	importIn.addEventListener("change", async () => {
		if (!importIn.files[0]) return;
		const data = await importAzpatchFile(importIn.files[0]);
		gz.applyPatch(data);
		refreshAll();
	});
	const importBtn = el("button", { text: "Import", onclick: () => importIn.click() });
	const qrBtn = el("button", { text: "Share via QR", onclick: () => showQrModal(gz) });
	patchBtns.append(saveBtn, exportBtn, importBtn, importIn, qrBtn);
	patchPanel.append(nameIn, patchBtns);
	const patchList = el("div", { class: "gz-patch-list" });
	patchPanel.appendChild(patchList);
	side.appendChild(patchPanel);

	function refreshPatchList() {
		patchList.innerHTML = "";
		for (const name of listPatches("granular")) {
			const row = el("div", { class: "row" });
			row.append(
				el("span", { text: name }),
				el("span", {}, [
					el("button", { text: "Load", onclick: () => { const p = loadPatch("granular", name); gz.applyPatch(p); refreshAll(); } }),
					el("button", { text: "Del", onclick: () => { deletePatch("granular", name); refreshPatchList(); } }),
				]),
			);
			patchList.appendChild(row);
		}
	}

	async function showQrModal(gzEngine) {
		const backdrop = el("div", { class: "gz-modal-backdrop", onclick: (e) => { if (e.target === backdrop) backdrop.remove(); } });
		const modal = el("div", { class: "gz-modal" });
		modal.appendChild(el("div", { text: "Preparing share link…" }));
		backdrop.appendChild(modal);
		document.body.appendChild(backdrop);
		try {
			const url = await buildShareUrl("granular", gzEngine.serializePatch());
			modal.innerHTML = "";
			modal.appendChild(el("div", { text: "Scan to load this patch:" }));
		const qrHolder = el("div");
		modal.appendChild(qrHolder);
		const linkRow = el("div", { class: "gz-hint", text: url });
		modal.appendChild(linkRow);
			const copyBtn = el("button", { text: "Copy link", onclick: async () => {
				try { await navigator.clipboard.writeText(url); copyBtn.textContent = "Copied"; }
				catch { linkRow.textContent = url; }
			} });
			modal.appendChild(copyBtn);
		modal.appendChild(el("button", { text: "Close", onclick: () => backdrop.remove() }));
		renderShareQr(qrHolder, url);
		} catch (error) {
			modal.innerHTML = "";
			modal.appendChild(el("div", { text: "Could not create QR: " + error.message }));
			modal.appendChild(el("button", { text: "Close", onclick: () => backdrop.remove() }));
		}
	}

	// ---------------------------------------------------------- log -------
	const logPanel = el("div", { class: "gz-panel" });
	logPanel.appendChild(el("h3", { text: "Log" }));
	const logEl = el("div", { class: "gz-log" });
	logPanel.appendChild(logEl);
	side.appendChild(logPanel);
	gz._onLog = () => { logEl.textContent = (gz._logLines || []).join("\n"); logEl.scrollTop = logEl.scrollHeight; };

	// ============================================================ redraw ===
	function buildSlider(specs, eng, idx, getVal, setVal, lockedIds) {
		const sp = specs[idx];
		const wrap = el("div", { class: "gz-slider" });
		if (lockedIds && lockedIds.has(sp.id)) wrap.classList.add("locked");
		const lbl = el("div", { class: "lbl" }, [el("span", { text: sp.label }), el("b", { text: fmtVal(sp, getVal()) })]);
		const input = el("input", { type: "range", min: sp.min, max: sp.max, step: (sp.max - sp.min) / 500 || 0.001, value: getVal() });
		input.addEventListener("input", () => { setVal(+input.value); lbl.lastChild.textContent = fmtVal(sp, +input.value); });
		wrap.append(lbl, input);
		return wrap;
	}

	function refreshEngineCtrl() {
		engCtrlRow.innerHTML = "";
		if (gz.engIdx === 0) {
			CLOUD_MODES.forEach((m, i) => engCtrlRow.appendChild(el("button", { text: m, class: i === gz.cloudMode ? "on" : "", onclick: () => { gz.setCloudMode(i); refreshAll(); } })));
		} else if (gz.engIdx === 1) {
			["A", "B"].forEach((v, i) => engCtrlRow.appendChild(el("button", { text: "VOICE " + v, class: i === gz.voiceSel ? "on" : "", onclick: () => { gz.voiceSel = i; refreshAll(); } })));
			engCtrlRow.appendChild(el("span", { text: "slot" }));
			[0, 1, 2, 3].forEach((s) => engCtrlRow.appendChild(el("button", { text: "S" + (s + 1), class: s === gz.voiceSlot[gz.voiceSel] ? "on" : "", onclick: () => { gz.setVoiceSlot(gz.voiceSel, s); refreshAll(); } })));
			const loadSlot = el("input", { type: "file", accept: "audio/*" });
			loadSlot.addEventListener("change", async () => { if (loadSlot.files[0]) { await gz.loadFileToSlot(gz.voiceSlot[gz.voiceSel], loadSlot.files[0]); refreshAll(); } });
			engCtrlRow.appendChild(loadSlot);
		} else {
			for (let b = 0; b < 8; b++) engCtrlRow.appendChild(el("button", { text: "BANK " + (b + 1), class: b === gz.bank ? "on" : "", onclick: () => { gz.setBank(b); refreshAll(); } }));
			const loadBank = el("input", { type: "file", accept: "audio/*" });
			loadBank.addEventListener("change", async () => { if (loadBank.files[0]) { await gz.loadFileToBank(gz.bank, loadBank.files[0]); refreshAll(); } });
			engCtrlRow.appendChild(loadBank);
			const padRow = el("div", { class: "gz-row wrap" });
			for (let p = 0; p < 8; p++) padRow.appendChild(el("button", {
				text: "PAD " + (p + 1),
				class: p === gz.padSel ? "on" : "",
				onclick: (e) => { gz.padSel = p; if (!e.shiftKey) gz.trigger(2, gz.bank * 8 + p, 0.9); refreshAll(); },
			}));
			engCtrlRow.appendChild(padRow);
		}
	}

	function refreshParams() {
		sliderGrid.innerHTML = "";
		const specs = gz.specsFor(gz.engIdx);
		const sel = gz.selStep[gz.engIdx];
		const lockedIds = sel != null ? new Set(Object.keys(gz.trk[gz.engIdx].steps[sel].locks)) : null;
		specs.forEach((sp, i) => {
			if (sp.arg === "lang" && sp.id !== "rnd" && sp.id !== "prob") return;
			sliderGrid.appendChild(buildSlider(specs, gz.engIdx, i,
				() => gz.getParam(gz.engIdx, i),
				(v) => { gz.editParam(gz.engIdx, i, v); refreshParams(); pad.scheduleRedraw(); },
				lockedIds));
		});
	}

	function refreshSrc() {
		[...srcSel.children].forEach((btn, i) => btn.classList.toggle("on", i === gz.srcIdx));
		wavLabel.textContent = gz.wavName;
		srcSliders.innerHTML = "";
		SPECS_SRC.forEach((sp, i) => {
			srcSliders.appendChild(buildSlider(SPECS_SRC, -1, i, () => gz.getSrcParam(i), (v) => { gz.setSrcParam(i, v); refreshSrc(); }));
		});
	}

	function refreshFx() {
		fxBoxes.forEach(({ byp, sliders }, slot) => {
			byp.classList.toggle("on", gz.fxBypass[slot]);
			sliders.innerHTML = "";
			SPECS_FX[slot].forEach((sp, i) => {
				sliders.appendChild(buildSlider(SPECS_FX[slot], -1, i, () => gz.getFxParam(slot, i), (v) => { gz.setFxParam(slot, i, v); refreshFx(); }));
			});
		});
	}

	function refreshSeq() {
		lenIn.value = gz.trk[gz.engIdx].length;
		divSel.value = gz.trk[gz.engIdx].div;
		stepGrid.innerHTML = "";
		const t = gz.trk[gz.engIdx];
		for (let i = 0; i < 64; i++) {
			const st = t.steps[i];
			const b = el("button", { class: "step" });
			if (i >= t.length) b.classList.add("off-range");
			if (st.on) b.classList.add("on");
			if (Object.keys(st.locks).length) b.classList.add("locked");
			if (st.notes.length > 1) b.classList.add("chord");
			if (i === gz.selStep[gz.engIdx]) b.classList.add("sel");
			if (gz.running && i === t.pos) b.classList.add("playing");
			b.addEventListener("click", (e) => {
				if (e.shiftKey) gz.deleteStepAt(i);
				else { gz.stepPress(i); refreshParams(); }
				refreshSeq(); pad.scheduleRedraw();
			});
			stepGrid.appendChild(b);
		}
		const sel = gz.selStep[gz.engIdx];
		stepInfo.textContent = sel != null
			? `step ${sel + 1}: notes=${t.steps[sel].notes.join(",")} vel=${t.steps[sel].vel.toFixed(2)} len=${t.steps[sel].len.toFixed(2)} prob=${t.steps[sel].prob.toFixed(2)} locks=${Object.keys(t.steps[sel].locks).length}`
			: "no step selected";
	}

	function refreshTransport() {
		playBtn.textContent = gz.running ? "STOP" : "PLAY";
		playBtn.classList.toggle("on", gz.running);
		recBtn.classList.toggle("on", gz.recArm);
		frzBtn.classList.toggle("on", gz.frz);
		tempoIn.value = gz.bpm;
		meterInBar.firstChild.style.width = (dbToUnit(gz.meterIn) * 100) + "%";
		meterOutBar.firstChild.style.width = (dbToUnit(gz.meterOut) * 100) + "%";
		lpDot.classList.toggle("on", pad.connected);
		lpStatus.lastChild.textContent = "Launchpad: " + (pad.connected ? "connected" : "not connected");
	}

	function refreshEngines() {
		[...engRow.children].forEach((wrap, i) => {
			const btn = wrap.querySelector(".eng-btn");
			const muteBtn = wrap.querySelector(".eng-mute-btn");
			btn.classList.toggle("focused", gz.focus === "eng" && gz.engIdx === i);
			btn.querySelector(".mute-dot").classList.toggle("muted", gz.muted[i]);
			muteBtn.classList.toggle("active", gz.muted[i]);
		});
	}

	function refreshAll() {
		refreshTransport();
		refreshEngines();
		refreshEngineCtrl();
		refreshParams();
		refreshSeq();
		refreshSrc();
		refreshFx();
		pad.scheduleRedraw();
	}

	gz._onMeter = () => { meterInBar.firstChild.style.width = (dbToUnit(gz.meterIn) * 100) + "%"; meterOutBar.firstChild.style.width = (dbToUnit(gz.meterOut) * 100) + "%"; };
	pad._onStatus = () => refreshTransport();
	gz._onSeqStep = (() => { const orig = gz._onSeqStep; return () => { orig && orig(); refreshSeq(); }; })();
	gz._onVoicesChanged = (() => { const orig = gz._onVoicesChanged; return () => { orig && orig(); }; })();

	setInterval(() => refreshTransport(), 250);

	refreshPatchList();
	refreshAll();

	// window.gz debug console mirror (spec §7: "everything reachable from the
	// console" — cheap to preserve here too).
	window.gz = gz;
	window.gzPad = pad;
}

// ============================================================================
// 6. mount()
// ============================================================================
function ensureCss() {
	if (document.querySelector('link[data-gz-css]')) return;
	const link = document.createElement("link");
	link.rel = "stylesheet";
	link.href = new URL("../../css/granular.css", import.meta.url).href;
	link.setAttribute("data-gz-css", "1");
	document.head.appendChild(link);
}

export async function mount(panel, gate, audioContext) {
	ensureCss();

	const sonic = await bootEngine({ synthdefDir: "granular", audioContext });
	if (gate && gate.parentNode) gate.remove();

	const gz = new GZEngine(sonic);
	await gz.boot();

	const pad = new GZPad(gz);

	buildUI(panel, gz, pad);

	// Deep-link patch load (spec §4): ?patch=...&inst=granular
	const fromUrl = await readPatchFromUrl();
	if (fromUrl && fromUrl.instrument === "granular" && fromUrl.data) {
		gz.applyPatch(fromUrl.data);
	}

	// Launchpad is the primary surface for this instrument — connect in the
	// background so the page is usable immediately even if no device is
	// plugged in (feature-detect per spec §7).
	if (navigator.requestMIDIAccess) {
		pad.connect().catch((err) => console.warn("Launchpad connect failed:", err));
	} else {
		gz.log("Web MIDI not available in this browser -- GUI-only control.");
	}

	window.addEventListener("beforeunload", () => { pad.disconnect(); });

	async function teardown() {
		await pad.disconnect();
		gz.allOff();
		await teardownEngine(sonic);
	}
	panel._gzTeardown = teardown; // kept for back-compat with any direct callers
	window.__granularApp = { gz, pad, teardown };
	return { gz, pad, teardown };
}
