// Generic Novation Launchpad Pro (Programmer Mode) driver over Web MIDI.
// Shared by ambient_zero and granular_zero web ports — instrument-specific
// button/LED semantics live in each app module; this module only knows how
// to find the device, speak its SysEx protocol, diff/throttle LED writes,
// and hand back debounced note/CC events.
//
// Ported 1:1 from ~az.setupMIDI / ~az.padSysex / ~az.padCache in
// ambient_zero_sc.scd (see spec_ambient_zero.md §10.6) — granular_zero_sc.scd
// uses the identical protocol.

const SYSEX_HEADER = [0xf0, 0x00, 0x20, 0x29, 0x02, 0x10];
const SYSEX_FOOTER = 0xf7;
const CC_DEBOUNCE_MS = 120; // padCCDebounce
const SHIFT_GRACE_MS = 250; // padShiftGraceTime
const LED_BATCH = 24; // quads per SysEx message (firmware limit)
const REDRAW_MIN_MS = 30; // padMinRedraw (~33/sec)
const HANDSHAKE_GAP_MS = 150;

export function padGidx(col, row) {
	return 11 + col + (7 - row) * 10;
}
export function padRight(row) {
	return 19 + (7 - row) * 10;
}
export function padLeft(row) {
	return 10 + (7 - row) * 10;
}
export function padTop(col) {
	return 91 + col;
}
export function padBottom(col) {
	return 1 + col;
}

function sleep(ms) {
	return new Promise((res) => setTimeout(res, ms));
}

export class Launchpad {
	constructor({ onNote, onCC, onLost } = {}) {
		this.input = null;
		this.output = null;
		this.onNote = onNote || (() => {});
		this.onCC = onCC || (() => {});
		this.onLost = onLost || (() => {});
		this.connected = false;
		this.ledCache = new Map(); // index -> "r,g,b"
		this.pendingLeds = new Map();
		this.redrawTimer = null;
		this.lastCcAt = new Map(); // cc -> timestamp
		this.shiftReleasedAt = 0;
	}

	async connect({ maxAttempts = 16, intervalMs = 250 } = {}) {
		if (!navigator.requestMIDIAccess) {
			console.warn("Web MIDI not available in this browser.");
			return false;
		}
		const access = await navigator.requestMIDIAccess({ sysex: true });
		access.onstatechange = () => this._scan(access);

		for (let i = 0; i < maxAttempts; i++) {
			if (await this._scan(access)) return true;
			await sleep(intervalMs);
		}
		return false;
	}

	async _scan(access) {
		const inputs = [...access.inputs.values()].filter((p) =>
			/launchpad/i.test(p.name || ""),
		);
		const outputs = [...access.outputs.values()].filter((p) =>
			/launchpad/i.test(p.name || ""),
		);
		if (!inputs.length || !outputs.length) return false;

		const pick = (ports) =>
			ports.find((p) => /standalone/i.test(p.name)) || ports[0];
		const input = pick(inputs);
		const output = pick(outputs);
		// Prefer a matching pair sharing the same logical port name — LEDs and
		// input presses must be on the SAME port or LEDs work but presses don't.
		const matched = inputs.find((i) => outputs.some((o) => o.name === i.name));
		this.input = matched
			? inputs.find((i) => i.name === matched.name)
			: input;
		this.output = matched
			? outputs.find((o) => o.name === matched.name)
			: output;

		if (!this.input || !this.output) return false;

		this.input.onmidimessage = (e) => this._handleMessage(e.data);
		await this._enterProgrammerMode();
		this.connected = true;
		return true;
	}

	async _sysex(bytes) {
		if (!this.output) return;
		try {
			this.output.send([...SYSEX_HEADER, ...bytes, SYSEX_FOOTER]);
		} catch (err) {
			console.warn("Launchpad SysEx send failed:", err);
			this.connected = false;
			this.output = null;
			this.onLost();
		}
	}

	async _enterProgrammerMode() {
		await this._sysex([0x21, 0x01]); // standalone mode
		await sleep(HANDSHAKE_GAP_MS);
		await this._sysex([0x2c, 0x03]); // layout 3 = programmer
		await sleep(HANDSHAKE_GAP_MS);
		await this._sysex([0x0e, 0x00]); // all LEDs off
		await sleep(HANDSHAKE_GAP_MS);
		this.ledCache.clear();
	}

	async disconnect() {
		if (!this.connected) return;
		await this._sysex([0x0e, 0x00]);
		await sleep(HANDSHAKE_GAP_MS);
		await this._sysex([0x2c, 0x00]); // back to factory note mode
		this.connected = false;
		this.input = null;
		this.output = null;
	}

	_handleMessage(data) {
		const [status, d1, d2] = data;
		const type = status & 0xf0;
		if (type === 0x90 || type === 0x80) {
			// note on/off (grid + top row send notes in programmer mode)
			this.onNote(d1, type === 0x90 ? d2 : 0);
			return;
		}
		if (type === 0xb0) {
			const now = performance.now();
			const last = this.lastCcAt.get(d1) || 0;
			if (now - last < CC_DEBOUNCE_MS) return;
			this.lastCcAt.set(d1, now);
			this.onCC(d1, d2);
		}
	}

	// --- LED writes: diffed + throttled, exactly mirroring padCache/padRefresh

	setLed(index, [r, g, b]) {
		r = Math.max(0, Math.min(63, r | 0));
		g = Math.max(0, Math.min(63, g | 0));
		b = Math.max(0, Math.min(63, b | 0));
		const key = `${r},${g},${b}`;
		if (this.ledCache.get(index) === key) return;
		this.pendingLeds.set(index, [r, g, b]);
		this._scheduleRedraw();
	}

	_scheduleRedraw() {
		if (this.redrawTimer) return;
		this.redrawTimer = setTimeout(() => this._flushLeds(), REDRAW_MIN_MS);
	}

	async _flushLeds() {
		this.redrawTimer = null;
		if (!this.pendingLeds.size) return;
		const entries = [...this.pendingLeds.entries()];
		this.pendingLeds.clear();

		for (let i = 0; i < entries.length; i += LED_BATCH) {
			const batch = entries.slice(i, i + LED_BATCH);
			const payload = [0x0b];
			for (const [index, [r, g, b]] of batch) {
				payload.push(index, r, g, b);
				this.ledCache.set(index, `${r},${g},${b}`);
			}
			await this._sysex(payload);
		}
	}

	allOff() {
		this._sysex([0x0e, 0x00]);
		this.ledCache.clear();
	}
}
