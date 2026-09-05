// Brain Ø-specific Launchpad Pro button/LED semantics (spec §10), driving
// the generic Launchpad driver in ../shared/launchpad.js. Ported 1:1 from
// ~az.padPress / ~az.padCCIn / ~az.padKeyDown / ~az.padRedraw
// (ambient_zero_sc.scd lines 2533-2900+2923-3089+563-2738) — every button here
// calls the exact same `actions` functions the on-screen GUI calls (spec
// §10.7 "GUI/Launchpad synchronization principle").

import { Launchpad, padGidx, padRight, padLeft, padTop, padBottom } from "../shared/launchpad.js";
import { PAD_C, SPECS, SLOT_SPECS, REVSHIM_SPECS, SCALES, SCALE_NAMES, warpValue, unwarpValue } from "./data.js";

const CC_DEBOUNCE_GRACE_MS = 250;

export function createLaunchpadController({ state, actions, sequencer, engine }) {
	const lp = new Launchpad({
		onNote: (num, vel) => handleNote(num, vel),
		onCC: (num, val) => handleCC(num, val),
		onLost: () => { connected = false; },
	});

	let connected = false;
	let blinkOn = true;
	let blinkTimer = null;

	function shiftOn() {
		return state.padShift || performance.now() < shiftGraceUntil;
	}
	let shiftGraceUntil = 0;

	// ---- helpers mirroring ~az.padKeyDegree / padKeyPitch (spec §10.4) ----
	function keyDegree(col, row) {
		const scaleSize = SCALES[state.keyScale].length;
		return (7 - row) * scaleSize + col;
	}
	function keyPitch(col, row) {
		const sc = SCALES[state.keyScale];
		const idx = keyDegree(col, row);
		return state.padKeyBase + state.keyRoot + Math.floor(idx / sc.length) * 12 + sc[idx % sc.length];
	}

	function fxParamCount(fxIdx) {
		if (fxIdx === 3) return REVSHIM_SPECS.length;
		return SLOT_SPECS[state.slotType[fxIdx]].length;
	}
	function getFxNorm(fxIdx, col) {
		if (fxIdx === 3) {
			const row = REVSHIM_SPECS[col];
			return unwarpValue(row[2], row[3], state.revShimParams[row[1]], row[5]);
		}
		const row = SLOT_SPECS[state.slotType[fxIdx]][col];
		return unwarpValue(row[2], row[3], state.slotParams[fxIdx][row[1]], row[5]);
	}
	function setFxNorm(fxIdx, col, norm) {
		if (fxIdx === 3) {
			const row = REVSHIM_SPECS[col];
			actions.setRevShimParam(row[1], warpValue(row[2], row[3], norm, row[5]));
		} else {
			const row = SLOT_SPECS[state.slotType[fxIdx]][col];
			actions.setSlotParam(fxIdx, row[1], warpValue(row[2], row[3], norm, row[5]));
		}
	}
	function getParamNorm(specIdx) {
		const row = SPECS[specIdx];
		const track = state.seq[state.layerSel];
		const v = track.selectedStep != null && track.steps[track.selectedStep].locks[row[0]] != null
			? track.steps[track.selectedStep].locks[row[0]]
			: state.lp[state.layerSel][row[1]];
		return unwarpValue(row[3], row[4], v, row[7]);
	}
	function setParamNorm(specIdx, norm) {
		const row = SPECS[specIdx];
		const v = warpValue(row[3], row[4], norm, row[7]);
		actions.setLayerParam(state.layerSel, row[0], v);
	}
	function getFxBypass(fxIdx) {
		if (fxIdx === 3) return !state.revShimParams.active;
		return !state.slotParams[fxIdx].active;
	}
	function toggleFxBypass(fxIdx) {
		if (fxIdx === 3) actions.toggleRevShimActive();
		else actions.toggleSlotActive(fxIdx);
	}

	// ---- momentary/latch key handling (spec padKeyDown/padKeyUp/padUnlatch) ----

	function findLatched(layer, pitch) {
		return state.padLatched.find((e) => e.layer === layer && e.pitch === pitch);
	}
	function unlatch(e) {
		const i = state.padLatched.indexOf(e);
		if (i >= 0) state.padLatched.splice(i, 1);
		actions.stopNoteMomentary(e.layer, e.pitch);
		if (e.step != null) actions.recordStepLength(e.layer, e.step, (performance.now() - e.t0) / 1000);
	}
	function keyUp(idx) {
		const h = state.padHeld.get(idx);
		if (h) {
			state.padHeld.delete(idx);
			actions.stopNoteMomentary(h.layer, h.pitch);
			if (h.step != null) actions.recordStepLength(h.layer, h.step, (performance.now() - h.t0) / 1000);
		}
	}
	function keysOffMomentary() {
		for (const idx of [...state.padHeld.keys()]) keyUp(idx);
	}
	function unlatchLayer(layer) {
		for (const e of state.padLatched.slice()) if (e.layer === layer) unlatch(e);
	}
	function allKeysOff() {
		keysOffMomentary();
		for (const e of state.padLatched.slice()) unlatch(e);
	}

	function keyDown(col, row, vel) {
		const layer = state.layerSel;
		const pitch = keyPitch(col, row);
		const idx = row * 8 + col;
		const latch = state.padLatchMode[layer] || shiftOn();
		const already = findLatched(layer, pitch);
		if (pitch > 127) return;
		if (already) { unlatch(already); return; }
		if (state.padHeld.has(idx)) return;
		const v = Math.max(0.05, Math.min(1, vel / 127));
		actions.playNoteMomentary(layer, pitch);
		let step = null;
		if (state.recArm) {
			const targetIdx = state.playing ? sequencer.nearestStepIndex(layer) : (state.seq[layer].selectedStep != null ? state.seq[layer].selectedStep : 0);
			if (targetIdx != null) step = actions.recordStepNote(layer, targetIdx, pitch);
		}
		const entry = { pitch, vel: v, t0: performance.now(), step, layer };
		if (latch) state.padLatched.push(entry);
		else state.padHeld.set(idx, entry);
	}

	// ---- top-level dispatch ------------------------------------------

	function handleNote(num, vel) {
		if (vel === 0) { handleRelease(num); return; }
		if (num >= 11 && num <= 88 && (num % 10) >= 1 && (num % 10) <= 8) {
			const col = (num % 10) - 1;
			const row = 7 - (Math.floor(num / 10) - 1);
			gridPress(col, row, vel);
			return;
		}
		if ([19, 29, 39, 49, 59, 69, 79, 89].includes(num)) {
			const row = 7 - (Math.floor(num / 10) - 1);
			rightColPress(row);
			return;
		}
		scheduleRefresh();
	}

	function handleRelease(num) {
		if (num >= 11 && num <= 88 && (num % 10) >= 1 && (num % 10) <= 8) {
			const col = (num % 10) - 1;
			const row = 7 - (Math.floor(num / 10) - 1);
			const idx = row * 8 + col;
			if (state.padHeld.has(idx)) keyUp(idx);
			scheduleRefresh();
		}
	}

	function gridPress(col, row, vel) {
		if (state.padFocus === "fx") {
			if (col < fxParamCount(state.padFx)) setFxNorm(state.padFx, col, (7 - row) / 7);
		} else {
			if (state.padMode === 0) {
				stepPress(row * 8 + col);
			} else if (state.padMode === 1) {
				const si = state.padPage * 8 + col;
				if (si < SPECS.length) setParamNorm(si, (7 - row) / 7);
			} else if (state.padMode === 2) {
				if (state.padScaleEdit) scalePick(col, row);
				else keyDown(col, row, vel);
			}
		}
		scheduleRefresh();
	}

	function stepPress(idx) {
		const layer = state.layerSel;
		const track = state.seq[layer];
		if (idx >= track.length) return;
		actions.clickStep(layer, idx);
	}

	function scalePick(col, row) {
		if (row < 2) {
			const i = row * 8 + col;
			if (i < 12) { state.keyRoot = i; }
		} else if (row >= 3 && row <= 4) {
			const i = (row - 3) * 8 + col;
			if (i < SCALE_NAMES.length) state.keyScale = i;
		}
	}

	function rightColPress(row) {
		if (row < 4) {
			if (shiftOn()) {
				actions.toggleMute(row);
			} else {
				keysOffMomentary();
				state.padFocus = "eng";
				actions.selectLayer(row);
			}
		} else {
			if (shiftOn()) {
				toggleFxBypass(row - 4);
			} else {
				keysOffMomentary();
				state.padFocus = "fx";
				state.padFx = row - 4;
			}
		}
	}

	function handleCC(num, val) {
		if (num === 80) {
			if (val > 0) { state.padShift = true; shiftGraceUntil = 0; }
			else { state.padShift = false; shiftGraceUntil = performance.now() + CC_DEBOUNCE_GRACE_MS; }
			scheduleRefresh();
			return;
		}
		if (val <= 0) return; // launchpad.js already debounces repeats
		leftOrTopPress(num);
		scheduleRefresh();
	}

	function leftOrTopPress(num) {
		if ([10, 20, 30, 40, 50, 60, 70].includes(num)) {
			const row = 7 - (Math.floor(num / 10) - 1);
			if (row === 7) { actions.toggleRecArm(); return; }
			if (row >= 1 && row <= 4) { state.padFocus = "eng"; state.padMode = 1; state.padPage = row - 1; return; }
			if (row === 5) { if (state.padMode === 2) state.padKeyBase = Math.min(96, state.padKeyBase + 12); return; }
			if (row === 6) { if (state.padMode === 2) state.padKeyBase = Math.max(0, state.padKeyBase - 12); return; }
			return;
		}
		if (num >= 91 && num <= 98) {
			const layer = state.layerSel;
			switch (num - 91) {
				case 0: actions.setTrackLength(layer, state.seq[layer].length + (shiftOn() ? 8 : 1)); break;
				case 1: actions.setTrackLength(layer, state.seq[layer].length - (shiftOn() ? 8 : 1)); break;
				case 2: if (shiftOn()) actions.clrTrack(layer); else actions.delStep(layer); break;
				case 3: actions.playToggle(); break;
				case 4:
					if (shiftOn()) { actions.randomizeTrack(layer); }
					else { keysOffMomentary(); state.padScaleEdit = false; state.padFocus = "eng"; state.padMode = 0; }
					break;
				case 5:
					state.padFocus = "eng"; state.padMode = 2;
					if (shiftOn()) {
						state.padScaleEdit = !state.padScaleEdit;
						if (state.padScaleEdit) keysOffMomentary();
					} else state.padScaleEdit = false;
					break;
				case 6:
					keysOffMomentary(); state.padScaleEdit = false; state.padFocus = "eng"; state.padMode = 1;
					break;
				case 7:
					if (shiftOn()) {
						state.padLatchMode = [false, false, false, false];
						allKeysOff();
					} else {
						state.padLatchMode[layer] = !state.padLatchMode[layer];
						if (!state.padLatchMode[layer]) unlatchLayer(layer);
					}
					break;
			}
		}
	}

	// ---- PLAY-button tempo blink (spec §10.3/10.5, "SOHA nem sötét") -------

	function startBlink() {
		if (blinkTimer) return;
		const step = () => {
			blinkOn = !blinkOn;
			scheduleRefresh();
			const beatMs = (60000 / (sequencer.getTempo() || 120)) / 2;
			blinkTimer = setTimeout(step, Math.max(60, beatMs));
		};
		blinkTimer = setTimeout(step, 300);
	}
	function stopBlink() { if (blinkTimer) clearTimeout(blinkTimer); blinkTimer = null; }

	// ---- redraw (spec §10.4/10.5, throttled ~33/s via shared Launchpad.setLed) --

	// The shared Launchpad driver already diffs+coalesces individual setLed()
	// calls into throttled batched SysEx sends (~33/s, spec §10.6 padRefresh),
	// so redraw() can simply be called synchronously on every state change.
	function scheduleRefresh() {
		if (!connected) return;
		redraw();
	}

	function padCols(setPx, count, getNorm, fillC) {
		for (let col = 0; col < 8; col++) {
			let lvl = -1;
			if (col < count) lvl = Math.round(Math.max(0, Math.min(1, getNorm(col))) * 7);
			for (let row = 0; row < 8; row++) {
				const fromBottom = 7 - row;
				let c = PAD_C.cOff;
				if (col < count) {
					c = fromBottom === lvl ? PAD_C.cTip : fromBottom < lvl ? fillC : PAD_C.cDim;
				}
				setPx(padGidx(col, row), c);
			}
		}
	}

	function redraw() {
		if (!lp.connected) return;
		const layer = state.layerSel;
		const track = state.seq[layer];
		const sel = track.selectedStep;
		const engFocus = state.padFocus === "eng";
		const paramMode = engFocus && state.padMode === 1;
		const keysMode = engFocus && state.padMode === 2;
		const set = (idx, c) => lp.setLed(idx, c);

		if (engFocus && state.padMode === 0) {
			for (let i = 0; i < 64; i++) {
				const st = track.steps[i];
				let c = PAD_C.cOff;
				if (i < track.length) {
					if (state.playing && i === track.pos) c = PAD_C.cPlayhead;
					else if (i === sel) c = PAD_C.cStepSel;
					else if (st.on) c = Object.keys(st.locks).length ? PAD_C.cStepLock : (st.notes.length > 1 ? PAD_C.cStepChord : PAD_C.cStepOn);
					else c = PAD_C.cDim;
				}
				set(padGidx(i % 8, Math.floor(i / 8)), c);
			}
		} else if (engFocus && state.padMode === 2 && state.padScaleEdit) {
			const base = PAD_C.cEngine[layer];
			const dim = base.map((v) => Math.max(1, Math.floor(v / 5)));
			for (let row = 0; row < 8; row++) for (let col = 0; col < 8; col++) {
				let c = PAD_C.cOff, i;
				if (row < 2) { i = row * 8 + col; if (i < 12) c = i === state.keyRoot ? base : dim; }
				else if (row >= 3 && row <= 4) { i = (row - 3) * 8 + col; if (i < SCALE_NAMES.length) c = i === state.keyScale ? PAD_C.cModeOn : PAD_C.cModeOff; }
				set(padGidx(col, row), c);
			}
		} else if (engFocus && state.padMode === 2) {
			const sc = SCALES[state.keyScale];
			const base = PAD_C.cEngine[layer];
			for (let row = 0; row < 8; row++) for (let col = 0; col < 8; col++) {
				const pitch = keyPitch(col, row);
				const isRoot = keyDegree(col, row) % sc.length === 0;
				let c;
				if (pitch > 127) c = PAD_C.cOff;
				else if (state.padHeld.has(row * 8 + col)) c = PAD_C.cTip;
				else if (findLatched(layer, pitch)) c = PAD_C.cKeyLatch;
				else c = isRoot ? base : base.map((v) => Math.max(1, Math.floor(v / 5)));
				set(padGidx(col, row), c);
			}
		} else if (paramMode) {
			padCols(set, Math.max(0, Math.min(8, SPECS.length - state.padPage * 8)), (col) => getParamNorm(state.padPage * 8 + col), PAD_C.cFill);
		} else {
			padCols(set, Math.min(8, fxParamCount(state.padFx)), (col) => getFxNorm(state.padFx, col), PAD_C.cFxFill);
		}

		// right column
		for (let k = 0; k < 4; k++) {
			const base = PAD_C.cEngine[k];
			let engC;
			if (shiftOn() || state.muted[k]) engC = state.muted[k] ? PAD_C.cMuteOn : PAD_C.cMuteOff;
			else engC = engFocus && k === layer ? base : base.map((v) => Math.floor(v / 8));
			set(padRight(k), engC);
			const byp = getFxBypass(k);
			set(padRight(k + 4), (shiftOn() || byp) ? (byp ? PAD_C.cMuteOn : PAD_C.cMuteOff) : (!engFocus && k === state.padFx ? PAD_C.cFx : PAD_C.cFxDim));
		}

		// left column
		set(padLeft(0), shiftOn() ? PAD_C.cShiftOn : PAD_C.cDim);
		for (let k = 0; k < 4; k++) set(padLeft(k + 1), paramMode ? (k === state.padPage ? PAD_C.cPageOn : PAD_C.cPageOff) : PAD_C.cOff);
		set(padLeft(5), keysMode ? PAD_C.cOctBtn : PAD_C.cOff);
		set(padLeft(6), keysMode ? PAD_C.cOctBtn : PAD_C.cOff);
		set(padLeft(7), state.recArm ? PAD_C.cRecOn : PAD_C.cRecOff);

		// top row
		set(padTop(0), track.length < 64 ? PAD_C.cOctBtn : PAD_C.cOff);
		set(padTop(1), track.length > 1 ? PAD_C.cOctBtn : PAD_C.cOff);
		set(padTop(2), shiftOn() ? PAD_C.cWarn : (sel != null ? PAD_C.cStepSel : PAD_C.cDim));
		set(padTop(3), state.playing ? (blinkOn ? PAD_C.cPlayOn : PAD_C.cPlayDim) : PAD_C.cPlayOff);
		set(padTop(4), shiftOn() ? PAD_C.cFill : (engFocus && state.padMode === 0 ? PAD_C.cModeOn : PAD_C.cModeOff));
		set(padTop(5), state.padScaleEdit ? PAD_C.cStepSel : (keysMode ? PAD_C.cModeOn : PAD_C.cModeOff));
		set(padTop(6), paramMode ? PAD_C.cModeOn : PAD_C.cModeOff);
		set(padTop(7), state.padLatchMode[layer] ? PAD_C.cHoldOn : PAD_C.cHoldOff);

		// bottom row: position bar
		for (let col = 0; col < 8; col++) {
			const seg = state.playing ? Math.max(0, Math.min(7, Math.floor((track.pos / Math.max(1, track.length)) * 8))) : -1;
			set(padBottom(col), col === seg ? PAD_C.cPlayhead : PAD_C.cDim);
		}
	}

	async function connect() {
		connected = await lp.connect();
		if (connected) { startBlink(); redraw(); }
		return connected;
	}
	async function disconnect() {
		stopBlink();
		await lp.disconnect();
		connected = false;
	}

	return { connect, disconnect, scheduleRefresh, get connected() { return connected; } };
}
