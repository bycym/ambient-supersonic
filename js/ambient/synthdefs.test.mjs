import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("GLITCH PERC SynthDef is bundled for on-demand loading", () => {
	const path = new URL("../../synthdefs/ambient/az_keinseier.scsyndef", import.meta.url);
	const data = readFileSync(path);
	assert.equal(data.toString("ascii", 0, 4), "SCgf");
	assert.ok(data.includes(Buffer.from("az_keinseier")));
});
