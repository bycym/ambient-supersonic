import test from "node:test";
import assert from "node:assert/strict";
import { createSequencer, newTrack } from "./sequencer.js";

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
		runUntil(140);
		assert.equal(hits.length, 4);
		assert.ok(hitLocks.every((locks) => locks.kPitch === 7));
		assert.ok(hits.slice(1).every((hit, i) => Math.abs(hit - hits[i] - 500 / 6 / 4) < 0.001));
		assert.equal(offs.length, 4);
		sequencer.stop();
		jobs = [];
		timeMs = 200;
		step.retrigger = 7;
		sequencer.start();
		tick();
		runUntil(251);
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
		tick(); // step 0 at 50 ms
		timeMs = 25;
		tick(); // step 1 is queued before step 0 has played
		runUntil(140);
		assert.deepEqual(hits, [50]);
		assert.equal(tracks[0].pos, 1);
		sequencer.stop();
		jobs = [];
		timeMs = 200;
		tracks[0].div = 8;
		sequencer.setTempo(400);
		sequencer.start();
		tick(); // four steps can be queued before the first one plays
		runUntil(320);
		assert.deepEqual(hits, [50, 250]);
		assert.equal(tracks[0].pos, 3);
		sequencer.stop();
	} finally {
		globalThis.setTimeout = originalTimeout;
		globalThis.setInterval = originalInterval;
		globalThis.clearInterval = originalClearInterval;
	}
});
