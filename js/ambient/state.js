import { defaultLayerParams, slotDefaults, GLITCH_PERC_BASE_DEFAULTS } from "./data.js";
import { newTrack } from "./sequencer.js";

export function createState() {
	return {
		layerSel: 0,
		structure: [0, 2, 4, 7],
		curWave: [-1, -1, -1],
		noiseSrc: 0,
		grainSrc: 0, // 0 = recorded/mic buffer, 1 = user WAV buffer
		usrChans: 0, // 0 = no WAV FILE sample loaded yet
		muted: [false, false, false, false],
		maxVoices: 6,
		tempoBpm: 120,
		vol: 0.5,
		lp: [defaultLayerParams(0), defaultLayerParams(1), defaultLayerParams(2), defaultLayerParams(3)],
		slotType: [0, 1, 3],
		slotParams: [slotDefaults(0), slotDefaults(1), slotDefaults(3)],
		revShimParams: { active: 1, size: 0.7, decay: 0.72, damp: 0.35, shimmer: 0.3, mix: 1.0 },
		masterParams: { active: 1, threshold: 0.15, ratio: 4, attack: 0.01, release: 0.15, makeup: 1, ceiling: 0.95 },
		keyRoot: 0, keyScale: 1, padKeyBase: 36,
		seqNote: [60, 60, 60, 60], // persistent note selector value per sequencer layer
		seq: Array.from({ length: 4 }, () => Object.assign(newTrack(), { selectedStep: null })),
		playing: false,
		controlView: 0, // 0 = sequencer, 1 = Launchpad grid
		recArm: false,
		lockSpecId: "cutoff",
		currentPatchName: "untitled",
		glitchBases: GLITCH_PERC_BASE_DEFAULTS.map((base) => ({ ...base })),

		// Launchpad-only transient UI state (spec §10.2)
		padMode: 0, // 0=STEP 1=PARAM 2=KEYS
		padFocus: "eng", // "eng" | "fx"
		padFx: 0, // 0-2 = fx slots, 3 = revshim
		padPage: 0,
		padShift: false,
		padLatchMode: [false, false, false, false],
		padArp: Array.from({ length: 4 }, () => ({ enabled: false, way: 0, octaves: 1, rate: 8 })),
		padScaleEdit: false,
		padHeld: new Map(), // gridIndex -> {layer,note}
		padLatched: [], // {layer,note}
		padLengthHold: null, // { direction: -1|1, button: 91|92, used: boolean }
	};
}
