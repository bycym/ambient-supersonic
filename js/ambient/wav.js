// Encode decoded browser audio as a standard 16-bit PCM WAV download.
export function encodeWav(audioBuffer) {
	const channels = audioBuffer.numberOfChannels;
	const frames = audioBuffer.length;
	const sampleRate = Math.round(audioBuffer.sampleRate);
	if (channels < 1 || frames < 1 || sampleRate < 1) throw new Error("Recording contains no audio");
	const dataBytes = frames * channels * 2;
	if (dataBytes > 0xffffffff - 36) throw new Error("Recording is too long for a WAV file");
	const bytes = new ArrayBuffer(44 + dataBytes);
	const view = new DataView(bytes);
	const writeText = (offset, value) => {
		for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
	};
	writeText(0, "RIFF");
	view.setUint32(4, 36 + dataBytes, true);
	writeText(8, "WAVE");
	writeText(12, "fmt ");
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);
	view.setUint16(22, channels, true);
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate * channels * 2, true);
	view.setUint16(32, channels * 2, true);
	view.setUint16(34, 16, true);
	writeText(36, "data");
	view.setUint32(40, dataBytes, true);
	const samples = Array.from({ length: channels }, (_, channel) => audioBuffer.getChannelData(channel));
	let offset = 44;
	for (let frame = 0; frame < frames; frame++) {
		for (let channel = 0; channel < channels; channel++) {
			const sample = Math.max(-1, Math.min(1, samples[channel][frame]));
			view.setInt16(offset, sample < 0 ? sample * 32768 : sample * 32767, true);
			offset += 2;
		}
	}
	return new Blob([bytes], { type: "audio/wav" });
}

export async function recordedAudioToWav(recording, audioContext) {
	const decoded = await audioContext.decodeAudioData(await recording.arrayBuffer());
	return encodeWav(decoded);
}
