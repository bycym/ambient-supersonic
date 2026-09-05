// Patch persistence shared by both instruments:
//   - localStorage save/load (named patches, per-instrument namespace)
//   - .azpatch-compatible JSON export/import (round-trips with the desktop
//     SuperCollider script's own save/load format where that instrument has one)
//   - URL-embeddable share links (?patch=<base64url gzip-free JSON>) + QR code
//     so a patch made on desktop can be scanned open on a phone against the
//     same page hosted on GitHub Pages.
//
// `ns` namespaces localStorage keys per instrument ("ambient" | "granular").

import qrcode from "../../vendor/qrcode/qrcode.mjs";

const STORE_PREFIX = "az_webport_patch::";

function storeKey(ns, name) {
	return STORE_PREFIX + ns + "::" + name;
}

export function listPatches(ns) {
	const out = [];
	for (let i = 0; i < localStorage.length; i++) {
		const k = localStorage.key(i);
		const prefix = STORE_PREFIX + ns + "::";
		if (k && k.startsWith(prefix)) out.push(k.slice(prefix.length));
	}
	return out.sort();
}

export function savePatch(ns, name, data) {
	const payload = Object.assign({ version: 1, name, savedAt: new Date().toISOString() }, data);
	localStorage.setItem(storeKey(ns, name), JSON.stringify(payload));
	return payload;
}

export function loadPatch(ns, name) {
	const raw = localStorage.getItem(storeKey(ns, name));
	return raw ? JSON.parse(raw) : null;
}

export function deletePatch(ns, name) {
	localStorage.removeItem(storeKey(ns, name));
}

// --- .azpatch export/import (plain JSON on the web; the desktop file is an
// SC Archive, but both are just serialized nested Dictionaries/Arrays, so a
// JSON mirror of the same key shape is readable/writable from either side
// with a small converter kept in each instrument's app module). -------------

export function exportAzpatchBlob(data) {
	const json = JSON.stringify(data, null, 2);
	return new Blob([json], { type: "application/json" });
}

export async function importAzpatchFile(file) {
	const text = await file.text();
	return JSON.parse(text);
}

// --- URL share + QR -----------------------------------------------------

function toBase64Url(str) {
	const bytes = new TextEncoder().encode(str);
	let bin = "";
	bytes.forEach((b) => (bin += String.fromCharCode(b)));
	return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(b64url) {
	const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
	const bin = atob(b64 + "===".slice((b64.length + 3) % 4));
	const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
	return new TextDecoder().decode(bytes);
}

export function buildShareUrl(ns, data) {
	const json = JSON.stringify(data);
	const encoded = toBase64Url(json);
	const url = new URL(window.location.href);
	url.hash = "";
	url.searchParams.set("patch", encoded);
	url.searchParams.set("inst", ns);
	return url.toString();
}

export function readPatchFromUrl() {
	const params = new URLSearchParams(window.location.search);
	const encoded = params.get("patch");
	const inst = params.get("inst");
	if (!encoded) return null;
	try {
		return { instrument: inst, data: JSON.parse(fromBase64Url(encoded)) };
	} catch (err) {
		console.warn("Failed to parse ?patch= URL param:", err);
		return null;
	}
}

// Renders a QR code encoding `url` into `container` (a DOM element), as an
// inline SVG so it stays crisp at any size and needs no canvas/network.
export function renderShareQr(container, url) {
	const qr = qrcode(0, "M");
	qr.addData(url);
	qr.make();

	const count = qr.getModuleCount();
	const cell = 4;
	const size = count * cell;
	const NS = "http://www.w3.org/2000/svg";
	const svg = document.createElementNS(NS, "svg");
	svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
	svg.setAttribute("width", size);
	svg.setAttribute("height", size);
	svg.style.background = "#fff";

	const bg = document.createElementNS(NS, "rect");
	bg.setAttribute("width", size);
	bg.setAttribute("height", size);
	bg.setAttribute("fill", "#fff");
	svg.appendChild(bg);

	let path = "";
	for (let r = 0; r < count; r++) {
		for (let c = 0; c < count; c++) {
			if (qr.isDark(r, c)) {
				path += `M${c * cell},${r * cell}h${cell}v${cell}h${-cell}z`;
			}
		}
	}
	const p = document.createElementNS(NS, "path");
	p.setAttribute("d", path);
	p.setAttribute("fill", "#000");
	svg.appendChild(p);

	container.innerHTML = "";
	container.appendChild(svg);
	return svg;
}
