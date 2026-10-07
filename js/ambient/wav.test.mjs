import test from "node:test";
import assert from "node:assert/strict";
import { encodeWav, recordedAudioToWav } from "./wav.js";

const audioBuffer = {
	numberOfChannels: 2,
	length: 2,
	sampleRate: 48000,
	getChannelData(channel) {
		return channel === 0 ? Float32Array.of(-1, 0.5) : Float32Array.of(1, -0.5);
	},
};

test("WAV encoder writes stereo PCM samples and a valid RIFF header", async () => {
	const wav = encodeWav(audioBuffer);
	assert.equal(wav.type, "audio/wav");
	const bytes = await wav.arrayBuffer();
	const view = new DataView(bytes);
	const text = (offset, length) => String.fromCharCode(...new Uint8Array(bytes, offset, length));
	assert.equal(text(0, 4), "RIFF");
	assert.equal(text(8, 4), "WAVE");
	assert.equal(text(12, 4), "fmt ");
	assert.equal(text(36, 4), "data");
	assert.equal(view.getUint32(4, true), bytes.byteLength - 8);
	assert.equal(view.getUint16(20, true), 1);
	assert.equal(view.getUint16(22, true), 2);
	assert.equal(view.getUint32(24, true), 48000);
	assert.equal(view.getUint32(40, true), 8);
	assert.deepEqual([44, 46, 48, 50].map((offset) => view.getInt16(offset, true)), [-32768, 32767, 16383, -16384]);
});

test("browser recording is decoded before WAV export", async () => {
	let decodedBytes;
	const wav = await recordedAudioToWav(new Blob(["recorded"]), {
		async decodeAudioData(bytes) { decodedBytes = bytes; return audioBuffer; },
	});
	assert.ok(decodedBytes instanceof ArrayBuffer);
	assert.equal(wav.type, "audio/wav");
});
