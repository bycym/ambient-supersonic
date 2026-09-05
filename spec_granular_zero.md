# granular_zero_sc → Web Port Specification

Source file analyzed: `supercollider_standalone/granular_zero_sc.scd` (3747 lines, all read in full).
Cross-referenced: `supercollider_standalone/README_granular_zero.md`, `supercollider_standalone/README.md`.

This document is the primary reference for porting `granular_zero_sc.scd` to a
browser app driving **SuperSonic** (WASM `scsynth`) over OSC, with all
sequencing/MIDI/state logic reimplemented in JavaScript. All line numbers refer
to `granular_zero_sc.scd` as it exists at the time of this analysis.

> **Important correction to the file's own header comment and to both READMEs**:
> the top-of-file doc comment (lines 1–68) and `README_granular_zero.md` both
> claim this build has **"no GUI at all"**. That is not accurate — the file
> contains a full Qt GUI builder, `~gz.buildGUI` (lines 1680–2334), built with
> `Window`, `Slider`, `Button`, `PopUpMenu`, `NumberBox`, `StaticText`, and it is
> called automatically 0.1s after the engine boots (line 2481:
> `{ ~gz.buildGUI[0].() }.defer(0.1);`). There is also a small pre-boot device
> picker window (lines 2512–2544). So the real picture is: Launchpad is the
> **primary/originally-designed** surface and the file is *usable* headless,
> but a Qt window **is** built and mirrors/drives the same state (see
> §5.7 "Existing Qt GUI structure" below) — useful as a design reference for
> the new web GUI, since the task brief says "no Qt GUI at all" when in fact
> there is one we can mine for a layout.

---

## 1. SynthDefs

All defined inside `~gz.defineSynths = [{ |s| ... }]` (lines 304–649), called once at boot (line 2400) as `~gz.defineSynths[0].(s)`.

### 1.0 Shared output tail (not a SynthDef — an inline function used by every voice-producing SynthDef)

Lines 305–324. `tail = { |sig, cut, res, lofi, atk, rel, gate, level, pan, amp, out, revB, dlyB, send, dsend| ... }`

Signal chain applied to every voice (`sig` is a stereo 2-element array):
1. `env = EnvGen.kr(Env.asr(atk, 1, rel), gate, doneAction: 2)` — ASR envelope, frees the synth (`doneAction: 2`) when `gate` goes to 0 and release finishes.
2. `RLPF.ar(sig, cut.clip(40,18000), (1 - res.clip(0,0.95)).max(0.05))` — resonant low-pass filter. Note: `res` is inverted to RLPF's `rq` (reciprocal Q); `rq = 1 - res`, floored at 0.05 so it can never divide by zero / self-oscillate uncontrolled.
3. Lo-fi stage (sample-rate + bit reduction), crossfaded in by one knob (`lofi` 0–1):
   - `srate = lofi.linexp(0,1, 48000, 900)` — sample-hold rate drops from 48kHz (transparent) to 900Hz (crushed) as lofi rises.
   - `bits = lofi.linlin(0,1, 24, 3)` — bit depth drops from 24 to 3.
   - `lo = Latch.ar(sig, Impulse.ar(srate))` then quantized: `lo = (lo * 2**bits).round * 2**(-bits)`.
   - `sig = XFade2.ar(sig, lo, (lofi*2)-1)` — equal-power crossfade dry→lofi.
4. `sig = LeakDC.ar(sig) * env * level.clip(0,1) * amp` — DC-block, apply envelope, level, and per-voice amp (used for velocity/mute).
5. `wide = Balance2.ar(sig[0], sig[1], pan.clip(-1,1))` — stereo-aware panning that preserves grain spread rather than collapsing to mono-panned.
6. `Out.ar(out, wide)` — main output.
7. `Out.ar(revB, wide * send.clip(0,1))` — reverb send bus.
8. `Out.ar(dlyB, wide * dsend.clip(0,1))` — delay send bus.

This tail's args (`cut, res, lofi, atk, rel, gate, level, pan, amp, out, revB, dlyB, send, dsend`) are common to CLOUDS, GRAINTOPIA, and CHEAT CODES voices — a JS port should implement this exact chain identically in every voice SynthDef (SuperSonic loads compiled `.scsyndef` binaries, so the tail logic must be baked into each SynthDef's compiled graph, not shared at runtime).

### 1.1 Input source SynthDefs

| Name | Line | Args (default) | Role |
|---|---|---|---|
| `\gz_src_none` | 330–346 | `out=0, gain=1, tone=0.5, motion=0.3, texLvl=1` | **NONE** source: built-in generative texture so the instrument always has material even unplugged. 5-voice `Mix.fill` of detuned `VarSaw` oscillators (partials 1..5 of a slowly LFNoise1-modulated fundamental 46–140 Hz), each detuned ±14 cents via `LFNoise1`, width modulated. Adds `PinkNoise.ar(0.3)` scaled by `LFNoise1`. Passed through `RLPF` (tone-controlled cutoff 180–9000 Hz exponential) then `Pan2` with LFNoise1-driven pan. `motion` (0–1) maps to an internal modulation rate `mrate` 0.01–0.6 Hz (exponential) that drives every LFNoise1 in the patch. |
| `\gz_src_mic` | 348–350 | `out=0, gain=1` | Hardware input channel 0, panned center via `Pan2`. |
| `\gz_src_line` | 352–354 | `out=0, gain=1` | Hardware inputs `[0,1]` stereo via `SoundIn.ar`. |
| `\gz_src_wav` | 359–362 | `out=0, buf=0, gain=1, rate=1, wavLvl=1` | Loops a mono buffer via `PlayBuf.ar(1, buf, rate*BufRateScale.kr(buf), loop=1, ...)`, panned center, scaled by `wavLvl` then `gain`. |
| `\gz_thru` | 365–367 | `in=0, out=0, monitor=0` | Direct monitor: `InFeedback.ar(in,2)` scaled by `Lag.kr(monitor,0.1)`, added into the main mix bus. |
| `\gz_capture` | 380–386 | `in=0, buf=0, run=1, headBus=0` | **Feeds CLOUDS.** Continuously mixes stereo input to mono (`Mix.ar(InFeedback.ar(in,2))*0.5`) and records into a circular mono buffer via `RecordBuf.ar(sig, buf, 0, 1, 0, run, loop=1, 0, 0)`. Also runs a parallel `Phasor.ar(0, run, 0, frames)` that exactly mirrors `RecordBuf`'s internal write head (advances 1 frame/sample while `run=1`, holds while `run=0`) and publishes its normalized position (0–1) to a control bus (`headBus`) via `Out.kr(headBus, A2K.kr(head)/frames)`. `run=0` is how FREEZE works: writing stops, `head` output freezes, grains keep reading old content. |
| `\gz_grab` | 393–397 | `in=0, buf=0, gain=1, offset=0, dur=4` | One-shot sampling into a buffer at a given frame `offset` for `dur` seconds: `RecordBuf.ar(..., offset, 1, 0, run, loop=0, 1, doneAction:0)` gated by `EnvGen.kr(Env([1,1,0],[dur,0]), doneAction:2)` (frees itself when done). This is what SHIFT+SOURCE / SHIFT+pad trigger for live sampling. |

### 1.2 CLOUDS engine — 4 SynthDefs, one per playback mode

Lines 405–496. Built in a `4.do { |m| SynthDef(("gz_clouds"++m).asSymbol, {...}) }` loop — **one SynthDef per mode instead of a `Select`-based single def**, deliberately, to save CPU (an idle spectral FFT chain running silently next to an active grain cloud would waste cycles on constrained hardware). Names: `\gz_clouds0` (GRANULAR), `\gz_clouds1` (STRETCH), `\gz_clouds2` (LOOP DLY), `\gz_clouds3` (SPECTRAL).

Common args (all 4 modes, line 407–411):
```
out=0, revB=0, dlyB=0, inBus=0, buf=0, headBus=0,
pos=0.1, gsize=0.4, dens=0.45, tex=0.5, pitch=0, spread=0.45,
jit=0.15, fb=0.15, blend=0, inGain=1, lofi=0, cut=14000, res=0.1,
atk=0.05, rel=1.2, level=0.8, pan=0, send=0.35, dsend=0.1,
gate=1, amp=1, mt=0.05, frz=0
```

