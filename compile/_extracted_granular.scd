~gz.defineSynths = [{ |s|
	var tail;

	// shared output stage. `sig` arrives as a 2-element (stereo) array.
	tail = { |sig, cut, res, lofi, atk, rel, gate, level, pan, amp, out, revB, dlyB, send, dsend|
		var env, lo, srate, bits, wide;
		env = EnvGen.kr(Env.asr(atk, 1, rel), gate, doneAction: 2);
		sig = RLPF.ar(sig, cut.clip(40, 18000), (1 - res.clip(0, 0.95)).max(0.05));
		// lo-fi: sample-rate reduction + bit reduction, faded in by one knob.
		srate = lofi.clip(0, 1).linexp(0, 1, 48000, 900);
		bits  = lofi.clip(0, 1).linlin(0, 1, 24, 3);
		lo = Latch.ar(sig, Impulse.ar(srate));
		lo = (lo * (2 ** bits)).round * (2 ** bits.neg);
		sig = XFade2.ar(sig, lo, (lofi.clip(0, 1) * 2) - 1);
		sig = LeakDC.ar(sig) * env * level.clip(0, 1) * amp;
		// stereo-aware pan: keeps the grain spread instead of collapsing it
		wide = Balance2.ar(sig[0], sig[1], pan.clip(-1, 1));
		Out.ar(out, wide);
		Out.ar(revB, wide * send.clip(0, 1));
		Out.ar(dlyB, wide * dsend.clip(0, 1));
	};

	// ------------------------------------------------------------------ input
	// NONE: the "no input needed" source. A slowly drifting bed of detuned
	// saws and filtered noise, so the granular engines always have something
	// to eat even with nothing plugged in.
	SynthDef(\gz_src_none, { arg out = 0, gain = 1, tone = 0.5, motion = 0.3, texLvl = 1;
		var f, sig, mrate;
		mrate = motion.clip(0, 1).linexp(0, 1, 0.01, 0.6);
		f = LFNoise1.kr(mrate * 0.5).range(46, 140);
		sig = Mix.fill(5, { |i|
			var det = LFNoise1.kr(mrate * (0.3 + (i * 0.11))).range(-14, 14);
			VarSaw.ar(
				f * (i + 1) * (2 ** (det / 1200)),
				LFNoise1.kr(mrate * 0.2).range(0, 1),
				LFNoise1.kr(mrate * 0.3).range(0.1, 0.9)
			) * (0.13 / (i + 1).sqrt);
		});
		sig = sig + (PinkNoise.ar(0.3) * LFNoise1.kr(mrate).range(0.15, 1));
		sig = RLPF.ar(sig, tone.clip(0, 1).linexp(0, 1, 180, 9000), 0.45);
		sig = Pan2.ar(sig, LFNoise1.kr(mrate * 0.4)) * texLvl.clip(0, 2);
		Out.ar(out, LeakDC.ar(sig) * gain.clip(0, 2));
	}).add;

	SynthDef(\gz_src_mic, { arg out = 0, gain = 1;
		Out.ar(out, Pan2.ar(SoundIn.ar(0), 0) * gain.clip(0, 2));
	}).add;

	SynthDef(\gz_src_line, { arg out = 0, gain = 1;
		Out.ar(out, SoundIn.ar([0, 1]) * gain.clip(0, 2));
	}).add;

	// WAV source. Sample files are loaded MONO (channel 0) on purpose: the
	// grain UGens can only read single-channel buffers, so one mono buffer
	// serves both the loop player and the granular engines.
	SynthDef(\gz_src_wav, { arg out = 0, buf = 0, gain = 1, rate = 1, wavLvl = 1;
		var sig = PlayBuf.ar(1, buf, rate * BufRateScale.kr(buf), 1, 0, 1);
		Out.ar(out, Pan2.ar(sig, 0) * wavLvl.clip(0, 2) * gain.clip(0, 2));
	}).add;

	// direct monitoring of the input, straight to the main mix
	SynthDef(\gz_thru, { arg in = 0, out = 0, monitor = 0;
		Out.ar(out, InFeedback.ar(in, 2) * Lag.kr(monitor.clip(0, 1), 0.1));
	}).add;

	// CLOUDS' food: a circular mono recording of the input. `run` = 0 is
	// FREEZE -- the write head simply stops, and the grains keep chewing
	// whatever was captured.
	//
	// It also PUBLISHES where the write head is, on a control bus. That is
	// what lets the grain engines read positions RELATIVE TO NOW (the way
	// Clouds does: position 0 is the audio going in this instant, turning the
	// knob walks back in time) instead of at a fixed spot in the buffer,
	// which would be silent until the head happened to pass it.
	// `Phasor` here mirrors RecordBuf's own write index: both advance one
	// frame per sample while `run` is 1 and both hold still while it is 0.
	SynthDef(\gz_capture, { arg in = 0, buf = 0, run = 1, headBus = 0;
		var sig = Mix.ar(InFeedback.ar(in, 2)) * 0.5;
		var frames = BufFrames.kr(buf);
		var head = Phasor.ar(0, run, 0, frames);
		RecordBuf.ar(sig, buf, 0, 1, 0, run, 1, 0, 0);
		Out.kr(headBus, A2K.kr(head) / frames);
	}).add;

	// one-shot sampling: record `dur` seconds of the input into a buffer,
	// starting at `offset` frames. The offset is what lets CHEAT CODES record
	// straight into one pad's slice of its bank buffer without disturbing the
	// pads either side of it. The envelope both gates the recording and frees
	// the synth when the take is done.
	SynthDef(\gz_grab, { arg in = 0, buf = 0, gain = 1, offset = 0, dur = 4;
		var sig = Mix.ar(InFeedback.ar(in, 2)) * 0.5 * gain.clip(0, 4);
		var run = EnvGen.kr(Env([1, 1, 0], [dur, 0]), doneAction: 2);
		RecordBuf.ar(sig, buf, offset, 1, 0, run, 0, 1, doneAction: 0);
	}).add;

	// ----------------------------------------------------------- CLOUDS x 4
	// One SynthDef per playback mode, built from one template. Separate defs
	// (instead of one def with a Select) keep the CPU cost to the mode you
	// are actually using -- a spectral chain running silently in the
	// background next to a grain cloud is exactly the sort of thing that
	// makes a Raspberry Pi give up.
	4.do { |m|
		SynthDef(("gz_clouds" ++ m).asSymbol, {
			arg out = 0, revB = 0, dlyB = 0, inBus = 0, buf = 0, headBus = 0,
			pos = 0.1, gsize = 0.4, dens = 0.45, tex = 0.5, pitch = 0, spread = 0.45,
			jit = 0.15, fb = 0.15, blend = 0, inGain = 1, lofi = 0, cut = 14000, res = 0.1,
			atk = 0.05, rel = 1.2, level = 0.8, pan = 0, send = 0.35, dsend = 0.1,
			gate = 1, amp = 1, mt = 0.05, frz = 0;
			var dry, sig, trig, dur, rate, p, fbSig, head;
			// every continuous parameter is lagged by `mt` (morph time), which
			// is what makes the randomiser GLIDE instead of jump
			pos = Lag.kr(pos, mt); gsize = Lag.kr(gsize, mt); dens = Lag.kr(dens, mt);
			tex = Lag.kr(tex, mt); pitch = Lag.kr(pitch, mt); spread = Lag.kr(spread, mt);
			jit = Lag.kr(jit, mt); fb = Lag.kr(fb, mt); cut = Lag.kr(cut, mt);
			dry = InFeedback.ar(inBus, 2) * inGain.clip(0, 2);
			dur = gsize.clip(0, 1).linexp(0, 1, 0.012, 1.5);
			rate = 2 ** (pitch / 12);
			// where to read from: `position` 0 sits just behind the write head
			// (the sound going in right now), and turning it up walks back
			// through the last few seconds. Freezing stops the head, so the
			// same knob then scrubs the frozen snapshot.
			head = (In.kr(headBus) - 0.02 - (pos * 0.95)).wrap(0, 1);

			case
			// ---- GRANULAR: the classic cloud. `texture` morphs the trigger
			// from a metronome (regular, comb-like) to Dust (irregular, airy).
			{ m == 0 } {
				var d = dens.clip(0, 1).linexp(0, 1, 0.8, 150);
				trig = Select.ar(K2A.ar(tex > 0.5), [Impulse.ar(d), Dust.ar(d)]);
				p = (head + (TRand.ar(-1, 1, trig) * jit * 0.5)).wrap(0, 1);
				// grain makeup: a sparse cloud of short windows is a lot
				// quieter than the material it is made of
				sig = GrainBuf.ar(2, trig, dur, buf, rate, p, 2,
					TRand.ar(-1, 1, trig) * spread, -1, 512) * 3;
			}
			// ---- STRETCH: big overlapping grains crawling through the buffer.
			// `texture` becomes the scan speed (0.5 = frozen in place).
			{ m == 1 } {
				var d = dens.clip(0, 1).linexp(0, 1, 4, 70);
				var scan = (tex - 0.5) * 0.5;
				trig = Impulse.ar(d);
				p = (head + Phasor.ar(0, scan / SampleRate.ir, 0, 1)
					+ (TRand.ar(-1, 1, trig) * jit * 0.2)).wrap(0, 1);
				sig = GrainBuf.ar(2, trig, dur * 2.5, buf, rate, p, 2,
					TRand.ar(-1, 1, trig) * spread, -1, 512) * 2;
			}
			// ---- LOOPING DELAY: no grains at all, a loop window read
			// straight out of the buffer -- Clouds' tape-loop mode.
			{ m == 2 } {
				// the loop window ENDS at the read position and runs backwards
				// in time from it, so the freshest audio is always in the loop.
				// Everything is in normalised (0-1) buffer terms, because the
				// window has to be able to wrap around the end of the buffer.
				var frames = BufFrames.kr(buf);
				var lenNorm = (gsize.clip(0, 1).linexp(0, 1, 0.05, 6)
					/ BufDur.kr(buf)).clip(0.001, 0.95);
				var startNorm = (head - lenNorm).wrap(0, 1);
				var ph, mono;
				ph = (startNorm + Phasor.ar(0, rate * BufRateScale.kr(buf) / frames,
					0, lenNorm)).wrap(0, 1) * frames;
				mono = BufRd.ar(1, buf, ph, 1, 4);
				sig = [mono, DelayC.ar(mono, 0.2, (spread * 0.03) + 0.0005)];
				trig = Impulse.ar(0);
			}
			// ---- SPECTRAL: FFT smear + freeze on the LIVE input, the way
			// Clouds' spectral mode works on what is coming in right now.
			{ m == 3 } {
				var mono = Mix.ar(dry) * 0.5;
				var chain, spec;
				chain = FFT(LocalBuf(2048), mono);
				chain = PV_MagSmear(chain, (tex * 40).clip(0, 40));
				chain = PV_BinShift(chain, rate.clip(0.125, 8), 0);
				chain = PV_MagFreeze(chain, frz);
				// smearing spreads the energy out, so the resynthesis comes
				// back quieter than the other modes without a little makeup
				spec = IFFT(chain) * 2.5;
				sig = [spec, DelayC.ar(spec, 0.05, (spread * 0.02) + 0.0003)];
				trig = Impulse.ar(0);
			};

			// feedback path: a short delay fed back into the grain stream --
			// low settings thicken, high settings build endless smeared tails
			fbSig = LocalIn.ar(2);
			sig = sig + (fbSig * fb.clip(0, 0.95));
			LocalOut.ar(LeakDC.ar(DelayC.ar(sig, 1.0, (dur * 2).clip(0.01, 0.95)).tanh));

			// `in blend` lets the raw input through next to the grains
			sig = sig + (dry * blend.clip(0, 1));

			tail.(sig, cut, res, lofi, atk, rel, gate, level, pan, amp,
				out, revB, dlyB, send, dsend);
		}).add;
	};

	// ------------------------------------------------------- GRAINTOPIA voice
	// One granular voice over a sample slot: a manual seek position plus an
	// independent scan speed (so it can crawl forward, sit still, or run
	// backwards), grain size/density/jitter/spread, pitch, filter.
	SynthDef(\gz_topia, {
		arg out = 0, revB = 0, dlyB = 0, buf = 0,
		pos = 0.2, speed = 0.2, gsize = 0.4, dens = 0.5, jit = 0.1, spread = 0.5,
		pitch = 0, fine = 0, cut = 12000, res = 0.15, lofi = 0, pan = 0, level = 0.7,
		send = 0.3, dsend = 0.15, atk = 0.05, rel = 0.8, gate = 1, amp = 1, mt = 2;
		var trig, dur, rate, p, sig, d, scanHz;
		pos = Lag.kr(pos, mt); speed = Lag.kr(speed, mt); gsize = Lag.kr(gsize, mt);
		dens = Lag.kr(dens, mt); jit = Lag.kr(jit, mt); spread = Lag.kr(spread, mt);
		cut = Lag.kr(cut, mt); pitch = Lag.kr(pitch, mt); res = Lag.kr(res, mt);
		d = dens.clip(0, 1).linexp(0, 1, 1, 120);
		dur = gsize.clip(0, 1).linexp(0, 1, 0.01, 1.2);
		rate = (2 ** ((pitch + (fine / 100)) / 12)) * BufRateScale.kr(buf);
		trig = Impulse.ar(d);
		// scan speed is in buffer-lengths per second, so it means the same
		// thing whatever length the loaded sample happens to be
		scanHz = speed / BufDur.kr(buf).max(0.05);
		p = (pos + Phasor.ar(0, scanHz / SampleRate.ir, 0, 1)
			+ (TRand.ar(-1, 1, trig) * jit * 0.5)).wrap(0, 1);
		sig = GrainBuf.ar(2, trig, dur, buf, rate, p, 2,
			TRand.ar(-1, 1, trig) * spread, -1, 512) * 3;
		tail.(sig, cut, res, lofi, atk, rel, gate, level, pan, amp,
			out, revB, dlyB, send, dsend);
	}).add;

	// ------------------------------------------------------- CHEAT CODES slice
	// One pad hit. Plays a window of the bank buffer (start + length) at a
	// given rate, optionally looping, with `bend` warping the rate at the
	// start of the hit -- the tape-speed dive that gives the original script
	// so much of its character.
	SynthDef(\gz_slice, {
		arg out = 0, revB = 0, dlyB = 0, buf = 0,
		start = 0, slen = 0.125, rate = 1, fine = 0, bend = 0, jit = 0,
		atk = 0.003, rel = 0.2, cut = 16000, res = 0.1, lofi = 0, pan = 0, level = 0.8,
		send = 0.2, dsend = 0.25, loop = 0, gate = 1, amp = 1, vel = 0.8;
		var frames, startF, lenF, rBase, r, ph, mono, sig, line, oneShot, gt, dur;
		frames = BufFrames.kr(buf);
		startF = (start + (TRand.kr(-1, 1, Impulse.kr(0)) * jit * 0.25)).clip(0, 0.999) * frames;
		lenF = (slen.clip(0.001, 1) * frames).max(128);
		rBase = rate * (2 ** (fine / 1200)) * BufRateScale.kr(buf);
		// bend: start the hit up to an octave off and slide back into tune
		r = rBase * (2 ** (bend * EnvGen.kr(Env([1, 0], [0.4]))));
		ph = Phasor.ar(0, r, startF, startF + lenF, startF + ((rBase < 0) * lenF));
		mono = BufRd.ar(1, buf, ph, 1, 4);
		// how long one pass takes -- all init-rate, so Line can use it
		dur = (lenF / (rBase.abs.max(0.01) * SampleRate.ir)).clip(0.01, 60);
		line = Line.kr(0, 1, dur);
		// a non-looping hit closes its own gate when the pass is done; a
		// looping one keeps running until the language closes the gate
		oneShot = Done.kr(line) * (1 - loop.clip(0, 1));
		gt = gate * (1 - oneShot);
		sig = [mono, mono];
		tail.(sig, cut, res, lofi, atk, rel, gt, level * vel.clip(0, 1), pan, amp,
			out, revB, dlyB, send, dsend);
	}).add;

	// ------------------------------------------------------------- FX: DELAY
	// A send effect: engines feed it through their "delay snd" amount, and it
	// adds its wet output back into the main mix bus. Ping-pong amount cross-
	// feeds the two channels, `tone` damps each repeat a little more.
	SynthDef(\gz_fx_delay, {
		arg in = 0, out = 0, active = 1, dtime = 0.375, fb = 0.45, tone = 6000,
		cross = 0.6, mix = 0.7;
		var sig, fbSig, l, r, dl, dr, t;
		sig = In.ar(in, 2);
		t = Lag.kr(dtime.clip(0.02, 4), 0.25);
		fbSig = LocalIn.ar(2);
		l = sig[0] + (fbSig[1] * cross) + (fbSig[0] * (1 - cross));
		r = sig[1] + (fbSig[0] * cross) + (fbSig[1] * (1 - cross));
		dl = DelayC.ar(l, 4, t);
		dr = DelayC.ar(r, 4, t * 1.005);
		LocalOut.ar(LeakDC.ar(LPF.ar([dl, dr], tone.clip(200, 18000)) * fb.clip(0, 0.95)));
		Out.ar(out, [dl, dr] * mix.clip(0, 1) * active.clip(0, 1));
	}).add;

	// ------------------------------------------------------------ FX: REVERB
	// Send effect too. An 8-line feedback delay network with a pitch-shifted
	// (shimmer) copy folded into its input -- the same topology as the
	// ambient_zero_sc reverb, which is a good, cheap, very smooth tail.
	SynthDef(\gz_fx_reverb, {
		arg in = 0, out = 0, active = 1, rsize = 0.72, decay = 0.75, damp = 0.35,
		shimmer = 0.25, mix = 0.8;
		var sig, sh, wet, tmp, fb;
		sig = In.ar(in, 2);
		sh = PitchShift.ar(sig, 0.2, 2, 0, 0.01) * shimmer.clip(0, 1);
		sig = DelayC.ar(sig, 0.2, 0.02) + sh;
		[0.0043, 0.0071, 0.0113, 0.0189].do { |t|
			sig = AllpassC.ar(sig, 0.1, t * (0.5 + rsize), 0.05);
		};
		fb = LocalIn.ar(8);
		tmp = Array.fill(8, { |i|
			var t = [0.0297, 0.0371, 0.0411, 0.0437, 0.0533, 0.0611, 0.0687, 0.0743][i]
				* (0.4 + (rsize * 2.2));
			var m = LFNoise2.kr(0.1 + (i * 0.07)) * 0.25 * 0.0015;
			DelayC.ar(sig[i % 2] + (fb[i] * ((decay * 0.62) + 0.36)), 0.5,
				(t + m).clip(0.001, 0.49));
		});
		tmp = tmp.collect { |x| LPF.ar(x, damp.clip(0, 1).linexp(0, 1, 16000, 700)) };
		tmp = [
			tmp[0] + tmp[1], tmp[0] - tmp[1], tmp[2] + tmp[3], tmp[2] - tmp[3],
			tmp[4] + tmp[5], tmp[4] - tmp[5], tmp[6] + tmp[7], tmp[6] - tmp[7]
		] * 0.5;
		LocalOut.ar(LeakDC.ar(tmp));
		wet = [Mix.ar(tmp[[0, 2, 4, 6]]), Mix.ar(tmp[[1, 3, 5, 7]])] * 0.3;
		wet = AllpassC.ar(wet, 0.05, [0.0071, 0.0091], 0.03);
		Out.ar(out, LeakDC.ar(wet) * mix.clip(0, 1) * active.clip(0, 1));
	}).add;

	// ------------------------------------------------------------- FX: SHAPE
	// An INSERT (the whole mix goes through it): saturation, a tilt EQ, bit
	// reduction and a stereo width control. This is the "make it dirty /
	// make it wide" stage.
	SynthDef(\gz_fx_shape, {
		arg in = 0, out = 0, active = 1, drive = 1, tilt = 0, bits = 24, width = 1, mix = 1;
		var dry, sig, lo, hi, mid, side, d, b;
		dry = In.ar(in, 2);
		d = drive.clip(1, 12);
		sig = (dry * d).tanh / d.sqrt;
		lo = LPF.ar(sig, 700);
		hi = sig - lo;
		sig = (lo * (1 - tilt.clip(-1, 1))) + (hi * (1 + tilt.clip(-1, 1)));
		b = bits.clip(2, 24);
		sig = ((sig * (2 ** b)).round) * (2 ** b.neg);
		mid = (sig[0] + sig[1]) * 0.5;
		side = (sig[0] - sig[1]) * 0.5 * width.clip(0, 2);
		sig = [mid + side, mid - side];
		Out.ar(out, XFade2.ar(dry, LeakDC.ar(sig), ((mix * active).clip(0, 1) * 2) - 1));
	}).add;

	// ------------------------------------------------------------ FX: MASTER
	// Compressor + limiter, always the last thing before the outputs. Makeup
	// gain sits BEFORE the limiter, so raising it can never push the output
	// past the ceiling.
	SynthDef(\gz_fx_master, {
		arg in = 0, out = 0, active = 1, threshold = 0.2, ratio = 4, attack = 0.01,
		release = 0.15, makeup = 1.2, ceiling = 0.95, amp = 0.9;
		var dry, comp, sig;
		dry = In.ar(in, 2);
		comp = Compander.ar(dry, dry,
			thresh: threshold.clip(0.01, 1), slopeBelow: 1,
			slopeAbove: (1 / ratio.max(1)), clampTime: attack, relaxTime: release);
		sig = Limiter.ar(comp * makeup.clip(0.1, 8), ceiling.clip(0.05, 1), 0.01);
		sig = XFade2.ar(dry, sig, (active.clip(0, 1) * 2) - 1);
		// a level readout for the headless status line (~gz.status)
		SendReply.kr(Impulse.kr(4), '/gz_meter',
			[Amplitude.kr(dry[0], 0.01, 0.2), Amplitude.kr(sig[0], 0.01, 0.2)]);
		Out.ar(out, sig * amp.clip(0, 2));
	}).add;
}];
