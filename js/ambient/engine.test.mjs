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