Common preamble (lines 412–425):
- Every continuous parameter is passed through `Lag.kr(param, mt)` — `mt` = "morph time" — so the RANDOMIZE feature glides instead of jumps: `pos, gsize, dens, tex, pitch, spread, jit, fb, cut` are all lagged.
- `dry = InFeedback.ar(inBus,2) * inGain` — the raw live input, used for spectral mode and the "in blend" feature.
- `dur = gsize.linexp(0,1, 0.012, 1.5)` — grain duration range 12ms–1.5s.
- `rate = 2**(pitch/12)` — semitone pitch to playback-rate ratio.
- `head = (In.kr(headBus) - 0.02 - (pos*0.95)).wrap(0,1)` — **read position is measured backward from the live write head**: `pos=0` reads just behind "now" (offset -0.02 to avoid reading the exact writing sample), `pos=1` reads nearly a full buffer (8s) in the past. This is the defining "Clouds" behavior — turning `pos` scrubs back in time relative to the moving write head, not to a fixed buffer offset.

Per-mode logic (`case` block, lines 427–482):

| Mode | Index | Trigger / read logic | UGens | Character |
|---|---|---|---|---|
| **GRANULAR** | m=0 | `trig` morphs from `Impulse.ar(d)` (regular/metronomic) to `Dust.ar(d)` (irregular) via `Select.ar(K2A.ar(tex>0.5), ...)`. Density `d = dens.linexp(0,1, 0.8, 150)` grains/sec. Grain position `p = (head + TRand.ar(-1,1,trig)*jit*0.5).wrap(0,1)` — jittered around the live head position. | `GrainBuf.ar(2, trig, dur, buf, rate, p, 2, TRand.ar(-1,1,trig)*spread, -1, 512) * 3` (stereo grain cloud, `spread` = per-grain random pan width, `-1` interpolation flag = default cubic, `512` = envelope buffer window). Makeup gain ×3 because a sparse cloud reads much quieter than the source. | Classic granular cloud — the "GRANULAR" Clouds mode. |
| **STRETCH** | m=1 | Fixed-rate `Impulse.ar(d)`, `d = dens.linexp(0,1, 4, 70)`. `texture` is repurposed as **scan speed**: `scan = (tex-0.5)*0.5` (0.5 = frozen). Position crawls: `p = (head + Phasor.ar(0, scan/SampleRate.ir, 0, 1) + jitter).wrap(0,1)`. | `GrainBuf.ar(2, trig, dur*2.5, buf, rate, p, 2, spread, -1, 512) * 2` — longer, overlapping grains (2.5× base duration). | Time-stretch / paulstretch-like crawl through the buffer. |
| **LOOP DLY** | m=2 | No grains at all — a **loop window read directly from the buffer**, ending at the read position so freshest audio is always included. `lenNorm = (gsize.linexp(0,1, 0.05, 6) / BufDur.kr(buf)).clip(0.001,0.95)` (loop length 0.05–6s expressed as a buffer-normalized fraction). `startNorm = (head - lenNorm).wrap(0,1)`. `ph` is a `Phasor.ar` scanning `startNorm..startNorm+lenNorm` at `rate*BufRateScale`, wrapped, scaled to frame index. | `mono = BufRd.ar(1, buf, ph, 1, 4)` (cubic interp); stereo widened via `sig = [mono, DelayC.ar(mono, 0.2, spread*0.03+0.0005)]` (micro-delay decorrelation). `trig = Impulse.ar(0)` (never fires — unused in this mode but kept for uniform code path). | Tape-loop / "Looping Delay" Clouds mode — a literal moving loop that always contains the newest material. |
| **SPECTRAL** | m=3 | FFT smear + freeze on the **live input directly** (not the recorded buffer): `mono = Mix.ar(dry)*0.5`. `chain = FFT(LocalBuf(2048), mono)` → `PV_MagSmear(chain, (tex*40).clip(0,40))` (magnitude smear amount 0–40 bins) → `PV_BinShift(chain, rate.clip(0.125,8), 0)` (bin shift = pitch shift, clipped 0.125–8×) → `PV_MagFreeze(chain, frz)` (freeze flag from the FREEZE button). | `spec = IFFT(chain)*2.5` (makeup gain, smearing loses energy); stereo via micro-delay decorrelation like LOOP DLY (`DelayC.ar(spec, 0.05, spread*0.02+0.0003)`). | FFT freeze/smear — the "SPECTRAL" Clouds mode. Note this is the only mode that reads live input instead of the recorded buffer, and the only one where `frz` (FREEZE) does something *inside the SynthDef itself* (freezing the FFT magnitude frame) rather than only via the capture-buffer write head stopping. |

Feedback + blend tail, common to all 4 modes (lines 484–491):
- `fbSig = LocalIn.ar(2); sig = sig + (fbSig * fb.clip(0,0.95))` — feedback loop mixed into the grain signal.
- `LocalOut.ar(LeakDC.ar(DelayC.ar(sig, 1.0, (dur*2).clip(0.01,0.95)).tanh))` — feeds a short (up to ~0.95s, related to grain duration) tanh-saturated delay back for the next control block; low `fb` thickens the sound, high `fb` builds smeared feedback tails.
- `sig = sig + (dry * blend.clip(0,1))` — "in blend" lets raw live input bleed directly alongside the grains.
- Then passed to the shared `tail.()` function (§1.0).

**Freeze note:** FREEZE (`~gz.setFreeze`, line 933) does two things simultaneously: (1) sets `capSyn.set(\run, 0)` — the capture buffer stops recording, so all non-spectral modes read a static snapshot; (2) sets `cloudSyn.set(\frz, 1)` — only consumed by SPECTRAL mode's `PV_MagFreeze`.

### 1.3 GRAINTOPIA voice — `\gz_topia`

Lines 502–524. One SynthDef, instantiated **twice** (voice A and voice B, each an independent `Synth` in its own sub-group `~gz.vGrp[0]`/`~gz.vGrp[1]`), plus extra copies spawned per key-press.

Args:
```
out=0, revB=0, dlyB=0, buf=0,
pos=0.2, speed=0.2, gsize=0.4, dens=0.5, jit=0.1, spread=0.5,
pitch=0, fine=0, cut=12000, res=0.15, lofi=0, pan=0, level=0.7,
send=0.3, dsend=0.15, atk=0.05, rel=0.8, gate=1, amp=1, mt=2
```

Logic:
- Lagged by `mt` (morph time, default 2s — much longer than CLOUDS' 0.05s default, since GRAINTOPIA's randomize/morph move is slower and more deliberate): `pos, speed, gsize, dens, jit, spread, cut, pitch, res`.
- `d = dens.linexp(0,1, 1, 120)` grains/sec; `dur = gsize.linexp(0,1, 0.01, 1.2)` grain duration.
- `rate = 2**((pitch + fine/100)/12) * BufRateScale.kr(buf)` — semitone pitch + cents fine-tune.
- `trig = Impulse.ar(d)` — regular grain trigger (no texture-based irregularity like CLOUDS GRANULAR mode).
- **Independent scan speed** (this is the headline GRAINTOPIA feature vs. CLOUDS): `scanHz = speed / BufDur.kr(buf).max(0.05)` — `speed` is expressed in **buffer-lengths per second**, so it means the same musical thing regardless of loaded sample length. `p = (pos + Phasor.ar(0, scanHz/SampleRate.ir, 0, 1) + jitter).wrap(0,1)` — manual seek (`pos`) plus autonomous scanning (`speed`, range -2..2, negative = reverse).
- `sig = GrainBuf.ar(2, trig, dur, buf, rate, p, 2, spread, -1, 512) * 3`.
- Passed to shared `tail.()`.

Two voices read from independent "sample slots" (`~gz.slotBuf[0..3]`, 4 mono buffers, 8s each) selected per-voice via `~gz.voiceSlot[voice]`.

### 1.4 CHEAT CODES slice — `\gz_slice`

Lines 531–555. One-shot (or looping) pad playback, spawned fresh per pad hit.

Args:
```
out=0, revB=0, dlyB=0, buf=0,
start=0, slen=0.125, rate=1, fine=0, bend=0, jit=0,
atk=0.003, rel=0.2, cut=16000, res=0.1, lofi=0, pan=0, level=0.8,
send=0.2, dsend=0.25, loop=0, gate=1, amp=1, vel=0.8
```

