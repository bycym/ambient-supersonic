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
		const sequencer = createSequencer({
			audioContext: { get currentTime() { return timeMs / 1000; } },
			engine: {
				noteOn() { hits.push(timeMs); return 1; },
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
