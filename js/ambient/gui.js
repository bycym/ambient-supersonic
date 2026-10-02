// Plain-DOM GUI (spec §9), mirroring the original Qt window's panel grouping.
// Every control here calls into the shared `actions` module (spec §10.7) —
// nothing here mutates state directly.

import {
	LAYERS, STRUCTURES, MOD_SHAPES, FILTER_NAMES, LFO_DESTS, WAVE_NAMES, NOISE_SRC_NAMES,
	NOTE_NAMES, SCALE_NAMES, ROOT_NAMES, SEQ_DIV_NAMES, SPECS, SLOT_TYPE_NAMES, SLOT_SPECS,
	REVSHIM_SPECS, MASTER_SPECS, warpValue, unwarpValue, midiFromNoteIndex, noteIndexFromMidi,
} from "./data.js";
import * as PatchMod from "./patch.js";

function el(tag, cls, text) {
	const e = document.createElement(tag);
	if (cls) e.className = cls;
	if (text != null) e.textContent = text;
	return e;
}
function selectEl(options, onChange, selectedIdx) {
	const s = el("select");
	options.forEach((label, i) => {
		const o = el("option", null, label);
		o.value = i;
		s.appendChild(o);
	});
	s.value = selectedIdx || 0;
	s.addEventListener("change", () => onChange(parseInt(s.value, 10)));
	return s;
}
function fmtVal(v, unit) {
	if (unit === "ct" || unit === "Hz") return Math.round(v) + unit;
	return (Math.round(v * 100) / 100) + unit;
}

