import { noteOffsets } from "./sequencer.js";

export const STEP_CLIPBOARD_KIND = "ambient-zero-step";

export function encodeStep(step) {
	return JSON.stringify({
		kind: STEP_CLIPBOARD_KIND,
		version: 1,
		step: {
			on: !!step.on,
			notes: step.notes.slice(),
			offsets: noteOffsets(step),
			vel: step.vel,
			chance: step.chance ?? 1,
			len: step.len,
			retrigger: step.retrigger ?? 0,
			locks: { ...step.locks },
		},
	});
}

export function decodeStep(text) {
	let payload;
	try { payload = JSON.parse(text); }
	catch { throw new Error("Clipboard does not contain step JSON"); }
	if (payload?.kind !== STEP_CLIPBOARD_KIND || payload.version !== 1) throw new Error("Clipboard does not contain a compatible step");
	const step = payload.step;
	const validNumber = (value, lo, hi) => typeof value === "number" && Number.isFinite(value) && value >= lo && value <= hi;
	if (!step || typeof step.on !== "boolean" || !Array.isArray(step.notes) || step.notes.length < 1 ||
		!step.notes.every((note) => Number.isInteger(note) && note >= 0 && note <= 127) ||
		new Set(step.notes).size !== step.notes.length ||
		!Array.isArray(step.offsets) || step.offsets.length !== step.notes.length ||
		!step.offsets.every((offset) => validNumber(offset, -0.5, 0.5)) ||
		!validNumber(step.vel, 0, 1) || !validNumber(step.chance, 0, 1) ||
		!validNumber(step.len, 0.1, 8) || !Number.isInteger(step.retrigger) || step.retrigger < 0 || step.retrigger > 7 ||
		!step.locks || Array.isArray(step.locks) || typeof step.locks !== "object" ||
		!Object.values(step.locks).every((value) => typeof value === "number" && Number.isFinite(value))) {
		throw new Error("Clipboard step data is invalid");
	}
	return {
		on: step.on, notes: step.notes.slice(), offsets: step.offsets.slice(),
		vel: step.vel, chance: step.chance, len: step.len, retrigger: step.retrigger,
		locks: { ...step.locks },
	};
}
