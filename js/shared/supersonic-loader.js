// Boots the Ambient Zero SuperSonic (WASM scsynth) instance from the vendored
// assets and its compiled SynthDefs.

import { SuperSonic } from "../../vendor/supersonic/dist/supersonic.js";

const ASSET_ROOT = new URL("../../vendor/", import.meta.url).href;
const WEBPORT_ROOT = new URL("../../", import.meta.url);

export async function bootEngine({ synthdefDir, scsynthOptions, audioContext, autoConnect = true } = {}) {
	// AudioContext must be created synchronously in the Start button's click
	// handler so browser autoplay policies retain the user gesture.
	const sonic = new SuperSonic({
		baseURL: ASSET_ROOT + "supersonic/dist/",
		coreBaseURL: ASSET_ROOT + "supersonic-core/",
		audioContext,
		autoConnect,
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

	try {
		if (sonic.audioContext && sonic.audioContext.state !== "running") {
			await sonic.audioContext.resume().catch(() => {});
		}
		await sonic.init();

		if (synthdefDir) {
			const dirUrl = new URL(`synthdefs/${synthdefDir}/`, WEBPORT_ROOT);
			const manifestUrl = new URL("manifest.json", dirUrl);
			const response = await fetch(manifestUrl);
			if (!response.ok) throw new Error(`Failed to load SynthDef manifest (${response.status}): ${manifestUrl}`);
			const names = await response.json();
			if (!Array.isArray(names) || names.some((name) => typeof name !== "string" || !/^[\w-]+$/.test(name))) {
				throw new Error(`Invalid SynthDef manifest: ${manifestUrl}`);
			}
			await Promise.all(
				names.map((name) => sonic.loadSynthDef(new URL(`${name}.scsyndef`, dirUrl).href)),
			);
		}

		return sonic;
	} catch (err) {
		await sonic.destroy().catch(() => {});
		throw err;
	}
}

export async function teardownEngine(sonic) {
	if (!sonic) return;
	try {
		await sonic.destroy();
	} catch (err) {
		console.warn("SuperSonic teardown error (ignored):", err);
	}
}
