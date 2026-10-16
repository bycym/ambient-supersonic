import test from "node:test";
import assert from "node:assert/strict";
import { STEMS, STEM_PAIR, selectedStems, wavHeader, encodeStem } from "./stem-format.js";
import { streamZip } from "./stem-zip.js";

test("stem modes map to nine synchronized channel pairs", () => {
	assert.deepEqual(selectedStems("master"), ["master"]);
	assert.deepEqual(selectedStems("full"), STEMS);
	assert.deepEqual(selectedStems("custom", ["fx2", "master"]), ["fx2", "master"]);
	assert.throws(() => selectedStems("custom", []));
	assert.deepEqual(STEMS.map((s) => STEM_PAIR[s]), [1, 2, 3, 4, 5, 6, 7, 8, 0]);
});

test("WAV headers and samples encode all three export formats", () => {
	const frames = 2, rate = 48000;
	const input = new Float32Array(frames * 18);
	input[0] = -1; input[1] = 1; input[18] = 0.5; input[19] = -0.5;
	for (const [format, bits, tag, bytes] of [["float32", 32, 3, 4], ["pcm24", 24, 1, 3], ["pcm16", 16, 1, 2]]) {
		const h = new DataView(wavHeader(frames, rate, format).buffer);
		assert.equal(h.getUint32(4, true), 36 + frames * 2 * bytes);
		assert.equal(h.getUint16(20, true), tag);
		assert.equal(h.getUint16(34, true), bits);
		assert.equal(h.getUint32(24, true), rate);
		const encoded = encodeStem(input, frames, 0, format);
		assert.equal(encoded.length, frames * 2 * bytes);
		if (format === "float32") assert.equal(new DataView(encoded.buffer).getFloat32(0, true), -1);
		if (format === "pcm16") assert.equal(new DataView(encoded.buffer).getInt16(2, true), 32767);
		if (format === "pcm24") assert.deepEqual([...encoded.slice(0, 3)], [0, 0, 128]);
	}
});

test("streamed ZIP has stored entries, descriptors, and central directory", async () => {
	const parts = [];
	await streamZip({ write: async (part) => parts.push(new Uint8Array(part)) }, [
		{ name: "master.wav", blob: new Blob([new Uint8Array([1, 2, 3])]) },
		{ name: "PARTIAL_TAKE.txt", blob: new Blob(["partial"]) },
	]);
	const bytes = new Uint8Array(parts.reduce((n, x) => n + x.length, 0));
	let at = 0; for (const part of parts) { bytes.set(part, at); at += part.length; }
	const v = new DataView(bytes.buffer);
	assert.equal(v.getUint32(0, true), 0x04034b50);
	assert.equal(v.getUint32(bytes.length - 22, true), 0x06054b50);
	assert.equal(v.getUint16(bytes.length - 14, true), 2);
	assert.equal(v.getUint32(bytes.length - 22 + 16, true) + v.getUint32(bytes.length - 22 + 12, true), bytes.length - 22);
});
