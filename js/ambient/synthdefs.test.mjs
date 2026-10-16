import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("GLITCH PERC SynthDef is bundled for on-demand loading", () => {
	const path = new URL("../../synthdefs/ambient/az_keinseier.scsyndef", import.meta.url);
	const data = readFileSync(path);
	assert.equal(data.toString("ascii", 0, 4), "SCgf");
	assert.ok(data.includes(Buffer.from("az_keinseier")));
});

test("stem routing SynthDefs are bundled for engine startup", () => {
	const root = new URL("../../synthdefs/ambient/", import.meta.url);
	const manifest = JSON.parse(readFileSync(new URL("manifest.json", root), "utf8"));
	for (const name of ["az_sidechain_key", "az_layer_route", "az_fx_stem_tap", "az_stem_mix", "az_stem_output"]) {
		assert.ok(manifest.includes(name), `${name} missing from manifest`);
		const data = readFileSync(new URL(`${name}.scsyndef`, root));
		assert.equal(data.toString("ascii", 0, 4), "SCgf");
		assert.ok(data.includes(Buffer.from(name)));
	}
});

test("every SynthDef named by the startup manifest is present and valid", () => {
	const root = new URL("../../synthdefs/ambient/", import.meta.url);
	const manifest = JSON.parse(readFileSync(new URL("manifest.json", root), "utf8"));
	assert.ok(manifest.length > 0);
	assert.equal(new Set(manifest).size, manifest.length, "manifest contains duplicate names");
	for (const name of manifest) {
		const data = readFileSync(new URL(`${name}.scsyndef`, root));
		assert.equal(data.toString("ascii", 0, 4), "SCgf", `${name} is not a SynthDef`);
		assert.ok(data.includes(Buffer.from(name)), `${name} binary has a different SynthDef name`);
	}
});
