import test from "node:test";
import assert from "node:assert/strict";
import { createState } from "./state.js";
import { createActions } from "./actions.js";
import { serializePatch } from "./patch.js";

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

test("native step chance survives Webport patch export", () => {
	const state = createState();
	state.seq[0].steps[0].chance = 0.35;
	state.seq[0].rnd.density = 65;
	state.seq[0].rnd.velMin = 25;
	const patch = JSON.parse(JSON.stringify(serializePatch(state)));
	assert.equal(patch.seq[0].steps[0].chance, 0.35);
	assert.equal(patch.seq[0].steps[1].chance, 1);
	assert.equal(patch.seq[0].rnd.density, 65);
	assert.equal(patch.seq[0].rnd.velMin, 25);
});

test("Webport RND applies per-track density, velocity, and chance ranges", () => {
	const { state, actions } = makeHarness();
	state.recArm = true;
	for (const [key, value] of Object.entries({ density: 100, velMin: 35, velMax: 35, chanceMin: 40, chanceMax: 40 })) {
		actions.setRndSetting(0, key, value);
	}
	actions.randomizeTrack(0);
	assert.ok(state.seq[0].steps.slice(0, 16).every((step) => step.on && step.vel === 0.35 && step.chance === 0.4));
	actions.setRndSetting(0, "density", 0);
	actions.randomizeTrack(0);
	assert.ok(state.seq[0].steps.slice(0, 16).every((step) => !step.on));
	actions.setRndSetting(0, "velMin", -20);
	assert.equal(state.seq[0].rnd.velMin, 0);
	actions.setRndSetting(0, "chanceMax", 130);
	assert.equal(state.seq[0].rnd.chanceMax, 100);
});
