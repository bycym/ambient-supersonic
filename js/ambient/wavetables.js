// Client-side reimplementation of ~az.tableFor / ~az.loadWave (spec §4).
//
// PORT NOTE (spec §11 item 11 / §4.2 "Determinism requirement"): SuperCollider's
// `thisThread.randSeed` + `.rand`/`.rand2` use a specific LCG whose exact bit
// stream we do not reimplement here. Wave families that don't use randomness
// (SAW/SQUARE/PULSE/WAVESHAPE/BELL/FORMANT/ORGAN, i.e. families 0-6) are
// bit-exact with the original (they're pure deterministic math). Family 7
// ("NOISY") uses `.rand`/`.rand2pi` and will sound similar but not identical
// to the desktop version — this is the one accepted, documented divergence
// the spec explicitly allows in lieu of shipping a multi-MB precomputed
// wavetable asset.

import { N_TABLES, TABLE_SIZE } from "./data.js";

// Deterministic seeded PRNG (mulberry32) — reseeded fresh for every tableFor()
// call with the same per-wave seed the original uses (`wave*977+13`), so the
// exact same wave always regenerates identically, matching the "cache is safe"
// assumption the original relies on. Not bit-compatible with SC's LCG.
function makeRng(seed) {
	let a = seed >>> 0;
	return function rng() {
		a |= 0; a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function sineFill(n, amps, phases) {
	const sig = new Float64Array(n);
	for (let h = 0; h < amps.length; h++) {
		const amp = amps[h];
		if (!amp) continue;
		const ph = phases ? phases[h] : 0;
		const w = (2 * Math.PI * (h + 1)) / n;
		for (let i = 0; i < n; i++) sig[i] += amp * Math.sin(w * i + ph);
	}
	return sig;
}

function normalizeSum(arr) {
	let s = 0;
	for (const v of arr) s += v;
	if (Math.abs(s) < 1e-12) return arr.map(() => 0);
	return arr.map((v) => v / s);
}

function normalizeSig(sig, peak = 1) {
	let max = 0;
	for (const v of sig) max = Math.max(max, Math.abs(v));
	if (max < 1e-12) return sig;
	const k = peak / max;
	for (let i = 0; i < sig.length; i++) sig[i] *= k;
	return sig;
}

// One 512-sample table for `wave` (0-31) at normalized morph position `t` (0..1).
export function tableFor(wave, t) {
	const fam = Math.floor(wave / 4);
	const vari = wave % 4;
	const n = TABLE_SIZE;
	const nh = 48;
	const dens = Math.round(Math.min(nh, Math.max(1, 4 + vari * 3 + t * (nh - 6))));
	const tilt = Math.max(0.35, 1.0 + vari * 0.35 - t * 0.9);
	const rng = makeRng((wave * 977 + 13) >>> 0);

	let sig;
	switch (fam) {
		case 0: { // SAW
			const amps = Array.from({ length: nh }, (_, i) => (i < dens ? Math.pow(i + 1, -tilt) : 0));
			sig = sineFill(n, normalizeSum(amps).map((v) => v * 2));
			break;
		}
		case 1: { // SQUARE (odd partials only)
			const amps = Array.from({ length: nh }, (_, i) => (i % 2 === 0 && i < dens ? Math.pow(i + 1, -tilt) : 0));
			sig = sineFill(n, normalizeSum(amps).map((v) => v * 2));
			break;
		}
		case 2: { // PULSE
			const duty = 0.5 - t * (0.34 + vari * 0.03);
			const sine = sineFill(n, [1]);
			const raw = new Float64Array(n);
			for (let i = 0; i < n; i++) raw[i] = i / n < duty ? 1.0 : -1.0;
			const b = (1 - t) * 0.45;
			sig = new Float64Array(n);
			for (let i = 0; i < n; i++) sig[i] = raw[i] * (1 - b) + sine[i] * b;
			normalizeSig(sig);
			break;
		}
		case 3: { // WAVESHAPE
			const drive = 1 + t * (12 + vari * 8);
			sig = new Float64Array(n);
			for (let i = 0; i < n; i++) sig[i] = Math.tanh(Math.sin((2 * Math.PI * i) / n) * drive);
			normalizeSig(sig);
			break;
		}
		case 4: { // BELL
			const amps = new Array(nh).fill(0);
			const count = Math.round(2 + vari + t * 9);
			for (let k = 0; k < count; k++) {
				const idx = Math.min(nh - 1, Math.round(Math.pow(k + 1, 1.38 + vari * 0.08) - 1));
				amps[idx] += 1 / (k + 1);
			}
			sig = sineFill(n, normalizeSum(amps).map((v) => v * 2));
			break;
		}
		case 5: { // FORMANT
			const centre = 1 + t * (nh - 8) + vari * 2;
			const w = 2 + vari * 2 + t * 6;
			const amps = Array.from({ length: nh }, (_, i) => Math.exp(-Math.pow((i - centre) / w, 2)));
			sig = sineFill(n, normalizeSum(amps).map((v) => v * 2));
			break;
		}
		case 6: { // ORGAN
			const amps = new Array(nh).fill(0);
			const drawbars = [0, 1, 3, 7, 15, 31];
			drawbars.forEach((idx, o) => {
				if (idx < nh) amps[idx] = Math.max(0, 1 - Math.abs((o / 5 - t) * 1.6)) * (1 / Math.sqrt(o + 1));
			});
			if (vari > 1) amps[2] += t * 0.4;
			if (amps.reduce((a, b) => a + b, 0) <= 0) amps[0] = 1;
			sig = sineFill(n, normalizeSum(amps).map((v) => v * 2));
			break;
		}
		default: { // NOISY (fam 7)
			const r = Array.from({ length: nh }, () => rng());
			const amps = Array.from({ length: nh }, (_, i) => (i < dens ? r[i] * Math.pow(i + 1, -Math.max(1.4 - t, 0.1)) : 0));
			const phs = Array.from({ length: nh }, () => rng() * 2 * Math.PI);
			sig = sineFill(n, normalizeSum(amps).map((v) => v * 2), phs);
			break;
		}
	}
	return normalizeSig(sig, 1);
}

// Signal:asWavetable — interleaved amp/slope format consumed by Osc/VOsc.
// table[2i] = 2*s1 - s2; table[2i+1] = s2 - s1 (s2 = next sample, wrapped).
export function asWavetable(sig) {
	const size = sig.length;
	const out = new Float32Array(size * 2);
	for (let i = 0; i < size; i++) {
		const s1 = sig[i];
		const s2 = sig[(i + 1) % size];
		out[i * 2] = 2 * s1 - s2;
		out[i * 2 + 1] = s2 - s1;
	}
	return out;
}

// Full 64-table wavetable-bank computation for one `wave` index, cached.
const waveCache = new Map();
export function tablesForWave(wave) {
	if (waveCache.has(wave)) return waveCache.get(wave);
	const tables = new Array(N_TABLES);
	for (let i = 0; i < N_TABLES; i++) {
		const t = i / (N_TABLES - 1);
		tables[i] = asWavetable(tableFor(wave, t));
	}
	waveCache.set(wave, tables);
	return tables;
}
