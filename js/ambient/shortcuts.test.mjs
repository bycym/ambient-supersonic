import test from "node:test";
import assert from "node:assert/strict";
import { stepShortcut } from "./shortcuts.js";

test("step shortcuts map transport and clipboard keys outside text controls", () => {
	const event = (key, extra = {}) => ({ key, code: key === " " ? "Space" : key, target: { closest: () => null }, ...extra });
	assert.equal(stepShortcut(event("c", { metaKey: true })), "copy");
	assert.equal(stepShortcut(event("v", { ctrlKey: true })), "paste");
	assert.equal(stepShortcut(event("Delete")), "delete");
	assert.equal(stepShortcut(event("Backspace")), "delete");
	assert.equal(stepShortcut(event(" ")), "play");
	assert.equal(stepShortcut(event("c", { metaKey: true, target: { closest: () => ({ tagName: "INPUT" }) } })), null);
	assert.equal(stepShortcut(event(" ", { target: { closest: () => ({ tagName: "TEXTAREA" }) } })), null);
});