Logic:
- `frames = BufFrames.kr(buf)`; `startF = (start + TRand.kr(-1,1,Impulse.kr(0))*jit*0.25).clip(0,0.999) * frames` — start position jittered once per hit (jitter amount ±0.25 of the `jit` knob, applied as a fraction of the buffer).
- `lenF = (slen.clip(0.001,1)*frames).max(128)` — slice length in frames, minimum 128 samples.
- `rBase = rate * (2**(fine/1200)) * BufRateScale.kr(buf)` — playback rate with cents fine-tune.
- **Bend** (the signature "tape dive" feature): `r = rBase * (2 ** (bend * EnvGen.kr(Env([1,0],[0.4]))))` — an envelope decays 1→0 over 0.4s, so `bend` (range -1..1) pushes the rate up to an octave off pitch at the start of the hit and slides back to `rBase` over 0.4 seconds.
- `ph = Phasor.ar(0, r, startF, startF+lenF, startF + ((rBase<0)*lenF))` — phasor scanning the slice window `[startF, startF+lenF]`, with the reset point flipped to the end when rate is negative (reverse playback).
- `mono = BufRd.ar(1, buf, ph, 1, 4)` (cubic interp).
- `dur = (lenF / (rBase.abs.max(0.01)*SampleRate.ir)).clip(0.01,60)` — how long one pass through the slice takes, computed at init-rate.
- `line = Line.kr(0,1,dur); oneShot = Done.kr(line) * (1 - loop.clip(0,1))` — non-looping hits self-close their gate when the pass completes; looping hits (`loop=1`) rely on the language layer to send `gate=0`.
- `gt = gate * (1 - oneShot)`; `sig = [mono, mono]` (dual-mono, stereo width comes only from the shared tail's pan).
- Passed to shared `tail.()`, with `level * vel.clip(0,1)` — velocity scales level, not a separate envelope parameter.

### 1.5 Effects — 4 SynthDefs (all always-instantiated, gain-staged by `active`)

| Name | Line | Args | Type | Description |
|---|---|---|---|---|
| `\gz_fx_delay` | 561–574 | `in=0, out=0, active=1, dtime=0.375, fb=0.45, tone=6000, cross=0.6, mix=0.7` | **Send** | Ping-pong stereo delay. `t = Lag.kr(dtime.clip(0.02,4), 0.25)`. Cross-feed: `l = sig[0] + fbSig[1]*cross + fbSig[0]*(1-cross)`, `r` symmetric — `cross` (0-1) blends between straight feedback (0) and full ping-pong (1). Two `DelayC.ar` lines (right line detuned ×1.005 for stereo width/chorus-like beating). Feedback path is `LPF`'d at `tone` (200-18000Hz) and scaled by `fb` (clip 0-0.95) before `LocalOut`. Output = `[dl,dr] * mix * active`. |
| `\gz_fx_reverb` | 580–607 | `in=0, out=0, active=1, rsize=0.72, decay=0.75, damp=0.35, shimmer=0.25, mix=0.8` | **Send** | 8-line FDN (feedback delay network) with shimmer. `sh = PitchShift.ar(sig,0.2,2,0,0.01)*shimmer` — pitch-shifted (×2, one octave up) copy added into the input as "shimmer". Passes through 4 series `AllpassC.ar` diffusers (times 4.3–18.9ms scaled by `rsize`). Then an 8-tap FDN: each tap is `DelayC.ar(sig[i%2] + fb[i]*(decay*0.62+0.36), 0.5, (baseTime*rsize-scaled + LFNoise2 modulation).clip(...))`, base times `[0.0297,0.0371,0.0411,0.0437,0.0533,0.0611,0.0687,0.0743]` scaled by `(0.4 + rsize*2.2)`, each individually LFO-modulated for chorus-like smoothness. Each tap `LPF`'d at `damp.linexp(0,1,16000,700)` (damping = high-frequency rolloff, inverted so 0=bright,1=dark). Taps mixed into a Hadamard-like matrix (sum/difference pairs) before feeding back (`LocalOut`) and being read out (`wet`, further diffused by 2 more `AllpassC`). This is architecturally identical to the reverb used in `ambient_zero_sc.scd` (per the file's own comment, line 578-579). |
| `\gz_fx_shape` | 613–628 | `in=0, out=0, active=1, drive=1, tilt=0, bits=24, width=1, mix=1` | **Insert** | Saturation (`(dry*drive).tanh / drive.sqrt`) → tilt EQ (split at 700Hz `LPF`, recombine with `tilt` weighting lo vs hi) → bit reduction (`(sig*2**bits).round * 2**-bits`, bits 2-24) → M/S stereo width control (`side *= width.clip(0,2)`) → `XFade2.ar(dry, wet, (mix*active*2)-1)` dry/wet crossfade (this is how the whole effect can be bypassed — `active=0` forces full dry regardless of `mix`). |
| `\gz_fx_master` | 634–648 | `in=0, out=0, active=1, threshold=0.2, ratio=4, attack=0.01, release=0.15, makeup=1.2, ceiling=0.95, amp=0.9` | **Insert, always last** | `Compander.ar(dry, dry, thresh, slopeBelow=1, slopeAbove=1/ratio, clampTime=attack, relaxTime=release)` (compressor only, no expansion since `slopeBelow=1`) → makeup gain applied *before* the limiter (`comp*makeup`) → `Limiter.ar(sig, ceiling.clip(0.05,1), 0.01)` — makeup can never push past `ceiling` because the limiter is downstream. `XFade2.ar(dry, sig, (active*2)-1)` for bypass. Also emits a meter reply: `SendReply.kr(Impulse.kr(4), '/gz_meter', [Amplitude.kr(dry[0],...), Amplitude.kr(sig[0],...)])` at 4Hz — the headless status line's VU meter data (also drives the GUI's meter widgets). Final `Out.ar(out, sig*amp.clip(0,2))`. |

---

## 2. Global architecture

### 2.1 Server boot options (lines 2384–2386)
```
s = Server.default;
s.options.memSize = 8192*8;      // 64MB — grain UGens + FDN reverb need headroom
s.options.numBuffers = 1024;
```
Web port: SuperSonic's server config should set an equivalent real-time memory allocation and buffer count ceiling. Buffer count needed: 1 (live) + 1 (WAV source) + 4 (GRAINTOPIA slots) + 8 (CHEAT CODES banks) = **14 buffers minimum**, but headroom for user-loaded replacements matters (old buffer freed only after new one loads, so transient double-allocation happens).

### 2.2 Buses (lines 2406–2413)
| Bus | Type/width | Purpose |
|---|---|---|
| `srcBus` | audio, 2ch | Input source output (thru/capture/grab all read from here) |
| `mixBus` | audio, 2ch | Main summing bus — all engines + FX sends output here |
| `revBus` | audio, 2ch | Reverb send bus (engines write wet-send here, `gz_fx_reverb` reads it) |
| `dlyBus` | audio, 2ch | Delay send bus |
| `shapeBus` | audio, 2ch | Between SHAPE insert and MASTER insert |
| `headBus` | **control**, 1ch | Publishes CLOUDS capture write-head position (0-1 normalized) |

### 2.3 Groups (lines 2416–2422), in explicit signal/execution order via `addToTail`
```
grp (root)
 ├─ srcGrp        (source synth, thru synth, capture synth, grab synths)
 ├─ engGrp[0]     (CLOUDS synths — drone + played notes)
 ├─ engGrp[1]     (GRAINTOPIA container)
 │   ├─ vGrp[0]   (voice A synths)
 │   └─ vGrp[1]   (voice B synths)
 ├─ engGrp[2]     (CHEAT CODES pad-hit synths)
 ├─ sendGrp       (gz_fx_delay, gz_fx_reverb — read from dlyBus/revBus, write to mixBus)
 ├─ shapeGrp      (gz_fx_shape — reads mixBus, writes shapeBus)
 └─ masterGrp     (gz_fx_master — reads shapeBus, writes hardware out 0)
```
Note `engGrp` is `Array.fill(3, {...})` — index 0=CLOUDS, 1=GRAINTOPIA (container, whose children `vGrp` are added *inside* it), 2=CHEAT CODES. This ordering matters for a web port using a single audio graph too: sources must render before engines, engines before sends, sends' wet output must mix back into mixBus before SHAPE reads it, SHAPE before MASTER. In a Web Audio-style or SuperSonic OSC-node-order model, replicate this exact topology (node/group execution order = per-block DSP order in scsynth).

### 2.4 Buffers (lines 2426–2429) — all **mono**
| Buffer | Size | Purpose |
|---|---|---|
| `liveBuf` | `sampleRate * 8` frames, 1ch | CLOUDS circular capture buffer (8 seconds) |
| `srcBuf` | `sampleRate` frames, 1ch (grows on load) | WAV source loop buffer |
| `slotBuf[0..3]` | `sampleRate * 8`, 1ch each | 4 GRAINTOPIA sample slots |
| `bankBuf[0..7]` | `sampleRate * 8`, 1ch each | 8 CHEAT CODES banks |

