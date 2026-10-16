import test from "node:test";
import assert from "node:assert/strict";
import { createEngine } from "./engine.js";
import { createState } from "./state.js";

test("layer buses and FX taps route dry, bypass, and reverb separately", async () => {
	const messages = [];
	let nextId = 500;
	const engine = createEngine({
		send: (...args) => messages.push(args),
		nextNodeId: () => ++nextId,
	});
	engine.grp.layer = [101, 102, 103, 104];
	engine.grp.sidechainKey = 112;
	engine.grp.layerRoute = 105;
	engine.grp.fxTap = [106, 107, 108];
	engine.grp.revShim = 109;
	engine.grp.stemMix = 110;
	engine.grp.master = 111;
	const state = createState();
	const play = (layer, note) => engine.noteOn(layer, note, 0.8,
		state.lp[layer], state.structure[layer], state.noiseSrc, null, false);
	play(3, 60);
	let voice = messages.filter((msg) => msg[0] === "/s_new").at(-1);
	assert.equal(voice[voice.indexOf("out") + 1], engine.bus.layer[3]);
	assert.equal(voice[voice.indexOf("revB") + 1], engine.bus.layerRev[3]);
	await engine.initFixedSynths({ revShim: {}, master: {} });
	const routes = messages.filter((msg) => msg[0] === "/s_new" && msg[1] === "az_layer_route");
	const key = messages.find((msg) => msg[0] === "/s_new" && msg[1] === "az_sidechain_key");
	assert.equal(key[key.indexOf("out") + 1], engine.bus.sidechainKey);
	assert.equal(routes.length, 4);
	assert.equal(routes[3][routes[3].indexOf("in") + 1], engine.bus.layer[3]);
	assert.equal(routes[3][routes[3].indexOf("bypassOut") + 1], engine.bus.bypass);
	assert.equal(routes[3][routes[3].indexOf("revIn") + 1], engine.bus.layerRev[3]);
	assert.equal(routes[3][routes[3].indexOf("revOut") + 1], engine.bus.rev);
	assert.equal(routes[3][routes[3].indexOf("stemOut") + 1], engine.bus.duckedLayer[3]);
	assert.equal(routes[3][routes[3].indexOf("keyIn") + 1], engine.bus.sidechainKey);
	const taps = messages.filter((msg) => msg[0] === "/s_new" && msg[1] === "az_fx_stem_tap");
	assert.deepEqual(taps.map((msg) => msg[msg.indexOf("stemOut") + 1]), engine.bus.fxStem);
	const rev = messages.find((msg) => msg[0] === "/s_new" && msg[1] === "az_master_revshim");
	assert.equal(rev[rev.indexOf("out") + 1], engine.bus.revReturn);

	engine.setLayerFxBypass(3, true);
	assert.deepEqual(messages.at(-1), ["/n_set", routes[3][2], "bypass", 1]);
	engine.setLayerMixer(3, "level", 1.25);
	assert.deepEqual(messages.at(-2), ["/n_set", routes[3][2], "level", 1.25]);
	assert.deepEqual(messages.at(-1), ["/n_set", key[2], "level3", 1.25]);
	play(3, 62);
	voice = messages.filter((msg) => msg[0] === "/s_new").at(-1);
	assert.equal(voice[voice.indexOf("out") + 1], engine.bus.layer[3]);
	assert.equal(voice[voice.indexOf("revB") + 1], engine.bus.layerRev[3]);
	assert.equal(engine.layerOutBus(0), engine.bus.layer[0]);
	engine.setPumpParam("active", 1);
	assert.deepEqual(messages.slice(-4).map((msg) => msg.slice(0, 4)), routes.map((route) => ["/n_set", route[2], "pumpActive", 1]));
	engine.setPumpTarget(3, 1);
	assert.deepEqual(messages.at(-1), ["/n_set", routes[3][2], "pumpTarget", 1]);
	engine.setPumpParam("source", 0);
	assert.deepEqual(messages.at(-1), ["/n_set", key[2], "source", 0]);
	engine.setPumpTempo(96);
	assert.deepEqual(messages.at(-1), ["/n_set", key[2], "bpm", 96]);
	engine.resetPumpBeat();
	assert.deepEqual(messages.at(-1), ["/n_set", key[2], "reset", 1]);
});

test("18-output engine writes eight stem pairs after the master pair", async () => {
	const messages = []; let nextId = 700;
	const engine = createEngine({ send: (...args) => messages.push(args), nextNodeId: () => ++nextId }, { outputChannels: 18 });
	engine.grp.layer = [101, 102, 103, 104]; engine.grp.layerRoute = 105;
	engine.grp.sidechainKey = 113;
	engine.grp.fxTap = [106, 107, 108]; engine.grp.revShim = 109;
	engine.grp.stemMix = 110; engine.grp.master = 111; engine.grp.stemOut = 112;
	await engine.initFixedSynths({ revShim: {}, master: {} });
	const taps = messages.filter((m) => m[0] === "/s_new" && m[1] === "az_stem_output");
	assert.deepEqual(taps.map((m) => m[m.indexOf("out") + 1]), [2, 4, 6, 8, 10, 12, 14, 16]);
	assert.deepEqual(taps.map((m) => m[m.indexOf("in") + 1]), [...engine.bus.duckedLayer, ...engine.bus.fxStem, engine.bus.revReturn]);
	assert.equal(engine.bus.layer[0], 20);
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
