export const STEMS = ["layer1", "layer2", "layer3", "layer4", "fx1", "fx2", "fx3", "reverb", "master"];
export const STEM_PAIR = Object.fromEntries(STEMS.map((name, i) => [name, i === 8 ? 0 : i + 1]));

export function selectedStems(mode, custom = STEMS) {
	if (mode === "master") return ["master"];
	if (mode === "full") return [...STEMS];
	const selected = STEMS.filter((name) => custom.includes(name));
	if (!selected.length) throw new Error("Select at least one stem");
	return selected;
}

export function wavHeader(frames, sampleRate, format) {
	const bits = format === "float32" ? 32 : format === "pcm24" ? 24 : 16;
	const bytes = bits / 8;
	const dataBytes = frames * 2 * bytes;
	if (dataBytes > 0xffffffff - 36) throw new Error("WAV exceeds the 4 GB RIFF limit");
	const buffer = new ArrayBuffer(44), v = new DataView(buffer);
	const str = (at, s) => { for (let i = 0; i < s.length; i++) v.setUint8(at + i, s.charCodeAt(i)); };
	str(0, "RIFF"); v.setUint32(4, dataBytes + 36, true); str(8, "WAVE"); str(12, "fmt ");
	v.setUint32(16, 16, true); v.setUint16(20, format === "float32" ? 3 : 1, true);
	v.setUint16(22, 2, true); v.setUint32(24, sampleRate, true);
	v.setUint32(28, sampleRate * 2 * bytes, true); v.setUint16(32, 2 * bytes, true);
	v.setUint16(34, bits, true); str(36, "data"); v.setUint32(40, dataBytes, true);
	return new Uint8Array(buffer);
}

export function encodeStem(interleaved, frames, pair, format) {
	const bytes = format === "float32" ? 4 : format === "pcm24" ? 3 : 2;
	const out = new Uint8Array(frames * 2 * bytes), v = new DataView(out.buffer);
	for (let i = 0; i < frames; i++) for (let ch = 0; ch < 2; ch++) {
		const sample = interleaved[i * 18 + pair * 2 + ch];
		const at = (i * 2 + ch) * bytes;
		if (format === "float32") v.setFloat32(at, sample, true);
		else if (format === "pcm24") {
			const n = Math.round(Math.max(-1, Math.min(1, sample)) * (sample < 0 ? 8388608 : 8388607));
			out[at] = n & 255; out[at + 1] = (n >> 8) & 255; out[at + 2] = (n >> 16) & 255;
		} else v.setInt16(at, Math.round(Math.max(-1, Math.min(1, sample)) * (sample < 0 ? 32768 : 32767)), true);
	}
	return out;
}
