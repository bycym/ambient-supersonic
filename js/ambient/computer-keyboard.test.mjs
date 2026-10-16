import test from "node:test";
import assert from "node:assert/strict";
import { SCALES } from "./data.js";
import { COMPUTER_KEY_ROWS, computerKeyPadIndex, createComputerKeyboard } from "./computer-keyboard.js";

function harness() {
	const state = {
		page: "play", controlView: 1, padFocus: "eng", padMode: 2,
		keyRoot: 0, keyScale: 1, padKeyBase: 36, layerSel: 0,
		padHeld: new Map(), padLatched: [], padLatchMode: [false, false, false, false],
		recArm: false, playing: false, seq: [{ selectedStep: null }],
	};
	const calls = [];
	let time = 0;
	const actions = {
		keyDegreeToPitch: (col, row) => {
			const scale = SCALES[state.keyScale], degree = (7 - row) * scale.length + col;
			return state.padKeyBase + state.keyRoot + Math.floor(degree / scale.length) * 12 + scale[degree % scale.length];
		},
		playNoteMomentary: (layer, pitch) => calls.push(["on", layer, pitch]),
		stopNoteMomentary: (layer, pitch) => calls.push(["off", layer, pitch]),
		recordStepNote: (layer, step, pitch) => { calls.push(["record", layer, step, pitch, state.padHeld.size]); return step; },
		recordStepLength: (layer, step, seconds) => calls.push(["length", layer, step, seconds]),
		syncArp: (layer) => calls.push(["arp", layer]),
	};
	const sequencer = { nearestStepIndex: () => 3 };
	const keyboard = createComputerKeyboard({ state, actions, sequencer, now: () => time });
	const event = (code, caps = true, extra = {}) => ({
		code, getModifierState: () => caps, preventDefault() {}, target: { closest: () => null }, ...extra,
	});
	return { state, calls, keyboard, event, advance: (ms) => { time += ms; } };
}

test("three physical key rows map to the bottom three Launchpad KEYS rows", () => {
	assert.deepEqual(COMPUTER_KEY_ROWS.map((row) => row.length), [8, 8, 8]);
	assert.equal(computerKeyPadIndex("KeyQ"), 40);
	assert.equal(computerKeyPadIndex("KeyI"), 47);
	assert.equal(computerKeyPadIndex("KeyA"), 48);
	assert.equal(computerKeyPadIndex("KeyK"), 55);
	assert.equal(computerKeyPadIndex("KeyZ"), 56);
	assert.equal(computerKeyPadIndex("Comma"), 63);
	assert.equal(computerKeyPadIndex("KeyP"), null);
});

test("Caps Lock plays and releases notes only in Launchpad KEYS view", () => {
	const { state, calls, keyboard, event } = harness();
	assert.equal(keyboard.keyDown(event("KeyQ", false)), false);
	state.controlView = 0;
	assert.equal(keyboard.keyDown(event("KeyQ")), false);
	state.controlView = 1;
	assert.equal(keyboard.keyDown(event("KeyQ", true, { target: { closest: () => ({ tagName: "INPUT" }) } })), false);
	assert.equal(keyboard.keyDown(event("KeyQ", true, { ctrlKey: true })), false);
	assert.equal(keyboard.keyDown(event("KeyQ")), true);
	assert.equal(keyboard.keyDown(event("KeyQ", true, { repeat: true })), true);
	assert.deepEqual(calls, [["on", 0, 60]]);
	assert.equal(state.padHeld.size, 1);
	keyboard.keyUp(event("KeyQ", false));
	assert.deepEqual(calls, [["on", 0, 60], ["off", 0, 60]]);
	assert.equal(state.padHeld.size, 0);
	state.padKeyBase = 48;
	keyboard.keyDown(event("KeyQ"));
	assert.deepEqual(calls.at(-1), ["on", 0, 72]);
});

test("keyboard chords record together and held notes release when Caps Lock turns off", () => {
	const { state, calls, keyboard, event, advance } = harness();
	state.recArm = true;
	keyboard.keyDown(event("KeyQ"));
	keyboard.keyDown(event("KeyW"));
	assert.deepEqual(calls.filter((call) => call[0] === "record"), [
		["record", 0, 0, 60, 0], ["record", 0, 0, 62, 1],
	]);
	advance(500);
	keyboard.keyDown(event("CapsLock", false));
	assert.equal(keyboard.held.size, 0);
	assert.equal(state.padHeld.size, 0);
	assert.deepEqual(calls.filter((call) => call[0] === "length"), [
		["length", 0, 0, 0.5], ["length", 0, 0, 0.5],
	]);
});

test("latch mode keeps a note sounding until its computer key is pressed again", () => {
	const { state, calls, keyboard, event } = harness();
	state.padLatchMode[0] = true;
	keyboard.keyDown(event("KeyZ"));
	keyboard.keyUp(event("KeyZ"));
	assert.equal(state.padLatched.length, 1);
	assert.equal(keyboard.held.size, 0);
	keyboard.keyDown(event("KeyZ"));
	assert.equal(state.padLatched.length, 0);
	assert.deepEqual(calls, [["on", 0, 36], ["arp", 0], ["off", 0, 36], ["arp", 0]]);
});
