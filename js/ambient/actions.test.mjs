import test from "node:test";
import assert from "node:assert/strict";
import { createState } from "./state.js";
import { createActions } from "./actions.js";

function makeHarness() {
	const state = createState();
	const engine = {
		layerOff() {},
		setMaxVoices() {},
		setVol() {},
		setGrainSource() {},
		noteOn() {},
		noteOff() {},
		setSlotParam() {},
		setRevShimParam() {},
		setMasterParam() {},
	};
	const sequencer = { setTempo() {}, stepDurSeconds() { return 1; } };
	return { state, actions: createActions({ state, engine, sequencer, refresh() {} }) };
}

test("layer parameter writes require REC and selected step", () => {
	const { state, actions } = makeHarness();
	const before = state.lp[0].cut;
	actions.setLayerParam(0, "cutoff", 1200);
	assert.equal(state.lp[0].cut, before);
	state.recArm = true;
	actions.setLayerParam(0, "cutoff", 1200);
	assert.equal(state.lp[0].cut, before);
	state.seq[0].selectedStep = 0;
	actions.setLayerParam(0, "cutoff", 1200);
	assert.equal(state.lp[0].cut, 1200);
	assert.equal(state.seq[0].steps[0].locks.cutoff, 1200);
});

test("Glitch mode change snapshots complete selected-step state", () => {
	const { state, actions } = makeHarness();
	state.structure[3] = 10;
	state.recArm = true;
	state.seq[3].selectedStep = 0;
	actions.setGlitchMode(3, 2);
	const locks = state.seq[3].steps[0].locks;
	for (const id of ["kMode", "kDecay", "kPitch", "kTone", "kSnap", "kBody", "kGrit", "kLevel", "kPan", "kSend"]) {
		assert.notEqual(locks[id], undefined, id);
	}
	assert.equal(locks.kMode, 2);
});

test("Glitch randomization snapshots generated values", () => {
	const { state, actions } = makeHarness();
	state.structure[3] = 10;
	state.recArm = true;
	state.seq[3].selectedStep = 0;
	actions.randomizeGlitchPerc(3);
	const step = state.seq[3].steps[0];
	assert.equal(step.locks.kDecay, state.lp[3].decay);
	assert.equal(step.locks.kPitch, state.lp[3].pitch);
	assert.equal(step.locks.kTone, state.lp[3].tone);
});

test("Glitch base save requires edit context and snapshots current state", () => {
	const { state, actions } = makeHarness();
	state.structure[3] = 10;
	state.lp[3].decay = 1.25;
	actions.saveGlitchBase(3, 0);
	assert.notEqual(state.glitchBases[0].decay, 1.25);
	state.recArm = true;
	state.seq[3].selectedStep = 0;
	actions.saveGlitchBase(3, 0);
	assert.equal(state.glitchBases[0].decay, 1.25);
	assert.equal(state.seq[3].steps[0].locks.kDecay, 1.25);
});
