// Tempo-locked step sequencer (spec §7). Runs 4 independent per-layer tracks.
//
// PORT NOTE (spec §7.2): there is no TempoClock in a browser. This uses the
// standard "lookahead" Web Audio scheduler pattern (Chris Wilson's classic
// metronome technique): a cheap setInterval "tick" every 25ms looks ahead
// ~100ms using audioContext.currentTime (not accumulated setTimeout drift),
// and schedules each individual note-on/note-off with its own setTimeout
// computed fresh from the current tempo — so a tempo change takes effect on
// the very next scheduled step, not just "eventually", matching the spec's
// requirement that step timing must be computed in beats and only converted
// to wall-clock ms at the point of scheduling.

import { SEQ_DIVS } from "./data.js";

export function newStep() {
	return { on: false, notes: [60], vel: 0.8, chance: 1, len: 0.9, locks: {} };
}

export function newRndSettings() {
	return { density: 30, velMin: 80, velMax: 80, chanceMin: 100, chanceMax: 100 };
}

export function newTrack() {
	return { steps: Array.from({ length: 64 }, newStep), length: 16, div: 7, pos: -1, stepTime: 0, mute: false, rnd: newRndSettings() };
}

export function createSequencer({ audioContext, engine, getLayerState, onStep, tracks }) {
	let playing = false;
	let tempoBpm = 120;
	let timer = null;
	let metronomeOn = false;
	let beatOrigin = 0;
	let nextClickTime = 0;
	const LOOKAHEAD_MS = 25;
	const SCHEDULE_AHEAD_S = 0.12;

	// IMPORTANT: `tracks` must be the SAME array the GUI/actions read and
	// write (state.seq) -- not a private copy. Earlier versions of this
	// module created their own internal track array here, which meant every
	// step the GUI toggled ON lived only in state.seq and was invisible to
	// this scheduler's fireStep(), so PLAY always ticked over silent,
	// all-steps-off tracks. Passing state.seq in directly is what makes the
	// GUI and the scheduler agree on what's actually programmed.
	if (!tracks) throw new Error("createSequencer requires `tracks` (pass state.seq)");
	const nextStepTime = [0, 0, 0, 0];

	function now() { return audioContext ? audioContext.currentTime : performance.now() / 1000; }

	function stepBeatDur(track) { return 1 / SEQ_DIVS[track.div]; }
	function stepSecDur(track) { return stepBeatDur(track) * (60 / tempoBpm); }

	function ensureTimer() {
		if (!timer && (playing || metronomeOn)) timer = setInterval(tick, LOOKAHEAD_MS);
	}

	function stopTimerIfIdle() {
		if (!playing && !metronomeOn && timer) {
			clearInterval(timer);
			timer = null;
		}
	}

	function beatDur() { return 60 / tempoBpm; }

	function nextBeatAfter(time) {
		const dur = beatDur();
		return beatOrigin + (Math.floor((time - beatOrigin) / dur) + 1) * dur;
	}

	function scheduleClick(when, beat) {
		if (!audioContext) return;
		// Direct destination connection keeps click out of sonic.node master recording.
		const osc = audioContext.createOscillator();
		const gain = audioContext.createGain();
		osc.frequency.value = beat % 4 === 0 ? 1200 : 850;
		gain.gain.setValueAtTime(0.0001, when);
		gain.gain.exponentialRampToValueAtTime(0.35, when + 0.002);
		gain.gain.exponentialRampToValueAtTime(0.0001, when + 0.045);
		osc.connect(gain);
		gain.connect(audioContext.destination);
		osc.start(when);
		osc.stop(when + 0.05);
		osc.onended = () => { osc.disconnect(); gain.disconnect(); };
	}

	function tick() {
		const t = now();
		if (playing) {
			for (let layer = 0; layer < 4; layer++) {
				const track = tracks[layer];
				while (nextStepTime[layer] < t + SCHEDULE_AHEAD_S) {
					scheduleStep(layer, track, nextStepTime[layer]);
					nextStepTime[layer] += stepSecDur(track);
				}
			}
		}
		while (metronomeOn && nextClickTime < t + SCHEDULE_AHEAD_S) {
			const beat = Math.max(0, Math.round((nextClickTime - beatOrigin) / beatDur()));
			scheduleClick(nextClickTime, beat);
			nextClickTime += beatDur();
		}
	}

	function scheduleStep(layer, track, when) {
		const delayMs = Math.max(0, (when - now()) * 1000);
		const idx = (track.pos + 1) % Math.max(1, track.length);
		setTimeout(() => fireStep(layer, track, idx, when), delayMs);
	}

	function fireStep(layer, track, idx, whenSec) {
		if (!playing) return;
		track.pos = idx;
		track.stepTime = whenSec;
		const step = track.steps[idx];
		onStep && onStep(layer, idx);
		if (step.on && !track.mute && Math.random() < Math.max(0, Math.min(1, step.chance ?? 1))) {
			const ls = getLayerState(layer);
			const ids = [];
			for (const note of step.notes) {
				const id = engine.noteOn(layer, note, step.vel, ls.lp, ls.structure, ls.noiseSrc, step.locks, ls.muted);
				if (id != null) ids.push(note);
			}
			const offMs = stepBeatDur(track) * (60 / tempoBpm) * step.len * 1000;
			setTimeout(() => { for (const note of ids) engine.noteOff(layer, note); }, offMs);
		}
	}

	function start() {
		if (playing) return;
		playing = true;
		const t = now();
		const startAt = metronomeOn ? nextBeatAfter(t) : t + 0.05;
		if (!metronomeOn) beatOrigin = startAt;
		for (let layer = 0; layer < 4; layer++) {
			tracks[layer].pos = -1;
			nextStepTime[layer] = startAt;
		}
		ensureTimer();
	}

	function stop() {
		playing = false;
		stopTimerIfIdle();
		for (let layer = 0; layer < 4; layer++) engine.layerOff(layer);
	}

	function setTempo(bpm) { tempoBpm = Math.max(20, Math.min(400, bpm)); }

	function setMetronome(enabled) {
		enabled = !!enabled;
		if (metronomeOn === enabled) return;
		metronomeOn = enabled;
		const t = now();
		if (enabled) {
			if (!playing) beatOrigin = t + 0.05;
			nextClickTime = playing ? nextBeatAfter(t) : beatOrigin;
			ensureTimer();
		} else {
			stopTimerIfIdle();
		}
	}
	function getTempo() { return tempoBpm; }

	// nearest-step quantization for real-time KEYS recording (spec §7.4)
	function nearestStepIndex(layer) {
		const track = tracks[layer];
		if (!playing) return null;
		const frac = Math.max(0, Math.min(1, (now() - track.stepTime) / stepSecDur(track)));
		return frac > 0.5 ? (track.pos + 1) % Math.max(1, track.length) : track.pos;
	}
	function stepDurSeconds(layer) { return stepSecDur(tracks[layer]); }

	return {
		tracks,
		start, stop,
		get playing() { return playing; },
		setTempo, getTempo, setMetronome,
		get metronomeOn() { return metronomeOn; },
		nearestStepIndex, stepDurSeconds,
	};
}
