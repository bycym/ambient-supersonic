export const COMPUTER_KEY_ROWS = [
	["KeyQ", "KeyW", "KeyE", "KeyR", "KeyT", "KeyY", "KeyU", "KeyI"],
	["KeyA", "KeyS", "KeyD", "KeyF", "KeyG", "KeyH", "KeyJ", "KeyK"],
	["KeyZ", "KeyX", "KeyC", "KeyV", "KeyB", "KeyN", "KeyM", "Comma"],
];

const PAD_BY_CODE = new Map(COMPUTER_KEY_ROWS.flatMap((codes, row) =>
	codes.map((code, col) => [code, (row + 5) * 8 + col])));

export function computerKeyPadIndex(code) {
	return PAD_BY_CODE.get(code) ?? null;
}

export function createComputerKeyboard({ state, actions, sequencer, onChange = () => {}, now = () => performance.now() }) {
	const held = new Map();
	let capsLockOn = false;

	function release(code) {
		const entry = held.get(code);
		if (!entry) return false;
		held.delete(code);
		state.padHeld.delete("keyboard:" + code);
		actions.stopNoteMomentary(entry.layer, entry.pitch);
		if (entry.step != null) actions.recordStepLength(entry.layer, entry.step, (now() - entry.t0) / 1000);
		onChange();
		return true;
	}

	function keyDown(event) {
		const wasCapsLockOn = capsLockOn;
		capsLockOn = !!event.getModifierState?.("CapsLock");
		const inTextControl = !!event.target?.closest?.("input, textarea, select, [contenteditable], [contenteditable=true]");
		if (event.code === "CapsLock") {
			if (!capsLockOn) releaseAll();
			if (!inTextControl) onChange();
			return false;
		}
		const index = computerKeyPadIndex(event.code);
		if (index == null || !capsLockOn || state.page !== "play" || state.controlView !== 1 ||
			state.padFocus !== "eng" || state.padMode !== 2 || event.metaKey || event.ctrlKey || event.altKey ||
			event.isComposing || inTextControl) {
			if (wasCapsLockOn !== capsLockOn && !inTextControl) onChange();
			return false;
		}
		event.preventDefault?.();
		if (event.repeat || held.has(event.code)) return true;

		const row = Math.floor(index / 8), col = index % 8;
		const pitch = actions.keyDegreeToPitch(col, row);
		if (pitch < 0 || pitch > 127) return true;
		const layer = state.layerSel;
		const latched = state.padLatched.find((entry) => entry.layer === layer && entry.pitch === pitch);
		if (latched) {
			state.padLatched.splice(state.padLatched.indexOf(latched), 1);
			actions.stopNoteMomentary(layer, pitch);
			if (latched.step != null) actions.recordStepLength(layer, latched.step, (now() - latched.t0) / 1000);
			actions.syncArp(layer);
			onChange();
			return true;
		}

		actions.playNoteMomentary(layer, pitch);
		let step = null;
		if (state.recArm) {
			const target = state.playing ? sequencer.nearestStepIndex(layer) : (state.seq[layer].selectedStep ?? 0);
			if (target != null) step = actions.recordStepNote(layer, target, pitch);
		}
		const entry = { layer, pitch, step, t0: now() };
		if (state.padLatchMode[layer]) {
			state.padLatched.push(entry);
			actions.syncArp(layer);
		} else {
			held.set(event.code, entry);
			state.padHeld.set("keyboard:" + event.code, entry);
		}
		onChange();
		return true;
	}

	function keyUp(event) {
		if (!held.has(event.code)) return false;
		event.preventDefault?.();
		return release(event.code);
	}

	function releaseAll() {
		for (const code of [...held.keys()]) release(code);
	}

	return { keyDown, keyUp, releaseAll, held, get capsLockOn() { return capsLockOn; } };
}
