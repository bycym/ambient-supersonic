// Plain-DOM GUI (spec §9), mirroring the original Qt window's panel grouping.
// Every control here calls into the shared `actions` module (spec §10.7) —
// nothing here mutates state directly.

import {
	LAYERS, STRUCTURES, NOISE_STRUCTURES, MOD_SHAPES, FILTER_NAMES, LFO_DESTS, WAVE_NAMES, NOISE_SRC_NAMES,
	NOTE_NAMES, SCALE_NAMES, ROOT_NAMES, SCALES, SEQ_DIV_NAMES, activeEngineSpecs, GLITCH_PERC_MODES, SLOT_TYPE_NAMES, SLOT_SPECS,
	REVSHIM_SPECS, MASTER_SPECS, PUMP_SPECS, MASTER_FILTER_SPECS, warpValue, unwarpValue, midiFromNoteIndex, noteIndexFromMidi,
} from "./data.js";
import * as PatchMod from "./patch.js";
import { STEMS, selectedStems } from "./stem-format.js";
import { startStemExport } from "./stem-export.js";
import { noteOffsets } from "./sequencer.js";
import { stepShortcut } from "./shortcuts.js";
import { COMPUTER_KEY_ROWS, createComputerKeyboard } from "./computer-keyboard.js";

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
function pitchLabel(midi) {
	if (midi >= 12 && midi <= 108) return NOTE_NAMES[midi - 12];
	return `MIDI ${midi}`;
}

