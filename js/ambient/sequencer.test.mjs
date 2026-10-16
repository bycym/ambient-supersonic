import test from "node:test";
import assert from "node:assert/strict";
import { createSequencer, newTrack, noteOffsets } from "./sequencer.js";
import { NOTE_NAMES, SEQ_DIVS, SEQ_DIV_NAMES } from "./data.js";

test("extended note and division lists keep existing indices", () => {
	assert.equal(NOTE_NAMES[0], "C0");
	assert.equal(NOTE_NAMES[96], "C8");
	assert.equal(SEQ_DIV_NAMES[8], "1/32");
	assert.equal(SEQ_DIV_NAMES[9], "1/32t");
	assert.equal(SEQ_DIVS[9], 12);
	assert.deepEqual(noteOffsets({ notes: [60, 64], offsets: [-0.8, 0.25] }), [-0.5, 0.25]);
	assert.deepEqual(noteOffsets({ notes: [60, 64] }), [0, 0]);
});

test("tempo pump aligns to transport beat and cancels pending reset on stop", () => {
	const setTimeoutBefore = globalThis.setTimeout;
	const clearTimeoutBefore = globalThis.clearTimeout;
	const setIntervalBefore = globalThis.setInterval;
	const clearIntervalBefore = globalThis.clearInterval;
	let now = 0;
	let nextId = 0;
	const jobs = new Map();
	const resets = [];
	try {
		globalThis.setTimeout = (fn, delay) => { const id = ++nextId; jobs.set(id, { fn, at: now + delay }); return id; };
		globalThis.clearTimeout = (id) => jobs.delete(id);
		globalThis.setInterval = () => ++nextId;
		globalThis.clearInterval = () => {};
		const seq = createSequencer({
			audioContext: { get currentTime() { return now / 1000; } },
			engine: { resetPumpBeat() { resets.push(now); }, layerOff() {} },
			getLayerState: () => ({}), tracks: Array.from({ length: 4 }, newTrack),
		});
		seq.start();
		const first = [...jobs.values()][0];
		assert.ok(first.at > 0);
		now = first.at;
		first.fn();
		assert.equal(resets.length, 1);
		seq.stop();
		jobs.clear();
		seq.start();
		seq.stop();
		assert.equal(jobs.size, 0);
		assert.equal(resets.length, 1);
	} finally {
		globalThis.setTimeout = setTimeoutBefore;
		globalThis.clearTimeout = clearTimeoutBefore;
		globalThis.setInterval = setIntervalBefore;
		globalThis.clearInterval = clearIntervalBefore;
	}
});

test("early and late note offsets play across a short loop and capture relative timing", () => {
	const originalTimeout = globalThis.setTimeout;
	const originalInterval = globalThis.setInterval;
	const originalClearInterval = globalThis.clearInterval;
	let timeMs = 0;
	let tick;
	let jobs = [];
	let nextId = 0;
	const hits = [];
	try {
		globalThis.setTimeout = (fn, delay) => { jobs.push({ fn, at: timeMs + delay, id: ++nextId }); return nextId; };
		globalThis.setInterval = (fn) => { tick = fn; return 1; };
		globalThis.clearInterval = () => {};
		const runUntil = (endMs) => {
			while (jobs.some((job) => job.at <= endMs)) {
				jobs.sort((a, b) => a.at - b.at || a.id - b.id);
				const job = jobs.shift();
				timeMs = job.at;
				job.fn();
			}
			timeMs = endMs;
		};
		const tracks = Array.from({ length: 4 }, newTrack);
		for (const track of tracks) track.div = 9;
		tracks[0].length = 2;
		tracks[0].steps[0].on = true;
		tracks[0].steps[0].notes = [60];
		tracks[0].steps[0].offsets = [-0.5];
		tracks[0].steps[1].on = true;
		tracks[0].steps[1].notes = [64];
		tracks[0].steps[1].offsets = [0.25];
		const sequencer = createSequencer({
			audioContext: { get currentTime() { return timeMs / 1000; } },
			engine: { noteOn(_layer, note) { hits.push({ note, at: timeMs }); return 1; }, noteOff() {}, layerOff() {} },
			getLayerState: () => ({ lp: {}, structure: 0, noiseSrc: 0, muted: false }),
			onStep() {}, tracks,
		});
		sequencer.start();
		tick();
		runUntil(105);
		tick();
		assert.equal(sequencer.nearestStepIndex(0), 1);
		assert.ok(Math.abs(sequencer.noteOffsetFor(0, 1) + 0.18) < 0.01);
		runUntil(145);
		assert.deepEqual(hits.map((hit) => hit.note), [60, 64, 60]);
		assert.ok(Math.abs(hits[0].at - 50) < 0.001);
		assert.ok(Math.abs(hits[1].at - (70.8333333333 + 41.6666666667 * 1.25)) < 0.001);
		assert.ok(Math.abs(hits[2].at - (70.8333333333 + 41.6666666667 * 1.5)) < 0.001);
		sequencer.stop();
	} finally {
		globalThis.setTimeout = originalTimeout;
		globalThis.setInterval = originalInterval;
		globalThis.clearInterval = originalClearInterval;
	}
});

