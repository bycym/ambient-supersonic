// Boots a SuperSonic (WASM scsynth) instance from the vendored assets in
// webport/vendor/, and loads a set of .scsyndef files for one instrument.
// Used by both the ambient and granular apps so each tab can boot (and
// later tear down) its own independent engine instance.

import { SuperSonic } from "../../vendor/supersonic/dist/supersonic.js";

const ASSET_ROOT = new URL("../../vendor/", import.meta.url).href;

export async function bootEngine({ synthdefDir, scsynthOptions, audioContext } = {}) {
	// Passing an already-created (and already-resumed) AudioContext matters:
	// it must be constructed synchronously inside the user's click handler
	// (see index.html's makeResumedAudioContext()) or the browser's autoplay
	// gesture window can expire before SuperSonic gets around to resuming its
	// own internally-created context, leaving audio permanently silent.
	const sonic = new SuperSonic({
		baseURL: ASSET_ROOT + "supersonic/dist/",
		coreBaseURL: ASSET_ROOT + "supersonic-core/",
		audioContext,
		scsynthOptions: Object.assign(
			{
				numInputBusChannels: 2,
				numOutputBusChannels: 2,
				numAudioBusChannels: 128,
				numControlBusChannels: 4096,
				numBuffers: 1024,
				maxNodes: 1024,
				realTimeMemorySize: 8192 * 8,
			},
			scsynthOptions || {},
		),
	});

	// Belt-and-suspenders: re-resume right before init() in case the
	// context got suspended again between the click and here (observed in
	// some browsers when several `await`s separate creation from use).
	if (sonic.audioContext && sonic.audioContext.state !== "running") {
		await sonic.audioContext.resume().catch(() => {});
	}
	await sonic.init();

	if (synthdefDir) {
		const dirUrl = ASSET_ROOT.replace(/vendor\/$/, "") + "synthdefs/" + synthdefDir + "/";
		const names = await fetch(dirUrl + "manifest.json").then((r) => r.json());
		await Promise.all(
			names.map((name) => sonic.loadSynthDef(dirUrl + name + ".scsyndef")),
		);
	}

	return sonic;
}

export async function teardownEngine(sonic) {
	if (!sonic) return;
	try {
		await sonic.destroy();
	} catch (err) {
		console.warn("SuperSonic teardown error (ignored):", err);
	}
}
