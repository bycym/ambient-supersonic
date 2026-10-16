// ambient_zero_sc web port — top-level module. See
// supercollider_standalone/webport/spec_ambient_zero.md for the full spec
// this implements, and ambient_engine.scd (line numbers cross-referenced in
// the spec) for ground truth on anything ambiguous.
//
// Architecture (spec §10.7's "single set of state-mutating functions" rule):
//   state.js        — the AZ state object (Appendix A shape)
//   data.js         — static spec tables (specs, slot types, LED palette, ...)
//   wavetables.js   — client-side ~az.tableFor / asWavetable port (spec §4)
//   engine.js       — OSC wiring: buses/groups/buffers/voices/FX (spec §1-§2,§5-§6)
//   sequencer.js    — lookahead tempo-locked step scheduler (spec §7)
//   actions.js      — central mutators shared by GUI + Launchpad (spec §10.7)
//   launchpad-map.js— Launchpad Pro button/LED semantics (spec §10)
//   gui.js          — plain-DOM UI (spec §9)
//   patch.js        — serialize/save/load/export/QR (spec §8)

import { bootEngine, teardownEngine } from "../shared/supersonic-loader.js";
import { createEngine } from "./engine.js";
import { createState } from "./state.js";
import { createActions } from "./actions.js";
import { createSequencer } from "./sequencer.js";
import { createLaunchpadController } from "./launchpad-map.js";
import { buildGui } from "./gui.js";
import * as PatchMod from "./patch.js";
import { slotDefaults } from "./data.js";

function ensureCss() {
	if (document.querySelector('link[data-az-css]')) return;
	const link = document.createElement("link");
	link.rel = "stylesheet";
	link.href = new URL("../../css/ambient.css", import.meta.url).href;
	link.dataset.azCss = "1";
	document.head.appendChild(link);
}

export async function mount(panel, gate, audioContext) {
	let sonic = null;
	let mountedTeardown = null;
	try {
	ensureCss();

	sonic = await bootEngine({ synthdefDir: "ambient", audioContext,
		scsynthOptions: { numOutputBusChannels: 18 }, autoConnect: false });
	const splitter = sonic.audioContext.createChannelSplitter(18);
	const masterNode = sonic.audioContext.createChannelMerger(2);
	sonic.node.connect(splitter);
	splitter.connect(masterNode, 0, 0);
	splitter.connect(masterNode, 1, 1);
	masterNode.connect(sonic.audioContext.destination);
	const engine = createEngine(sonic, { outputChannels: 18, masterNode });
	await engine.init();

	const state = createState();

	await engine.initFixedSynths({ revShim: state.revShimParams, master: state.masterParams, pump: state.pumpParams, bpm: state.tempoBpm });
	engine.setMaxVoices(state.maxVoices);
	for (let i = 0; i < 3; i++) {
		await engine.setSlotType(i, state.slotType[i]);
		state.slotParams[i] = slotDefaults(state.slotType[i]);
		for (const k in state.slotParams[i]) engine.setSlotParam(i, k, state.slotParams[i][k]);
	}
	// default wavetable content for the 3 tonal layers (wave 0 = "GLAS")
	for (let layer = 0; layer < 3; layer++) {
		await engine.loadWave(layer, 0);
		state.curWave[layer] = 0;
	}

	let gui = null;
	let launchpad = null;
	function refreshAll() {
		gui && gui.refresh();
		launchpad && launchpad.scheduleRefresh();
	}

	const sequencer = createSequencer({
		audioContext: sonic.audioContext,
		engine,
		tracks: state.seq, // same array the GUI/actions read+write -- see sequencer.js comment
		getLayerState: (layer) => ({ lp: state.lp[layer], structure: state.structure[layer], noiseSrc: state.noiseSrc, muted: state.muted[layer] }),
		onStep: () => refreshAll(),
	});
	sequencer.setTempo(state.tempoBpm);

	const actions = createActions({ state, engine, sequencer, refresh: refreshAll });

	launchpad = createLaunchpadController({ state, actions, sequencer, engine, onConnectionChange: () => gui && gui.refresh() });

	gui = buildGui({ panel, state, actions, engine, sequencer, launchpad, audioContext: sonic.audioContext, stemSource: sonic.node });

	if (gate && gate.parentNode) gate.remove();

	// Deep-link patch load (spec: "On mount, call readPatchFromUrl() first...")
	const fromUrl = await PatchMod.readPatchFromUrl();
	if (fromUrl && fromUrl.instrument === "ambient" && fromUrl.data) {
		await PatchMod.applyPatch(state, fromUrl.data, { engine, sequencer, refreshAll });
	} else {
		refreshAll();
	}

	// Launchpad is optional — connect in the background, never block the GUI.
	launchpad.connect().catch((err) => console.warn("Launchpad connect failed:", err));

	// Simple output-level meter (spec §11 item 8's AnalyserNode fallback —
	// SendReply->JS bridging from az_master_complim's meter isn't relied on
	// here since it's unverified against this SuperSonic build; see report).
	let meterTimer = null;
	if (sonic.audioContext && sonic.node) {
		try {
			const analyser = sonic.audioContext.createAnalyser();
			analyser.fftSize = 1024;
			masterNode.connect(analyser);
			const buf = new Float32Array(analyser.fftSize);
			meterTimer = setInterval(() => {
				analyser.getFloatTimeDomainData(buf);
				let sum = 0;
				for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
				const rms = Math.sqrt(sum / buf.length);
				const db = rms > 0 ? 20 * Math.log10(rms) : -Infinity;
				for (const meter of gui.meterEls || [gui.meterEl]) meter.textContent = "out: " + (isFinite(db) ? db.toFixed(1) : "-inf") + " dB";
			}, 150);
		} catch (err) {
			console.warn("Meter analyser setup failed:", err);
		}
	}

	async function teardown() {
		gui?.dispose?.();
		if (gui?.stopExport) await gui.stopExport();
		if (meterTimer) clearInterval(meterTimer);
		sequencer.stop();
		sequencer.setMetronome(false);
		await launchpad.disconnect().catch(() => {});
		engine.teardown();
		masterNode.disconnect();
		sonic.node.disconnect(splitter);
		await teardownEngine(sonic);
	}
	mountedTeardown = teardown;

	window.__ambientApp = { state, engine, actions, sequencer, launchpad, gui, teardown };
	return { state, engine, actions, sequencer, launchpad, gui, teardown };
	} catch (err) {
		if (mountedTeardown) await mountedTeardown().catch(() => {});
		else if (sonic) await teardownEngine(sonic);
		throw err;
	}
}