test("step retrigger adds evenly spaced hits and stops pending hits", () => {
	const originalTimeout = globalThis.setTimeout;
	const originalInterval = globalThis.setInterval;
	const originalClearInterval = globalThis.clearInterval;
	let timeMs = 0;
	let tick;
	let jobs = [];
	let nextId = 0;
	const hits = [];
	const offs = [];
	try {
		globalThis.setTimeout = (fn, delay) => {
			jobs.push({ fn, at: timeMs + delay, id: ++nextId });
			return nextId;
		};
		globalThis.setInterval = (fn) => { tick = fn; return 1; };
		globalThis.clearInterval = () => {};
		const runUntil = (endMs) => {
			while (jobs.some((job) => job.at <= endMs)) {
				jobs.sort((a, b) => a.at - b.at || a.id - b.id);
				const job = jobs.shift();
				timeMs = job.at;
				job.fn();
			}
			timeMs = endMs;
		};
		const tracks = Array.from({ length: 4 }, newTrack);
		const step = tracks[0].steps[0];
		step.on = true;
		step.retrigger = 3;
		step.offsets = [-0.25];
		step.chance = 1;
		step.locks = { kPitch: 7 };
		const hitLocks = [];
		const sequencer = createSequencer({
			audioContext: { get currentTime() { return timeMs / 1000; } },
			engine: {
				noteOn(layer, note, velocity, lp, structure, noiseSrc, locks) { hits.push(timeMs); hitLocks.push(locks); return 1; },
				noteOff() { offs.push(timeMs); },
				layerOff() {},
			},
			getLayerState: () => ({ lp: {}, structure: 0, noiseSrc: 0, muted: false }),
			onStep() {},
			tracks,
		});
		sequencer.start();
		tick();
		runUntil(190);
		assert.equal(hits.length, 4);
		assert.ok(Math.abs(hits[0] - (50 + 500 / 6 / 4)) < 0.001);
		assert.ok(hitLocks.every((locks) => locks.kPitch === 7));
		assert.ok(hits.slice(1).every((hit, i) => Math.abs(hit - hits[i] - 500 / 6 / 4) < 0.001));
		assert.equal(offs.length, 4);
		sequencer.stop();
		jobs = [];
		timeMs = 200;
		step.retrigger = 7;
		step.offsets = [0];
		sequencer.start();
		tick();
		runUntil(300);
		assert.equal(hits.length, 5);
		sequencer.stop();
		runUntil(400);
		assert.equal(hits.length, 5);
	} finally {
		globalThis.setTimeout = originalTimeout;
		globalThis.setInterval = originalInterval;
		globalThis.clearInterval = originalClearInterval;
	}
});

test("lookahead schedules each step once when retrigger is zero", () => {
	const originalTimeout = globalThis.setTimeout;
	const originalInterval = globalThis.setInterval;
	const originalClearInterval = globalThis.clearInterval;
	let timeMs = 0;
	let tick;
	let jobs = [];
	const hits = [];
	try {
		globalThis.setTimeout = (fn, delay) => { jobs.push({ fn, at: timeMs + delay }); return jobs.length; };
		globalThis.setInterval = (fn) => { tick = fn; return 1; };
		globalThis.clearInterval = () => {};
		const runUntil = (endMs) => {
			while (jobs.some((job) => job.at <= endMs)) {
				jobs.sort((a, b) => a.at - b.at);
				const job = jobs.shift();
				timeMs = job.at;
				job.fn();
			}
			timeMs = endMs;
		};
		const tracks = Array.from({ length: 4 }, newTrack);
		tracks[0].length = 4;
		tracks[0].steps[0].on = true;
		assert.equal(tracks[0].steps[0].retrigger, 0);
		const sequencer = createSequencer({
			audioContext: { get currentTime() { return timeMs / 1000; } },
			engine: { noteOn() { hits.push(timeMs); return 1; }, noteOff() {}, layerOff() {} },
			getLayerState: () => ({ lp: {}, structure: 10, noiseSrc: 0, muted: false }),
			onStep() {}, tracks,
		});
		sequencer.start();
		tick(); // step 0 after half-step count-in
		timeMs = 25;
		tick(); // step 1 is queued before step 0 has played
		runUntil(140);
		assert.ok(Math.abs(hits[0] - (50 + 500 / 6 / 2)) < 0.001);
		assert.equal(hits.length, 1);
		assert.equal(tracks[0].pos, 0);
		sequencer.stop();
		jobs = [];
		timeMs = 200;
		tracks[0].div = 8;
		sequencer.setTempo(400);
		sequencer.start();
		tick(); // four steps can be queued before the first one plays
		runUntil(320);
		assert.ok(Math.abs(hits[1] - (250 + 150 / 6 / 2)) < 0.001);
		assert.equal(hits.length, 2);
		assert.equal(tracks[0].pos, 3);
		sequencer.stop();
	} finally {
		globalThis.setTimeout = originalTimeout;
		globalThis.setInterval = originalInterval;
		globalThis.clearInterval = originalClearInterval;
	}
});
