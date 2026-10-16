class StemCapture extends AudioWorkletProcessor {
	constructor() {
		super(); this.armed = false; this.frames = 0; this.limit = Math.floor(sampleRate * 600);
		this.chunkFrames = 2048; this.chunk = new Float32Array(this.chunkFrames * 18); this.filled = 0;
		this.port.onmessage = ({ data }) => {
			if (data?.type === "start") { this.limit = data.limit; this.armed = true; this.frames = 0; }
			if (data === "stop") this.stop();
		};
	}
	flush() {
		if (!this.filled) return;
		const data = this.chunk.slice(0, this.filled * 18);
		this.port.postMessage({ type: "chunk", frames: this.filled, data: data.buffer }, [data.buffer]);
		this.filled = 0;
	}
	stop() {
		if (!this.armed) return;
		this.armed = false; this.flush(); this.port.postMessage({ type: "stopped", frames: this.frames });
	}
	process(inputs, outputs) {
		if (!this.armed) return true;
		const channels = inputs[0] || [];
		const count = channels[0]?.length || outputs[0]?.[0]?.length || 128;
		for (let i = 0; i < count && this.armed; i++) {
			const offset = this.filled * 18;
			for (let ch = 0; ch < 18; ch++) this.chunk[offset + ch] = channels[ch]?.[i] || 0;
			this.filled++; this.frames++;
			if (this.filled === this.chunkFrames) this.flush();
			if (this.frames === this.limit) this.stop();
		}
		return true;
	}
}
registerProcessor("az-stem-capture", StemCapture);