export function buildGui({ panel, state, actions, engine, sequencer, launchpad, audioContext, stemSource }) {
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
	tempoInput.type = "text"; tempoInput.inputMode = "decimal";
	const commitTempo = () => {
		const raw = tempoInput.value.trim();
		const bpm = raw && Number.isFinite(Number(raw)) ? Number(raw) : 60;
		actions.setTempo(bpm);
		tempoInput.value = state.tempoBpm;
	};
	tempoInput.addEventListener("blur", commitTempo);
	tempoInput.addEventListener("keydown", (event) => { if (event.key === "Enter") { commitTempo(); tempoInput.blur(); } });
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

	const recExportBtn = el("button", "az-btn az-rec-master", "REC WAV");
	top.appendChild(recExportBtn);

	const meterEl = el("div", "az-meter", "out: --");
	top.appendChild(meterEl);

	const lpStatus = el("div", "az-lp-status", "Launchpad: not connected");
	top.appendChild(lpStatus);
	const lpReconnect = el("button", "az-btn az-lp-reconnect", "CONNECT MIDI");
	lpReconnect.type = "button";
	lpReconnect.addEventListener("click", async () => {
		lpReconnect.disabled = true;
		lpReconnect.textContent = "CONNECTING…";
		lpStatus.textContent = "Launchpad: requesting MIDI access…";
		try {
			await launchpad.disconnect();
			const found = await launchpad.connect();
			lpStatus.textContent = found ? "Launchpad: connected" : "Launchpad not found — check USB connection";
		} catch (err) {
			lpStatus.textContent = "Launchpad: " + (err?.message || "MIDI access failed");
		}
		lpReconnect.disabled = false;
		lpReconnect.textContent = launchpad.connected ? "RECONNECT" : "CONNECT MIDI";
	});
	top.appendChild(lpReconnect);

	const pageNav = el("div", "az-tabs"); root.appendChild(pageNav);
	const playPageBtn = el("button", "az-tab active", "LAYERS");
	const mixerPageBtn = el("button", "az-tab", "MIXER");
	const masterPageBtn = el("button", "az-tab", "MASTER");
	const exportPageBtn = el("button", "az-tab", "EXPORT");
	pageNav.append(playPageBtn, mixerPageBtn, masterPageBtn, exportPageBtn);
	const playPage = el("div", "az-page"); root.appendChild(playPage);
	const mixerPage = el("div", "az-panel az-mixer-page hidden"); root.appendChild(mixerPage);
	const masterPage = el("div", "az-panel az-master-page hidden"); root.appendChild(masterPage);
	const exportPage = el("div", "az-panel az-export-page hidden"); root.appendChild(exportPage);
	function showPage(which) {
		state.page = which;
		playPage.classList.toggle("hidden", which !== "play");
		mixerPage.classList.toggle("hidden", which !== "mixer");
		exportPage.classList.toggle("hidden", which !== "export");
		masterPage.classList.toggle("hidden", which !== "master");
		playPageBtn.classList.toggle("active", which === "play");
		mixerPageBtn.classList.toggle("active", which === "mixer");
		exportPageBtn.classList.toggle("active", which === "export");
		masterPageBtn.classList.toggle("active", which === "master");
	}
	playPageBtn.onclick = () => showPage("play"); mixerPageBtn.onclick = () => showPage("mixer"); exportPageBtn.onclick = () => showPage("export"); masterPageBtn.onclick = () => showPage("master");
	mixerPage.appendChild(el("div", "az-panel-title", "MIXER"));
	const mixerStrips = el("div", "az-mixer-strips"); mixerPage.appendChild(mixerStrips);
	const mixerRefs = LAYERS.map((name, layer) => {
		const strip = el("section", "az-mixer-strip");
		strip.appendChild(el("h3", "az-mixer-heading", name));
		const controls = {};
		for (const [key, label, min, max, step] of [
			["level", "LEVEL", 0, 2, 0.01], ["pan", "PAN", -1, 1, 0.01], ["send", "REVERB SEND", 0, 2, 0.01],
		]) {
			const wrap = el("label", "az-mixer-control");
			const head = el("span", "az-mixer-control-head");
			head.appendChild(el("span", null, label));
			const readout = el("span", "az-mixer-readout"); head.appendChild(readout);
			const input = el("input"); input.type = "range"; input.min = min; input.max = max; input.step = step;
			input.setAttribute("aria-label", `${name} ${label.toLowerCase()}`);
			input.addEventListener("input", () => actions.setMixerTrim(layer, key, Number(input.value)));
			wrap.append(head, input); strip.appendChild(wrap);
			controls[key] = { input, readout };
		}
		const mute = mkBtn("MUTE", "az-mixer-mute", () => actions.setMixerMute(layer, !state.muted[layer]));
		mute.setAttribute("aria-label", `${name} mute`);
		const route = mkBtn("THROUGH FX", "az-mixer-route", () => actions.setLayerFxBypass(layer, !state.layerFxBypass[layer]));
		route.setAttribute("aria-label", `${name} FX route`);
		strip.append(mute, route);
		mixerStrips.appendChild(strip);
		return { controls, mute, route };
	});
	const mixerMaster = el("section", "az-mixer-master"); mixerPage.appendChild(mixerMaster);
	mixerMaster.appendChild(el("h3", "az-mixer-heading", "MASTER"));
	const mixerMasterLevel = el("input");
	mixerMasterLevel.type = "range"; mixerMasterLevel.min = 0; mixerMasterLevel.max = 1; mixerMasterLevel.step = 0.01;
	mixerMasterLevel.setAttribute("aria-label", "Master level");
	mixerMasterLevel.addEventListener("input", () => actions.setVol(Number(mixerMasterLevel.value)));
	mixerMaster.appendChild(mixerMasterLevel);
	const mixerMeter = el("div", "az-meter", "out: -inf dB"); mixerMaster.appendChild(mixerMeter);

	const prefKey = "ambient_zero_export_preferences";
	let prefs;
	try { prefs = JSON.parse(localStorage.getItem(prefKey)) || {}; } catch { prefs = {}; }
	prefs = { mode: "master", format: "float32", custom: [...STEMS], ...prefs };
	if (!Array.isArray(prefs.custom)) prefs.custom = [...STEMS];
	const savePrefs = () => localStorage.setItem(prefKey, JSON.stringify(prefs));
	exportPage.appendChild(el("div", "az-panel-title", "AUDIO EXPORT"));
	const modeRow = el("label", "az-field-row", "Mode"); exportPage.appendChild(modeRow);
	const modeSel = el("select");
	for (const [value, label] of [["master", "MASTER ONLY"], ["full", "FULL STEMS"], ["custom", "CUSTOM"]]) {
		const opt = el("option", null, label); opt.value = value; modeSel.appendChild(opt);
	}
	modeSel.value = ["master", "full", "custom"].includes(prefs.mode) ? prefs.mode : "master";
	modeRow.appendChild(modeSel);
	const formatRow = el("label", "az-field-row", "WAV format"); exportPage.appendChild(formatRow);
	const formatSel = el("select");
	for (const [value, label] of [["float32", "32-bit float"], ["pcm24", "24-bit PCM"], ["pcm16", "16-bit PCM"]]) {
		const opt = el("option", null, label); opt.value = value; formatSel.appendChild(opt);
	}
	formatSel.value = ["float32", "pcm24", "pcm16"].includes(prefs.format) ? prefs.format : "float32";
	formatRow.appendChild(formatSel);
	const customBox = el("div", "az-export-stems"); exportPage.appendChild(customBox);
	const stemChecks = STEMS.map((name) => {
		const label = el("label", "az-field-row"); const check = el("input"); check.type = "checkbox";
		check.checked = prefs.custom.includes(name); label.append(check, document.createTextNode(name.toUpperCase()));
		customBox.appendChild(label); check.onchange = () => { prefs.custom = STEMS.filter((n, i) => stemChecks[i].checked); savePrefs(); };
		return check;
	});
	const exportHint = el("div", "az-export-hint"); exportPage.appendChild(exportHint);
	exportPage.appendChild(el("div", "az-export-hint", "Use the recording button in the top bar to start or stop."));
	const exportStatus = el("div", "az-export-status", "Ready to export"); exportPage.appendChild(exportStatus);
	let exportController = null, exportBusy = false;
	function refreshExportControls() {
		prefs.mode = modeSel.value; prefs.format = formatSel.value;
		const selected = prefs.mode === "custom" ? STEMS.filter((_, i) => stemChecks[i].checked) : selectedStems(prefs.mode);
		customBox.classList.toggle("hidden", prefs.mode !== "custom");
		const bytes = selected.length * audioContext.sampleRate * 600 * 2 * (prefs.format === "float32" ? 4 : prefs.format === "pcm24" ? 3 : 2);
		exportHint.textContent = `${selected.length} stem(s) · up to ${(bytes / 1e9).toFixed(2)} GB for 10 minutes at ${audioContext.sampleRate} Hz. Stop after effect tails finish.`;
		modeSel.disabled = formatSel.disabled = exportBusy;
		stemChecks.forEach((check) => { check.disabled = exportBusy; });
		recExportBtn.disabled = exportBusy || (!exportController && !selected.length);
		recExportBtn.textContent = exportController ? "STOP REC" : exportBusy ? "SAVING…" : prefs.mode === "master" ? "REC WAV" : "REC STEMS";
		recExportBtn.title = exportController ? "Stop and save the recording" : prefs.mode === "master" ? "Record the master output as a WAV file" : "Record the selected stems as a ZIP file";
		recExportBtn.classList.toggle("active", !!exportController);
	}
	modeSel.onchange = () => { prefs.mode = modeSel.value; savePrefs(); refreshExportControls(); };
	formatSel.onchange = () => { prefs.format = formatSel.value; savePrefs(); refreshExportControls(); };
	stemChecks.forEach((check) => check.addEventListener("change", refreshExportControls));
	async function toggleExport() {
		if (exportBusy) return;
		exportBusy = true; refreshExportControls();
		try {
			if (exportController) {
				const controller = exportController; exportController = null;
				exportStatus.textContent = "Saving export…"; await controller.stop();
			} else {
				const selected = selectedStems(prefs.mode, prefs.custom);
				if (!window.showSaveFilePicker) throw new Error("Save As requires Chrome or Edge with the File System Access API");
				const now = new Date().toISOString().replace(/[:.]/g, "-");
				const isWav = prefs.mode === "master";
				const handle = await window.showSaveFilePicker({ suggestedName: `ambient_zero_${now}.${isWav ? "wav" : "zip"}`,
					types: [{ description: isWav ? "WAV audio" : "ZIP archive", accept: { [isWav ? "audio/wav" : "application/zip"]: [isWav ? ".wav" : ".zip"] } }] });
				exportStatus.textContent = "Preparing recording…";
				exportController = await startStemExport({ context: audioContext, source: stemSource, saveHandle: handle,
					selected, format: prefs.format, onStatus: (message) => { exportStatus.textContent = message; },
					onFinished: ({ frames, partial }) => { exportStatus.textContent = `${partial ? "Partial take" : "Saved"}: ${(frames / audioContext.sampleRate).toFixed(1)} seconds`; exportController = null; refreshExportControls(); } });
				exportStatus.textContent = `Recording export… maximum ${(exportController.frameLimit / audioContext.sampleRate / 60).toFixed(1)} minutes`;
			}
		} catch (error) {
			if (error.name !== "AbortError") {
				exportStatus.textContent = "Export failed: " + error.message;
				alert(exportStatus.textContent);
			}
		} finally { exportBusy = false; refreshExportControls(); }
	}
	recExportBtn.onclick = toggleExport;
	refreshExportControls();

	// ================= Patch panel =================
	const patchBar = el("div", "az-patchbar");
	root.insertBefore(patchBar, pageNav);
	const patchSelect = el("select", "az-patch-select");
	patchBar.appendChild(patchSelect);
	const nameField = el("input", "az-patch-name");
	nameField.type = "text"; nameField.value = "untitled"; nameField.placeholder = "patch name";
	patchBar.appendChild(nameField);

	function refreshPatchList(preferredName = patchSelect.value) {
		const names = PatchMod.listPatches(PatchMod.NS);
		patchSelect.innerHTML = "";
		for (const name of names) {
			const o = el("option", null, name);
			o.value = name;
			patchSelect.appendChild(o);
		}
		if (names.includes(preferredName)) patchSelect.value = preferredName;
	}
	refreshPatchList();

	function mkBtn(label, cls, fn) {
		const b = el("button", "az-btn " + (cls || ""), label);
		b.addEventListener("click", fn);
		return b;
	}
	function refreshKeySettings() {
		refresh();
		launchpad && launchpad.scheduleRefresh();
	}
	patchBar.appendChild(mkBtn("LOAD", null, async () => {
		const data = PatchMod.loadPatch(PatchMod.NS, patchSelect.value);
		if (!data) return;
		await PatchMod.applyPatch(state, data, { engine, sequencer, refreshAll: refresh });
		state.currentPatchName = patchSelect.value;
		nameField.value = patchSelect.value;
	}));
	function saveNamedPatch(name) {
		const savedName = name.trim() || "untitled";
		PatchMod.savePatch(PatchMod.NS, savedName, PatchMod.serializePatch(state));
		state.currentPatchName = savedName;
		nameField.value = savedName;
		refreshPatchList(savedName);
	}
	patchBar.appendChild(mkBtn("SAVE", null, () => {
		const name = state.currentPatchName && state.currentPatchName !== "untitled" ? state.currentPatchName : nameField.value || "untitled";
		saveNamedPatch(name);
	}));
	patchBar.appendChild(mkBtn("SAVE AS", null, () => {
		saveNamedPatch(nameField.value);
	}));
	patchBar.appendChild(mkBtn("DELETE", "az-danger", () => {
		const deletedName = patchSelect.value;
		if (!deletedName) return;
		PatchMod.deletePatch(PatchMod.NS, deletedName);
		if (state.currentPatchName === deletedName) {
			state.currentPatchName = null;
			nameField.value = "untitled";
		}
		refreshPatchList();
	}));
	patchBar.appendChild(mkBtn("Export .azpatch", null, () => {
		const blob = PatchMod.exportAzpatchBlob(PatchMod.serializePatch(state));
		const a = document.createElement("a");
		a.href = URL.createObjectURL(blob);
		a.download = (state.currentPatchName || nameField.value.trim() || "untitled") + ".azpatch";
		a.click();
		setTimeout(() => URL.revokeObjectURL(a.href), 4000);
	}));
	const importInput = el("input");
	importInput.type = "file"; importInput.accept = ".azpatch,application/json"; importInput.style.display = "none";
	importInput.addEventListener("change", async () => {
		if (!importInput.files[0]) return;
		const data = await PatchMod.importAzpatchFile(importInput.files[0]);
		await PatchMod.applyPatch(state, data, { engine, sequencer, refreshAll: refresh });
		state.currentPatchName = null;
		nameField.value = importInput.files[0].name.replace(/\.(azpatch|json)$/i, "") || "imported_patch";
		patchSelect.selectedIndex = -1;
	});
	patchBar.appendChild(importInput);
	patchBar.appendChild(mkBtn("Import .azpatch", null, () => importInput.click()));
	patchBar.appendChild(mkBtn("Copy Patch", null, async () => {
		try {
			await navigator.clipboard.writeText(JSON.stringify(PatchMod.serializePatch(state)));
		} catch (error) {
			alert("Could not copy patch: " + error.message);
		}
	}));
	patchBar.appendChild(mkBtn("Paste Patch", null, async () => {
		try {
			const data = JSON.parse(await navigator.clipboard.readText());
			await PatchMod.applyPatch(state, data, { engine, sequencer, refreshAll: refresh });
			state.currentPatchName = null;
			nameField.value = "clipboard_patch";
			patchSelect.selectedIndex = -1;
		} catch (error) {
			alert("Could not paste patch: " + error.message);
		}
	}));

	const qrModal = el("div", "az-qr-modal hidden");
	const qrBox = el("div", "az-qr-box");
	qrModal.appendChild(qrBox);
	document.body.appendChild(qrModal);
	qrModal.addEventListener("click", (e) => { if (e.target === qrModal) qrModal.classList.add("hidden"); });
	patchBar.appendChild(mkBtn("Share via QR", null, async () => {
		qrBox.innerHTML = "";
		qrBox.appendChild(el("div", "az-qr-hint", "Preparing share link…"));
		qrModal.classList.remove("hidden");
		try {
			const url = await PatchMod.buildShareUrl(PatchMod.NS, PatchMod.serializePatch(state));
			qrBox.innerHTML = "";
			qrBox.appendChild(el("div", "az-qr-hint", "Scan to load this patch"));
		const container = el("div");
		qrBox.appendChild(container);
		PatchMod.renderShareQr(container, url);
		const link = el("input", "az-share-link");
		link.value = url;
		link.readOnly = true;
		link.addEventListener("click", () => link.select());
		qrBox.appendChild(link);
		const copyBtn = mkBtn("Copy link", null, async () => {
			try { await navigator.clipboard.writeText(url); copyBtn.textContent = "Copied"; }
			catch { link.focus(); link.select(); }
		});
		qrBox.appendChild(copyBtn);
		const closeBtn = mkBtn("Close", null, () => qrModal.classList.add("hidden"));
		qrBox.appendChild(closeBtn);
		} catch (error) {
			qrBox.innerHTML = "";
			qrBox.appendChild(el("div", "az-qr-hint", "Could not create QR: " + error.message));
			qrBox.appendChild(mkBtn("Close", null, () => qrModal.classList.add("hidden")));
		}
	}));

	// ================= Layer tabs =================
	const tabs = el("div", "az-tabs");
	playPage.appendChild(tabs);
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
	playPage.appendChild(body);

	// ---- Param panel ----
	const paramPanel = el("div", "az-panel az-params");
	body.appendChild(paramPanel);
	const synthHeader = el("div", "az-synth-header");
	paramPanel.appendChild(synthHeader);
	synthHeader.appendChild(el("div", "az-eyebrow", "SOUND DESIGN / 01—04"));
	const structLabel = el("div", "az-struct-label", "");
	synthHeader.appendChild(structLabel);
	const editHint = el("div", "az-edit-hint", "Adjust layer sound here; arm REC and select a step to write locks");
	synthHeader.appendChild(editHint);
	const synthArmBtn = mkBtn("ARM STEP EDIT", "az-synth-arm", () => actions.toggleRecArm());
	synthHeader.appendChild(synthArmBtn);
	const layerFxRouteRow = el("div", "az-field-row az-layer-fx-route");
	paramPanel.appendChild(layerFxRouteRow);
	layerFxRouteRow.appendChild(el("strong", null, "LAYER FX ROUTE"));
	const layerFxRouteBtn = mkBtn("THROUGH FX1-3", null, () =>
		actions.setLayerFxBypass(state.layerSel, !state.layerFxBypass[state.layerSel]));
	layerFxRouteRow.appendChild(layerFxRouteBtn);

	const dropdownRow = el("div", "az-dropdown-row");
	paramPanel.appendChild(dropdownRow);
	const structSelectWrap = el("div", "az-field-inline");
	paramPanel.insertBefore(structSelectWrap, dropdownRow);
	let structSelect = selectEl(STRUCTURES, (v) => actions.setStructure(state.layerSel, v));
	structSelectWrap.appendChild(el("span", null, "structure"));
	structSelectWrap.appendChild(structSelect);
	const noiseStructWrap = el("div", "az-field-inline hidden");
	structSelectWrap.after(noiseStructWrap);
	noiseStructWrap.appendChild(el("span", null, "engine"));
	const noiseStructSelect = selectEl(NOISE_STRUCTURES, (v) => actions.setStructure(3, v + 7));
	noiseStructWrap.appendChild(noiseStructSelect);

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
	const grainControls = el("div", "az-field-inline hidden");
	const grainFileInput = el("input");
	grainFileInput.type = "file"; grainFileInput.accept = "audio/*"; grainFileInput.hidden = true;
	grainFileInput.addEventListener("change", async () => {
		if (grainFileInput.files[0]) await actions.loadGrainSampleFile(grainFileInput.files[0]);
		grainFileInput.value = "";
	});
	const grainLoadBtn = mkBtn("Load Grain WAV...", null, () => grainFileInput.click());
	let grainRecorder = null;
	const grainCaptureBtn = mkBtn("Capture Mic", null, async () => {
		if (grainRecorder) { grainRecorder.stop(); grainRecorder = null; grainCaptureBtn.textContent = "Capture Mic"; }
		else {
			grainCaptureBtn.textContent = "Stop Capture";
			try { grainRecorder = await engine.startGrainCapture(() => { grainRecorder = null; grainCaptureBtn.textContent = "Capture Mic"; actions.setGrainSource(0); }); }
			catch (err) { grainCaptureBtn.textContent = "Capture Mic"; alert("Microphone capture failed: " + err.message); }
		}
	});
	grainControls.append(grainLoadBtn, grainCaptureBtn, grainFileInput);
	paramPanel.insertBefore(grainControls, dropdownRow);

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
	const extraControlWraps = [filterWrap, modShapeWrap, l1destWrap, l2destWrap];

	const sliderGrid = el("div", "az-param-groups");
	const glitchModeRow = el("div", "az-glitch-modes az-field-row");
	glitchModeRow.appendChild(el("span", null, "hit"));
	const glitchModeButtons = GLITCH_PERC_MODES.map((name, mode) => {
		const button = mkBtn(name, "az-glitch-mode", () => {
			actions.setGlitchMode(state.layerSel, mode);
			actions.playNoteMomentary(state.layerSel, state.seqNote[state.layerSel] ?? 60);
		});
		glitchModeRow.appendChild(button);
		return button;
	});
	const glitchRandomButton = mkBtn("RND", "az-glitch-random", () => {
		actions.randomizeGlitchPerc(state.layerSel);
		actions.playNoteMomentary(state.layerSel, state.seqNote[state.layerSel] ?? 60);
	});
	glitchModeRow.appendChild(glitchRandomButton);
	const glitchBaseRow = el("div", "az-glitch-base az-field-row");
	glitchBaseRow.appendChild(el("span", null, "base"));
	const glitchBaseSelect = selectEl(GLITCH_PERC_MODES, (mode) => {
		actions.setGlitchMode(state.layerSel, mode);
		actions.playNoteMomentary(state.layerSel, state.seqNote[state.layerSel] ?? 60);
	});
	glitchBaseRow.appendChild(glitchBaseSelect);
	glitchBaseRow.appendChild(mkBtn("SAVE BASE", null, () => actions.saveGlitchBase(state.layerSel, parseInt(glitchBaseSelect.value, 10))));
	const glitchStepRndRow = el("div", "az-glitch-step-rnd az-field-row");
	const glitchStepRndButton = mkBtn("RND STEP SOUNDS", null, () => actions.randomizeGlitchStepSounds(state.layerSel));
	const glitchAllRndButton = mkBtn("RND ALL SOUNDS", null, () => actions.randomizeGlitchStepSounds(state.layerSel, true));
	const glitchStepRndHint = el("span", "az-glitch-step-rnd-hint");
	glitchStepRndRow.append(glitchStepRndButton, glitchAllRndButton, glitchStepRndHint);
	paramPanel.appendChild(glitchModeRow);
	paramPanel.appendChild(glitchBaseRow);
	paramPanel.appendChild(glitchStepRndRow);
	const sourceField = el("section", "az-param-group az-source-field");
	sourceField.appendChild(el("h3", "az-param-group-title", "SOURCE"));
	const sourceControls = el("div", "az-param-controls");
	sourceField.appendChild(sourceControls);
	paramPanel.append(sourceField, sliderGrid);
	const parameterGroups = {};
	for (const name of ["TONE", "MODULATION", "ENVELOPE", "FILTER", "OUTPUT"]) {
		const section = el("section", `az-param-group az-param-${name.toLowerCase()}`);
		section.appendChild(el("h3", "az-param-group-title", name));
		const controls = el("div", "az-param-controls");
		const sliders = el("div", "az-knob-grid");
		section.append(controls, sliders);
		sliderGrid.appendChild(section);
		parameterGroups[name] = { section, controls, sliders };
	}
	sourceControls.append(structSelectWrap, noiseStructWrap, sampleBtnWrap, grainControls, waveWrap,
		glitchModeRow, glitchBaseRow, glitchStepRndRow);
	parameterGroups.MODULATION.controls.append(modShapeWrap, l1destWrap, l2destWrap);
	parameterGroups.FILTER.controls.append(filterWrap);
	parameterGroups.OUTPUT.controls.append(layerFxRouteRow);
	dropdownRow.remove();
	let sliderRows = [];
	let sliderSpecKey = "";
	function groupForParameter(key) {
		if (["atk", "dec", "sus", "rel", "attack", "decay", "sustain", "release"].includes(key)) return "ENVELOPE";
		if (/^(l[12]|lfo|mod|pwmDepth|fmAmt|ringAmt)/i.test(key)) return "MODULATION";
		if (/^(cut|res|egAmt|envToFilter|kbdTracking|tone|dCut|filter)/i.test(key)) return "FILTER";
		if (/^(level|amp|pan|revSend|outLevel|noiseVol)/i.test(key)) return "OUTPUT";
		return "TONE";
	}
	function rebuildLayerSliders(specs) {
		Object.values(parameterGroups).forEach((group) => group.sliders.replaceChildren());
		sliderRows = specs.filter((row) => row[0] !== "kMode").map((row) => {
			const [id, key, name, lo, hi, def, unit, warp, integer] = row;
			const rowEl = el("div", "az-knob-card");
			const label = el("span", "az-knob-label", name);
			rowEl.appendChild(label);
			const dial = el("div", "az-knob-dial");
			const range = el("input");
			range.type = "range"; range.min = 0; range.max = 1; range.step = integer ? 1 / Math.max(1, hi - lo) : 0.001;
			range.setAttribute("aria-label", name);
			range.title = `Drag up or down to adjust ${name}; double-click to reset`;
			dial.appendChild(range);
			rowEl.appendChild(dial);
			const readout = el("span", "az-knob-value", "");
			rowEl.appendChild(readout);
			const commit = (normal) => {
				const n = Math.max(0, Math.min(1, normal));
				range.value = n;
				let v = warpValue(lo, hi, n, warp);
				if (integer) v = Math.round(v);
				actions.setLayerParam(state.layerSel, id, v);
			};
			range.addEventListener("input", () => {
				if (!range.hasPointerCapture?.(pointerId)) commit(Number(range.value));
			});
			let pointerId = -1;
			let startY = 0;
			let startValue = 0;
			range.addEventListener("pointerdown", (event) => {
				if (range.disabled) return;
				range.focus({ preventScroll: true });
				pointerId = event.pointerId;
				startY = event.clientY;
				startValue = Number(range.value);
				range.setPointerCapture(pointerId);
				event.preventDefault();
			});
			range.addEventListener("pointermove", (event) => {
				if (event.pointerId !== pointerId) return;
				commit(startValue + (startY - event.clientY) / (event.shiftKey ? 600 : 180));
			});
			range.addEventListener("pointerup", () => { pointerId = -1; });
			range.addEventListener("pointercancel", () => { pointerId = -1; });
			range.addEventListener("dblclick", () => commit(unwarpValue(lo, hi, def, warp)));
			parameterGroups[groupForParameter(key)].sliders.appendChild(rowEl);
			return { id, key, lo, hi, unit, warp, range, readout, dial, rowEl };
		});
	}

	// ---- Sequencer panel ----
	const seqPanel = el("div", "az-panel az-seq");
	body.appendChild(seqPanel);
	seqPanel.appendChild(el("div", "az-panel-title", "SEQUENCER"));
	const viewToolbar = el("div", "az-field-row az-view-toolbar");
	seqPanel.appendChild(viewToolbar);
	const viewButtons = ["SEQUENCER", "LAUNCHPAD"].map((name, view) => mkBtn(name, null, () => {
		state.controlView = view;
		refresh();
	}));
	viewButtons.forEach((button) => viewToolbar.appendChild(button));
	const recArmBtn = mkBtn("REC ARM", "az-recarm", () => actions.toggleRecArm());
	recArmBtn.title = "Arm step editing and note capture";
	viewToolbar.appendChild(recArmBtn);

	const keysRow = el("div", "az-field-row");
	seqPanel.appendChild(keysRow);
	keysRow.appendChild(el("span", null, "keys:"));
	const rootSelect = selectEl(ROOT_NAMES, (v) => { state.keyRoot = v; refreshKeySettings(); });
	keysRow.appendChild(rootSelect);
	const scaleSelect = selectEl(SCALE_NAMES, (v) => { state.keyScale = v; refreshKeySettings(); });
	keysRow.appendChild(scaleSelect);
	const setKeysOctave = (octave) => {
		if (!Number.isFinite(octave)) return;
		state.padKeyBase = (Math.max(-1, Math.min(7, Math.round(octave))) + 1) * 12;
		refreshKeySettings();
	};
	const octInput = el("input");
	octInput.type = "number"; octInput.min = -1; octInput.max = 7; octInput.step = 1;
	octInput.addEventListener("input", () => { if (octInput.value !== "") setKeysOctave(Number(octInput.value)); });
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
	noteRow.appendChild(el("span", null, "div"));
	const divSelect = selectEl(SEQ_DIV_NAMES, (v) => actions.setTrackDiv(state.layerSel, v));
	noteRow.appendChild(divSelect);

	const seqBtnRow = el("div", "az-field-row");
	seqPanel.appendChild(seqBtnRow);
	seqBtnRow.appendChild(mkBtn("RND", null, () => actions.randomizeTrack(state.layerSel)));
	seqBtnRow.appendChild(mkBtn("DEL STEP", null, () => actions.delStep(state.layerSel)));
	const copyStep = async () => {
		const json = actions.copySelectedStep(state.layerSel);
		if (json) await navigator.clipboard.writeText(json);
	};
	const pasteStep = async () => {
		try { actions.pasteSelectedStep(state.layerSel, await navigator.clipboard.readText()); }
		catch (error) { alert(`Could not paste step: ${error.message}`); }
	};
	seqBtnRow.appendChild(mkBtn("COPY STEP", null, () => { copyStep().catch((error) => alert(`Could not copy step: ${error.message}`)); }));
	seqBtnRow.appendChild(mkBtn("PASTE STEP", null, pasteStep));
	seqBtnRow.appendChild(mkBtn("CLEAR ALL STEPS", "az-danger az-clrtrack", () => {
		if (confirm("Clear all steps in the selected layer?")) actions.clrTrack(state.layerSel);
	}));
	const rndPanel = el("div", "az-rnd-settings");
	seqPanel.appendChild(rndPanel);
	rndPanel.appendChild(el("strong", "az-rnd-heading", "RND SETTINGS"));
	const rndActiveCounts = state.seq.map((track) => track.rnd.activeSteps >= 0 ? track.rnd.activeSteps : track.length);
	const rndActiveWrap = el("div", "az-rnd-active");
	rndActiveWrap.appendChild(el("span", null, "Active steps"));
	const rndActiveSlider = el("input");
	rndActiveSlider.type = "range"; rndActiveSlider.min = 0; rndActiveSlider.max = 64; rndActiveSlider.step = 1;
	rndActiveSlider.setAttribute("aria-label", "Active steps slider");
	rndActiveSlider.addEventListener("input", () => {
		rndActiveCounts[state.layerSel] = Number(rndActiveSlider.value);
		actions.setRndSetting(state.layerSel, "activeSteps", rndActiveCounts[state.layerSel]);
	});
	rndActiveWrap.appendChild(rndActiveSlider);
	const rndActiveNumber = el("input");
	rndActiveNumber.type = "number"; rndActiveNumber.min = 0; rndActiveNumber.max = 64; rndActiveNumber.step = 1;
	rndActiveNumber.setAttribute("aria-label", "Exact active step count");
	rndActiveNumber.addEventListener("change", () => {
		const layer = state.layerSel;
		rndActiveCounts[layer] = Number(rndActiveNumber.value);
		actions.setRndSetting(layer, "activeSteps", rndActiveCounts[layer]);
		rndActiveNumber.value = state.seq[layer].rnd.activeSteps;
	});
	rndActiveWrap.appendChild(rndActiveNumber);
	const rndModeButton = mkBtn("DENSITY %", "az-rnd-mode", () => {
		const layer = state.layerSel;
		actions.setRndSetting(layer, "activeSteps", state.seq[layer].rnd.activeSteps < 0 ? rndActiveCounts[layer] : -1);
	});
	rndModeButton.title = "Switch between exact active steps and density percentage";
	rndActiveWrap.appendChild(rndModeButton);
	rndPanel.appendChild(rndActiveWrap);
	const rndInputs = [
		["density", "Density %"], ["velMin", "Vel min %"], ["velMax", "Vel max %"],
		["chanceMin", "Chance min %"], ["chanceMax", "Chance max %"],
	].map(([key, label]) => {
		const wrap = el("label", "az-rnd-field");
		wrap.appendChild(el("span", null, label));
		const input = el("input");
		input.type = "number"; input.min = 0; input.max = 100; input.step = 1;
		input.addEventListener("change", () => actions.setRndSetting(state.layerSel, key, Number(input.value)));
		wrap.appendChild(input);
		rndPanel.appendChild(wrap);
		return [key, input];
	});

	const grid = el("div", "az-grid");
	seqPanel.insertBefore(grid, seqBtnRow);
	const stepBtns = [];
	for (let i = 0; i < 64; i++) {
		const b = el("button", "az-step");
		b.addEventListener("click", () => actions.clickStep(state.layerSel, i));
		grid.appendChild(b);
		stepBtns.push(b);
	}

	const gridView = el("div", "az-launch-grid-view");
	seqPanel.appendChild(gridView);
	const gridToolbar = el("div", "az-field-row");
	gridView.appendChild(gridToolbar);
	const gridModeButtons = ["STEP", "PARAM", "KEYS"].map((name, mode) => mkBtn(name, null, () => { state.padFocus = "eng"; state.padMode = mode; refresh(); }));
	gridModeButtons.forEach((b) => gridToolbar.appendChild(b));
	["FX1", "FX2", "FX3", "REV"].forEach((name, fx) => gridToolbar.appendChild(mkBtn(name, null, () => { state.padFocus = "fx"; state.padFx = fx; refresh(); })));
	const gridPageSelect = selectEl(["PAGE 1", "PAGE 2", "PAGE 3", "PAGE 4"], (page) => { state.padPage = page; refresh(); });
	gridToolbar.appendChild(gridPageSelect);
	const gridKeysWrap = el("div", "az-field-row");
	gridView.appendChild(gridKeysWrap);
	const gridRootSelect = selectEl(ROOT_NAMES, (v) => { state.keyRoot = v; refreshKeySettings(); });
	const gridScaleSelect = selectEl(SCALE_NAMES, (v) => { state.keyScale = v; refreshKeySettings(); });
	const gridKeyLabel = el("strong", "az-key-label");
	gridKeysWrap.append(gridKeyLabel, gridRootSelect, gridScaleSelect);
	const gridOctDown = mkBtn("OCT −", null, () => setKeysOctave(state.padKeyBase / 12 - 2));
	const gridOctLabel = el("span", "az-key-octave");
	const gridOctUp = mkBtn("OCT +", null, () => setKeysOctave(state.padKeyBase / 12));
	gridKeysWrap.append(gridOctDown, gridOctLabel, gridOctUp);
	const computerKeyHint = el("div", "az-computer-key-hint");
	gridView.appendChild(computerKeyHint);
	const keyLatchBtn = mkBtn("LATCH OFF", "az-key-latch", () => {
		const layer = state.layerSel;
		state.padLatchMode[layer] = !state.padLatchMode[layer];
		if (!state.padLatchMode[layer]) {
			for (const held of state.padLatched.slice()) {
				if (held.layer !== layer) continue;
				state.padLatched.splice(state.padLatched.indexOf(held), 1);
				actions.stopNoteMomentary(held.layer, held.pitch);
				if (held.step != null) actions.recordStepLength(held.layer, held.step, (performance.now() - held.t0) / 1000);
			}
			actions.syncArp(layer);
		}
		refresh();
		launchpad && launchpad.scheduleRefresh();
	});
	gridKeysWrap.appendChild(keyLatchBtn);
	const arpRow = el("div", "az-field-row az-arp-row");
	gridView.appendChild(arpRow);
	const arpToggle = mkBtn("ARP OFF", "az-key-arp", () => actions.setArp(state.layerSel, "enabled", !state.padArp[state.layerSel].enabled));
	const arpWaySelect = selectEl(actions.arpWays, (v) => actions.setArp(state.layerSel, "way", v));
	const arpOctaveSelect = selectEl(["1 octave", "2 octaves", "3 octaves", "4 octaves"], (v) => actions.setArp(state.layerSel, "octaves", v + 1));
	const arpRateSelect = selectEl(["1/4", "1/8", "1/16", "1/32"], (v) => actions.setArp(state.layerSel, "rate", actions.arpRates[v]));
	arpWaySelect.title = "Arpeggio order";
	arpOctaveSelect.title = "Octave span";
	arpRateSelect.title = "Tempo-synced note rate";
	arpRow.append(arpToggle, el("span", null, "MODE"), arpWaySelect, el("span", null, "OCT"), arpOctaveSelect, el("span", null, "RATE"), arpRateSelect);
	const screenGrid = el("div", "az-control-grid");
	gridView.appendChild(screenGrid);
	const screenPads = [];
	const screenHeld = new Map();
	const computerKeyboard = createComputerKeyboard({ state, actions, sequencer, onChange: () => refresh() });
	const computerPadLabels = new Map(COMPUTER_KEY_ROWS.flatMap((codes, row) =>
		codes.map((code, col) => [(row + 5) * 8 + col, code === "Comma" ? "," : code.slice(3)])));
	for (let idx = 0; idx < 64; idx++) {
		const col = idx % 8, row = Math.floor(idx / 8);
		const pad = el("button", "az-control-pad");
		pad.addEventListener("click", () => {
			const layer = state.layerSel;
			if (state.padFocus === "fx") {
				const specs = state.padFx === 3 ? REVSHIM_SPECS : SLOT_SPECS[state.slotType[state.padFx]];
				if (col < specs.length) {
					const [label, key, lo, hi, def, warp] = specs[col];
					const v = warpValue(lo, hi, (7 - row) / 7, warp);
					if (state.padFx === 3) actions.setRevShimParam(key, v); else actions.setSlotParam(state.padFx, key, v);
				}
			} else if (state.padMode === 0 && layer === 3 && state.structure[layer] === 10 && row === 7 && col < 5) actions.setGlitchMode(layer, col);
			else if (state.padMode === 0) actions.clickStep(layer, row * 8 + col);
			else if (state.padMode === 1) {
				const spec = activeEngineSpecs(layer, state.structure[layer])[state.padPage * 8 + col];
				if (spec) {
					let value = warpValue(spec[3], spec[4], (7 - row) / 7, spec[7]);
					if (spec[8]) value = Math.round(value);
					actions.setLayerParam(layer, spec[0], value);
				}
			}
		});
		pad.addEventListener("pointerdown", (event) => {
			if (state.padFocus !== "eng" || state.padMode !== 2) return;
			event.preventDefault();
			const scale = SCALES[state.keyScale], degree = (7 - row) * scale.length + col;
			const pitch = state.padKeyBase + state.keyRoot + Math.floor(degree / scale.length) * 12 + scale[degree % scale.length];
			if (pitch > 127 || screenHeld.has(idx)) return;
			const layer = state.layerSel;
			const alreadyLatched = state.padLatched.find((held) => held.layer === layer && held.pitch === pitch);
			if (alreadyLatched) {
				state.padLatched.splice(state.padLatched.indexOf(alreadyLatched), 1);
				actions.stopNoteMomentary(layer, pitch);
				if (alreadyLatched.step != null) actions.recordStepLength(layer, alreadyLatched.step, (performance.now() - alreadyLatched.t0) / 1000);
				actions.syncArp(layer);
				refresh();
				launchpad && launchpad.scheduleRefresh();
				return;
			}
			actions.playNoteMomentary(layer, pitch);
			let step = null;
			if (state.recArm) {
				step = state.playing ? sequencer.nearestStepIndex(layer) : (state.seq[layer].selectedStep ?? 0);
				if (step != null) actions.recordStepNote(layer, step, pitch);
			}
			const held = { layer, pitch, step, t0: performance.now(), latch: !!state.padLatchMode[layer] };
			if (held.latch) { state.padLatched.push(held); actions.syncArp(layer); }
			screenHeld.set(idx, held);
			refresh();
			launchpad && launchpad.scheduleRefresh();
			pad.setPointerCapture?.(event.pointerId);
		});
		const releaseScreenKey = () => {
			const held = screenHeld.get(idx);
			if (!held) return;
			screenHeld.delete(idx);
			if (held.latch) return;
			actions.stopNoteMomentary(held.layer, held.pitch);
			if (held.step != null) actions.recordStepLength(held.layer, held.step, (performance.now() - held.t0) / 1000);
			refresh();
			launchpad && launchpad.scheduleRefresh();
		};
		pad.addEventListener("pointerup", releaseScreenKey);
		pad.addEventListener("pointercancel", releaseScreenKey);
		pad.addEventListener("lostpointercapture", releaseScreenKey);
		screenGrid.appendChild(pad);
		screenPads.push(pad);
	}

	const chordReadout = el("div", "az-chord", "(select a step)");
	seqPanel.appendChild(chordReadout);
	const noteEditor = el("div", "az-note-editor");
	seqPanel.appendChild(noteEditor);
	let renderedNoteLayer = -1, renderedNoteStep = -1;
	function renderNoteEditor(track) {
		if (renderedNoteLayer === state.layerSel && renderedNoteStep === track.selectedStep && noteEditor.contains(document.activeElement)) return;
		renderedNoteLayer = state.layerSel;
		renderedNoteStep = track.selectedStep;
		noteEditor.replaceChildren();
		const step = track.selectedStep == null ? null : track.steps[track.selectedStep];
		if (!step) return;
		const offsets = noteOffsets(step);
		step.notes.forEach((pitch, index) => {
			const row = el("div", "az-note-event");
			const select = selectEl(NOTE_NAMES, (v) => actions.setStepNotePitch(state.layerSel, index, midiFromNoteIndex(v)), noteIndexFromMidi(pitch));
			if (pitch < 12 || pitch > 108) {
				const current = el("option", null, pitchLabel(pitch));
				current.value = "-1"; current.disabled = true;
				select.appendChild(current); select.value = "-1";
			}
			select.setAttribute("aria-label", `Note ${index + 1} pitch`);
			select.disabled = !state.recArm || !step.on;
			row.appendChild(select);
			const drag = el("input");
			drag.type = "range"; drag.min = -50; drag.max = 50; drag.step = 0.1;
			drag.value = offsets[index] * 100;
			drag.setAttribute("aria-label", `Note ${index + 1} timing drag`);
			drag.disabled = !state.recArm || !step.on;
			row.appendChild(drag);
			const exact = el("input");
			exact.type = "number"; exact.min = -50; exact.max = 50; exact.step = 0.1;
			exact.value = (offsets[index] * 100).toFixed(1);
			exact.setAttribute("aria-label", `Note ${index + 1} timing percent`);
			exact.disabled = !state.recArm || !step.on;
			drag.addEventListener("input", () => {
				actions.setStepNoteOffset(state.layerSel, index, Number(drag.value) / 100, false);
				exact.value = Number(drag.value).toFixed(1);
			});
			drag.addEventListener("change", refresh);
			exact.addEventListener("change", () => actions.setStepNoteOffset(state.layerSel, index, Number(exact.value) / 100));
			row.appendChild(exact);
			row.appendChild(el("span", null, "%"));
			const remove = mkBtn("REMOVE", null, () => actions.removeStepNote(state.layerSel, index));
			remove.disabled = !state.recArm || !step.on;
			row.appendChild(remove);
			noteEditor.appendChild(row);
		});
		const addRow = el("div", "az-field-row");
		const addPitch = selectEl(NOTE_NAMES, () => {}, noteIndexFromMidi(state.seqNote[state.layerSel] ?? 60));
		addPitch.setAttribute("aria-label", "Pitch to add");
		addRow.appendChild(addPitch);
		const add = mkBtn("ADD NOTE", null, () => actions.addStepNote(state.layerSel, midiFromNoteIndex(Number(addPitch.value))));
		add.disabled = !state.recArm || !step.on;
		addRow.appendChild(add);
		noteEditor.appendChild(addRow);
	}
	noteEditor.addEventListener("focusout", () => queueMicrotask(() => {
		if (!noteEditor.contains(document.activeElement)) renderNoteEditor(state.seq[state.layerSel]);
	}));
	const retriggerRow = el("div", "az-field-row az-retrigger");
	seqPanel.appendChild(retriggerRow);
	retriggerRow.appendChild(el("span", null, "Retrigger (extra hits)"));
	const retriggerInput = el("input");
	retriggerInput.type = "number"; retriggerInput.min = 0; retriggerInput.max = 7; retriggerInput.step = 1;
	retriggerInput.setAttribute("aria-label", "Selected step retrigger count");
	retriggerInput.addEventListener("change", () => {
		const track = state.seq[state.layerSel];
		if (track.selectedStep == null) return;
		actions.setStepRetrigger(state.layerSel, Number(retriggerInput.value));
		retriggerInput.value = track.steps[track.selectedStep].retrigger ?? 0;
	});
	retriggerRow.appendChild(retriggerInput);
	const retriggerRndButton = mkBtn("RND RETRIG", null, () => actions.randomizeStepRetrigger(state.layerSel));
	retriggerRow.appendChild(retriggerRndButton);

	// ---- Param-lock panel ----
	const lockPanel = el("div", "az-panel az-lock");
	seqPanel.appendChild(lockPanel);
	lockPanel.appendChild(el("div", "az-panel-title", "PARAM LOCK"));
	const lockRow = el("div", "az-field-row");
	lockPanel.appendChild(lockRow);
	const lockParamSelect = selectEl([], (v) => {
		const row = activeEngineSpecs(state.layerSel, state.structure[state.layerSel])[v];
		if (row) state.lockSpecId = row[0];
		refresh();
	});
	lockRow.appendChild(lockParamSelect);
	const lockSlider = el("input");
	lockSlider.type = "range"; lockSlider.min = 0; lockSlider.max = 1; lockSlider.step = 0.001;
	lockRow.appendChild(lockSlider);
	const lockReadout = el("span", null, "");
	lockRow.appendChild(lockReadout);
	lockSlider.addEventListener("input", () => {
		const row = activeEngineSpecs(state.layerSel, state.structure[state.layerSel]).find((s) => s[0] === state.lockSpecId);
		lockReadout.textContent = fmtVal(warpValue(row[3], row[4], parseFloat(lockSlider.value), row[7]), row[6]);
	});
	const lockBtnRow = el("div", "az-field-row");
	lockPanel.appendChild(lockBtnRow);
	lockBtnRow.appendChild(mkBtn("SET LOCK", null, () => {
		const row = activeEngineSpecs(state.layerSel, state.structure[state.layerSel]).find((s) => s[0] === state.lockSpecId);
		if (!row) return;
		let value = warpValue(row[3], row[4], parseFloat(lockSlider.value), row[7]);
		if (row[8]) value = Math.round(value);
		actions.setLock(state.layerSel, state.lockSpecId, value);
	}));
	lockBtnRow.appendChild(mkBtn("CLR LOCK", null, () => actions.clrLock(state.layerSel, state.lockSpecId)));
	const lockStatus = el("div", "az-lock-status", "(select a step)");
	lockPanel.appendChild(lockStatus);
	const sequencerOnly = [keysRow, noteRow, seqBtnRow, rndPanel, grid, chordReadout, noteEditor, retriggerRow, lockPanel];

	// ================= FX chain =================
	const fxChain = el("div", "az-panel az-fxchain");
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
	masterPage.append(fxChain, fixedRow);
	masterPage.appendChild(el("div", "az-panel-title", "MASTER PROCESSING"));
	const masterGrid = el("div", "az-master-grid"); masterPage.appendChild(masterGrid);
	const pumpBox = el("section", "az-fxbox"); masterGrid.appendChild(pumpBox);
	pumpBox.appendChild(el("h3", "az-panel-title", "SIDECHAIN PUMP"));
	const pumpActive = mkBtn("BYP", null, () => actions.setPumpParam("active", state.pumpParams.active ? 0 : 1));
	pumpBox.appendChild(pumpActive);
	function pumpSelect(label, options, key) {
		const row = el("label", "az-field-row az-master-select");
		row.appendChild(el("span", null, label));
		const select = selectEl(options, (value) => actions.setPumpParam(key, value));
		row.appendChild(select); pumpBox.appendChild(row);
		return select;
	}
	const pumpMode = pumpSelect("MODE", ["AUDIO LAYER", "TEMPO"], "mode");
	const pumpSource = pumpSelect("SOURCE", LAYERS, "source");
	const pumpRate = pumpSelect("BEAT RATE", ["½ / BEAT", "1 / BEAT", "2 / BEAT"], "rate");
	pumpBox.appendChild(el("div", "az-field-label", "DUCK TARGETS"));
	const targetRow = el("div", "az-master-targets"); pumpBox.appendChild(targetRow);
	const targetBtns = LAYERS.map((label, i) => {
		const button = mkBtn(label, null, () => actions.setPumpTarget(i, !state.pumpParams.targets[i]));
		button.setAttribute("aria-pressed", "false");
		targetRow.appendChild(button);
		return button;
	});
	const pumpSliders = PUMP_SPECS.map(([label, key, lo, hi, , warp]) => {
		const row = el("label", "az-slider-row"); pumpBox.appendChild(row);
		row.appendChild(el("span", "az-slider-label", label));
		const range = el("input"); range.type = "range"; range.min = 0; range.max = 1; range.step = 0.001;
		row.appendChild(range);
		const readout = el("span", "az-slider-val", ""); row.appendChild(readout);
		range.addEventListener("input", () => actions.setPumpParam(key, warpValue(lo, hi, Number(range.value), warp)));
		return { key, lo, hi, warp, range, readout };
	});
	masterGrid.appendChild(masterBox.box);
	const filterBox = el("section", "az-fxbox"); masterGrid.appendChild(filterBox);
	filterBox.appendChild(el("h3", "az-panel-title", "MASTER FILTERS"));
	const filterControls = MASTER_FILTER_SPECS.map(([label, activeKey, freqKey, lo, hi]) => {
		const header = el("div", "az-field-row"); filterBox.appendChild(header);
		header.appendChild(el("span", null, label));
		const button = mkBtn("BYP", null, () => actions.setMasterParam(activeKey, state.masterParams[activeKey] ? 0 : 1));
		header.appendChild(button);
		const row = el("label", "az-slider-row"); filterBox.appendChild(row);
		row.appendChild(el("span", "az-slider-label", "CUTOFF"));
		const range = el("input"); range.type = "range"; range.min = 0; range.max = 1; range.step = 0.001;
		row.appendChild(range);
		const readout = el("span", "az-slider-val", ""); row.appendChild(readout);
		range.addEventListener("input", () => actions.setMasterParam(freqKey, warpValue(lo, hi, Number(range.value), true)));
		return { activeKey, freqKey, lo, hi, button, range, readout };
	});
	masterPage.appendChild(meterEl);

	// ================= refresh =================

	function refresh() {
		showPage(state.page || "play");
		const isLaunchpadView = state.controlView === 1;
		viewButtons.forEach((button, i) => {
			button.classList.toggle("active", i === state.controlView);
			button.setAttribute("aria-pressed", String(i === state.controlView));
		});
		sequencerOnly.forEach((node) => node.classList.toggle("hidden", isLaunchpadView));
		gridView.classList.toggle("hidden", !isLaunchpadView);
		tabBtns.forEach((b, i) => b.classList.toggle("active", i === state.layerSel));
		muteBtns.forEach((b, i) => b.classList.toggle("active", state.muted[i]));
		mixerRefs.forEach(({ controls, mute, route }, i) => {
			for (const [key, property] of [["level", "mixerLevel"], ["pan", "mixerPan"], ["send", "mixerSend"]]) {
				controls[key].input.value = state[property][i];
				controls[key].readout.textContent = state[property][i].toFixed(2);
			}
			mute.classList.toggle("active", state.muted[i]);
			mute.setAttribute("aria-pressed", String(state.muted[i]));
			route.textContent = state.layerFxBypass[i] ? "BYPASS FX" : "THROUGH FX";
			route.classList.toggle("active", state.layerFxBypass[i]);
			route.setAttribute("aria-pressed", String(state.layerFxBypass[i]));
		});
		mixerMasterLevel.value = state.vol;

		const layer = state.layerSel;
		const track = state.seq[layer];
		const isTonal = layer <= 2;
		const isNoise = layer === 3 && state.structure[layer] === 7;
		const isGrain = layer === 3 && (state.structure[layer] === 8 || state.structure[layer] === 9);
		const activeSpecs = activeEngineSpecs(layer, state.structure[layer]);
		const specKey = layer + ":" + state.structure[layer];
		if (sliderSpecKey !== specKey) { sliderSpecKey = specKey; rebuildLayerSliders(activeSpecs); }
		const isGlitchPerc = layer === 3 && state.structure[layer] === 10;
		glitchModeRow.classList.toggle("hidden", !isGlitchPerc);
		glitchBaseRow.classList.toggle("hidden", !isGlitchPerc);
		glitchStepRndRow.classList.toggle("hidden", !isGlitchPerc);
		glitchModeButtons.forEach((button, i) => button.classList.toggle("active", isGlitchPerc && state.lp[layer].mode === i));
		glitchBaseSelect.value = state.lp[layer].mode ?? 0;
		glitchModeButtons.forEach((button) => { button.disabled = !isGlitchPerc; });
		glitchRandomButton.disabled = !isGlitchPerc;
		glitchBaseSelect.disabled = !isGlitchPerc;
		const selectedGlitchStep = track.selectedStep != null && track.steps[track.selectedStep]?.on ? track.selectedStep : null;
		const activeGlitchSteps = isGlitchPerc && track.steps.slice(0, track.length).some((step) => step.on);
		glitchStepRndButton.disabled = !activeGlitchSteps;
		glitchAllRndButton.disabled = !activeGlitchSteps;
		glitchStepRndHint.textContent = selectedGlitchStep != null ? `Selected step ${selectedGlitchStep + 1}` : "No selection: all active steps";
		structLabel.textContent = LAYERS[layer] + " -- " + (isTonal ? STRUCTURES[state.structure[layer]] : NOISE_STRUCTURES[state.structure[layer] - 7]);
		layerFxRouteBtn.textContent = state.layerFxBypass[layer] ? "BYPASS FX1-3" : "THROUGH FX1-3";
		layerFxRouteBtn.classList.toggle("active", state.layerFxBypass[layer]);
		layerFxRouteBtn.setAttribute("aria-pressed", String(state.layerFxBypass[layer]));
		structSelectWrap.classList.toggle("hidden", !isTonal);
		noiseStructWrap.classList.toggle("hidden", isTonal);
		if (isTonal) structSelect.value = state.structure[layer];
		else noiseStructSelect.value = state.structure[layer] - 7;
		sampleBtnWrap.classList.toggle("hidden", !(isNoise && state.noiseSrc === 9));
		grainControls.classList.toggle("hidden", !isGrain);
		extraControlWraps.forEach((wrap) => wrap.classList.toggle("hidden", !isNoise && !isTonal || (isTonal && state.structure[layer] === 6)));

		waveWrap.classList.toggle("hidden", !(isTonal || isNoise || isGrain));
		for (const group of Object.values(parameterGroups)) {
			const hasVisibleControls = [...group.controls.children].some((control) => !control.classList.contains("hidden"));
			group.controls.classList.toggle("hidden", !hasVisibleControls);
			group.section.classList.toggle("hidden", !hasVisibleControls && group.sliders.childElementCount === 0);
		}
		waveWrap.querySelector("span").textContent = isTonal ? "wave" : isNoise ? "source" : "grain source";
		const mode = isTonal ? "wave" : isNoise ? "noise" : "grain";
		const waveOptions = isTonal ? WAVE_NAMES : isNoise ? NOISE_SRC_NAMES : ["LINE IN", "WAV FILE"];
		if (waveSelect.dataset.mode !== mode) {
			waveSelect.innerHTML = "";
			waveOptions.forEach((label, i) => { const o = el("option", null, label); o.value = i; waveSelect.appendChild(o); });
			waveSelect.dataset.mode = mode;
			waveSelect.onchange = () => {
				const v = parseInt(waveSelect.value, 10);
				if (isTonal) actions.setWave(layer, v);
				else if (isNoise) {
					actions.setNoiseSrc(v);
					if (v === 9 && !state.usrChans) sampleFileInput.click();
				} else {
					actions.setGrainSource(v);
					if (v === 1) grainFileInput.click();
				}
			};
		}
		waveSelect.value = isTonal ? Math.max(0, state.curWave[layer]) : isNoise ? state.noiseSrc : state.grainSrc;

		const lp = state.lp[layer];
		filterSelect.value = lp.ftype;
		modShapeSelect.value = lp.modShape;
		l1destSelect.value = lp.l1dest;
		l2destSelect.value = lp.l2dest;

		gridModeButtons.forEach((b, i) => b.classList.toggle("active", state.padFocus === "eng" && state.padMode === i));
		[...gridToolbar.querySelectorAll("button")].slice(3).forEach((b, i) => b.classList.toggle("active", state.padFocus === "fx" && state.padFx === i));
		gridPageSelect.value = state.padPage;
		gridPageSelect.classList.toggle("hidden", state.padFocus !== "eng" || state.padMode !== 1);
		gridKeysWrap.classList.toggle("hidden", state.padFocus !== "eng" || state.padMode !== 2);
		gridRootSelect.value = state.keyRoot;
		gridScaleSelect.value = state.keyScale;
		gridKeyLabel.textContent = ROOT_NAMES[state.keyRoot] + " " + SCALE_NAMES[state.keyScale];
		const keysOctave = Math.round(state.padKeyBase / 12) - 1;
		gridOctLabel.textContent = "OCT " + keysOctave;
		gridOctDown.disabled = keysOctave <= -1;
		gridOctUp.disabled = keysOctave >= 7;
		computerKeyHint.classList.toggle("hidden", state.padFocus !== "eng" || state.padMode !== 2);
		computerKeyHint.textContent = computerKeyboard.capsLockOn
			? "Caps Lock ON · Q–I / A–K / Z–, play notes"
			: "Turn on Caps Lock to play Q–I / A–K / Z–, on your keyboard";
		keyLatchBtn.classList.toggle("active", !!state.padLatchMode[layer]);
		keyLatchBtn.textContent = state.padLatchMode[layer] ? "LATCH ON" : "LATCH OFF";
		keyLatchBtn.setAttribute("aria-pressed", String(!!state.padLatchMode[layer]));
		keyLatchBtn.classList.toggle("hidden", state.padFocus !== "eng" || state.padMode !== 2);
		const arp = state.padArp[layer];
		arpToggle.classList.toggle("active", !!arp.enabled);
		arpToggle.textContent = arp.enabled ? "ARP ON" : "ARP OFF";
		arpToggle.setAttribute("aria-pressed", String(!!arp.enabled));
		arpToggle.classList.toggle("hidden", state.padFocus !== "eng" || state.padMode !== 2);
		arpWaySelect.value = arp.way;
		arpOctaveSelect.value = arp.octaves - 1;
		arpRateSelect.value = actions.arpRates.indexOf(arp.rate);
		[arpWaySelect, arpOctaveSelect, arpRateSelect].forEach((control) => control.classList.toggle("hidden", state.padFocus !== "eng" || state.padMode !== 2));
		arpRow.classList.toggle("hidden", state.padFocus !== "eng" || state.padMode !== 2);
		const padSpecs = activeEngineSpecs(layer, state.structure[layer]);
		for (let i = 0; i < 64; i++) {
			const pad = screenPads[i], col = i % 8, row = Math.floor(i / 8);
			pad.textContent = "";
			pad.className = "az-control-pad";
			pad.disabled = false;
			if (state.padFocus === "fx") {
				const specs = state.padFx === 3 ? REVSHIM_SPECS : SLOT_SPECS[state.slotType[state.padFx]];
				const spec = specs[col];
				if (spec) { const value = state.padFx === 3 ? state.revShimParams[spec[1]] : state.slotParams[state.padFx][spec[1]]; const level = Math.round(unwarpValue(spec[2], spec[3], value, spec[5]) * 7); pad.classList.toggle("on", 7 - row <= level); pad.title = spec[0]; }
			} else if (state.padMode === 0 && layer === 3 && state.structure[layer] === 10 && row === 7 && col < 5) {
				pad.textContent = ["KICK", "SNARE", "HAT", "CLAP", "PERC"][col];
				pad.classList.toggle("on", state.lp[layer].mode === col);
				pad.title = "GLITCH PERC: " + pad.textContent;
			} else if (state.padMode === 0) {
				const idx = row * 8 + col, step = track.steps[idx];
				pad.textContent = String(idx + 1);
				pad.classList.toggle("on", idx < track.length && step.on);
				pad.classList.toggle("selected", track.selectedStep === idx);
				pad.classList.toggle("playhead", state.playing && track.pos === idx);
				pad.disabled = idx >= track.length;
			} else if (state.padMode === 1) {
				const spec = padSpecs[state.padPage * 8 + col];
				if (spec) { const value = state.lp[layer][spec[1]]; const level = Math.round(unwarpValue(spec[3], spec[4], value, spec[7]) * 7); pad.classList.toggle("on", 7 - row <= level); pad.title = spec[2] + ": " + fmtVal(value, spec[6]); }
				else pad.disabled = true;
			} else {
				const scale = SCALES[state.keyScale], degree = (7 - row) * scale.length + col;
				const pitch = state.padKeyBase + state.keyRoot + Math.floor(degree / scale.length) * 12 + scale[degree % scale.length];
				const pitchClass = ((pitch % 12) + 12) % 12;
				const octave = Math.floor(pitch / 12) - 1;
				const latched = state.padLatched.some((held) => held.layer === layer && held.pitch === pitch);
				const held = [...screenHeld.values(), ...computerKeyboard.held.values()].some((entry) => entry.layer === layer && entry.pitch === pitch);
				const keyboardLabel = computerPadLabels.get(i);
				pad.textContent = pitch <= 127 ? (keyboardLabel ? keyboardLabel + "\n" : "") + ROOT_NAMES[pitchClass] + octave : "";
				pad.classList.add("az-key-pad", "az-octave-" + ((octave + 1) % 7));
				pad.classList.toggle("root-note", degree % scale.length === 0);
				pad.classList.toggle("latched", latched);
				pad.classList.toggle("held", held);
				pad.title = pitch <= 127 ? `${keyboardLabel ? keyboardLabel + " · " : ""}${ROOT_NAMES[state.keyRoot]} ${SCALE_NAMES[state.keyScale]} · degree ${(degree % scale.length) + 1} · ${ROOT_NAMES[pitchClass]}${octave}` : "Out of MIDI range";
				pad.disabled = pitch > 127;
			}
		}
		lockParamSelect.innerHTML = "";
		activeSpecs.forEach((row, i) => { const opt = el("option", null, row[2]); opt.value = i; opt.dataset.id = row[0]; lockParamSelect.appendChild(opt); });
		if (!activeSpecs.some((row) => row[0] === state.lockSpecId)) state.lockSpecId = activeSpecs[0][0];
		lockParamSelect.value = activeSpecs.findIndex((row) => row[0] === state.lockSpecId);
		for (const s of sliderRows) {
			const locked = track.selectedStep != null && track.steps[track.selectedStep].locks[s.id] !== undefined;
			const showLock = state.recArm && locked;
			const v = showLock ? track.steps[track.selectedStep].locks[s.id] : lp[s.key];
			const normalized = Math.max(0, Math.min(1, unwarpValue(s.lo, s.hi, v, s.warp)));
			s.range.value = normalized;
			s.dial.style.setProperty("--progress", `${normalized * 270}deg`);
			s.dial.style.setProperty("--angle", `${-135 + normalized * 270}deg`);
			s.readout.textContent = fmtVal(v, s.unit) + (showLock ? " •L" : "");
			s.rowEl.classList.toggle("az-knob-locked", showLock);
		}
		const canEditSound = state.recArm && track.selectedStep != null;
		editHint.textContent = canEditSound ? `Editing step ${track.selectedStep + 1} · changes saved as parameter locks` : "Adjust layer sound here; arm REC and select a step to write locks";
		synthArmBtn.classList.toggle("active", state.recArm);
		synthArmBtn.setAttribute("aria-pressed", String(state.recArm));
		synthArmBtn.textContent = state.recArm ? "STEP EDIT ARMED" : "ARM STEP EDIT";
		noteSelect.disabled = !state.recArm;
		if (document.activeElement !== tempoInput) tempoInput.value = state.tempoBpm;
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
		noteSelect.value = noteIndexFromMidi(state.seqNote[layer] ?? 60);
		lenInput.value = track.length;
		divSelect.value = track.div;
		if (track.rnd.activeSteps >= 0) rndActiveCounts[layer] = track.rnd.activeSteps;
		rndActiveSlider.value = rndActiveCounts[layer];
		if (document.activeElement !== rndActiveNumber) rndActiveNumber.value = rndActiveCounts[layer];
		rndModeButton.textContent = track.rnd.activeSteps < 0 ? "DENSITY %" : "EXACT COUNT";
		rndModeButton.classList.toggle("active", track.rnd.activeSteps < 0);
		rndModeButton.setAttribute("aria-pressed", String(track.rnd.activeSteps < 0));
		for (const [key, input] of rndInputs) input.value = track.rnd[key];

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
			chordReadout.textContent = "notes: " + st.notes.map((n, i) => `${pitchLabel(n)} ${((noteOffsets(st)[i] ?? 0) * 100).toFixed(1)}%`).join(", ") + `  vel:${st.vel.toFixed(2)}  len:${st.len.toFixed(2)}  retrig:${st.retrigger ?? 0}`;
			const lockNames = Object.keys(st.locks).map((id) => activeSpecs.find((s) => s[0] === id)?.[2] || id);
			lockStatus.textContent = lockNames.length ? "locks: " + lockNames.join(", ") : "no locks on this step";
		} else {
			chordReadout.textContent = "(select a step)";
			lockStatus.textContent = "(select a step)";
		}
		renderNoteEditor(track);
		const canEditRetrigger = state.recArm && track.selectedStep != null && track.steps[track.selectedStep].on;
		if (document.activeElement !== retriggerInput) retriggerInput.value = track.selectedStep != null ? track.steps[track.selectedStep].retrigger ?? 0 : 0;
		retriggerInput.disabled = !canEditRetrigger;
		retriggerRndButton.disabled = !canEditRetrigger;
		const activeLockRow = activeSpecs.find((s) => s[0] === state.lockSpecId);
		if (activeLockRow) {
			lockParamSelect.value = activeSpecs.indexOf(activeLockRow);
			const lockValue = track.selectedStep != null && track.steps[track.selectedStep].locks[state.lockSpecId] != null
				? track.steps[track.selectedStep].locks[state.lockSpecId] : state.lp[layer][activeLockRow[1]];
			lockSlider.value = unwarpValue(activeLockRow[3], activeLockRow[4], lockValue, activeLockRow[7]);
			lockReadout.textContent = fmtVal(lockValue, activeLockRow[6]);
		}

		slotBoxes.forEach((b) => b.refresh());
		revShimBox.refresh();
		masterBox.refresh();
		pumpActive.textContent = state.pumpParams.active ? "ON" : "BYP";
		pumpActive.classList.toggle("active", !!state.pumpParams.active);
		pumpActive.setAttribute("aria-pressed", String(!!state.pumpParams.active));
		pumpMode.value = state.pumpParams.mode;
		pumpSource.value = state.pumpParams.source;
		pumpRate.value = state.pumpParams.rate;
		targetBtns.forEach((button, i) => {
			button.classList.toggle("active", !!state.pumpParams.targets[i]);
			button.setAttribute("aria-pressed", String(!!state.pumpParams.targets[i]));
		});
		for (const s of pumpSliders) {
			const value = state.pumpParams[s.key];
			s.range.value = unwarpValue(s.lo, s.hi, value, s.warp);
			s.readout.textContent = (s.key === "attack" || s.key === "release") ? value.toFixed(3) : fmtVal(value, "");
		}
		for (const c of filterControls) {
			const value = state.masterParams[c.freqKey];
			const active = !!state.masterParams[c.activeKey];
			c.button.textContent = active ? "ON" : "BYP";
			c.button.classList.toggle("active", active);
			c.button.setAttribute("aria-pressed", String(active));
			c.range.value = unwarpValue(c.lo, c.hi, value, true);
			c.readout.textContent = fmtVal(value, "Hz");
		}

		lpStatus.textContent = "Launchpad: " + (launchpad && launchpad.connected ? "connected" : "not connected");
		lpReconnect.textContent = launchpad && launchpad.connected ? "RECONNECT" : "CONNECT MIDI";
	}

	const onShortcut = (event) => {
		if (computerKeyboard.keyDown(event)) return;
		const command = stepShortcut(event);
		if (!command) return;
		event.preventDefault();
		if (command === "copy") copyStep().catch((error) => alert(`Could not copy step: ${error.message}`));
		if (command === "paste") pasteStep();
		if (command === "play") actions.playToggle();
		if (command === "delete") actions.delStep(state.layerSel);
	};
	const onKeyboardKeyUp = (event) => computerKeyboard.keyUp(event);
	const onWindowBlur = () => computerKeyboard.releaseAll();
	document.addEventListener("keydown", onShortcut);
	document.addEventListener("keyup", onKeyboardKeyUp);
	window.addEventListener("blur", onWindowBlur);
	refresh();
	return { refresh, meterEl, meterEls: [meterEl, mixerMeter], refreshPatchList, stopExport: () => exportController?.stop(), dispose: () => {
		computerKeyboard.releaseAll();
		document.removeEventListener("keydown", onShortcut);
		document.removeEventListener("keyup", onKeyboardKeyUp);
		window.removeEventListener("blur", onWindowBlur);
	} };
}