export function buildGui({ panel, state, actions, engine, sequencer, launchpad }) {
	panel.innerHTML = "";
	const root = el("div", "az-root");
	panel.appendChild(root);

	// ================= Top transport bar =================
	const top = el("div", "az-topbar");
	root.appendChild(top);
	top.appendChild(el("div", "az-title", "ambient_zero"));

	const playBtn = el("button", "az-btn az-play", "PLAY");
	playBtn.addEventListener("click", () => actions.playToggle());
	top.appendChild(playBtn);

	const metronomeBtn = el("button", "az-btn az-metronome", "METRO");
	metronomeBtn.title = "Arm or disarm metronome";
	metronomeBtn.addEventListener("click", () => {
		sequencer.setMetronome(!sequencer.metronomeOn);
		refresh();
	});
	top.appendChild(metronomeBtn);

	const tempoWrap = el("label", "az-field");
	tempoWrap.appendChild(el("span", null, "tempo"));
	const tempoInput = el("input");
	tempoInput.type = "number"; tempoInput.min = 20; tempoInput.max = 400; tempoInput.step = 1;
	tempoInput.addEventListener("input", () => actions.setTempo(parseFloat(tempoInput.value) || 120));
	tempoWrap.appendChild(tempoInput);
	top.appendChild(tempoWrap);

	const volWrap = el("label", "az-field");
	volWrap.appendChild(el("span", null, "vol"));
	const volInput = el("input");
	volInput.type = "range"; volInput.min = 0; volInput.max = 1; volInput.step = 0.01;
	volInput.addEventListener("input", () => actions.setVol(parseFloat(volInput.value)));
	volWrap.appendChild(volInput);
	top.appendChild(volWrap);

	const polyWrap = el("label", "az-field");
	polyWrap.appendChild(el("span", null, "poly"));
	const polyInput = el("input");
	polyInput.type = "number"; polyInput.min = 1; polyInput.max = 16; polyInput.step = 1;
	polyInput.addEventListener("input", () => actions.setMaxVoices(parseInt(polyInput.value, 10) || 6));
	polyWrap.appendChild(polyInput);
	top.appendChild(polyWrap);

	const recBtn = el("button", "az-btn az-rec-master", "REC");
	let masterRec = null;
	recBtn.addEventListener("click", () => {
		if (masterRec) {
			masterRec.rec.stop();
			masterRec.donePromise.then((blob) => {
				const a = document.createElement("a");
				a.href = URL.createObjectURL(blob);
				a.download = "ambient_zero_" + Date.now() + ".webm";
				a.click();
				setTimeout(() => URL.revokeObjectURL(a.href), 4000);
			});
			masterRec = null;
			recBtn.classList.remove("active");
			recBtn.textContent = "REC";
		} else {
			masterRec = engine.startMasterRecording();
			recBtn.classList.add("active");
			recBtn.textContent = "● REC";
		}
	});
	top.appendChild(recBtn);

	const meterEl = el("div", "az-meter", "out: --");
	top.appendChild(meterEl);

	const lpStatus = el("div", "az-lp-status", "Launchpad: not connected");
	top.appendChild(lpStatus);

	// ================= Patch panel =================
	const patchBar = el("div", "az-patchbar");
	root.appendChild(patchBar);
	const patchSelect = el("select", "az-patch-select");
	patchBar.appendChild(patchSelect);
	const nameField = el("input", "az-patch-name");
	nameField.type = "text"; nameField.value = "untitled"; nameField.placeholder = "patch name";
	patchBar.appendChild(nameField);

	function refreshPatchList() {
		patchSelect.innerHTML = "";
		for (const name of PatchMod.listPatches(PatchMod.NS)) {
			const o = el("option", null, name);
			o.value = name;
			patchSelect.appendChild(o);
		}
	}
	refreshPatchList();

	function mkBtn(label, cls, fn) {
		const b = el("button", "az-btn " + (cls || ""), label);
		b.addEventListener("click", fn);
		return b;
	}
	patchBar.appendChild(mkBtn("LOAD", null, async () => {
		const data = PatchMod.loadPatch(PatchMod.NS, patchSelect.value);
		if (!data) return;
		await PatchMod.applyPatch(state, data, { engine, refreshAll: refresh });
		state.currentPatchName = patchSelect.value;
		nameField.value = patchSelect.value;
	}));
	patchBar.appendChild(mkBtn("SAVE", null, () => {
		const name = state.currentPatchName && state.currentPatchName !== "untitled" ? state.currentPatchName : nameField.value || "untitled";
		PatchMod.savePatch(PatchMod.NS, name, PatchMod.serializePatch(state));
		state.currentPatchName = name;
		refreshPatchList();
	}));
	patchBar.appendChild(mkBtn("SAVE AS", null, () => {
		const name = nameField.value || "untitled";
		PatchMod.savePatch(PatchMod.NS, name, PatchMod.serializePatch(state));
		state.currentPatchName = name;
		refreshPatchList();
	}));
	patchBar.appendChild(mkBtn("DELETE", "az-danger", () => {
		PatchMod.deletePatch(PatchMod.NS, patchSelect.value);
		refreshPatchList();
	}));
	patchBar.appendChild(mkBtn("Export .azpatch", null, () => {
		const blob = PatchMod.exportAzpatchBlob(PatchMod.serializePatch(state));
		const a = document.createElement("a");
		a.href = URL.createObjectURL(blob);
		a.download = (state.currentPatchName || "untitled") + ".azpatch";
		a.click();
		setTimeout(() => URL.revokeObjectURL(a.href), 4000);
	}));
	const importInput = el("input");
	importInput.type = "file"; importInput.accept = ".azpatch,application/json"; importInput.style.display = "none";
	importInput.addEventListener("change", async () => {
		if (!importInput.files[0]) return;
		const data = await PatchMod.importAzpatchFile(importInput.files[0]);
		await PatchMod.applyPatch(state, data, { engine, refreshAll: refresh });
	});
	patchBar.appendChild(importInput);
	patchBar.appendChild(mkBtn("Import .azpatch", null, () => importInput.click()));

	const qrModal = el("div", "az-qr-modal hidden");
	const qrBox = el("div", "az-qr-box");
	qrModal.appendChild(qrBox);
	document.body.appendChild(qrModal);
	qrModal.addEventListener("click", (e) => { if (e.target === qrModal) qrModal.classList.add("hidden"); });
	patchBar.appendChild(mkBtn("Share via QR", null, () => {
		const url = PatchMod.buildShareUrl(PatchMod.NS, PatchMod.serializePatch(state));
		qrBox.innerHTML = "";
		qrBox.appendChild(el("div", "az-qr-hint", "Scan to load this patch"));
		const container = el("div");
		qrBox.appendChild(container);
		PatchMod.renderShareQr(container, url);
		const closeBtn = mkBtn("Close", null, () => qrModal.classList.add("hidden"));
		qrBox.appendChild(closeBtn);
		qrModal.classList.remove("hidden");
	}));

	// ================= Layer tabs =================
	const tabs = el("div", "az-tabs");
	root.appendChild(tabs);
	const tabBtns = [], muteBtns = [];
	LAYERS.forEach((name, i) => {
		const b = el("button", "az-tab", name);
		b.addEventListener("click", () => actions.selectLayer(i));
		tabs.appendChild(b);
		tabBtns.push(b);
	});
	const muteRow = el("div", "az-mutes");
	tabs.appendChild(muteRow);
	LAYERS.forEach((name, i) => {
		const b = el("button", "az-btn az-mute", "M" + (i + 1));
		b.addEventListener("click", () => actions.toggleMute(i));
		muteRow.appendChild(b);
		muteBtns.push(b);
	});

	// ================= Main body: param panel | sequencer =================
	const body = el("div", "az-body");
	root.appendChild(body);

	// ---- Param panel ----
	const paramPanel = el("div", "az-panel az-params");
	body.appendChild(paramPanel);
	const structLabel = el("div", "az-struct-label", "");
	paramPanel.appendChild(structLabel);

	const dropdownRow = el("div", "az-dropdown-row");
	paramPanel.appendChild(dropdownRow);
	const structSelectWrap = el("div", "az-field-inline");
	paramPanel.insertBefore(structSelectWrap, dropdownRow);
	let structSelect = selectEl(STRUCTURES, (v) => actions.setStructure(state.layerSel, v));
	structSelectWrap.appendChild(el("span", null, "structure"));
	structSelectWrap.appendChild(structSelect);

	const sampleBtnWrap = el("div", "az-field-inline hidden");
	const loadSampleBtn = mkBtn("Load Sample...", null, () => sampleFileInput.click());
	sampleBtnWrap.appendChild(loadSampleBtn);
	const sampleFileInput = el("input");
	sampleFileInput.type = "file"; sampleFileInput.accept = "audio/*"; sampleFileInput.style.display = "none";
	sampleFileInput.addEventListener("change", async () => {
		if (sampleFileInput.files[0]) await actions.loadSampleFile(sampleFileInput.files[0]);
	});
	sampleBtnWrap.appendChild(sampleFileInput);
	paramPanel.insertBefore(sampleBtnWrap, dropdownRow);

	const waveWrap = el("div", "az-field-inline");
	dropdownRow.appendChild(waveWrap);
	waveWrap.appendChild(el("span", null, "wave/src"));
	let waveSelect = selectEl(WAVE_NAMES, async (v) => actions.setWave(state.layerSel, v));
	waveWrap.appendChild(waveSelect);

	const filterWrap = el("div", "az-field-inline");
	dropdownRow.appendChild(filterWrap);
	filterWrap.appendChild(el("span", null, "filter"));
	const filterSelect = selectEl(FILTER_NAMES, (v) => actions.setLayerExtra(state.layerSel, "ftype", v));
	filterWrap.appendChild(filterSelect);

	const modShapeWrap = el("div", "az-field-inline");
	dropdownRow.appendChild(modShapeWrap);
	modShapeWrap.appendChild(el("span", null, "mod shape"));
	const modShapeSelect = selectEl(MOD_SHAPES, (v) => actions.setLayerExtra(state.layerSel, "modShape", v));
	modShapeWrap.appendChild(modShapeSelect);

	const l1destWrap = el("div", "az-field-inline");
	dropdownRow.appendChild(l1destWrap);
	l1destWrap.appendChild(el("span", null, "lfo1 dest"));
	const l1destSelect = selectEl(LFO_DESTS, (v) => actions.setLayerExtra(state.layerSel, "l1dest", v));
	l1destWrap.appendChild(l1destSelect);

	const l2destWrap = el("div", "az-field-inline");
	dropdownRow.appendChild(l2destWrap);
	l2destWrap.appendChild(el("span", null, "lfo2 dest"));
	const l2destSelect = selectEl(LFO_DESTS, (v) => actions.setLayerExtra(state.layerSel, "l2dest", v));
	l2destWrap.appendChild(l2destSelect);

	const sliderGrid = el("div", "az-slider-grid");
	paramPanel.appendChild(sliderGrid);
	const sliderRows = SPECS.map((row) => {
		const [id, key, name, lo, hi, def, unit, warp] = row;
		const rowEl = el("div", "az-slider-row");
		rowEl.appendChild(el("span", "az-slider-label", name));
		const range = el("input");
		range.type = "range"; range.min = 0; range.max = 1; range.step = 0.001;
		rowEl.appendChild(range);
		const readout = el("span", "az-slider-val", "");
		rowEl.appendChild(readout);
		range.addEventListener("input", () => {
			const v = warpValue(lo, hi, parseFloat(range.value), warp);
			actions.setLayerParam(state.layerSel, id, v);
		});
		sliderGrid.appendChild(rowEl);
		return { id, key, lo, hi, unit, warp, range, readout };
	});

	// ---- Sequencer panel ----
	const seqPanel = el("div", "az-panel az-seq");
	body.appendChild(seqPanel);
	seqPanel.appendChild(el("div", "az-panel-title", "SEQUENCER"));

	const keysRow = el("div", "az-field-row");
	seqPanel.appendChild(keysRow);
	keysRow.appendChild(el("span", null, "keys:"));
	const rootSelect = selectEl(ROOT_NAMES, (v) => { state.keyRoot = v; refresh(); });
	keysRow.appendChild(rootSelect);
	const scaleSelect = selectEl(SCALE_NAMES, (v) => { state.keyScale = v; refresh(); });
	keysRow.appendChild(scaleSelect);
	const octInput = el("input");
	octInput.type = "number"; octInput.min = -1; octInput.max = 7; octInput.step = 1;
	octInput.addEventListener("input", () => { state.padKeyBase = (parseInt(octInput.value, 10) + 1) * 12; refresh(); });
	keysRow.appendChild(el("span", null, "oct"));
	keysRow.appendChild(octInput);

	const noteRow = el("div", "az-field-row");
	seqPanel.appendChild(noteRow);
	noteRow.appendChild(el("span", null, "note"));
	const noteSelect = selectEl(NOTE_NAMES, (v) => actions.setSelectedStepNote(state.layerSel, midiFromNoteIndex(v)));
	noteRow.appendChild(noteSelect);
	noteRow.appendChild(el("span", null, "len"));
	const lenInput = el("input");
	lenInput.type = "number"; lenInput.min = 1; lenInput.max = 64; lenInput.step = 1;
	lenInput.addEventListener("input", () => actions.setTrackLength(state.layerSel, parseInt(lenInput.value, 10) || 16));
	noteRow.appendChild(lenInput);
	const recArmBtn = mkBtn("REC", "az-recarm", () => actions.toggleRecArm());
	noteRow.appendChild(recArmBtn);
	noteRow.appendChild(el("span", null, "div"));
	const divSelect = selectEl(SEQ_DIV_NAMES, (v) => actions.setTrackDiv(state.layerSel, v));
	noteRow.appendChild(divSelect);

	const seqBtnRow = el("div", "az-field-row");
	seqPanel.appendChild(seqBtnRow);
	seqBtnRow.appendChild(mkBtn("RND", null, () => actions.randomizeTrack(state.layerSel)));
	seqBtnRow.appendChild(mkBtn("DEL STEP", null, () => actions.delStep(state.layerSel)));
	seqBtnRow.appendChild(mkBtn("CLR TRACK", "az-danger az-clrtrack", () => {
		if (confirm("Clear the entire track?")) actions.clrTrack(state.layerSel);
	}));

	const grid = el("div", "az-grid");
	seqPanel.appendChild(grid);
	const stepBtns = [];
	for (let i = 0; i < 64; i++) {
		const b = el("button", "az-step");
		b.addEventListener("click", () => actions.clickStep(state.layerSel, i));
		grid.appendChild(b);
		stepBtns.push(b);
	}

	const chordReadout = el("div", "az-chord", "(select a step)");
	seqPanel.appendChild(chordReadout);

	// ---- Param-lock panel ----
	const lockPanel = el("div", "az-panel az-lock");
	seqPanel.appendChild(lockPanel);
	lockPanel.appendChild(el("div", "az-panel-title", "PARAM LOCK"));
	const lockRow = el("div", "az-field-row");
	lockPanel.appendChild(lockRow);
	const lockParamSelect = selectEl(SPECS.map((s) => s[2]), (v) => { state.lockSpecId = SPECS[v][0]; refresh(); });
	lockRow.appendChild(lockParamSelect);
	const lockSlider = el("input");
	lockSlider.type = "range"; lockSlider.min = 0; lockSlider.max = 1; lockSlider.step = 0.001;
	lockRow.appendChild(lockSlider);
	const lockReadout = el("span", null, "");
	lockRow.appendChild(lockReadout);
	lockSlider.addEventListener("input", () => {
		const row = SPECS.find((s) => s[0] === state.lockSpecId);
		lockReadout.textContent = fmtVal(warpValue(row[3], row[4], parseFloat(lockSlider.value), row[7]), row[6]);
	});
	const lockBtnRow = el("div", "az-field-row");
	lockPanel.appendChild(lockBtnRow);
	lockBtnRow.appendChild(mkBtn("SET LOCK", null, () => {
		const row = SPECS.find((s) => s[0] === state.lockSpecId);
		actions.setLock(state.layerSel, state.lockSpecId, warpValue(row[3], row[4], parseFloat(lockSlider.value), row[7]));
	}));
	lockBtnRow.appendChild(mkBtn("CLR LOCK", null, () => actions.clrLock(state.layerSel, state.lockSpecId)));
	const lockStatus = el("div", "az-lock-status", "(select a step)");
	lockPanel.appendChild(lockStatus);

	// ================= FX chain =================
	const fxChain = el("div", "az-panel az-fxchain");
	root.appendChild(fxChain);
	fxChain.appendChild(el("div", "az-panel-title", "FX CHAIN"));
	const fxRow = el("div", "az-fx-row");
	fxChain.appendChild(fxRow);

	function mkSlotBox(slotIdx) {
		const box = el("div", "az-fxbox");
		box.appendChild(el("div", "az-panel-title", "FX" + (slotIdx + 1)));
		const head = el("div", "az-field-row");
		box.appendChild(head);
		const typeSelect = selectEl(SLOT_TYPE_NAMES, async (v) => { await actions.setSlotType(slotIdx, v); rebuildSliders(); });
		head.appendChild(typeSelect);
		const activeBtn = mkBtn("ON", null, () => actions.toggleSlotActive(slotIdx));
		head.appendChild(activeBtn);
		const sliderHost = el("div");
		box.appendChild(sliderHost);
		let sliders = [];
		function rebuildSliders() {
			sliderHost.innerHTML = "";
			sliders = SLOT_SPECS[state.slotType[slotIdx]].map((row) => {
				const [label, key, lo, hi, def, warp] = row;
				const r = el("div", "az-slider-row");
				r.appendChild(el("span", "az-slider-label", label));
				const range = el("input");
				range.type = "range"; range.min = 0; range.max = 1; range.step = 0.001;
				r.appendChild(range);
				const readout = el("span", "az-slider-val", "");
				r.appendChild(readout);
				range.addEventListener("input", () => actions.setSlotParam(slotIdx, key, warpValue(lo, hi, parseFloat(range.value), warp)));
				sliderHost.appendChild(r);
				return { key, lo, hi, warp, range, readout };
			});
		}
		rebuildSliders();
		return {
			box, typeSelect, activeBtn,
			refresh() {
				typeSelect.value = state.slotType[slotIdx];
				const active = !!state.slotParams[slotIdx].active;
				activeBtn.textContent = active ? "ON" : "BYP";
				activeBtn.classList.toggle("active", active);
				for (const s of sliders) {
					const v = state.slotParams[slotIdx][s.key];
					s.range.value = unwarpValue(s.lo, s.hi, v, s.warp);
					s.readout.textContent = fmtVal(v, "");
				}
			},
		};
	}
	const slotBoxes = [0, 1, 2].map(mkSlotBox);
	slotBoxes.forEach((b) => fxRow.appendChild(b.box));

	// ---- fixed boxes ----
	const fixedRow = el("div", "az-fixed-row");
	root.appendChild(fixedRow);
	function mkFixedBox(title, specs, getParams, setParam, toggleActive) {
		const box = el("div", "az-fxbox");
		box.appendChild(el("div", "az-panel-title", title));
		const activeBtn = mkBtn("ON", null, toggleActive);
		box.appendChild(activeBtn);
		const sliders = specs.map((row) => {
			const [label, key, lo, hi, def, warp] = row;
			const r = el("div", "az-slider-row");
			r.appendChild(el("span", "az-slider-label", label));
			const range = el("input");
			range.type = "range"; range.min = 0; range.max = 1; range.step = 0.001;
			r.appendChild(range);
			const readout = el("span", "az-slider-val", "");
			r.appendChild(readout);
			range.addEventListener("input", () => setParam(key, warpValue(lo, hi, parseFloat(range.value), warp)));
			box.appendChild(r);
			return { key, lo, hi, warp, range, readout };
		});
		return {
			box,
			refresh() {
				const p = getParams();
				activeBtn.textContent = p.active ? "ON" : "BYP";
				activeBtn.classList.toggle("active", !!p.active);
				for (const s of sliders) {
					const v = p[s.key];
					s.range.value = unwarpValue(s.lo, s.hi, v, s.warp);
					s.readout.textContent = fmtVal(v, "");
				}
			},
		};
	}
	const revShimBox = mkFixedBox("REVERB + SHIMMER", REVSHIM_SPECS, () => state.revShimParams, (k, v) => actions.setRevShimParam(k, v), () => actions.toggleRevShimActive());
	const masterBox = mkFixedBox("MASTER (comp+lim)", MASTER_SPECS, () => state.masterParams, (k, v) => actions.setMasterParam(k, v), () => actions.toggleMasterActive());
	fixedRow.appendChild(revShimBox.box);
	fixedRow.appendChild(masterBox.box);
	fixedRow.appendChild(meterEl);

	// ================= refresh =================

	function refresh() {
		tabBtns.forEach((b, i) => b.classList.toggle("active", i === state.layerSel));
		muteBtns.forEach((b, i) => b.classList.toggle("active", state.muted[i]));

		const layer = state.layerSel;
		const isTonal = layer <= 2;
		structLabel.textContent = LAYERS[layer] + " -- " + (isTonal ? STRUCTURES[state.structure[layer]] : "NOISE");
		structSelectWrap.classList.toggle("hidden", !isTonal);
		sampleBtnWrap.classList.toggle("hidden", !(layer === 3 && state.noiseSrc === 9));
		if (isTonal) structSelect.value = state.structure[layer];

		waveWrap.querySelector("span").textContent = isTonal ? "wave" : "source";
		const waveOptions = isTonal ? WAVE_NAMES : NOISE_SRC_NAMES;
		if (waveSelect.dataset.mode !== (isTonal ? "wave" : "noise")) {
			waveSelect.innerHTML = "";
			waveOptions.forEach((label, i) => { const o = el("option", null, label); o.value = i; waveSelect.appendChild(o); });
			waveSelect.dataset.mode = isTonal ? "wave" : "noise";
			waveSelect.onchange = () => {
				const v = parseInt(waveSelect.value, 10);
				if (isTonal) actions.setWave(layer, v);
				else {
					actions.setNoiseSrc(v);
					if (v === 9 && !state.usrChans) sampleFileInput.click();
				}
			};
		}
		waveSelect.value = isTonal ? Math.max(0, state.curWave[layer]) : state.noiseSrc;

		const lp = state.lp[layer];
		filterSelect.value = lp.ftype;
		modShapeSelect.value = lp.modShape;
		l1destSelect.value = lp.l1dest;
		l2destSelect.value = lp.l2dest;

		const track = state.seq[layer];
		for (const s of sliderRows) {
			const locked = track.selectedStep != null && track.steps[track.selectedStep].locks[s.id] !== undefined;
			const v = locked ? track.steps[track.selectedStep].locks[s.id] : lp[s.key];
			s.range.value = unwarpValue(s.lo, s.hi, v, s.warp);
			s.readout.textContent = fmtVal(v, s.unit) + (locked ? " •L" : "");
		}

		tempoInput.value = state.tempoBpm;
		volInput.value = state.vol;
		polyInput.value = state.maxVoices;
		playBtn.textContent = state.playing ? "STOP" : "PLAY";
		playBtn.classList.toggle("active", state.playing);
		metronomeBtn.classList.toggle("active", sequencer.metronomeOn);
		metronomeBtn.setAttribute("aria-pressed", String(sequencer.metronomeOn));
		recArmBtn.classList.toggle("active", state.recArm);

		rootSelect.value = state.keyRoot;
		scaleSelect.value = state.keyScale;
		octInput.value = Math.round(state.padKeyBase / 12) - 1;
		noteSelect.value = noteIndexFromMidi(track.selectedStep != null ? track.steps[track.selectedStep].notes[0] : 60);
		lenInput.value = track.length;
		divSelect.value = track.div;

		for (let i = 0; i < 64; i++) {
			const st = track.steps[i];
			const b = stepBtns[i];
			b.classList.toggle("disabled", i >= track.length);
			b.classList.toggle("on", st.on);
			b.classList.toggle("selected", track.selectedStep === i);
			b.classList.toggle("playhead", state.playing && track.pos === i);
			b.classList.toggle("locked", Object.keys(st.locks).length > 0);
			b.classList.toggle("chord", st.notes.length > 1);
		}
		if (track.selectedStep != null) {
			const st = track.steps[track.selectedStep];
			chordReadout.textContent = "notes: " + st.notes.map((n) => NOTE_NAMES[noteIndexFromMidi(n)]).join(",") + `  vel:${st.vel.toFixed(2)}  len:${st.len.toFixed(2)}`;
			const lockNames = Object.keys(st.locks).map((id) => SPECS.find((s) => s[0] === id)[2]);
			lockStatus.textContent = lockNames.length ? "locks: " + lockNames.join(", ") : "no locks on this step";
		} else {
			chordReadout.textContent = "(select a step)";
			lockStatus.textContent = "(select a step)";
		}
		lockParamSelect.value = SPECS.findIndex((s) => s[0] === state.lockSpecId);

		slotBoxes.forEach((b) => b.refresh());
		revShimBox.refresh();
		masterBox.refresh();

		lpStatus.textContent = "Launchpad: " + (launchpad && launchpad.connected ? "connected" : "not connected");
	}

	refresh();
	return { refresh, meterEl, refreshPatchList };
}