All mono because `GrainBuf`/`BufRd` grain UGens can only read single-channel buffers (explicitly noted in comments, lines 356-358, 840-843). Loaded files are read via `Buffer.readChannel(s, path, channels:[0], ...)` — **left channel only**, discarding channel 1 of stereo source files. Stereo width is synthesized later via grain spread + panning, never from buffer channel count.

**Web port implication**: SuperSonic buffer loading from browser-provided files (via drag-and-drop or `<input type=file>` + `FileReader`/`AudioContext.decodeAudioData`) must extract channel 0 only and load as mono, matching this exact behavior, or grain playback will misbehave (GrainBuf requires mono).

### 2.5 Effect chain topology (matches README ASCII diagram, README_granular_zero.md lines 105-117)
```
CLOUDS ─┬─ direct (dry, level/pan already applied in tail) ──────────────┐
GRAINTOPIA ─┤                                                             │
CHEAT CODES ┤                                                             │
        ├── "delay snd" per-voice ──> gz_fx_delay (send) ────────────────┤
        └── "reverb snd" per-voice ─> gz_fx_reverb (send) ───────────────┤
                                                                          v
                                                          mixBus (sum of all above)
                                                                          v
                                                    gz_fx_shape (insert: drive/tilt/crush/width)
                                                                          v
                                                          shapeBus
                                                                          v
                                                gz_fx_master (insert: compressor+limiter, ALWAYS active last)
                                                                          v
                                                                   hardware out 0/1
```
DELAY and REVERB are **parallel sends** (every voice contributes its own `send`/`dsend` amount, wet output summed back into `mixBus`). SHAPE and MASTER are **serial inserts** the entire mix passes through. All four can be bypassed individually via `active` (crossfades to fully dry, does not stop the synth).

### 2.6 Master output level metering
`gz_fx_master` sends `/gz_meter` OSC replies at 4Hz with `[inputAmplitude, outputAmplitude]` (lines 645-646, 2465-2467 `OSCdef(\gz_meter, ...)`). Drives both the headless console `~gz.status` output feel and the GUI's `inMeter`/`outMeter` sliders (lines 2290-2291). Web port: listen for this same OSC message from SuperSonic and drive VU meter widgets; values are raw `Amplitude.kr` (linear 0-1ish), convert with `.ampdb` → `linlin(-60,0,0,1)` exactly as the SC GUI code does (line 2290-2291).

---

## 3. Sequencer / performance logic

**This is a live-performance instrument driven by the Launchpad Pro grid, with an optional 64-step-per-engine step sequencer bolted on — NOT a fixed step sequencer that must be programmed before it makes sound.** Keys/pads always sound when pressed regardless of sequencer or record-arm state; the sequencer is opt-in via the REC arm toggle and independent PLAY/STOP transport. Both the Launchpad and the (existing but README-uncredited) Qt GUI drive the exact same state through the same function calls.

### 3.1 Clock / tempo (lines 1340, 2469)
- `TempoClock.default.tempo = bpm/60`, default boot tempo **110 bpm** (line 2469). Console: `~gz.setTempo[0].(bpm)` clips 20-300 bpm.
- Everything sequencer-related uses `TempoClock.default` (not `SystemClock`) — this exact bug (`SystemClock` ignoring tempo) is called out as a *fixed* historical bug in `ambient_zero_sc.scd`'s README (README.md lines 291-299); `granular_zero_sc.scd` was apparently written correctly from the start.
- Web port: implement a JS scheduler (e.g. a `setInterval`/`AudioContext`-clock-driven lookahead scheduler, Web Audio "scheduling ahead of time" pattern) that computes beat duration as `60/bpm` seconds and multiplies by the step's clock division (§3.2).

### 3.2 Per-engine track data model (lines 1255–1271)
```
divs      = [4, 2, 1, 1.5, 0.5, 1/3, 0.25, 1/6, 0.125]   // beats per step
divNames  = ["1/1","1/2","1/4","1/4.","1/8","1/8t","1/16","1/16t","1/32"]

Step  = { on: bool, notes: [midiNoteOrPadIdx...], vel: 0..1, len: 0..~8 (beats-fraction gate), prob: 0..1, locks: {paramId: value} }
Track = { steps: Step[64], length: 1..64, div: 0..8 (index into divs), pos: int, stepTime: float, trackMute: bool }
```
3 independent tracks (`~gz.trk = Array.fill(3, {...})`), one per engine (CLOUDS/GRAINTOPIA/CHEAT CODES). Each has its own length, clock division, and running `Routine` (`~gz.trackLoop`, lines 1296–1313) — **all 3 run simultaneously and independently once `startSeq` is called** (line 1317: `3.do { ~gz.trackLoop[0].(i) }`), each on its own `TempoClock`-scheduled beat loop that waits `stepBeats` between steps (not `1/16` fixed — the per-track `div` setting).

Step's `notes` array holds **MIDI note numbers for CLOUDS/GRAINTOPIA** or **`bank*8+pad` indices for CHEAT CODES** (same value space `~gz.trigger` takes, see §3.4). Multiple notes on one step = a chord (all triggered together, all get their own note-off scheduling).

### 3.3 Playback loop (`~gz.trigStep`, lines 1278–1294; `~gz.trackLoop`, 1296–1313)
Each step fires if `st.on && (st.prob >= random(0,1))` — probability gate rolled fresh every pass. All notes in `st.notes` are triggered via `~gz.trigger`. Gate-off scheduling: `TempoClock.default.sched(beats*st.len, {~gz.stopVoice(...)})`, but **only for CLOUDS/GRAINTOPIA (sustaining) or looping CHEAT CODES pads** — one-shot CHEAT CODES pads free themselves automatically via their own envelope, no note-off needed (line 1287: `if((track<2) or: {~gz.padP[...][\loopm] > 0.5})`).

The track loop redraws the pad LEDs and GUI step buttons only when the *currently focused* track advances (line 1307: `if(track == ~gz.engIdx)`) — an optimization to avoid unnecessary redraw traffic for background tracks. Web port doesn't need this optimization for LED traffic reasons, but should replicate "only the visible engine's playhead is highlighted."

### 3.4 Trigger entry point — `~gz.trigger` (lines 1114–1169)
Single function used by Launchpad keys, sequencer steps, GUI pad buttons, and the console API (`~gz.trigger[0].(eng, val, vel, locks)`). Behavior per engine:
- **CLOUDS (eng=0)**: if a voice for this note is already sounding, stop it first (retrigger-not-stack). Voice-stealing (`~gz.steal`, oldest voice released) once `maxVoices` (10) is exceeded. Spawns `Synth(("gz_clouds"++cloudMode), args, engGrp[0])` with `pitch = basePitch + (note - 60)` (note 60 = no transposition) and applies any step parameter-locks (`~gz.applyLocks`).
- **GRAINTOPIA (eng=1)**: same retrigger/steal logic, spawns `\gz_topia` in `vGrp[voiceSel]` (the *currently focused* voice — so sequencer playback of GRAINTOPIA always uses whichever voice A/B is focused at trigger time, not per-step voice assignment).
- **CHEAT CODES (eng=2)**: `val` decoded as `bank = val.div(8), pad = val % 8`. Spawns `\gz_slice` reading `bankBuf[bank]` with that pad's full parameter set. Tracked in `~gz.padVoices` list (capped at 24 concurrent, oldest force-released beyond that) so live knob changes and the sequencer/panic can still reach a still-sounding looping pad.

Voice bookkeeping uses SC's `NodeWatcher` (`sy.register(true); sy.onFree({...})`, lines 1085-1089) to know when a synth has self-terminated (envelope done) so as not to send messages to a dead node (`FAILURE IN SERVER /n_set Node not found`). **Web port equivalent**: SuperSonic/OSC has no built-in node-watcher; must track voice lifetime in JS using `/n_end` OSC notifications (subscribe via `/notify` and each spawned synth's `doneAction: 2` will trigger an `/n_end` reply) and mirror this "forget on death" bookkeeping exactly, or stale `/n_set` calls to freed synths will silently no-op (harmless) but stale tracking will break voice-stealing/mute-all logic.

