import test from "node:test";
import assert from "node:assert/strict";
import { createEngine } from "./engine.js";
import { createState } from "./state.js";

test("one layer can bypass FX1-3 while retaining reverb send and master routing", () => {
	const messages = [];
	let nextId = 500;
	const engine = createEngine({
		send: (...args) => messages.push(args),
		nextNodeId: () => ++nextId,
	});
	engine.grp.layer = [101, 102, 103, 104];
	const state = createState();
	const play = (layer, note) => engine.noteOn(layer, note, 0.8,
		state.lp[layer], state.structure[layer], state.noiseSrc, null, false);
	play(3, 60);
	let voice = messages.filter((msg) => msg[0] === "/s_new").at(-1);
	assert.equal(voice[voice.indexOf("out") + 1], engine.bus.mix);
	assert.equal(voice[voice.indexOf("revB") + 1], engine.bus.rev);

	engine.setLayerFxBypass(3, true);
	assert.deepEqual(messages.at(-1), ["/n_set", 104, "out", engine.bus.slot[2]]);
	play(3, 62);
	voice = messages.filter((msg) => msg[0] === "/s_new").at(-1);
	assert.equal(voice[voice.indexOf("out") + 1], engine.bus.slot[2]);
	assert.equal(voice[voice.indexOf("revB") + 1], engine.bus.rev);
	assert.equal(engine.layerOutBus(0), engine.bus.mix);
});

test("master REC exports a WAV and disconnects its capture tap", async () => {
	const originalMediaRecorder = globalThis.MediaRecorder;
	const calls = [];
	class FakeMediaRecorder {
		constructor(stream) { this.stream = stream; this.mimeType = "audio/webm"; }
		start() { calls.push("start"); }
		stop() {
			calls.push("stop");
			this.ondataavailable({ data: new Blob(["encoded"]) });
			this.onstop();
		}
	}
	globalThis.MediaRecorder = FakeMediaRecorder;
	try {
		const destination = { stream: {} };
		const sonic = {
			node: {
				connect(target) { assert.equal(target, destination); calls.push("connect"); },
				disconnect(target) { assert.equal(target, destination); calls.push("disconnect"); },
			},
			audioContext: {
				createMediaStreamDestination() { return destination; },
				async decodeAudioData() {
					return { numberOfChannels: 1, length: 1, sampleRate: 48000, getChannelData: () => Float32Array.of(0.5) };
				},
			},
		};
		const recording = createEngine(sonic).startMasterRecording();
		assert.ok(recording);
		recording.rec.stop();
		const wav = await recording.donePromise;
		assert.equal(wav.type, "audio/wav");
		assert.deepEqual(calls, ["connect", "start", "stop", "disconnect"]);
	} finally {
		globalThis.MediaRecorder = originalMediaRecorder;
	}
});

test("step preview uses an independent voice and releases only that voice", () => {
	const originalTimeout = globalThis.setTimeout;
	const messages = [];
	let releasePreview;
	let nextId = 600;
	try {
		globalThis.setTimeout = (fn) => { releasePreview = fn; return 1; };
		const engine = createEngine({
			send: (...args) => messages.push(args),
			nextNodeId: () => ++nextId,
		});
		engine.grp.layer = [101, 102, 103, 104];
		const state = createState();
		const held = engine.noteOn(0, 60, 0.8, state.lp[0], state.structure[0], state.noiseSrc, null, false);
		const preview = engine.previewNote(0, 60, 0.42, state.lp[0], state.structure[0], state.noiseSrc, { cutoff: 1200 }, false);
		assert.notEqual(held, preview);
		assert.equal(messages.filter((message) => message[0] === "/s_new").length, 2);
		const previewMessage = messages.find((message) => message[0] === "/s_new" && message[2] === preview);
		assert.equal(previewMessage[previewMessage.lastIndexOf("cut") + 1], 1200);
		assert.ok(!messages.some((message) => message[0] === "/n_set" && message[1] === held));
		releasePreview();
		assert.deepEqual(messages.at(-1), ["/n_set", preview, "gate", 0]);
		engine.noteOff(0, 60);
		assert.deepEqual(messages.at(-1), ["/n_set", held, "gate", 0]);
	} finally {
		globalThis.setTimeout = originalTimeout;
	}
});
