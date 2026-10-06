var nTables = 64, tableSize = 512;
~az.defineSynths = [{ |s|
	var lfo, tail, noiseGens;

	// `lfo` -- újrafelhasználható függvény: 10 LFO-hullámforma közül
	// választ (`Select.kr`) a `shape` paraméter alapján. Ez hajtja meg
	// mind a 2 LFO-t ÉS a fő "mod" modulátort minden hangban.
	lfo = { |shape, freq, mul = 1|
		Select.kr(shape.clip(0, 9), [
			SinOsc.kr(freq),
			(LFPulse.kr(freq, 0, 0.5) * 2) - 1,
			LFTri.kr(freq),
			LFSaw.kr(freq),
			LFSaw.kr(freq).neg,
			LFNoise0.kr(freq),
			LFNoise2.kr(freq),
			(((LFSaw.kr(freq) * 0.5) + 0.5).pow(0.3) * 2) - 1,
			(((LFSaw.kr(freq) * -0.5) + 0.5).pow(0.3) * 2) - 1,
			(LFPulse.kr(freq, 0, 0.1) * 2) - 1
		]) * mul;
	};

	// `tail` -- a "közös utolsó szakasz", amin MINDEN hang áthalad: szűrő
	// (filter), burkológörbe (ADSR envelope), panorámázás, és a reverb-
	// send elküldése a REVERB+SHIMMER effekthez.
	tail = { |sig, gate, atk, dec, sus, rel, cut, res, egAmt, ftype,
		dCut, dLvl, dPan, level, pan, vel, out, revB, revSend|
		var env, fc, q, o;
		// `EnvGen.kr(Env.adsr(...), gate, doneAction: 2)` -- ADSR burkoló-
		// görbe; a `doneAction: 2` KRITIKUS: amikor a hang teljesen
		// lecsengett, EZ SZABADÍTJA FEL a Synth-et (enélkül a lejátszott
		// hangok soha nem tűnnének el, feleslegesen fogyasztva CPU-t).
		env = EnvGen.kr(Env.adsr(atk, dec, sus, rel, curve: -2), gate, doneAction: 2);
		fc = (cut * (2 ** ((env * egAmt * 4) + (dCut * 6)))).clip(20, 18000);
		q = (1 - res).clip(0.05, 1);
		// 3 szűrőtípus közül választ (LPF/BPF/HPF)
		o = Select.ar(ftype.clip(0, 2), [
			RLPF.ar(sig, fc, q),
			BPF.ar(sig, fc, q * 1.5),
			RHPF.ar(sig, fc, q)
		]);
		o = o * env * vel * level * (1 + dLvl).clip(0, 2);
		o = LeakDC.ar(o.softclip) * 0.22;
		o = Pan2.ar(o, (pan + dPan).clip(-1, 1));
		Out.ar(out, o);
		Out.ar(revB, o * revSend);
	};

	// ---- 6 Blendwave structures ------------------------------------------
	6.do { |st|
		// a 6 "Blendwave struktúra" (DRONE1/2, PAD1/2, ATMOS1/2) -- lásd a
		// norns Engine_AmbientZero.sc-ben a TELJES, soronkénti magyarázatot
		// az oszcillátor-elrendezésekről és az LFO-célzásról.
		SynthDef(("az_str" ++ st).asSymbol, {
			arg out = 0, revB = 0, revSend = 0.3, gate = 1, hz = 110, vel = 0.7,
			bank = 0, harmonic = 0.3, modDepth = 0.2, modRate = 0.25, modShape = 0,
			balance = 0.5, detune = 9, pitch = 0, fmAmt = 0.3, ratio = 2, ringAmt = 0.5,
			atk = 2, dec = 3, sus = 0.7, rel = 6,
			cut = 3500, res = 0.2, egAmt = 0.2, ftype = 0,
			l1rate = 0.05, l1depth = 0.2, l1shape = 0, l1dest = 2,
			l2rate = 0.11, l2depth = 0.12, l2shape = 6, l2dest = 1,
			level = 0.7, pan = 0,
			glide = 0, bend = 0, press = 0;

			var m1, m2, mod, dPitch, dCut, dHarm, dLvl, dPan, dMod;
			var f, pos, posY, sig, top = nTables - 1;

			m1 = lfo.(l1shape, l1rate.linexp(0, 1, 0.01, 12), l1depth);
			m2 = lfo.(l2shape, l2rate.linexp(0, 1, 0.01, 12), l2depth);
			dPitch = Select.kr(l1dest, [m1, 0, 0, 0, 0, 0]) + Select.kr(l2dest, [m2, 0, 0, 0, 0, 0]);
			dCut   = Select.kr(l1dest, [0, m1, 0, 0, 0, 0]) + Select.kr(l2dest, [0, m2, 0, 0, 0, 0]);
			dHarm  = Select.kr(l1dest, [0, 0, m1, 0, 0, 0]) + Select.kr(l2dest, [0, 0, m2, 0, 0, 0]);
			dLvl   = Select.kr(l1dest, [0, 0, 0, m1, 0, 0]) + Select.kr(l2dest, [0, 0, 0, m2, 0, 0]);
			dPan   = Select.kr(l1dest, [0, 0, 0, 0, m1, 0]) + Select.kr(l2dest, [0, 0, 0, 0, m2, 0]);
			dMod   = Select.kr(l1dest, [0, 0, 0, 0, 0, m1]) + Select.kr(l2dest, [0, 0, 0, 0, 0, m2]);

			mod = lfo.(modShape, modRate.linexp(0, 1, 0.01, 16), (modDepth + dMod).clip(0, 1));

			f = Lag.kr(hz, glide) * (2 ** ((pitch + bend + (dPitch * 1200)) / 1200));

			pos = (harmonic + dHarm + (mod * (if((st == 1) or: { (st == 2) or: { st == 3 } }, { 0.5 }, { 0 })))).clip(0, 1) * top;
			posY = top - pos;

			sig = switch(st,
				0, {
					var d = detune * (1 + (mod * 2));
					var a = VOsc.ar(bank + pos, f * (2 ** (d / 1200)));
					var b = VOsc.ar(bank + posY, f * (2 ** (d.neg / 1200)));
					XFade2.ar(a, b, (balance * 2) - 1);
				},
				1, {
					var a = VOsc.ar(bank + pos, f * (2 ** (detune / 1200)));
					var b = VOsc.ar(bank + posY, f * (2 ** (detune.neg / 1200)));
					XFade2.ar(a, b, (balance * 2) - 1);
				},
				2, {
					var a = VOsc.ar(bank + pos, f);
					var b = VOsc.ar(bank + posY, f * (2 ** (detune / 1200)));
					var c = VOsc.ar(bank + posY, f * (2 ** (detune.neg / 1200)) * 2);
					XFade2.ar(a, (b + c) * 0.5, (balance * 2) - 1);
				},
				3, {
					var a = VOsc.ar(bank + pos, f);
					var b = VOsc.ar(bank + pos, f * (2 ** (detune / 1200)) * 1.4983);
					var c = VOsc.ar(bank + posY, f * (2 ** (detune.neg / 1200)) * 0.5);
					XFade2.ar((a + b) * 0.5, c, (balance * 2) - 1);
				},
				4, {
					var a = VOsc.ar(bank + pos, f);
					var r = SinOsc.ar(f * ratio * (1 + (mod * 0.5)));
					XFade2.ar(a, a * r, (ringAmt * 2) - 1);
				},
				{
					var mf = f * ratio;
					var m = VOsc.ar(bank + posY, mf) * mf * fmAmt * 4;
					var a = VOsc.ar(bank + pos, (f + m + (f * mod * 0.06)).clip(20, 18000));
					var b = VOsc.ar(bank + posY, f * (2 ** (detune / 1200)));
					XFade2.ar(a, b, (balance * 2) - 1);
				}
			);

			sig = sig * (1 + (press * 0.6));
			tail.(sig, gate, atk, dec, sus, rel, cut, res, egAmt, ftype,
				dCut, dLvl, dPan, level, pan, vel, out, revB, revSend);
		}).add;
	};

	// ---- NOISE layer: 8 synthesised nature textures ----------------------
	noiseGens = [
		{ |f, m| BPF.ar(WhiteNoise.ar(0.5) + (Dust2.ar(2500 * (1 + m)) * 0.25), (f * 12).clip(40, 16000), 0.9)
			+ LPF.ar(BrownNoise.ar(0.2), (f * 3).clip(40, 16000)) },
		{ |f, m| BPF.ar(PinkNoise.ar(1.6), (f * (4 + LFNoise2.kr(0.13).range(1, 8)) * (1 + m)).clip(40, 16000), 0.35) },
		{ |f, m| var e = LFNoise2.kr(0.08).range(0.1, 1);
			LPF.ar(BrownNoise.ar(1.4) * e, (f * (5 + (e * 12)) * (1 + m)).clip(40, 16000)) },
		{ |f, m| Mix.fill(5, { |i|
			BPF.ar(WhiteNoise.ar(0.4), (f * (8 + (i * 5)) * LFNoise2.kr(0.4 + (i * 0.2)).range(0.8, 1.4) * (1 + m)).clip(40, 16000), 0.12) }) },
		{ |f, m| LPF.ar(BrownNoise.ar(0.7), (f * 4 * (1 + m)).clip(40, 16000))
			+ BPF.ar((Dust2.ar(9) * 6) + WhiteNoise.ar(0.1), (f * 16).clip(40, 16000), 0.4) },
		{ |f, m| (SinOsc.ar((f * LFNoise1.kr(6).range(24, 40) * (1 + m)).clip(40, 12000))
			* EnvGen.kr(Env.perc(0.01, 0.12), Dust.kr(0.8)) * 0.15)
			+ BPF.ar(PinkNoise.ar(0.6), (f * 6).clip(40, 16000), 0.5) },
		{ |f, m| (LPF.ar(BrownNoise.ar(2.2), (f * 1.5 * (1 + m)).clip(30, 8000))
			* LFNoise2.kr(0.06).range(0.05, 1).pow(2))
			+ LPF.ar(WhiteNoise.ar(0.07), (f * 8).clip(40, 16000)) },
		{ |f, m| (BPF.ar(WhiteNoise.ar(1.0), (f * 40 * (1 + m)).clip(200, 16000), 0.02)
			* LFPulse.kr(11, 0, 0.35).lag(0.004) * 0.6)
			+ BPF.ar(PinkNoise.ar(0.3), (f * 5).clip(40, 16000), 0.6) }
	];

	noiseGens.do { |gen, i|
		// NOISE réteg: a 8 szintetizált "természeti" textúra (eső, szél,
		// óceán, patak, tűz, erdő, mennydörgés, éjszaka) egy KÖZÖS SynthDef-
		// sablonba kerül, a `noiseGens` listából kiválasztott recepttel.
		SynthDef(("az_noise" ++ i).asSymbol, {
			arg out = 0, revB = 0, revSend = 0.3, gate = 1, hz = 110, vel = 0.7,
			noiseMix = 0.15, pitch = 0, modDepth = 0.2, modRate = 0.25, modShape = 0,
			atk = 1, dec = 2, sus = 0.85, rel = 5,
			cut = 6000, res = 0.1, egAmt = 0, ftype = 0,
			l1rate = 0.05, l1depth = 0.2, l1shape = 0, l1dest = 1,
			l2rate = 0.11, l2depth = 0.1, l2shape = 6, l2dest = 4,
			level = 0.7, pan = 0, press = 0;
			var m1, m2, dCut, dLvl, dPan, mod, f, sig;
			m1 = lfo.(l1shape, l1rate.linexp(0, 1, 0.01, 12), l1depth);
			m2 = lfo.(l2shape, l2rate.linexp(0, 1, 0.01, 12), l2depth);
			dCut = Select.kr(l1dest, [0, m1, 0, 0, 0, 0]) + Select.kr(l2dest, [0, m2, 0, 0, 0, 0]);
			dLvl = Select.kr(l1dest, [0, 0, 0, m1, 0, 0]) + Select.kr(l2dest, [0, 0, 0, m2, 0, 0]);
			dPan = Select.kr(l1dest, [0, 0, 0, 0, m1, 0]) + Select.kr(l2dest, [0, 0, 0, 0, m2, 0]);
			mod = lfo.(modShape, modRate.linexp(0, 1, 0.01, 16), modDepth);
			f = hz * (2 ** (pitch / 1200));
			sig = gen.(f, mod * 0.5);
			sig = sig + (WhiteNoise.ar(noiseMix) * (1 + press));
			tail.(sig, gate, atk, dec, sus, rel, cut, res, egAmt, ftype,
				dCut, dLvl, dPan, level, pan, vel, out, revB, revSend);
		}).add;
	};

	[1, 2].do { |ch|
		// a NOISE réteg SAJÁT hangfájlt (WAV) is le tud játszani a 8
		// szintetizált textúra helyett -- mono és sztereó fájlokhoz KÜLÖN
		// SynthDef kell, mert a csatornaszám fordításkor rögzül.
		SynthDef(("az_noisebuf" ++ ch).asSymbol, {
			arg out = 0, revB = 0, revSend = 0.3, gate = 1, hz = 110, vel = 0.7,
			buf = 0, loop = 1, start = 0, noiseMix = 0.1, pitch = 0,
			modDepth = 0.2, modRate = 0.25, modShape = 0,
			atk = 0.5, dec = 2, sus = 0.9, rel = 4,
			cut = 8000, res = 0.1, egAmt = 0, ftype = 0,
			l1rate = 0.05, l1depth = 0.2, l1shape = 0, l1dest = 1,
			l2rate = 0.11, l2depth = 0.1, l2shape = 6, l2dest = 4,
			level = 0.7, pan = 0, press = 0;
			var m1, m2, dCut, dLvl, dPan, mod, rate, sig;
			m1 = lfo.(l1shape, l1rate.linexp(0, 1, 0.01, 12), l1depth);
			m2 = lfo.(l2shape, l2rate.linexp(0, 1, 0.01, 12), l2depth);
			dCut = Select.kr(l1dest, [0, m1, 0, 0, 0, 0]) + Select.kr(l2dest, [0, m2, 0, 0, 0, 0]);
			dLvl = Select.kr(l1dest, [0, 0, 0, m1, 0, 0]) + Select.kr(l2dest, [0, 0, 0, m2, 0, 0]);
			dPan = Select.kr(l1dest, [0, 0, 0, 0, m1, 0]) + Select.kr(l2dest, [0, 0, 0, 0, m2, 0]);
			mod = lfo.(modShape, modRate.linexp(0, 1, 0.01, 16), modDepth);
			rate = (hz / 110) * (2 ** ((pitch + (mod * 600)) / 1200)) * BufRateScale.kr(buf);
			sig = PlayBuf.ar(ch, buf, rate, 1, BufFrames.kr(buf) * start.clip(0, 0.99), loop);
			sig = Mix.ar(sig) * if(ch == 2, { 0.7 }, { 1.0 });
			sig = sig + (WhiteNoise.ar(noiseMix) * (1 + press));
			tail.(sig, gate, atk, dec, sus, rel, cut, res, egAmt, ftype,
				dCut, dLvl, dPan, level, pan, vel, out, revB, revSend);
		}).add;
	};

	// Original algorithmic percussion voice: tuned impacts, noisy transients,
	// inharmonic resonances, and controllable sample-rate/bit reduction.
	SynthDef(\az_keinseier, { |out = 0, revB = 0, hz = 110, vel = 0.8, gate = 1,
		mode = 0, decay = 0.24, pitch = 0, tone = 8000, snap = 0.35, body = 0.65,
		grit = 0.2, level = 0.7, pan = 0, revSend = 0|
		var base, bodyEnv, snapEnv, pitchEnv, noise, kick, snare, metal, wood, glitch;
		var raw, sig, crushRate, bits, crushed, toneHz;
		base = (hz * (2 ** (pitch / 12))).clip(25, 12000);
		// Percussive voices ignore note-off. Each hit owns its full envelope.
		bodyEnv = EnvGen.kr(Env.perc(0.001, decay.clip(0.02, 3), curve: -5), doneAction: 2);
		snapEnv = EnvGen.kr(Env.perc(0.001, (decay * 0.22).clip(0.008, 0.45), curve: -8));
		pitchEnv = EnvGen.kr(Env.perc(0.001, 0.055, curve: -6));
		toneHz = tone.clip(250, 12000);
		noise = HPF.ar(WhiteNoise.ar(1), toneHz) * snapEnv;
		kick = SinOsc.ar((base * (1 + (pitchEnv * (2 + (snap * 16))))).clip(25, 15000)) * bodyEnv;
		snare = (SinOsc.ar((base * 1.47).clip(30, 12000)) * body) + (noise * (0.3 + snap));
		snare = snare * bodyEnv;
		metal = Mix([SinOsc.ar((base * 2.013).clip(30, 15000)),
			SinOsc.ar((base * 2.771).clip(30, 15000)) * 0.7,
			SinOsc.ar((base * 4.193).clip(30, 15000)) * 0.45]);
		metal = (metal * body + (noise * snap)) * bodyEnv;
		wood = Mix(Ringz.ar(Impulse.ar(0), [base, base * 2.37, base * 3.91], decay.clip(0.02, 3))) * bodyEnv;
		glitch = (noise + (BPF.ar(WhiteNoise.ar(1), toneHz, 0.08) * Dust2.ar(grit.linexp(0, 1, 3, 100)))) * bodyEnv;
		raw = Select.ar(mode.round.clip(0, 4), [kick, snare, metal, wood, glitch]);
		raw = raw + (noise * snap * 0.35);
		crushRate = grit.clip(0, 1).linexp(0, 1, 24000, 1500);
		bits = grit.clip(0, 1).linlin(0, 1, 16, 4);
		crushed = Latch.ar(raw, Impulse.ar(crushRate));
		crushed = (crushed * (2 ** bits)).round * (2 ** bits.neg);
		sig = XFade2.ar(raw, crushed, (grit.clip(0, 1) * 2) - 1);
		sig = RLPF.ar(sig, toneHz, (0.25 + ((1 - grit) * 0.5)).clip(0.05, 0.9));
		sig = LeakDC.ar(sig.softclip) * bodyEnv * vel.clip(0, 1) * level.clip(0, 1);
		sig = Pan2.ar(sig, pan.clip(-1, 1));
		Out.ar(out, sig);
		Out.ar(revB, sig * revSend.clip(0, 1));
	}).add;

	// ---- REVERB as a slot-compatible effect: same in/out/active/mix
	// interface as the chorus/flanger/delay slot effects below, so any of
	// the 4 can be freely chosen for fx1/fx2/fx3. Self-contained 8-line FDN
	// with shimmer (pitch-shifted feedback) folded into the same insert.
	// ---- FX-LÁNC EFFEKTEK -- mindegyik ugyanazt a "közös nyelvet"
	// beszéli: van `in`/`out` busza, egy `active` (bypass) kapcsolója,
	// és egy `mix` (száraz/nedves) csúszkája -- ez teszi lehetővé, hogy
	// BÁRMELYIK effekt BÁRMELYIK FX-slotba (1/2/3) betehető legyen.
	//
	// slot-kompatibilis REVERB (a fix REVERB+SHIMMER-től FÜGGETLEN példány)
	SynthDef(\az_slot_reverb, {
		arg in = 0, out = 0, active = 1, mix = 0.5, size = 0.7, decay = 0.72,
		damp = 0.35, shimmer = 0.3;
		var dry, sig, sh, wet, tmp, fb;
		dry = In.ar(in, 2);
		sig = DelayC.ar(dry, 0.2, 0.02);

		sh = PitchShift.ar(dry, 0.2, 2, 0, 0.01) * shimmer;
		sig = sig + sh;

		[0.0043, 0.0071, 0.0113, 0.0189].do { |t|
			sig = AllpassC.ar(sig, 0.1, t * (0.5 + size), 0.05);
		};

		fb = LocalIn.ar(8);
		tmp = Array.fill(8, { |i|
			var t = [0.0297, 0.0371, 0.0411, 0.0437, 0.0533, 0.0611, 0.0687, 0.0743][i]
				* (0.4 + (size * 2.2));
			var m = LFNoise2.kr(0.1 + (i * 0.07)) * 0.25 * 0.0015;
			DelayC.ar(sig[i % 2] + (fb[i] * ((decay * 0.62) + 0.36)), 0.5, (t + m).clip(0.001, 0.49));
		});
		tmp = tmp.collect { |x| LPF.ar(x, damp.linexp(0, 1, 16000, 700)) };
		tmp = [
			tmp[0] + tmp[1], tmp[0] - tmp[1], tmp[2] + tmp[3], tmp[2] - tmp[3],
			tmp[4] + tmp[5], tmp[4] - tmp[5], tmp[6] + tmp[7], tmp[6] - tmp[7]
		] * 0.5;
		LocalOut.ar(LeakDC.ar(tmp));

		wet = [Mix.ar(tmp[[0, 2, 4, 6]]), Mix.ar(tmp[[1, 3, 5, 7]])] * 0.3;
		wet = AllpassC.ar(wet, 0.05, [0.0071, 0.0091], 0.03);
		wet = LeakDC.ar(wet);
		Out.ar(out, XFade2.ar(dry, wet, ((mix * active).clip(0, 1) * 2) - 1));
	}).add;

	// ---- fixed MASTER reverb + shimmer stage: fed by each layer's own
	// "reverb snd" amount (a parallel send, independent of the fx1/fx2/fx3
	// serial chain), positioned right before the compressor/limiter. This
	// is what makes the per-layer send knobs meaningful -- turning a
	// layer's send up puts more of THAT layer into this shared reverb tail.
	// a FIX REVERB+SHIMMER -- ez NEM "insert" effekt (nincs a jel
	// útjába beépítve), hanem PÁRHUZAMOS "send-return": a bemenete a
	// `revBus`, amit MINDEN réteg feltölt a SAJÁT "reverb snd" (send)
	// mennyiségével -- innen a "rétegenkénti send" koncepció a GUI-ban.
	SynthDef(\az_master_revshim, {
		arg in = 0, out = 0, active = 1, mix = 1, size = 0.7, decay = 0.72,
		damp = 0.35, shimmer = 0.3;
		var sig, sh, wet, tmp, fb;
		sig = In.ar(in, 2);
		sh = PitchShift.ar(sig, 0.2, 2, 0, 0.01) * shimmer;
		sig = DelayC.ar(sig, 0.2, 0.02) + sh;

		[0.0043, 0.0071, 0.0113, 0.0189].do { |t|
			sig = AllpassC.ar(sig, 0.1, t * (0.5 + size), 0.05);
		};

		fb = LocalIn.ar(8);
		tmp = Array.fill(8, { |i|
			var t = [0.0297, 0.0371, 0.0411, 0.0437, 0.0533, 0.0611, 0.0687, 0.0743][i]
				* (0.4 + (size * 2.2));
			var m = LFNoise2.kr(0.1 + (i * 0.07)) * 0.25 * 0.0015;
			DelayC.ar(sig[i % 2] + (fb[i] * ((decay * 0.62) + 0.36)), 0.5, (t + m).clip(0.001, 0.49));
		});
		tmp = tmp.collect { |x| LPF.ar(x, damp.linexp(0, 1, 16000, 700)) };
		tmp = [
			tmp[0] + tmp[1], tmp[0] - tmp[1], tmp[2] + tmp[3], tmp[2] - tmp[3],
			tmp[4] + tmp[5], tmp[4] - tmp[5], tmp[6] + tmp[7], tmp[6] - tmp[7]
		] * 0.5;
		LocalOut.ar(LeakDC.ar(tmp));

		wet = [Mix.ar(tmp[[0, 2, 4, 6]]), Mix.ar(tmp[[1, 3, 5, 7]])] * 0.3;
		wet = AllpassC.ar(wet, 0.05, [0.0071, 0.0091], 0.03);
		// this is a parallel send-return (not an insert), so there's no
		// local "dry" to crossfade against -- just add the wet tail,
		// scaled by mix/active, into the shared bus it shares with fx3's
		// output (Out.ar sums onto an existing bus rather than overwriting).
		Out.ar(out, LeakDC.ar(wet) * mix * active.clip(0, 1));
	}).add;

	// ---- MASTER FX: fixed compressor + limiter combo, always the very
	// last stage before hardware output. 5 parameters: threshold, ratio,
	// attack, release (compressor) and ceiling (limiter, true-peak safety).
	// a FIX MASTER kompresszor+limiter -- MINDIG a lánc legvégén fut,
	// közvetlenül a hangkimenet előtt.
	SynthDef(\az_master_complim, {
		arg in = 0, out = 0, active = 1, threshold = 0.15, ratio = 4,
		attack = 0.01, release = 0.15, ceiling = 0.95, makeup = 1, amp = 1;
		var dry, comp, sig, inAmp, grAmp, outAmp;
		dry = In.ar(in, 2);
		comp = Compander.ar(dry, dry,
			thresh: threshold, slopeBelow: 1, slopeAbove: (1 / ratio.max(1)),
			clampTime: attack, relaxTime: release);
		// `makeup` -- utólagos erősítés. A Compander CSAK halkítani tud, így
		// nélküle a kompresszió legjobb esetben is csak "kicsit halkabb"
		// eredményt ad: pont ezért tűnik úgy, mintha a master szekció nem
		// csinálna semmit. A makeup a limiter ELŐTT van, tehát a `ceiling`
		// továbbra is megvédi a kimenetet a túlvezérléstől.
		sig = Limiter.ar(comp * makeup, ceiling, 0.01);
		sig = XFade2.ar(dry, sig, (active.clip(0, 1) * 2) - 1);

		// ---- MÉRŐ (meter): a GUI-nak visszaküldött 3 érték 8x másodpercenként.
		// Enélkül a kompresszor teljesen "vak": nem látszik, hogy egyáltalán
		// bekapcsol-e. `grAmp` = a kompresszor SAJÁT erősítés-változása
		// (makeup NÉLKÜL), tehát 1.0 = nincs kompresszió, 0.5 = -6 dB.
		inAmp = Amplitude.kr(dry[0], 0.01, 0.2);
		outAmp = Amplitude.kr(sig[0], 0.01, 0.2);
		grAmp = (Amplitude.kr(comp[0], 0.01, 0.2) / inAmp.max(1e-4)).clip(0.0001, 1);
		SendReply.kr(Impulse.kr(8), '/az_master_meter', [inAmp, grAmp, outAmp]);

		// final gain applied AFTER the limiter/ceiling so raising volume
		// can't defeat the peak-safety stage
		Out.ar(out, sig * amp);
	}).add;

	// slot-compatible compressor/limiter -- same DSP as the fixed master
	// stage above, but with a mix control so it can also be placed in any
	// of the fx1/fx2/fx3 slots (e.g. to compress before the reverb, in
	// addition to the always-present master stage at the very end).
	// ugyanaz a kompresszor+limiter, "slot-kompatibilis" verzióban (van
	// `mix` csúszkája) -- BÁRMELYIK FX-slotba betehető, a fix MASTER-től
	// FÜGGETLENÜL.
	SynthDef(\az_slot_complim, {
		arg in = 0, out = 0, active = 1, mix = 1, threshold = 0.15, ratio = 4,
		attack = 0.01, release = 0.15, ceiling = 0.95, makeup = 1;
		var dry, sig;
		dry = In.ar(in, 2);
		sig = Compander.ar(dry, dry,
			thresh: threshold, slopeBelow: 1, slopeAbove: (1 / ratio.max(1)),
			clampTime: attack, relaxTime: release);
		sig = Limiter.ar(sig * makeup, ceiling, 0.01);
		Out.ar(out, XFade2.ar(dry, sig, ((mix * active).clip(0, 1) * 2) - 1));
	}).add;

	// ---- the 5 original Brain Ø master effect types, rebuilt as
	// slot-compatible insert effects (in/out/active/mix + 4 own params).

	// TAPE DLY -- szalagos visszhang, "wow" (lassú hangmagasság-
	// ingadozás) szimulációval, organikus, "élő" hangzást adva.
	SynthDef(\az_slot_tape, {
		arg in = 0, out = 0, active = 1, mix = 0.4, time = 0.375,
		feedback = 0.45, tone = 4000, wow = 0.3;
		var dry, fb, d;
		dry = In.ar(in, 2);
		fb = LocalIn.ar(2);
		d = DelayC.ar(dry + (fb * feedback.clip(0, 0.95)), 4,
			(time * (1 + (LFNoise2.kr([0.7, 1.1]) * wow * 0.02))).clip(0.001, 3.9));
		d = LPF.ar(HPF.ar(d, 120), tone);
		d = (d * 1.4).tanh * 0.8;
		LocalOut.ar(d);
		Out.ar(out, XFade2.ar(dry, dry + d, ((mix * active).clip(0, 1) * 2) - 1));
	}).add;

	// REV DLY -- "fordított" visszhang: egy Phasor segítségével
	// megfordítjuk a visszhang lejátszási irányát.
	SynthDef(\az_slot_revdelay, {
		arg in = 0, out = 0, active = 1, mix = 0.4, time = 1.0,
		feedback = 0.3, tone = 6000, spread = 0.3;
		var dry, rd, len, ph, wet;
		dry = In.ar(in, 2);
		len = time.clip(0.05, 3.9);
		ph = Phasor.ar(0, 1 / SampleRate.ir, 0, len);
		rd = DelayC.ar(dry, 4, [(len - ph + 0.001).clip(0.001, 3.99),
			(len - ph + 0.001 + (spread * 0.05)).clip(0.001, 3.99)]);
		rd = LPF.ar(rd, tone);
		rd = rd + DelayC.ar(rd * feedback.clip(0, 0.9), 4, len);
		wet = dry + rd;
		Out.ar(out, XFade2.ar(dry, wet, ((mix * active).clip(0, 1) * 2) - 1));
	}).add;

	// OVERDRIVE -- meleg, szaturált torzítás (`tanh` görbe).
	SynthDef(\az_slot_drive, {
		arg in = 0, out = 0, active = 1, mix = 0.7, drive = 0.4,
		tone = 3000, bias = 0, outLevel = 1;
		var dry, d;
		dry = In.ar(in, 2);
		d = ((dry + bias) * drive.linexp(0, 1, 1, 60)).tanh;
		d = LPF.ar(d, tone) * drive.linexp(0, 1, 1, 0.35) * outLevel;
		Out.ar(out, XFade2.ar(dry, d, ((mix * active).clip(0, 1) * 2) - 1));
	}).add;

	// CRUSH -- bit- és mintavétel-csökkentés (klasszikus "lo-fi" hangzás).
	SynthDef(\az_slot_crush, {
		arg in = 0, out = 0, active = 1, mix = 0.6, bits = 8,
		rate = 8000, drive = 1, smooth = 0.3;
		var dry, c, q;
		dry = In.ar(in, 2);
		q = 0.5 ** bits.clip(1, 16);
		c = ((dry * drive) / q).round * q;
		c = Latch.ar(c, Impulse.ar(rate));
		c = LPF.ar(c, smooth.linexp(0, 1, 20000, 2000));
		Out.ar(out, XFade2.ar(dry, c, ((mix * active).clip(0, 1) * 2) - 1));
	}).add;

	// TILT EQ -- "dönthető" hangszín-szűrő: egyszerre emeli az egyik
	// véget és süllyeszti a másikat egy adott frekvencia körül.
	SynthDef(\az_slot_tilt, {
		arg in = 0, out = 0, active = 1, mix = 1.0, tilt = 0,
		freq = 900, res = 1, drive = 1;
		var dry, sig;
		dry = In.ar(in, 2);
		sig = BLowShelf.ar(dry, freq, res, tilt.neg * 12);
		sig = BHiShelf.ar(sig, freq, res, tilt * 12);
		sig = (sig * drive).tanh * drive.reciprocal.max(0.3);
		Out.ar(out, XFade2.ar(dry, sig, ((mix * active).clip(0, 1) * 2) - 1));
	}).add;

	// ---- end-of-chain effects: always instantiated, each independently
	// bypassable (active) and mix-able, placed after the master fx slot so
	// the overall output has continuous, evolving movement. ------------------

	// CHORUS -- késleltetett, lassan ingadozó másolatokkal keveri a
	// bemenetet, "kettőzött", szélesebb hangzást adva.
	SynthDef(\az_end_chorus, {
		arg in = 0, out = 0, active = 1, mix = 0.5, rate = 0.3, depth = 0.5,
		feedback = 0.25, spread = 0.5;
		var dry, fb, wetL, wetR, lfoL, lfoR, base = 0.012, wet;
		dry = In.ar(in, 2);
		fb = LocalIn.ar(2);
		lfoL = SinOsc.kr(rate.linexp(0, 1, 0.03, 4));
		lfoR = SinOsc.kr(rate.linexp(0, 1, 0.03, 4) * 1.07, pi * spread);
		wetL = DelayC.ar(dry[0] + (fb[0] * feedback.clip(0, 0.9)), 0.05,
			(base + (lfoL * depth * 0.008)).clip(0.001, 0.045));
		wetR = DelayC.ar(dry[1] + (fb[1] * feedback.clip(0, 0.9)), 0.05,
			(base + (lfoR * depth * 0.008)).clip(0.001, 0.045));
		LocalOut.ar([wetL, wetR]);
		wet = [wetL, wetR];
		Out.ar(out, XFade2.ar(dry, wet, ((mix * active).clip(0, 1) * 2) - 1));
	}).add;

	// FLANGER -- mint a CHORUS, csak rövidebb késleltetéssel és nagyobb
	// visszacsatolással -- "fém csövön átfújt" hangzás.
	SynthDef(\az_end_flanger, {
		arg in = 0, out = 0, active = 1, mix = 0.5, rate = 0.2, depth = 0.7,
		feedback = 0.5, delayBase = 0.003;
		var dry, fb, wetL, wetR, lfoL, lfoR, wet;
		dry = In.ar(in, 2);
		fb = LocalIn.ar(2);
		lfoL = SinOsc.kr(rate.linexp(0, 1, 0.02, 3));
		lfoR = SinOsc.kr(rate.linexp(0, 1, 0.02, 3), pi / 2);
		wetL = DelayC.ar(dry[0] + (fb[0] * feedback.clip(0, 0.95)), 0.03,
			(delayBase + (lfoL * depth * 0.0025)).clip(0.0002, 0.028));
		wetR = DelayC.ar(dry[1] + (fb[1] * feedback.clip(0, 0.95)), 0.03,
			(delayBase + (lfoR * depth * 0.0025)).clip(0.0002, 0.028));
		LocalOut.ar([wetL, wetR]);
		wet = [wetL, wetR];
		Out.ar(out, XFade2.ar(dry, wet, ((mix * active).clip(0, 1) * 2) - 1));
	}).add;

	// DELAY -- klasszikus, sztereó "ping-pong" visszhang.
	SynthDef(\az_end_delay, {
		arg in = 0, out = 0, active = 1, mix = 0.35, timeL = 0.375, timeR = 0.5,
		feedback = 0.35, damp = 0.4, cross = 0.5;
		var dry, fbIn, dL, dR, wet;
		dry = In.ar(in, 2);
		fbIn = LocalIn.ar(2);
		dL = DelayC.ar(dry[0] + (fbIn[1] * cross * feedback) + (fbIn[0] * (1 - cross) * feedback),
			2, timeL.clip(0.01, 1.9));
		dR = DelayC.ar(dry[1] + (fbIn[0] * cross * feedback) + (fbIn[1] * (1 - cross) * feedback),
			2, timeR.clip(0.01, 1.9));
		dL = LPF.ar(dL, damp.linexp(0, 1, 12000, 800));
		dR = LPF.ar(dR, damp.linexp(0, 1, 12000, 800));
		LocalOut.ar([dL, dR]);
		wet = [dL, dR];
		Out.ar(out, XFade2.ar(dry, wet, ((mix * active).clip(0, 1) * 2) - 1));
	}).add;

	// standalone-specific: record straight from the hardware input (mic/line-in)
	// `az_rec` -- a NOISE réteg "mintavétel" (sample) funkciójához:
	// felveszi a hangbemenetet egy bufferbe.
	SynthDef(\az_rec, { arg buf = 0, dur = 8;
		var sig = SoundIn.ar([0, 1]);
		RecordBuf.ar(sig, buf, 0, 1, 0, 1, 0, 1, doneAction: 2);
	}).add;

	// Added engines ported from ambient_zero_sc.scd.
	SynthDef(\az_vogon, {
		arg out = 0, revB = 0, hz = 440, gate = 1, vel = 0.8, amp = 0.2,
			waveSelect = 1, pwm = 0.5, pwmDepth = 0.3, noiseVol = 0.01,
			lfoFreq = 3.5, lfoToPitch = 0.003, lfoToFilter = 0.1,
			cutoff = 1200, resonance = 0.2, envToFilter = 0.4,
			kbdTracking = 0.5, attack = 0.01, decay = 0.3,
			sustain = 0.6, release = 0.5, revSend = 0.3;
		var lfo, freq, env, pulse, osc, signal, fFreq, voice;
		lfo = SinOsc.kr(lfoFreq);
		freq = hz * (1 + (lfo * lfoToPitch));
		pulse = Pulse.ar(freq, (pwm + (lfo * pwmDepth * 0.4)).clip(0.05, 0.95));
		osc = Select.ar(waveSelect.round.clip(0, 3), [
			Saw.ar(freq), pulse, LFTri.ar(freq), SinOsc.ar(freq)
		]);
		env = EnvGen.kr(Env.adsr(attack, decay, sustain, release, curve: -4), gate, doneAction: 2);
		signal = osc + WhiteNoise.ar(noiseVol);
		fFreq = (cutoff + (env * envToFilter * 4000) + (lfo * lfoToFilter * 500)
			+ (freq * kbdTracking)).clip(20, 20000);
		voice = MoogFF.ar(signal, fFreq, resonance * 3.5) * env * vel * amp;
		Out.ar(out, voice ! 2);
		Out.ar(revB, voice * revSend ! 2);
	}).add;

	SynthDef(\az_clouds, { |out = 0, revB = 0, buf = 0, headBus = 0,
		hz = 110, vel = 0.7, gate = 1, pos = 0.1, gsize = 0.4, dens = 0.45,
		tex = 0.5, pitch = 0, spread = 0.45, jit = 0.15, fb = 0.15,
		blend = 0, inGain = 1, cut = 14000, res = 0.1, atk = 0.05,
		rel = 1.2, level = 0.8, pan = 0, revSend = 0.35|
		var trig, dur, rate, head, p, sig, fbSig, env, rq;
		var density = dens.clip(0, 1).linexp(0, 1, 0.8, 150);
		dur = gsize.clip(0, 1).linexp(0, 1, 0.012, 1.5);
		trig = Select.ar(K2A.ar(tex > 0.5), [Impulse.ar(density), Dust.ar(density)]);
		head = In.kr(headBus) - 0.02 - (pos * 0.95);
		p = (head + (TRand.ar(-1, 1, trig) * jit * 0.5)).wrap(0, 1);
		rate = (hz / 110) * (2 ** (pitch / 12)) * BufRateScale.kr(buf);
		sig = GrainBuf.ar(2, trig, dur, buf, rate, p, 2,
			(TRand.ar(-1, 1, trig) * spread) + pan, -1, 512) * 3;
		sig = sig + (SoundIn.ar(0) ! 2 * blend.clip(0, 1) * inGain.clip(0, 2));
		fbSig = LocalIn.ar(2);
		sig = sig + (fbSig * fb.clip(0, 0.9));
		LocalOut.ar(LeakDC.ar(DelayC.ar(sig, 1, (dur * 2).clip(0.01, 0.95)).tanh));
		rq = (1 - res).clip(0.05, 1);
		sig = RLPF.ar(sig, cut.clip(40, 18000), rq);
		env = EnvGen.kr(Env.asr(atk, 1, rel), gate, doneAction: 2);
		sig = Balance2.ar(sig[0], sig[1], pan) * env * vel * level;
		sig = LeakDC.ar(sig.softclip) * 0.22;
		Out.ar(out, sig);
		Out.ar(revB, sig * revSend);
	}).add;

	SynthDef(\az_graintopia, { |out = 0, revB = 0, buf = 0, hz = 110,
		vel = 0.7, gate = 1, pos = 0.2, speed = 0.2, gsize = 0.4,
		dens = 0.5, jit = 0.1, spread = 0.5, pitch = 0, cut = 12000,
		res = 0.15, lofi = 0, atk = 0.05, rel = 0.8, level = 0.7,
		pan = 0, revSend = 0.3|
		var trig, dur, rate, scan, p, sig, env, rq, crushed, sr, bits;
		var density = dens.clip(0, 1).linexp(0, 1, 1, 120);
		dur = gsize.clip(0, 1).linexp(0, 1, 0.01, 1.2);
		trig = Impulse.ar(density);
		scan = speed / BufDur.kr(buf).max(0.05);
		p = (pos + Phasor.ar(0, scan / SampleRate.ir, 0, 1)
			+ (TRand.ar(-1, 1, trig) * jit * 0.5)).wrap(0, 1);
		rate = (hz / 110) * (2 ** (pitch / 12)) * BufRateScale.kr(buf);
		sig = GrainBuf.ar(2, trig, dur, buf, rate, p, 2,
			(TRand.ar(-1, 1, trig) * spread) + pan, -1, 512) * 3;
		// Use standard UGens so this engine does not depend on Decimator.
		sr = lofi.clip(0, 1).linexp(0, 1, 48000, 900);
		bits = lofi.clip(0, 1).linlin(0, 1, 24, 3);
		crushed = Latch.ar(sig, Impulse.ar(sr));
		crushed = (crushed * (2 ** bits)).round * (2 ** bits.neg);
		sig = XFade2.ar(sig, crushed, (lofi.clip(0, 1) * 2) - 1);
		rq = (1 - res).clip(0.05, 1);
		sig = RLPF.ar(sig, cut.clip(40, 18000), rq);
		env = EnvGen.kr(Env.asr(atk, 1, rel), gate, doneAction: 2);
		sig = Balance2.ar(sig[0], sig[1], pan) * env * vel * level;
		sig = LeakDC.ar(sig.softclip) * 0.22;
		Out.ar(out, sig);
		Out.ar(revB, sig * revSend);
	}).add;
}];