### 3.5 Live keys/pads and REC-arm write-through (lines 1423–1478, 3095–3164)
- **REC off**: keys/pads only sound (`~gz.trigger` called directly), nothing written to the track — lets you "improvise over a finished pattern."
- **REC on, sequencer stopped**: the hit is written to `~gz.selStep[track]` (or step 0 if none selected), and selection auto-advances by 1 after write (typical step-programming workflow: tap note, auto-advances, tap next note...).
- **REC on, sequencer running**: hit lands on the **nearest step in time** — if more than halfway through the current step's duration has elapsed since the beat-loop last advanced (`elapsed > beats*0.5`), it's written to `pos+1`, else to `pos` (this is "quantize to nearest, not always-next" live recording, giving natural feel).
- Holding a key and releasing it later becomes that step's **gate length** (`~gz.recordLength`, lines 1457–1463): `len = (secondsHeld/beatDuration).clip(0.05,8)`.
- Two keys held together (chord) land on the *same* step by appending to `st.notes` if already `on` (line 1443).
- **Parameter locks while REC armed**: moving any fader (Launchpad column or GUI slider) while a step is selected calls `~gz.setLock[0].(track, selectedStep, paramIdx, value)` (via `~gz.editParam`, lines 1538–1543) — writes that value into `steps[sel].locks[paramId]`, live and audible simultaneously (does not require a separate "lock mode" toggle; simply happens whenever REC is on and a step is selected).

