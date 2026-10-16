import test from "node:test";
import assert from "node:assert/strict";
import { createState } from "./state.js";
import { createActions } from "./actions.js";
import { decodeStep, encodeStep } from "./step-clipboard.js";

test("step clipboard exchanges full steps across layers and rejects malformed data", () => {
	const state = createState();
	const actions = createActions({
		state, engine: { previewNote() {} },
		sequencer: { stepDurSeconds() { return 1; } }, refresh() {},
	});
	state.seq[0].selectedStep = 0;
	state.seq[1].selectedStep = 3;
	state.seq[0].steps[0] = {
		on: true, notes: [48, 64], offsets: [-0.25, 0.375],
		vel: 0.7, chance: 0.8, len: 1.5, retrigger: 2, locks: { unsupportedOtherLayerLock: 123 },
	};
	const json = actions.copySelectedStep(0);
	assert.deepEqual(decodeStep(json), state.seq[0].steps[0]);
	assert.equal(actions.pasteSelectedStep(1, json), true);
	assert.deepEqual(state.seq[1].steps[3], state.seq[0].steps[0]);
	const original = structuredClone(state.seq[1].steps[3]);
	for (const malformed of ["{", "{}", JSON.stringify({ ...JSON.parse(json), step: { ...JSON.parse(json).step, notes: [48, 48] } })]) {
		assert.throws(() => actions.pasteSelectedStep(1, malformed));
		assert.deepEqual(state.seq[1].steps[3], original);
	}
});

test("individual note editing preserves parallel offsets and unique pitches", () => {
	const state = createState();
	const actions = createActions({
		state, engine: { previewNote() {} },
		sequencer: { stepDurSeconds() { return 1; } }, refresh() {},
	});
	state.recArm = true;
	state.seq[0].selectedStep = 0;
	state.seq[0].steps[0].on = true;
	assert.equal(actions.addStepNote(0, 64), true);
	assert.equal(actions.addStepNote(0, 64), false);
	assert.equal(actions.setStepNoteOffset(0, 1, -0.32), true);
	assert.equal(actions.setStepNotePitch(0, 0, 64), false);
	assert.equal(actions.setStepNotePitch(0, 1, 67), true);
	assert.deepEqual(state.seq[0].steps[0].notes, [60, 67]);
	assert.deepEqual(state.seq[0].steps[0].offsets, [0, -0.32]);
	assert.equal(actions.removeStepNote(0, 0), true);
	assert.deepEqual(state.seq[0].steps[0].notes, [67]);
	assert.deepEqual(state.seq[0].steps[0].offsets, [-0.32]);
	assert.deepEqual(decodeStep(encodeStep(state.seq[0].steps[0])).offsets, [-0.32]);
});

test("selected-step preview follows stored per-note timing", () => {
	const state = createState();
	const heard = [];
	const scheduled = [];
	const originalTimer = globalThis.setTimeout;
	globalThis.setTimeout = (callback, delay) => { scheduled.push({ callback, delay }); return 1; };
	try {
		const actions = createActions({
			state, engine: { previewNote(_layer, note) { heard.push(note); } },
			sequencer: { stepDurSeconds() { return 1; } }, refresh() {},
		});
		Object.assign(state.seq[0].steps[0], { on: true, notes: [60, 64], offsets: [-0.5, 0.5] });
		actions.clickStep(0, 0);
		assert.deepEqual(heard, [60]);
		assert.equal(scheduled.length, 1);
		assert.equal(scheduled[0].delay, 1000);
		scheduled[0].callback();
		assert.deepEqual(heard, [60, 64]);
	} finally { globalThis.setTimeout = originalTimer; }
});