### 3.6 FREEZE (lines 933–937, 1613, and LED logic 2985-2991)
`~gz.setFreeze[0].(bool)`:
- Sets `capSyn.set(\run, frz?0:1)` — CLOUDS' circular capture buffer stops writing when frozen, so the write head (published via `headBus`) holds still and CLOUDS' `pos` knob then scrubs a static snapshot instead of live-scrolling audio.
- Sets `cloudSyn.set(\frz, frz?1:0)` — only meaningful in SPECTRAL mode (`\gz_clouds3`), where it also freezes the FFT magnitude frame via `PV_MagFreeze`.
- Launchpad: **SHIFT + 94** (per this app's README deviation note) toggles freeze via `~gz.toggleFreeze`. Button 98 (USER/LATCH) also displays FREEZE state with priority over latch-mode color when frozen (`cFrzOn` wins over `cHoldOn`/`cHoldOff`, line 2989).
- `~gz.grabForEngine` (line 961-974) treats CLOUDS specially: SHIFT+SOURCE for CLOUDS just un-freezes (`setFreeze(false)`) rather than sampling into a slot, since CLOUDS is "always recording anyway."

### 3.7 RND (randomize) and undo — the "Graintopia move" (lines 1197–1240)
- `~gz.randomize[0].(eng)`: for the *focused* engine's *currently relevant* parameter set (whole CLOUDS engine; the focused GRAINTOPIA voice's 16 params; the selected CHEAT CODES pad's 18 params), rolls a **new random target** for every parameter **except** `~gz.rndSkip = [\level, \morph, \rnd, \prob]` (excluded so randomizing never silences or destabilizes the instrument), and blends from current value toward that target by `amt = rnd amount` (that engine/voice/pad's own `\rnd` parameter, 0=no change, 1=fully random): `newVal = cur + (target-cur)*amt`. Actual glide-to-new-value happens automatically at the synth level because every param is `Lag.kr(param, mt)` — the language just sets the *target* value instantly, and the running synth's internal lag smooths the audible transition over `mt` ("morph time") seconds. **Before rolling**, a full snapshot of the current parameter values is captured into `~gz.rndUndo[eng]` (line 1223).
- `~gz.undoRandom[0].(eng)`: restores every parameter from `~gz.rndUndo[eng]` (one level of undo only — a second undo after already undoing does nothing new since it wasn't re-snapshotted).
- Launchpad mapping (per this file's deviation from `ambient_zero_sc.scd`, confirmed at lines 2617-2622 and README_granular_zero.md/README.md): **SHIFT+95 (SESSION)** = RND — on the STEP page (`padMode==0`) it fills the *track* with a random pattern (`~gz.rndTrack`, different from parameter randomize, see below); on any other page/focus (PARAM page, or SOURCE/FX focused) it randomizes that section's *parameters* (`~gz.randomize` for engine focus, or a direct per-column jitter of ±0.35 normalized for SOURCE/FX focus, line 3366-3371 — note SOURCE/FX "RND" has **no undo**, only engine-parameter RND does). **SHIFT+97 (DEVICE)** = undo last RND (`~gz.undoRandom`), only meaningful when `focus == \eng`.
- Separately, **track-fill RND** (`~gz.rndTrack`, lines 1399–1421) is a *different* function: fills ~34% of the track's steps with `on=true`, random velocity 0.5-1.0, random gate length 0.2-1.4 beats, weighted-random probability `[1,1,1,0.75,0.5].choose`, and notes drawn from the current scale (CLOUDS/GRAINTOPIA: `base + 12*rand(3) + scale.choose`) or the current bank's 8 pads (CHEAT CODES: `bank*8 + rand(8)`). This has **no undo mechanism** — it directly overwrites `t.steps` in place with no snapshot.

**Important distinction for the JS port**: "RND" is heavily overloaded by context (STEP page → track fill; PARAM/engine focus → parameter randomize+morph; SOURCE/FX focus → direct parameter jitter). The undo button (SHIFT+DEVICE/97) *only* undoes the parameter-randomize case, never the track-fill case or the SOURCE/FX jitter case. Implement these as three distinct JS functions mapped from the same physical gesture based on current `focus`/`padMode` state, exactly mirroring lines 3356–3371.

---

## 4. Patch save/load

**Not implemented in this file.** Confirmed explicitly by the file's own README (`README_granular_zero.md` line 280: *"Patch save/load is not implemented here (`ambient_zero_sc.scd` has it)"*), and no `savePatch`/`loadPatch`/`~gz.patches` symbols exist anywhere in the 3747-line file (verified by full read — no `Archive`, `.writeArchive`, or patch-directory code paths exist for `~gz`, unlike `ambient_zero_sc.scd`'s `~az.savePatch`/`~az.loadPatch`/`~/ambient_zero_sc_patches/` pattern described in the main README.md lines 213-241).

**For the web port**, since full parity with the original also means "no patch save/load was ever a feature to replicate," a `localStorage`-based save/load system is a **net-new addition beyond parity**, not a port of existing functionality. If the parent project wants one anyway (reasonable, since browsers can't rely on `~/granular_zero_samples/`-style disk conventions), a suggested localStorage schema mirroring the full `~gz` state shape documented in §2 above would be:

```jsonc
{
  "version": 1,
  "name": "my patch",
  "engIdx": 0, "focus": "eng", "fxIdx": 0, "srcIdx": 0,
  "cloudMode": 0, "frz": false,
  "voiceSel": 0, "voiceSlot": [0,1],
  "bank": 0, "padSel": 0,
  "muted": [false,false,false],
  "fxBypass": [false,false,false,false],
  "recArm": false,
  "tempoBpm": 110,
  "keyRoot": 0, "keyScale": 1, "keyBase": 48,
  "pvClouds": { "pos":0.10, "gsize":0.40, "...": "..." },
  "pvVoice": [ { "...16 params..." }, { "...16 params..." } ],
  "pvSrc": { "ingain":1.0, "...": "..." },
  "fxP": [ {"...delay 5 params"}, {"...reverb 5"}, {"...shape 5"}, {"...master 7"} ],
  "padP": [ /* 8 banks */ [ /* 8 pads */ { "start":0,"slen":0.125,"...":"..." } ] ],
  "tracks": [
    { "steps": [ {"on":false,"notes":[60],"vel":0.8,"len":0.9,"prob":1,"locks":{}}, "...64 entries" ],
      "length": 16, "div": 6 },
    "... 3 tracks total"
  ]
}
```
This intentionally does **not** attempt to serialize loaded sample audio (buffers) — those are large binary WAV/AIFF data the original also never serialized (it has no patch system at all), so file re-selection on load remains the user's responsibility, exactly as file loading already works in the original (`~gz.loadFile` re-reads from disk/path every time). A JS patch loader should likewise just remember *which* file was last loaded (by name) as a hint, not embed audio data in `localStorage` (size limits would make that impractical anyway).

---

## 5. Launchpad Pro MIDI mapping

### 5.1 Physical layout & numbering (lines 2559–2569, confirmed identical to README.md's shared table and README_granular_zero.md)
Launchpad Pro is switched into **Programmer Mode** via SysEx on connect (`~gz.padConnect`, line 3555: `padSysex([0x21,0x01])` standalone mode, then `padSysex([0x2c,0x03])` = layout 3 = programmer). In this mode:
- 8×8 grid: note numbers, bottom-left = 11, top-right = 88 (`+10` per row up, `+1` per column right).
- Round buttons: same base-10 numbering scheme, arrive as **CC** messages, not notes.
```
        91 92 93 94 95 96 97 98        <- top row
     80 [81..88] 89                     <- 8x8 grid + right column
     ...
     10 [11..18] 19
         1  2  3  4  5  6  7  8        <- bottom row
```
Coordinate conversion used throughout the code: `~gz.padGidx[0].(col,row) = 11 + col + ((7-row)*10)` (row 0 = **top** row in the code's internal `col,row` convention — grid row indices count top-down while device row-numbers count bottom-up, so `(7-row)` flips it), `padRight[0].(row)=19+((7-row)*10)`, `padLeft[0].(row)=10+((7-row)*10)`, `padTop[0].(col)=91+col`, `padBottom[0].(col)=1+col` (lines 2715–2719).

### 5.2 Right column — what the grid edits (lines 2572–2584, dispatch at 3273–3303)
| Button | Plain press | SHIFT+press |
|---|---|---|
| 19/29/39 (rows 0-2) | Select engine: CLOUDS / GRAINTOPIA / CHEAT CODES. Releases finger-held (non-latched) notes first. | Toggle **mute** that engine. |
| 49 (row 3) | Focus INPUT SOURCE — grid becomes source's fader editor. | **SAMPLE**: record input into focused engine's buffer (`~gz.grabForEngine`) |
| 59/69/79/89 (rows 4-7) | Focus that effect (DELAY/REVERB/SHAPE/MASTER) — grid becomes its fader editor. | Toggle **bypass** that effect. |

While SHIFT is held, all 8 right-column buttons show **red** mute/bypass state (`cMuteOn`/`cMuteOff`, `[55,0,0]`/`[7,1,1]`) instead of their normal engine/fx color, so the player can preview what's about to flip before releasing.

### 5.3 8×8 grid modes (dispatch lines 3244–3272, LED draw lines 2841–2917)
Grid behavior depends on `~gz.focus` (`\eng`/`\src`/`\fx`) and, when `\eng`, on `~gz.padMode` (0=STEP, 1=PARAM, 2=KEYS/PADS):

| Mode | Condition | Behavior | LED colors |
|---|---|---|---|
| **STEP** | `focus==\eng && padMode==0` | Press = `~gz.stepPress` (toggle-on/select a step). 64 cells = 64 steps of the *focused engine's* track. | dim (`cDim [1,1,1]`) = empty, `cStepOn [0,28,50]` (blue) = on, `cStepLock [45,34,0]` (amber) = has param-locks, `cStepSel [63,55,0]` (bright yellow) = selected, `cStepChord [0,50,32]` (green) = chord (>1 note), `cPlayhead [63,63,63]` (white) = current playing step. Cells beyond track `length` show off/nothing playable. |
| **PARAM** | `focus==\eng && padMode==1`, or `focus==\src`, or `focus==\fx` | Grid = 8 column faders, one param per column, filled bottom-up (row 7=bottom=0%, row 0=top=100%). Press sets `(7-row)/7` as normalized value via `~gz.setGridNorm`. Left column (`padLeft` rows 1-4) picks which page of 8 params (engines with >8 params, e.g. GRAINTOPIA's 32 or CLOUDS' 21, page across `padPage` 0-3). | Filled cells use `cFill`(engine)/`cSrc`(source)/`cFxFill`(fx) color below the level, `cTip [63,63,63]` (white) marks the exact top filled cell (the "cursor"), `cDim` above it. |
| **KEYS/PADS** | `focus==\eng && padMode==2` | CLOUDS/GRAINTOPIA: scale-locked keyboard, 1 octave per row (`~gz.padKeyPitch`), root notes brighter. CHEAT CODES: literal 8×8 = 8 banks × 8 pads, press = select+play that pad. | CLOUDS/GRAINTOPIA: engine color (`cEngine[i]`) full-bright on scale roots, dimmed (÷5) on non-root scale degrees, `cTip` while finger-held, `cKeyLatch [63,34,0]` (amber) while latched. Notes above MIDI 127 render `cOff` (unplayable). CHEAT CODES: `cTip` for a currently-sounding pad, `cStepSel` for the selected pad, full engine color for the current bank's row, dimmed (÷6) for other banks' rows. |
| **SCALE EDITOR** | `focus==\eng && padMode==2 && padScaleEdit==true`, opened via SHIFT+96 | Grid stops playing notes. Rows 0-1 (top two) = 12 root notes (C..B), press = `~gz.setKeyRoot`. Rows 3-4 = up to 12 scale names, press = `~gz.setKeyScale`. Row 2 and cols beyond count = off. | Root row: engine color on selected root, dim (÷5, floor 1) elsewhere. Scale row: `cModeOn [0,50,20]` selected, `cModeOff [3,8,5]` elsewhere. |
| **SOURCE/FX focused (any padMode)** | `focus==\src` or `focus==\fx` | Grid is *always* the column-fader editor regardless of `padMode` (padMode only matters when `focus==\eng`). | Same fader visual language as PARAM mode above, with `cSrc`/`cFxFill` as the fill color. |

### 5.4 Left column (lines 2605–2609, dispatch 3304–3334, LEDs 2948–2959)
| Button (device row) | Function |
|---|---|
| 80 (row 0, SHIFT) | Hold = modifier. LED: `cShiftOn [63,63,63]` while held, `cDim` otherwise. |
| 70/60/50/40 (rows 1-4) | Select parameter page 1-4 (`padPage = row-1`, clipped to how many pages the current section actually has) and switches grid to PARAM mode if currently on engine focus. LED: `cPageOn [30,20,50]` for current page, `cPageOff [4,3,6]` for other *available* pages, `cOff` for pages beyond the section's param count. |
| 30 (row 5, UP) | If SOURCE focused: step to next WAV file (`~gz.stepWav[0].(1)`). Else if in KEYS mode: CHEAT CODES → bank+1; CLOUDS/GRAINTOPIA → octave up (`keyBase+12`, max 108). |
| 20 (row 6, DOWN) | Mirror of above: prev WAV file / bank-1 / octave down (`keyBase-12`, min 12). |
| 10 (row 7, RECORD) | Toggle `~gz.recArm` (does REC write to the sequencer). LED: `cRecOn [55,0,0]` armed / `cRecOff [8,2,2]` idle. |

Rows 5/6 (UP/DOWN) LEDs light `cOctBtn [20,14,40]` only when "live" per `~gz.padUpDownLive` (true when `focus==\src`, or `focus==\eng && padMode==2`) — i.e. dark/inert unless the button actually does something in the current context.

### 5.5 Top row — follows the device's own printed labels (lines 2610–2632, dispatch 3335–3410, LEDs 2960–2991)
| Button | Label | Plain | SHIFT |
|---|---|---|---|
| 91 | UP | `~gz.addSteps(1, eng)` — track length +1 | +8 |
| 92 | DOWN | `~gz.addSteps(-1, eng)` — track length -1 | -8 |
| 93 | LEFT | `~gz.delStep` — delete selected step | `~gz.clrTrack` — wipe entire track |
| 94 | RIGHT | `~gz.togglePlay` — PLAY/STOP transport | **FREEZE** (`~gz.toggleFreeze`) — this is the app's documented deviation from `ambient_zero_sc.scd`'s SHIFT+94 mapping |
| 95 | SESSION | Switch to STEP page (`focus=\eng, padMode=0`); releases finger-held notes, closes scale editor | **RND**: on STEP page → `rndTrack` (pattern fill); else → `randomize` (engine params) or direct ±0.35 jitter (SOURCE/FX) |
| 96 | NOTE | Switch to KEYS/PADS mode (`padMode=2`), closes scale editor if open | Toggle **SCALE EDITOR** (`padScaleEdit`); opening it releases finger-held notes |
| 97 | DEVICE | Switch to PARAM page mode (`padMode=1`); releases finger-held notes, closes scale editor | **Undo last RND** (`~gz.undoRandom`) — this app's documented deviation from `ambient_zero_sc.scd`'s SHIFT+97 mapping |
| 98 | USER | Toggle **LATCH mode** for the focused engine (`padLatchMode[eng]`); switching off releases that engine's held notes | Switch latch mode off **everywhere** + release **everything** (`padAllKeysOff`) — "one button for silence" |

LED behavior specifics:
- **91/92**: lit `cOctBtn` only while there's room to move (length<64 / length>1), else `cOff`.
- **93**: `cWarn [50,18,0]` (orange) while SHIFT held (previewing CLR TRACK), else `cStepSel` if a step is selected, `cDim` otherwise.
- **94 — never dark**: blinks `cPlayOn [0,55,10]`/`cPlayDim [0,10,2]` in time with the tempo (half-beat on/off, via `~gz.padStartBlink`, a `TempoClock`-scheduled routine, lines 3427–3446 — doubles as a visual metronome) while running; solid `cPlayOff [55,0,0]` (red) when stopped.
- **95**: `cFill` while SHIFT held (previewing RND), else `cModeOn`/`cModeOff` for STEP-page-active/inactive.
- **96**: `cStepSel` while scale editor open, else `cModeOn`/`cModeOff` for KEYS-mode-active/inactive.
- **97**: `cModeOn`/`cModeOff` for PARAM-mode-active/inactive (no SHIFT-preview color; undo is a one-shot action not a toggle).
- **98**: `cFrzOn [0,40,63]` (cyan, **overrides** latch color) when CLOUDS is frozen, else `cHoldOn [0,55,20]` (green) / `cHoldOff [4,8,4]` for the *focused* engine's latch-mode on/off state. Note this means FREEZE state is shown on button 98 regardless of which engine is focused — a slightly surprising cross-engine display choice worth preserving for parity.

### 5.6 Bottom row — position bar / variant picker (lines 2633–2637, dispatch 3412–3414, LEDs 2993–3008)
- **Normal (SHIFT not held)**: 8-cell position bar showing which 1/8th of the track the playhead is currently in (`(pos/length)*8`), lit `cPlayhead` on the active cell, `cDim` elsewhere. Only meaningful while running.
- **SHIFT held**: picks the "variant" of whatever is focused, via `~gz.subPress`/`~gz.subActive`/`~gz.subCount` (lines 1564–1607):
  - **CLOUDS focused**: 4 active cells (cols 0-3) = the 4 playback modes (GRANULAR/STRETCH/LOOP DLY/SPECTRAL), press sets `~gz.setCloudMode`.
  - **GRAINTOPIA focused**: cols 0-1 = voice A/B select; cols 4-7 = that voice's sample slot (0-3).
  - **CHEAT CODES focused**: 8 active cells = the 8 banks, press sets `~gz.setBank`.
  - **SOURCE focused**: 4 active cells = NONE/MIC/LINE/WAV, press = `~gz.startSource`.
  - **FX focused**: `subCount=0`, no variants (SHIFT+bottom-row does nothing while an FX slot is focused).
  - Active/current cell = `cTip` (white), other in-range cells = `cFill`, out-of-range = `cOff`.

### 5.7 LATCH mode details (lines 187-194 README, 3095-3183 code)
- **LATCH (button 98) toggle, per engine**: while on, every note played on that engine survives key release, until pressed again to release. Independent per engine (one engine can drone while another is played normally). Switching latch off for an engine releases only that engine's currently-latched notes (`~gz.padUnlatchEngine`). SHIFT+98 = kill latch everywhere + release every held note on every engine (`padAllKeysOff`).
- **SHIFT + a single key** = one-off latch (holds that one note latched even with latch-mode off for the engine) — implemented as: `latch = (padLatchMode[eng] || padShiftOn()) && eng != 2` (CHEAT CODES pads are always one-shots, never latchable, line 3104).
- Latched notes are tracked **by pitch + engine** (not by grid position), so they survive octave/scale/mode/engine changes and sequencer start/stop — except `stopSeq` calls `allOff` which *does* clear latches too (line 1328-1331, with an explicit comment noting this asymmetry needs matching bookkeeping cleanup).
- Finger-held (non-latched) notes are released whenever the underlying grid layout would change under them (switching engine, opening scale editor, switching mode) — `~gz.padKeysOffMomentary` — but latched notes are deliberately left alone in those same transitions, since surviving mode changes is the entire point of latch.

### 5.8 SHIFT button debounce/grace logic (lines 3201–3237)
Two important MIDI-hygiene details to replicate for correctness on real hardware (or emulate meaningfully for Web MIDI):
1. **Pressure-sensitive CC debounce**: the Launchpad Pro's round buttons send multiple CC messages per physical press (pressure-sensing artifacts), and easing off sends a 0 while still physically down. Only a `0→nonzero` transition with `>0.12s` (`padCCDebounce`) since the last accepted press counts as a "press" (line 3222). Without this, PLAY/STOP would double-fire and merely blink instead of toggling.
2. **SHIFT release grace window**: SHIFT's *release* is tracked (not just press), and a 0.25s grace period (`padShiftGraceTime`) after release still counts as "shifted" (`~gz.padShiftOn`, lines 3211–3213) — because releasing SHIFT mid-chord (common when playing SHIFT+multiple keys) would otherwise cause some notes in the chord to be interpreted as un-shifted.

### 5.9 SysEx / device handshake details (lines 2721–2789, 3475–3657)
- Programmer-mode SysEx header: `[0xf0,0x00,0x20,0x29,0x02,0x10, ...payload..., 0xf7]` (Novation manufacturer ID).
- On connect: `[0x21,0x01]` (standalone/not-Ableton mode) → wait 0.15s → `[0x2c,0x03]` (layout 3 = Programmer) → wait 0.10s → `[0x0e,0x00]` (all LEDs off) → wait 0.05s (lines 3555–3557). Commands need spacing; sent back-to-back some units drop messages.
- LED set message: `[0x0b, pad1, r1,g1,b1, pad2, r2,g2,b2, ...]`, batched up to 24 pads per SysEx message (`clump(24)`, line 2779), RGB values **0-63 range, not 0-255**.
- **LED diff caching** (`~gz.padCache`, lines 2762–2789): only send LEDs that actually changed value since the last redraw — critical for performance, since the playhead can advance many times/sec and resending all 100 LEDs each time (~1150 LED commands/sec) causes visible stutter and dropped incoming button presses on real hardware. A JS/Web MIDI port should replicate this diffing (compare a cached 100-entry array before emitting SysEx).
- **Throttled/coalesced redraw** (`~gz.padRefresh`, lines 3027–3049): draws are rate-limited to ~33Hz (30ms min gap); if a redraw request lands inside the cooldown window, it's not dropped but merged into one trailing scheduled redraw that will show final state. Web port: implement the same "leading + trailing" throttle pattern (similar to lodash's `throttle` with `trailing: true`).
- Disconnect/cleanup (`~gz.padDisconnect`, lines 3455–3471) sends `[0x0e,0x00]` (LEDs off) then `[0x2c,0x00]` (back to factory Note-layout mode) — important for leaving the hardware in a sane state for other software when the web app closes. Web MIDI equivalent: send this on page unload / explicit disconnect if feasible (`beforeunload` is unreliable for MIDI SysEx delivery, but attempt it; also expose a manual "disconnect" UI action).
- Device auto-discovery: scans `MIDIClient.destinations`/`sources` (SC) for a name/device string containing "launchpad" (case-insensitive), preferring a port named "standalone" if multiple are present, and **pins output+input to the same port name** (a historical bug fixed here: previously output and input could independently latch onto different ports of a multi-port device, so LEDs would work but buttons wouldn't). Retries every 0.25s for up to 10s (40 tries) after `MIDIClient.init` since CoreMIDI enumerates asynchronously. **Web MIDI port**: use `navigator.requestMIDIAccess({sysex:true})`, iterate `.inputs`/`.outputs`, match names containing "launchpad" (case-insensitive), prefer "standalone" in the name, and pin input/output to matching names — replicate the same retry-on-cold-start behavior since Web MIDI's device list can also populate asynchronously (listen to `onstatechange` in addition to an initial scan/retry loop).

### 5.10 Debug helpers (lines 3568–3614)
- `~gz.padPorts` — prints all MIDI sources/destinations the machine sees (Web MIDI equivalent: log `navigator.requestMIDIAccess()`'s `.inputs`/`.outputs` maps).
- `~gz.padSelfTest` — reconnects, flashes the whole grid white for 1s, then restores. Useful smoke-test to keep as a debug button in the web UI.
- `~gz.padDebug = true` — logs every incoming MIDI message. Keep as a devtools/console toggle in the web port.

---

## 6. Existing (uncredited) Qt GUI — reference for the new web GUI layout

Since the README claims "no GUI" but the file **does** build one (`~gz.buildGUI`, lines 1680–2334), it's a useful layout reference even though the task asks for an invented web GUI. Summary of its panel layout (window 1180×900px):
- **Top transport bar** (y≈10-24): title, PLAY/STOP, tempo NumberBox, volume slider (drives `fxP[3][6]` = master `amp`), REC toggle, FREEZE toggle, SAMPLE button, in/out meters, connection status text, DISK-REC (records master bus to `.wav` in `<script dir>/recordings/`, separate from the sequencer's REC-arm), QUIT.
- **Engine tabs row** (y≈42-66): 3 engine-select buttons (colored per engine), 3 mute buttons, engine label.
- **Engine-specific control row** (y≈98-136): CLOUDS mode popup; GRAINTOPIA voice A/B buttons + slot popup; CHEAT CODES bank popup + 8 pad buttons; a "Load into slot/bank..." button (native file dialog, `Dialog.openPanel`) — **not portable to web as-is**, see §7.
- **Parameter sliders grid** (y≈142-494, two columns of 16 rows = 32 slots): generic slider+label+numeric-readout rows, re-labeled/shown-hidden per engine (CLOUDS uses 21, GRAINTOPIA uses 32 across 2 "pages"/columns representing voice A/B, CHEAT CODES uses 18).
- **PARAM LOCK panel** (y≈498-588): dropdown of parameter, slider, SET LOCK / CLR LOCK buttons, status text showing which locks exist on the selected step.
- **INPUT SOURCE panel** (right side, y≈76-228): source popup, prev/next WAV buttons, Load File... button (native dialog), file label, 8 source-parameter sliders.
- **SEQUENCER panel** (right side, y≈310-592): key/scale/octave popups, note/pad NumberBox + name readout, length/div controls, vel/prob NumberBoxes, RND/DEL/CLR buttons, 8×8 step-button grid (color-coded exactly like the Launchpad's STEP mode), step-info readout.
- **FX panel** (far right, y≈76-822, one box per slot): 4 stacked boxes (DELAY/REVERB/SHAPE/MASTER), each with a bypass button and its own sliders.

Everything here calls the *exact same* `~gz.*` functions the Launchpad calls (`~gz.editParam`, `~gz.setParam`, `~gz.trigger`, etc.) — there is no parallel/duplicate state, just multiple views. **This "one state, multiple views" architecture is exactly the pattern the web port should follow**: a central JS state object + pure functions to mutate it (mirroring `~gz.setParam`, `~gz.trigger`, `~gz.editParam`, etc. 1:1), with the web GUI, the Launchpad-via-WebMIDI handler, and any console/debug commands all calling into that same layer, never touching state directly.

---

## 7. External dependencies / behaviors that cannot port directly

| Original behavior | Line(s) | Why it can't port as-is | Suggested browser equivalent |
|---|---|---|---|
| `Dialog.openPanel` native file picker (Load File / Load into slot/bank) | 1849-1860, 1991-1998, 2530-2543 (soundcard picker too) | Native OS file dialog, not available to a web page directly | `<input type="file" accept="audio/*">` (or drag-and-drop zone) + `FileReader`/`fetch` + `AudioContext.decodeAudioData`, then extract channel 0 and upload as a mono buffer to SuperSonic via its buffer-loading API (or an `/b_alloc`+manual sample-fill OSC sequence if SuperSonic doesn't expose a high-level file loader). |
| `~/granular_zero_samples/` directory scan (`~gz.scanWavs`, `PathName(...).files`) | 112, 829-838, 882-892 | No filesystem access from a browser sandbox | Replace "step through files in a folder" with a small in-browser sample library: either (a) let the user multi-select files once via `<input type=file multiple>` and keep them in an in-memory/IndexedDB list to step through, or (b) ship a curated set of default samples as static assets fetched via `fetch()`. UP/DOWN (rows 5/6 on SOURCE focus) then steps through that in-memory list instead of a directory listing. |
| `s.record(path, ...)` disk recording of the master bus (`~gz.startRec`/`stopRec`, "DISK REC" GUI button) | 2364-2379, 1776-1785 | No arbitrary filesystem write from a browser; also SuperSonic/scsynth's own recording feature (if any) still needs a destination | Use `MediaRecorder` API against the Web Audio destination node (SuperSonic's audio output, tapped via `AudioContext`), buffer chunks, and on stop trigger a browser download (`<a download>` blob URL) instead of writing to a fixed `recordings/` folder. |
| Output device picker window (`~gzDevWin`, pre-boot dialog choosing an audio interface) | 2512-2544 | SC's `ServerOptions.outDevices` enumerates native CoreAudio/ASIO/JACK devices; a browser only sees what `AudioContext`/`navigator.mediaDevices` exposes, and even then output-device *selection* (as opposed to input) is not universally supported (`setSinkId` is Chrome-only, not universal) | If available, use `HTMLMediaElement.setSinkId()` / `AudioContext` sink selection where supported; otherwise skip this step entirely and just use the browser's default output — acceptable simplification, flag it as a known gap in the port rather than trying to fully replicate. |
| Native MIDI backend absence handling (`try { MIDIClient.init } { midiOK=false }`) | 3620-3626 | Web MIDI API has its own failure mode (`navigator.requestMIDIAccess` rejecting, or not existing in the browser at all e.g. Safari without a flag/polyfill) | Feature-detect `navigator.requestMIDIAccess` up front; if absent, disable Launchpad-related UI and show a "console/GUI only" banner exactly analogous to `"no MIDI backend on this machine -- console control only."` (line 3625). |
| `Platform.userHomeDir` sample directory path (`~gz.sampleDir`) | 112 | No meaningful "home directory" concept in a browser | Drop entirely; superseded by the file-input/IndexedDB approach above. |
| SC console/REPL API (`~gz.status[0].()`, `~gz.trigger[0].(...)`, etc., as a live-codeable interface) | throughout, and the "Console API" section of README_granular_zero.md (lines 209-231) | Sclang's live-coding console is a desktop-app-specific interactive REPL feature | Optional: expose an equivalent debug console in the web app (a JS `window.gz = {...}` object mirroring the same function names/signatures, so power users can drive it from the browser devtools console) — cheap to add and preserves the spirit of "everything reachable from the console" noted throughout the original file's comments. |
| `AppClock`/`TempoClock`/`SystemClock` distinctions, `.defer` (main-thread marshaling for Qt safety) | throughout (e.g. 87-88, 1087, 3198, 3240) | SuperCollider-specific threading/scheduling model (Qt GUI calls must run on the "AppClock"/main thread; MIDI callbacks arrive on a background thread and must `.defer` back) | JavaScript is single-threaded (Web MIDI/Audio callbacks and DOM updates all run on the same event loop, modulo AudioWorklet threads), so this entire category of concern **disappears** in the port — no `.defer` equivalent needed, but *do* preserve the equivalent scheduling precision distinction: use `TempoClock`-equivalent (a lookahead/rAF-driven beat scheduler) for musical timing, vs. plain `setTimeout`/`requestAnimationFrame` for UI-only redraws (LED throttling, meter ticks), matching the original's `TempoClock` vs `AppClock` split (e.g. line 3427 blink task on `TempoClock`, line 2286 meter task on `AppClock`). |
| SuperCollider `NodeWatcher`/`.isPlaying`/`.onFree` voice-liveness tracking | 1085-1103 | SuperSonic/OSC has no built-in equivalent object model | Reimplement in JS: on every `/s_new`, record `{nodeId, engine, val}`; subscribe to scsynth's node-notification OSC messages (requires sending `/notify 1` to the server after connecting) and listen for `/n_end` to prune the tracking map — mirrors `~gz.watch`/`~gz.forget`/`~gz.alive` exactly. |
| `Date.getDate.format(...)` timestamped recording filenames | 2367 | Trivially portable actually — `new Date().toISOString()` or similar in JS | Not a real gap; just noted for completeness since it's part of the DISK REC feature above. |

---

## 8. Cross-reference: README claims vs. code (for the JS port author's awareness)

- README_granular_zero.md's parameter index lists (lines 50-53, 69-72, and 79-80 for CHEAT CODES) match the in-code spec tables (`~gz.specsClouds` lines 148-172, `~gz.specsVoice` lines 177-194, `~gz.specsPad` lines 197-216) exactly, including order — safe to use either as the source of truth for the JS parameter table; this document's §1 restates them with min/max/default/unit/exponential-flag for direct porting.
- The "SHIFT+94 = FREEZE, SHIFT+97 = undo last RND" deviation claimed in both READMEs (README.md line 268-269, README_granular_zero.md N/A explicitly but implied) is confirmed correct against the code (line 2628-2629 comment, and dispatch at lines 3350-3352 for 94/FREEZE, 3386-3395 for 97/undo).
- Known limits section (README_granular_zero.md lines 275-283) is accurate against the code: 8-second mono buffers everywhere (§2.4), left-channel-only file loading (§2.4), no patch save/load (§4 above), and single 64-step track per engine with no pattern chaining (§3.2 — confirmed, no bank/pattern-chain data structures exist anywhere in `~gz.trk`).
