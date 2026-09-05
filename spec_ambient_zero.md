# ambient_zero_sc — Web Port Specification

Source of truth: `supercollider_standalone/ambient_zero_sc.scd` (3347 lines, sclang).
All line numbers below refer to that file as of this writing. Cross-reference:
`supercollider_standalone/README.md` (Hungarian user manual, mostly consistent with
the code — deviations are flagged below).

Target: reimplement all sclang-side logic (sequencing, GUI, MIDI mapping, patch
save/load) in JavaScript/HTML, running against **SuperSonic** (WASM scsynth) which
only understands compiled SynthDefs + OSC (`/s_new`, `/n_set`, `/n_free`, `/n_go`,
buffer-fill messages, etc). sclang itself is NOT available in the browser.

---

## Table of Contents

1. [Global Architecture](#1-global-architecture)
2. [SynthDefs](#2-synthdefs)
3. [Layer Parameters (the 25 specs)](#3-layer-parameters-the-25-specs)
4. [Wavetable / Structure Generation](#4-wavetable--structure-generation)
5. [NOISE Layer](#5-noise-layer)
6. [FX Chain](#6-fx-chain)
7. [Sequencer](#7-sequencer)
8. [Patch Save/Load](#8-patch-saveload)
9. [GUI Structure](#9-gui-structure)
10. [Launchpad Pro MIDI Mapping](#10-launchpad-pro-midi-mapping)
11. [Non-Portable Behaviors & Browser Equivalents](#11-non-portable-behaviors--browser-equivalents)

---

## 1. Global Architecture

### 1.1 Top-level state container

Everything lives in one sclang `Event` called `~az` (lines 149, 153+). In JS this
maps naturally to a single global (or module-scoped) state object, e.g. `AZ`.
Functions are stored as 1-element arrays in sclang purely to prevent Event
auto-invocation (`~az.fn[0].()`) — **this quirk is irrelevant in JS**; just use
plain methods/functions.

### 1.2 Server boot options (lines 1290–1305)

```
s.options.memSize = 8192 * 4;      // 32768 KB
s.options.numBuffers = 1024;
```
Must be set before boot. In SuperSonic, the equivalent WASM scsynth init options
(memory size, buffer count) should be set generously at load time — the original
note explains that too-small `memSize` silently fails reverb/shimmer delay-line
allocation and the wavetable buffer count (3 layers × 64 tables + rec/user buffers)
needs `numBuffers` ≥ ~200, budgeted here at 1024 for headroom.

### 1.3 Buses (lines 1307–1309)

| Bus | Type | Channels | Purpose |
|---|---|---|---|
| `~az.mixBus` | audio | 2 | Sum of all 4 layers' dry output (this is FX1's input) |
| `~az.slotBus[0..2]` | audio | 2 each | Output of FX1, FX2, FX3 respectively (serial chain hops) |
| `~az.revBus` | audio | 2 | Parallel reverb+shimmer send bus — every layer writes `sig * revSend` here |

### 1.4 Groups (lines 1311–1315), execution order (head→tail)

```
~az.grp                              (root group for everything below)
  ~az.layerGrp[0..3]  (addToTail)    DRONE, PAD, ATMOS, NOISE voice groups
  ~az.slotGrp[0..2]   (addToTail)    FX1, FX2, FX3 synths
  ~az.revShimGrp      (addToTail)    fixed reverb+shimmer synth
  ~az.masterGrp       (addToTail)    fixed master comp/limiter synth
```
Because groups are added `\addToTail` in this order, execution order is exactly
layer voices → FX1 → FX2 → FX3 → reverb+shimmer → master, matching the audio
signal flow (SC executes synths in a group in list order, first-added = executes
first = earlier stage). In a JS/OSC-driven SuperSonic setup, this same ordering
must be preserved either via explicit synth group order in `/g_new`+`/s_new
addToTail`, or by having a fixed static node order if SuperSonic's group model
allows it.

### 1.5 Buffers (lines 1317–1321)

- `~az.banks[0..2]` — one `Buffer.allocConsecutive(64, tableSize*2, 1)` per tonal
  layer (DRONE/PAD/ATMOS), i.e. **64 consecutive single-channel buffers per
  layer**, each `tableSize*2 = 1024` frames (SC wavetable format interleaves
  amplitude/phase-delta, i.e. `.asWavetable` doubles the sample count). `bankBase`
  = the bufnum of buffer 0 in each bank (so `bank + pos` addressing in the
  SynthDef's `VOsc.ar(bank + pos, freq)` works via consecutive integer bufnums).
- `~az.recBuf` — `Buffer.alloc(sampleRate*8, 2)`, stereo, 8s: input recording target
  for NOISE-layer line-in sampling.
- `~az.usrBuf` — `Buffer.alloc(sampleRate*8, 2)`, stereo, 8s: placeholder, replaced
  wholesale by `Buffer.read` when the user loads a WAV/AIFF file (see §5.3).

**Port note**: SuperSonic's Buffer/wavetable support and `VOsc` (wavetable
oscillator reading consecutive buffers) needs verifying — if `VOsc` isn't
available in SuperSonic's UGen set, the wavetable-morph oscillator core of
`az_str0..5` cannot run as-is and either needs a substitute UGen graph or must be
pre-rendered. See §4 for the exact generation algorithm to replicate in JS.

### 1.6 The 4 layers

```js
layers = ["DRONE", "PAD", "ATMOS", "NOISE"]   // index 0..3
```
- Layers 0–2 (DRONE/PAD/ATMOS) are "tonal" layers: each picks one of 6
  **structures** (oscillator topologies) and one of 32 **waveforms** (wavetable
  content).
- Layer 3 (NOISE) has no structure/waveform; instead picks one of 8 synthesized
  noise textures, or LINE IN, or a loaded WAV FILE (10 options total, see §5).

Per-layer live parameter state: `~az.lp[layer]` (an `IdentityDictionary`), holding
all 25 spec values (§3) *plus* 4 extra dropdown-backed keys not in `~az.specs`:
`ftype` (filter type 0-2), `modShape` (0-9), `l1dest` (0-5), `l2dest` (0-5).
These 4 were historically bugged ("filter doesn't work", see README troubleshooting)
because they weren't persisted per-layer — the fix stores them in `~az.lp[layer]`
just like the slider specs, and every new note passes the full `~az.lp[layer]`
dict as synth args (line 979). **Port requirement**: your JS layer-state object
must likewise hold all 29 keys (25 specs + ftype/modShape/l1dest/l2dest) per
layer, and every triggered voice must receive the full current snapshot as
`/s_new` args.

### 1.7 Signal flow diagram

```
DRONE  ─┐
PAD    ─┼─► mixBus ─► FX1 ─► slotBus0 ─► FX2 ─► slotBus1 ─► FX3 ─► slotBus2 ─┐
ATMOS  ─┤                                                                     ├─► masterSynth(in=slotBus2) ─► Out 0 (hw out)
NOISE  ─┘                                                                     │
                                                                               │
each layer's own synth ALSO does:  Out.ar(revBus, sig * revSend) ────────────►┘
                                    revShimSynth reads revBus, writes its wet
                                    tail into slotBus2 (same bus FX3 outputs to;
                                    Out.ar SUMS, doesn't overwrite) ───────────┘
```
Key point: reverb+shimmer is a **parallel send/return**, not part of the FX1→FX2→
FX3 serial insert chain. It is fed by each layer's own `revSend` amount (0..1,
part of the 25 specs) and its wet output is *summed* onto `slotBus[2]` (FX3's
output bus) so both reach the master compressor/limiter together.

### 1.8 Voice management (lines 955–1010)

- `~az.voices[layer]` — `IdentityDictionary` mapping MIDI note number → currently
  playing `Synth`.
- `~az.held[layer]` — `List` of currently-held note numbers, oldest-first, used
  for voice stealing.
- `~az.maxVoices` — polyphony cap per layer (default 6, GUI "poly" NumberBox,
  range 1–16).
- **Voice stealing** (lines 973–977): before starting a new voice, while
  `held[layer].size >= maxVoices`, the OLDEST held note is force-released
  (`gate=0`) and removed.
- **noteOn** (lines 968–996):
  1. If layer is muted, no-op.
  2. `hz = note.midicps`.
  3. If a voice already exists at that note number, `noteOff` it first (retrigger).
  4. Voice-steal check (above).
  5. Build args: `[out=mixBus, revB=revBus, hz, vel, gate=1]` + every key in
     `~az.lp[layer]` (spread in) + p-lock overrides appended LAST (so they
     override the layer defaults for this specific note only — args processed
     in order, later values in an OSC `/s_new` message win) + (layers 0-2 only)
     `bank=bankBase[layer]` + (layer 3 only) `buf=` (usrBuf.bufnum or
     recBuf.bufnum depending on noiseSrc).
  6. `Synth(defFor(layer), args, layerGrp[layer])`.
- **noteOff** (lines 998–1002): sets `gate=0` on the voice's Synth (triggers
  release stage of the ADSR, which `doneAction: 2` will free), removes bookkeeping.
- **layerOff** (lines 1004–1010): force-release (`gate=0`) every voice on a layer
  and clear bookkeeping — used on mute, stop, structure/wave switch.
- `defFor(layer)` (lines 956–966): resolves which SynthDef name to instantiate:
  - layer ≤ 2 → `"az_str" ++ structure[layer]` (structure 0-5)
  - layer 3, noiseSrc < 8 → `"az_noise" ++ noiseSrc` (8 synthesized textures)
  - layer 3, noiseSrc ≥ 8 → `"az_noisebuf" ++ chans` where chans = usrChans (1 or
    2) if noiseSrc==9 (WAV FILE), else 2 (LINE IN, recorded stereo).

**Port note**: SuperSonic voice management is entirely a JS responsibility —
maintain the same per-layer dict-of-active-node-ids + held-list + steal logic,
sending `/s_new` and `/n_set (gate,0)` OSC messages directly.

---

## 2. SynthDefs

All defined inside `~az.defineSynths` (lines 467–953), a single function run once
against the server at boot. Every SynthDef must be pre-compiled to `.scsyndef`
binary form (via a real sclang/scsynth toolchain, offline) and loaded into
SuperSonic — SuperSonic cannot compile UGen graphs itself, only load compiled defs
and drive them via OSC.

### 2.1 Shared helper functions (not SynthDefs themselves, lines 468–512)

**`lfo(shape, freq, mul=1)`** (473–486) — 10-way LFO shape selector via
`Select.kr`, shared by LFO1, LFO2, and the main `mod` oscillator in every voice
SynthDef:

| idx | shape | UGen |
|---|---|---|
| 0 | SINE | `SinOsc.kr(freq)` |
| 1 | SQAR | `(LFPulse.kr(freq,0,0.5)*2)-1` |
| 2 | TRI | `LFTri.kr(freq)` |
| 3 | SAW | `LFSaw.kr(freq)` |
| 4 | R.SAW | `LFSaw.kr(freq).neg` |
| 5 | RAND | `LFNoise0.kr(freq)` |
| 6 | S.RND | `LFNoise2.kr(freq)` |
| 7 | LOG | `(((LFSaw.kr(freq)*0.5)+0.5).pow(0.3)*2)-1` |
| 8 | R.LOG | `(((LFSaw.kr(freq)*-0.5)+0.5).pow(0.3)*2)-1` |
| 9 | PL.10 | `(LFPulse.kr(freq,0,0.1)*2)-1` (10% duty pulse) |

Result multiplied by `mul` (depth).

**`tail(sig, gate, atk,dec,sus,rel, cut,res,egAmt,ftype, dCut,dLvl,dPan, level,pan,vel, out,revB,revSend)`**
(491–512) — shared post-processing chain every voice SynthDef routes through at
the end:
1. `env = EnvGen.kr(Env.adsr(atk,dec,sus,rel, curve:-2), gate, doneAction:2)` — the
   `doneAction:2` is what frees the Synth node once the release finishes; critical
   for a JS port too (SuperSonic must free/`n_free` synths after release the same
   way, or the port needs to poll for silence / rely on scsynth's own doneAction).
2. Filter cutoff modulation: `fc = (cut * 2**((env*egAmt*4) + (dCut*6))).clip(20,18000)`
   — envelope amount and LFO-destination "dCut" both modulate cutoff exponentially
   (in octaves): `env*egAmt*4` = up to ±4 octaves from envelope, `dCut*6` = up to
   ±6 octaves from LFO.
3. `q = (1-res).clip(0.05,1)` — resonance inverted to Q (higher res slider = lower
   q = sharper resonance).
4. 3-way filter select (`ftype` 0/1/2):
   - 0 = `RLPF.ar(sig, fc, q)` (resonant low-pass)
   - 1 = `BPF.ar(sig, fc, q*1.5)` (band-pass, boosted Q)
   - 2 = `RHPF.ar(sig, fc, q)` (resonant high-pass)
5. `o = o * env * vel * level * (1+dLvl).clip(0,2)` — envelope, velocity, level
   slider, and LFO-destination level-mod all multiply together.
6. `o = LeakDC.ar(o.softclip) * 0.22` — DC-block + soft saturation, fixed -13dB-ish
   attenuation (`*0.22`) headroom trim baked into every voice.
7. `o = Pan2.ar(o, (pan+dPan).clip(-1,1))` — stereo pan, base pan + LFO-destination
   pan-mod.
8. `Out.ar(out, o)` — writes to `mixBus`.
9. `Out.ar(revB, o * revSend)` — parallel write of `o` scaled by `revSend` to
   `revBus` (the reverb+shimmer parallel send).

### 2.2 The 6 "Blendwave structure" voice SynthDefs: `\az_str0` .. `\az_str5`

(lines 515–591, one per `st` in `6.do`)

**Full arg list** (all 6 structures share identical args; only the oscillator
graph inside differs by `st`):

```
out=0, revB=0, revSend=0.3, gate=1, hz=110, vel=0.7,
bank=0, harmonic=0.3, modDepth=0.2, modRate=0.25, modShape=0,
balance=0.5, detune=9, pitch=0, fmAmt=0.3, ratio=2, ringAmt=0.5,
atk=2, dec=3, sus=0.7, rel=6,
cut=3500, res=0.2, egAmt=0.2, ftype=0,
l1rate=0.05, l1depth=0.2, l1shape=0, l1dest=2,
l2rate=0.11, l2depth=0.12, l2shape=6, l2dest=1,
level=0.7, pan=0,
glide=0, bend=0, press=0
```

**UGen graph** (530–589):
1. Two LFOs computed via the shared `lfo` helper:
   `m1 = lfo(l1shape, l1rate.linexp(0,1,0.01,12), l1depth)`
   `m2 = lfo(l2shape, l2rate.linexp(0,1,0.01,12), l2depth)`
   — rate slider (0-1 linear) maps exponentially to 0.01–12 Hz.
2. LFO destination routing via `Select.kr(l1dest, [...])` for each of 6 possible
   destinations (indices match `~az.lfoDests = ["PITCH","CUTOFF","HARMONIC",
   "LEVEL","PAN","MOD"]`); `dPitch/dCut/dHarm/dLvl/dPan/dMod` each sum
   contributions from LFO1 and LFO2 if either targets that destination.
3. Main mod oscillator: `mod = lfo(modShape, modRate.linexp(0,1,0.01,16),
   (modDepth+dMod).clip(0,1))` — a THIRD, separate modulator (not LFO1/2), whose
   own rate/shape/depth are separate params (`modRate`, `modShape`, `modDepth`),
   additionally depth-modulated by dMod (if LFO1/2 target "MOD").
4. Pitch: `f = Lag.kr(hz, glide) * (2 ** ((pitch+bend+(dPitch*1200))/1200))` —
   portamento via `Lag`, then cents-based pitch offset (pitch param + bend + LFO
   pitch-mod in cents, 1200 cents/octave).
5. Wavetable position: `pos = (harmonic + dHarm + (mod * <0.5 or 0>)).clip(0,1) *
   top` where `top = nTables-1 = 63`, and the mod contributes to position only for
   `st` in {1,2,3} (structures index 1-3 use `mod` to also wobble table position by
   up to 0.5, structures 0/4/5 do not). `posY = top - pos` (mirror position, used
   by several structures for a complementary/opposing oscillator).
6. Six distinct oscillator graphs selected by `st` (0-5), each returning `sig`:
   - **st=0**: `d = detune*(1+(mod*2))` (mod modulates detune amount); two `VOsc`
     at `bank+pos` / `bank+posY`, offset by `±d` cents, crossfaded by `balance`
     via `XFade2.ar(a,b,(balance*2)-1)`. (Detune amount itself is LFO/mod-modulated.)
   - **st=1**: same two-VOsc XFade2 structure but with static `detune` (not
     mod-modulated); `mod` instead perturbs wavetable `pos`/`posY` directly (per
     step 5 above).
   - **st=2**: `a` = VOsc at `pos`, undetuned; `b`+`c` = two VOscs at `posY`,
     detuned ± and the negative one pitched ×2 (octave up); `(b+c)*0.5` mixed and
     crossfaded against `a` by `balance`.
   - **st=3**: `a`+`b` both at `pos` (one undetuned, one detuned by
     `detune × 1.4983` — near a perfect fifth ratio), summed and crossfaded
     against `c` (at `posY`, detuned negative, half-speed/octave-down) by `balance`.
   - **st=4**: ring-mod structure — `a` = VOsc at `pos`; `r` = `SinOsc.ar(f * ratio
     * (1+(mod*0.5)))`; crossfade between `a` (dry) and `a*r` (ring-modulated) by
     `ringAmt`.
   - **st=5 (default case)**: FM structure — `mf = f*ratio` (modulator frequency);
     `m = VOsc.ar(bank+posY, mf) * mf * fmAmt * 4` (wavetable-based FM modulator,
     scaled by modulator freq and fmAmt — classic FM index scaling); `a` =
     `VOsc.ar(bank+pos, (f+m+(f*mod*0.06)).clip(20,18000))` (carrier FM'd by `m`
     plus a small mod-oscillator vibrato); `b` = `VOsc` at `posY`, detuned;
     crossfaded a/b by balance.
7. `sig = sig * (1 + (press*0.6))` — aftertouch/pressure boosts amplitude up to
   +60%.
8. Routed through shared `tail(...)`.

**Port implication**: this requires `VOsc` (interpolating wavetable oscillator
reading a *bank* of consecutive buffers addressed by a continuous "index" arg —
i.e. crossfades between adjacent wavetables as `pos` moves). If SuperSonic lacks
`VOsc`, this is the single biggest technical risk in the port; options: (a)
implement the wavetable interpolation client-side into a custom Web Audio node
running in parallel to SuperSonic's synthesis (breaks the "everything via OSC to
one engine" model), (b) find/build a VOsc-equivalent UGen for SuperSonic if its
UGen set is extensible, or (c) precompute far fewer, coarser table positions and
approximate with simpler oscillators. This must be resolved before other work
proceeds on the tonal layers.

### 2.3 NOISE layer synthesized textures: `\az_noise0` .. `\az_noise7`

(lines 593–640)

Args (identical across all 8, only the `gen` UGen recipe differs):
```
out=0, revB=0, revSend=0.3, gate=1, hz=110, vel=0.7,
noiseMix=0.15, pitch=0, modDepth=0.2, modRate=0.25, modShape=0,
atk=1, dec=2, sus=0.85, rel=5,
cut=6000, res=0.1, egAmt=0, ftype=0,
l1rate=0.05, l1depth=0.2, l1shape=0, l1dest=1,
l2rate=0.11, l2depth=0.1, l2shape=6, l2dest=4,
level=0.7, pan=0, press=0
```
Note: NOISE layer has no `harmonic/balance/detune/fmAmt/ratio/ringAmt` (no
oscillator bank/structure) — those specs are simply unused/ignored for this
layer at the GUI level (sliders still shown though — see §9; they'd have no
audible effect since the SynthDef doesn't accept those arg names... actually
since sclang `Synth.new` silently ignores unknown args, extra args in `~az.lp`
sent to a NOISE-layer voice that doesn't declare them are just dropped).

`f = hz * (2**(pitch/1200))` (simple pitch-shift, no glide/bend/structure).
`sig = gen.(f, mod*0.5)` where `gen` is one of 8 noise-generator closures (595–613,
each takes `f` = base freq for filter-cutoff scaling, `m` = mod amount 0..~0.5):

| idx | name (README) | UGen recipe |
|---|---|---|
| 0 | RAIN | `BPF(WhiteNoise(0.5)+Dust2(2500*(1+m))*0.25, (f*12).clip(40,16000), 0.9) + LPF(BrownNoise(0.2), (f*3).clip(40,16000))` |
| 1 | WIND | `BPF(PinkNoise(1.6), (f*(4+LFNoise2(0.13).range(1,8))*(1+m)).clip(40,16000), 0.35)` |
| 2 | OCEAN | `e=LFNoise2(0.08).range(0.1,1); LPF(BrownNoise(1.4)*e, (f*(5+(e*12))*(1+m)).clip(40,16000))` |
| 3 | STREAM | `Mix.fill(5,{i: BPF(WhiteNoise(0.4), (f*(8+(i*5))*LFNoise2(0.4+(i*0.2)).range(0.8,1.4)*(1+m)).clip(40,16000), 0.12)})` |
| 4 | FIRE | `LPF(BrownNoise(0.7), (f*4*(1+m)).clip(40,16000)) + BPF((Dust2(9)*6)+WhiteNoise(0.1), (f*16).clip(40,16000), 0.4)` |
| 5 | FOREST | `(SinOsc((f*LFNoise1(6).range(24,40)*(1+m)).clip(40,12000)) * EnvGen(Env.perc(0.01,0.12),Dust.kr(0.8)) * 0.15) + BPF(PinkNoise(0.6), (f*6).clip(40,16000), 0.5)` (random chirps + pink bed) |
| 6 | THUNDER | `(LPF(BrownNoise(2.2), (f*1.5*(1+m)).clip(30,8000)) * LFNoise2(0.06).range(0.05,1).pow(2)) + LPF(WhiteNoise(0.07), (f*8).clip(40,16000))` |
| 7 | NIGHT | `(BPF(WhiteNoise(1.0), (f*40*(1+m)).clip(200,16000), 0.02) * LFPulse.kr(11,0,0.35).lag(0.004)*0.6) + BPF(PinkNoise(0.3), (f*5).clip(40,16000), 0.6)` (chirping insects + pink bed) |

After `gen`, `sig = sig + (WhiteNoise.ar(noiseMix) * (1+press))` (extra white-noise
mix layer, boosted by aftertouch), then through shared `tail(...)` (LFO
routing for these limited to CUTOFF(1)/LEVEL(3)/PAN(4) destinations only —
default `l1dest=1, l2dest=4`).

### 2.4 NOISE layer sample-playback: `\az_noisebuf1`, `\az_noisebuf2`

(lines 642–669, one per channel-count `ch` in `[1,2]`)

Args:
```
out=0, revB=0, revSend=0.3, gate=1, hz=110, vel=0.7,
buf=0, loop=1, start=0, noiseMix=0.1, pitch=0,
modDepth=0.2, modRate=0.25, modShape=0,
atk=0.5, dec=2, sus=0.9, rel=4,
cut=8000, res=0.1, egAmt=0, ftype=0,
l1rate=0.05, l1depth=0.2, l1shape=0, l1dest=1,
l2rate=0.11, l2depth=0.1, l2shape=6, l2dest=4,
level=0.7, pan=0, press=0
```
`rate = (hz/110) * (2**((pitch+(mod*600))/1200)) * BufRateScale.kr(buf)` (pitch
tracks note relative to A2=110Hz baseline, plus mod-oscillator vibrato up to ±600
cents scaled by `modDepth`, plus buffer's native-samplerate correction).
`sig = PlayBuf.ar(ch, buf, rate, 1, BufFrames.kr(buf)*start.clip(0,0.99), loop)`,
mono channels summed if `ch==2` scaled ×0.7 headroom (`Mix.ar(sig) *
if(ch==2,0.7,1.0)`), then `+ WhiteNoise.ar(noiseMix)*(1+press)`, then `tail(...)`.
Which def is used is chosen dynamically by `usrChans` (mono file → `az_noisebuf1`,
stereo → `az_noisebuf2`); `az_noise` for LINE IN always uses `az_noisebuf2` (the
recBuf is always allocated stereo).

### 2.5 `\az_rec` (line 949-952) — input recorder

```
arg buf=0, dur=8;
sig = SoundIn.ar([0,1]);
RecordBuf.ar(sig, buf, 0,1,0,1,0,1, doneAction:2);
```
Records 2-channel hardware input into `recBuf`; self-frees via `doneAction:2`.
**Not portable as-is** — browser mic capture needs `getUserMedia` + manual
buffer-write via OSC or a JS-side ring buffer (see §11).

### 2.6 FX SynthDefs — serial-chain-compatible (fx1/fx2/fx3 slot types)

All 10 slot-type SynthDefs share a **common interface**: `in` (bus), `out` (bus),
`active` (0/1 bypass flag — note: NOT literally bypass, active=0 crossfades fully
to dry via `XFade2` in most; see below), `mix` (dry/wet), plus type-specific
params. `~az.slotDefs` order **must exactly match** `~az.slotTypeNames` order —
this is enforced by list-position pairing, not by name lookup (line 356-362 flags
this as an easy-to-break invariant).

| # | slotTypeNames | SynthDef | Params (name, key, lo, hi, default, warp) |
|---|---|---|---|
| 0 | REVERB | `\az_slot_reverb` | size 0-1 (0.7), decay 0-0.99 (0.72), damp 0-1 (0.35), shimmer 0-1 (0.3), mix 0-1 (0.5) |
| 1 | CHORUS | `\az_end_chorus` | rate 0-1 (0.3), depth 0-1 (0.5), feedback 0-0.9 (0.25), spread 0-1 (0.5), mix 0-1 (0.5) |
| 2 | FLANGER | `\az_end_flanger` | rate 0-1 (0.2), depth 0-1 (0.7), feedback 0-0.95 (0.5), delay base 0.0003-0.01 (0.003, **warp**), mix 0-1 (0.5) |
| 3 | DELAY | `\az_end_delay` | time L 0.02-1.8 (0.375, **warp**), time R 0.02-1.8 (0.5, **warp**), feedback 0-0.9 (0.35), damp 0-1 (0.4), cross 0-1 (0.5), mix 0-1 (0.35) |
| 4 | COMP/LIM | `\az_slot_complim` | threshold 0.005-1 (0.15, **warp**), ratio 1-20 (4, **warp**), attack 0.0005-0.2 (0.01, **warp**), release 0.01-1 (0.15, **warp**), makeup 0.25-8 (1, **warp**), ceiling 0.05-1 (0.95), mix 0-1 (1.0) |
| 5 | TAPE DLY | `\az_slot_tape` | time 0.02-3 (0.375, **warp**), feedback 0-0.95 (0.45), tone 300-10000 (4000, **warp**), wow 0-1 (0.3), mix 0-1 (0.4) |
| 6 | REV DLY | `\az_slot_revdelay` | time 0.05-3 (1.0, **warp**), feedback 0-0.9 (0.3), tone 500-12000 (6000, **warp**), spread 0-1 (0.3), mix 0-1 (0.4) |
| 7 | OVERDRIVE | `\az_slot_drive` | drive 0-1 (0.4), tone 300-12000 (3000, **warp**), bias -0.3-0.3 (0), out lvl 0.2-1.5 (1), mix 0-1 (0.7) |
| 8 | CRUSH | `\az_slot_crush` | bits 1-16 (8), rate 500-22050 (8000, **warp**), drive 1-4 (1), smooth 0-1 (0.3), mix 0-1 (0.6) |
| 9 | TILT EQ | `\az_slot_tilt` | tilt -1-1 (0), freq 200-4000 (900, **warp**), res 0.3-2 (1), drive 1-3 (1), mix 0-1 (1.0) |

"warp" = exponential slider scaling: `value = lo * (hi/lo)**sliderNorm` (0..1 →
lo..hi exponential), vs linear `value = lo + sliderNorm*(hi-lo)`. Every GUI
slider and every Launchpad PARAM/FX column uses this same two-branch formula
(both directions: normalized→value on read, value→normalized on redraw) — see
lines 1646-1650, 1687-1690, 2093-2099, 2166-2168. **This exact formula must be
replicated identically in JS** for slider ↔ parameter-value mapping to feel the
same.

Detailed UGen graphs for each slot-effect type:

**`\az_slot_reverb`** (681–713) — self-contained 8-line FDN with shimmer, doubles
as the fixed reverb+shimmer engine's DSP (see §2.7, byte-for-byte identical graph
except this one crossfades dry/wet via `mix*active`, the fixed one is a pure
send/return with no dry). Structure:
1. `dry = In.ar(in,2)`.
2. Early reflection: `sig = DelayC.ar(dry, 0.2, 0.02)` (20ms delay).
3. Shimmer: `sh = PitchShift.ar(dry, 0.2, 2, 0, 0.01) * shimmer` (2x = octave-up
   pitch shift via granular `PitchShift`, windowSize 0.2s), added to `sig`.
4. 4 serial allpass diffusers: `[0.0043,0.0071,0.0113,0.0189].do{t: sig =
   AllpassC.ar(sig, 0.1, t*(0.5+size), 0.05)}` (size controls delay-time scaling).
5. 8-line FDN tank: `fb = LocalIn.ar(8)`; 8 delay lines with times
   `[0.0297,0.0371,0.0411,0.0437,0.0533,0.0611,0.0687,0.0743] *
   (0.4+(size*2.2))` each perturbed by slow `LFNoise2` modulation (±0.0015s ×
   depth), fed by `sig[i%2] + fb[i]*((decay*0.62)+0.36)` (ping-pong input,
   feedback scaled 0.36–0.98 by decay).
6. `tmp = tmp.collect{LPF.ar(x, damp.linexp(0,1,16000,700))}` (per-line damping
   filter, damp 0→16kHz i.e. bright, damp 1→700Hz i.e. dark).
7. Householder-like mixing matrix: `tmp = [t0+t1,t0-t1,t2+t3,t2-t3,t4+t5,t4-t5,
   t6+t7,t6-t7] * 0.5` — pairwise sum/difference butterfly.
8. `LocalOut.ar(LeakDC.ar(tmp))` closes the feedback loop.
9. `wet = [Mix(tmp[0,2,4,6]), Mix(tmp[1,3,5,7])] * 0.3` → stereo sum of even/odd
   lines, then a final stereo allpass smear (`AllpassC` at 0.0071/0.0091s), DC-blocked.
10. `Out.ar(out, XFade2.ar(dry, wet, ((mix*active).clip(0,1)*2)-1))`.

**`\az_end_chorus`** (892–907) — dual delay-line chorus: `lfoL = SinOsc.kr(rate
map 0.03-4Hz)`, `lfoR` = same rate ×1.07 with phase offset `pi*spread`; each
channel delayed `0.012s base ± lfoX*depth*0.008s` via `DelayC`, with feedback
(`LocalIn`/`LocalOut`, clipped 0-0.9) summed into the delay input before
re-delaying. `Out = XFade2(dry, wet, mix*active)`.

**`\az_end_flanger`** (911–926) — same topology as chorus but shorter base delay
(`delayBase` param 0.0003–0.01, itself a warp-scaled *parameter* not a constant),
faster LFO range (0.02-3Hz), 90°-phase-offset R channel (`pi/2` fixed, not
`spread`-controlled), higher feedback ceiling (0.95), smaller depth scale
(±0.0025s×depth).

**`\az_end_delay`** (929–944) — stereo ping-pong: `dL` reads `dry[0] +
fbIn[1]*cross*fb + fbIn[0]*(1-cross)*fb` (cross-feeds R feedback into L input by
`cross` amount and vice versa) delayed by `timeL`; `dR` symmetric with `timeR`;
each LPF'd by `damp` (linexp 0-1 → 12kHz-800Hz); `Out = XFade2(dry, [dL,dR],
mix*active)`.

**`\az_slot_complim`** (801–811) — `Compander.ar(dry,dry, thresh:threshold,
slopeBelow:1, slopeAbove:1/ratio.max(1), clampTime:attack, relaxTime:release)`
then `Limiter.ar(sig*makeup, ceiling, 0.01)`, `Out = XFade2(dry, sig,
mix*active)`. Identical DSP to the fixed master (§2.8) minus the meter/SendReply.

**`\az_slot_tape`** (818–830) — `DelayC` with feedback (`LocalIn`/`LocalOut`,
clip 0-0.95) modulated by `LFNoise2.kr([0.7,1.1]) * wow * 0.02` (stereo-independent
wow/flutter), filtered `LPF(HPF(d,120), tone)`, saturated `(d*1.4).tanh*0.8`.
`Out = XFade2(dry, dry+d, mix*active)` — note wet output is `dry+d` (delay ADDED
to dry inside the wet branch, not delay alone), meaning even at mix=1 you still
hear dry+delay, not delay-only.

**`\az_slot_revdelay`** (834–847) — reverse-delay via `Phasor.ar(0, 1/SampleRate,
0, len)` sawtooth ramp, delay-read position computed as `len - phase` (playing the
delay buffer backwards), 2 taps (L/R offset by `spread*0.05`), LPF'd by `tone`,
plus one more forward `DelayC` feedback pass (`feedback` param, clip 0-0.9) for
repeats. `wet = dry + rd`.

**`\az_slot_drive`** (850–858) — `tanh` waveshaper: `d = ((dry+bias) *
drive.linexp(0,1,1,60)).tanh`, then `LPF(d, tone) * drive.linexp(0,1,1,0.35) *
outLevel` (drive simultaneously scales input gain into tanh AND scales output
level down, so higher drive = more saturation but partially self-compensating
loudness).

**`\az_slot_crush`** (861–871) — bit reduction: `q = 0.5**bits.clip(1,16); c =
((dry*drive)/q).round*q` (quantization), then sample-rate reduction via
`Latch.ar(c, Impulse.ar(rate))`, then smoothing `LPF(c, smooth.linexp(0,1,20000,2000))`.

**`\az_slot_tilt`** (875–884) — `BLowShelf.ar(dry,freq,res,tilt.neg*12)` then
`BHiShelf.ar(sig,freq,res,tilt*12)` (opposite-sign shelf boost/cut around `freq`
— classic tilt EQ), then `(sig*drive).tanh * drive.reciprocal.max(0.3)`
(saturation with partial makeup).

### 2.7 `\az_master_revshim` — fixed reverb+shimmer (lines 724–757)

Byte-for-byte same FDN/shimmer DSP as `\az_slot_reverb` (§2.6 #0) EXCEPT: no
`dry` variable/crossfade — it's a pure send/return, `in` bus is `revBus`, output
is `Out.ar(out, LeakDC.ar(wet) * mix * active.clip(0,1))` (unconditionally summed
onto its output bus — no dry passthrough because there IS no local dry signal at
this stage, only the accumulated sends from all 4 layers). Its `out` bus target
is `slotBus[2]` (same as FX3's output — see §1.4/1.7).

Params identical to slot REVERB: size, decay, damp, shimmer, mix (default mix=1.0
here vs 0.5 for the slot version), plus `active`.

### 2.8 `\az_master_complim` — fixed master compressor+limiter (lines 764–792)

```
arg in=0, out=0, active=1, threshold=0.15, ratio=4,
    attack=0.01, release=0.15, ceiling=0.95, makeup=1, amp=1;
```
1. `comp = Compander.ar(dry,dry, thresh:threshold, slopeBelow:1,
   slopeAbove:1/ratio.max(1), clampTime:attack, relaxTime:release)`.
2. `sig = Limiter.ar(comp*makeup, ceiling, 0.01)` — makeup gain applied BEFORE the
   limiter so `ceiling` still guarantees no overs.
3. `sig = XFade2.ar(dry, sig, (active.clip(0,1)*2)-1)`.
4. **Metering** (780–787): `inAmp/outAmp = Amplitude.kr(dry[0]/sig[0], 0.01, 0.2)`;
   `grAmp = (Amplitude.kr(comp[0],0.01,0.2) / inAmp.max(1e-4)).clip(0.0001,1)`
   (gain-reduction ratio, 1.0=no compression, 0.5=-6dB); sent via
   `SendReply.kr(Impulse.kr(8), '/az_master_meter', [inAmp, grAmp, outAmp])` — 8
   times/sec. **Port note**: SuperSonic must support `SendReply`→OSC-reply routing
   back to the JS host, or the meter needs to be computed client-side by analyzing
   the output audio stream (e.g. via Web Audio `AnalyserNode` on the final mix) as
   a substitute.
5. Final gain: `Out.ar(out, sig*amp)` — `amp` is a SEPARATE arg from all the
   comp/limiter params, driven by the top-bar "vol" slider (see §9), applied
   *after* the limiter so raising volume cannot defeat the ceiling.

Params: threshold 0.005-1 (0.15, warp), ratio 1-20 (4, warp), attack 0.0005-0.2
(0.01, warp), release 0.01-1 (0.15, warp), makeup 0.25-8 (1, warp), ceiling
0.05-1 (0.95, linear) — 6 GUI sliders (the box only exposes these 6, not `amp`
which is separately controlled by the top "vol" slider, and not `active` which
has its own ON/BYP button).

---

## 3. Layer Parameters (the 25 specs)

`~az.specs` (lines 423–449) — every row: `[id, key, displayName, min, max,
default, unit, warp]`. `id` is used for p-lock storage keys (matches sequencer
step `locks` dict keys); `key` is the literal SynthDef arg name (same as `id`
except `detune→detune` etc. — a few differ, see table). Applies identically to
all 4 layers (though NOISE ignores harmonic/balance/detune/ratio/fmAmt/ringAmt
since its SynthDefs don't declare those args).

| id | SynthDef arg (key) | Display name | Min | Max | Default | Unit | Warp |
|---|---|---|---|---|---|---|---|
| harmonic | harmonic | harmonic | 0 | 1 | 0.30 | | no |
| balance | balance | balance | 0 | 1 | 0.50 | | no |
| detune | detune | detune | -60 | 60 | 9 | ct | no |
| pitch | pitch | pitch | -2400 | 2400 | 0 | ct | no |
| ratio | ratio | op ratio | 0.5 | 15.99 | 2 | | no |
| fm | fmAmt | fm amount | 0 | 1 | 0.30 | | no |
| ring | ringAmt | ring mix | 0 | 1 | 0.50 | | no |
| modrate | modRate | mod rate | 0 | 1 | 0.25 | | no |
| moddepth | modDepth | mod depth | 0 | 1 | 0.20 | | no |
| attack | atk | attack | 0.001 | 20 | 2.0 | s | **yes** |
| decay | dec | decay | 0.001 | 20 | 3.0 | s | **yes** |
| sustain | sus | sustain | 0 | 1 | 0.70 | | no |
| release | rel | release | 0.01 | 30 | 6.0 | s | **yes** |
| cutoff | cut | cutoff | 40 | 16000 | 3500 | Hz | **yes** |
| res | res | resonance | 0 | 0.95 | 0.20 | | no |
| egamt | egAmt | eg amount | -1 | 1 | 0.20 | | no |
| l1rate | l1rate | lfo1 rate | 0 | 1 | 0.05 | | no |
| l1depth | l1depth | lfo1 depth | 0 | 1 | 0.20 | | no |
| l2rate | l2rate | lfo2 rate | 0 | 1 | 0.11 | | no |
| l2depth | l2depth | lfo2 depth | 0 | 1 | 0.12 | | no |
| level | level | level | 0 | 1 | 0.70 | | no |
| pan | pan | pan | -1 | 1 | 0 | | no |
| reverb | revSend | reverb snd | 0 | 1 | 0.30 | | no |
| glide | glide | glide | 0 | 5 | 0 | s | no |
| noisemix | noiseMix | noise mix | 0 | 1 | 0.15 | | no |

Plus 4 dropdown-backed, non-slider params stored per-layer (not in `~az.specs`
but persisted in `~az.lp[layer]` the same way):

| key | Display | Options (index = value) |
|---|---|---|
| ftype | filter | `["LPF","BPF","HPF"]` |
| modShape | mod shape | `["SINE","SQAR","TRI","SAW","R.SAW","RAND","S.RND","LOG","R.LOG","PL.10"]` (same 10 as LFO shapes) |
| l1dest | lfo1 dest | `["PITCH","CUTOFF","HARMONIC","LEVEL","PAN","MOD"]` |
| l2dest | lfo2 dest | same 6-item list as l1dest |

`~az.specById` (453-454) — the same list indexed by `id` symbol for O(1) lookup
(p-lock application, GUI dropdown lookups). In JS: a plain object/Map keyed by
`id` string.

**Warp formula** (used identically for every warp=true param, both slot-FX and
layer specs): given a normalized slider value `n` in [0,1]:
```
value = lo * (hi/lo) ** n           // n -> value
n = log(value/lo) / log(hi/lo)      // value -> n  (for redrawing sliders from data)
```
Linear (warp=false): `value = lo + n*(hi-lo)`, inverse `n = (value-lo)/(hi-lo)`.

---

## 4. Wavetable / Structure Generation

### 4.1 Overview

32 waveforms × 64 tables each = wavetable-per-position morphing. Structures (6,
described in §2.2) are the oscillator *topology*; waveforms (32, `~az.waveNames`)
are the harmonic *content* loaded into the buffer bank a structure reads from.
Generation is entirely algorithmic (no samples), computed once per waveform
(cached in `~az.waveCache[wave]`, an array of 64 `Signal`s), and re-sent to the
server only when a layer's selected `wave` actually changes (`~az.curWave[layer]`
guards against redundant resends).

`~az.waveNames` (303–308, 32 entries, 8 families × 4 variants each):
```
GLAS,MIST,EMBR,DUSK,  HOLL,VEIL,IRON,REED,
SLIT,BREA,PWM.,FOLD,  PURE,BOWL,WARM,BLOW,
BELL,TINE,CHIM,GONG,  VOWL,AHH.,OOH.,THRO,
PIPE,DRAW,CHOR,OCTA,  DUST,SNOW,STAR,VOID
```
(family = `wave.div(4)` → 0..7, variant = `wave % 4` → 0..3; family index maps to
the `switch(fam, ...)` branches in `tableFor`, in order: SAW, SQUARE, PULSE,
WAVESHAPE, BELL, FORMANT, ORGAN, NOISY.)

### 4.2 `~az.tableFor(wave, t)` — single-table generator (lines 171–246)

Computes ONE 512-sample `Signal` (a wavetable frame) for `wave` (0-31) at
normalized morph position `t` (0.0-1.0, t=0 → table 0, t=1 → table 63).

Common setup (174–183):
```
fam = wave.div(4); vari = wave % 4; n = tableSize (512)
nh = 48   // max harmonic count considered
dens = (4 + (vari*3) + (t*(nh-6))).max(1).min(nh).round     // "density": how many harmonics are active, grows with t
tilt = (1.0 + (vari*0.35) - (t*0.9)).max(0.35)              // spectral tilt/rolloff exponent, brightens... actually DEcreases with t (less rolloff = brighter as t→1, since higher tilt = darker via reciprocal power)
thisThread.randSeed = (wave*977) + 13   // deterministic seed per wave, so regenerating gives identical results
```

Family-by-family recipe (all use `Signal.sineFill(n, amps[, phases])` — additive
synthesis by summing `amps.size` harmonic sine partials with given relative
amplitudes/phases, unless noted):

- **fam 0 — SAW** (191–194): full harmonic series, amplitude `i<dens ?
  (i+1)**tilt.reciprocal : 0` for harmonic index `i` (0-based, so harmonic `i+1`),
  normalized to sum then ×2, `Signal.sineFill`.
- **fam 1 — SQUARE** (195–199): only EVEN `i` (i.e. odd harmonic NUMBERS
  1,3,5.../ODD partials in 1-indexed terms) below `dens`, same `(i+1)**tilt.reciprocal`
  falloff — approximates a square wave's odd-harmonics-only spectrum.
- **fam 2 — PULSE** (200–206): variable duty-cycle pulse wave computed directly in
  the time domain (`duty = 0.5 - (t*(0.34+(vari*0.03)))`, i.e. duty shrinks as t
  grows), `Signal.fill` generates a ±1 square wave at that duty cycle, then
  cross-blended with a plain sine (`b = (1-t)*0.45` blend amount, more sine at low
  t) before final `.normalize`.
- **fam 3 — WAVESHAPE** (208–212): `drive = 1 + (t*(12+(vari*8)))`; a pure sine
  `(2pi*i/n).sin` driven through `.tanh(drive)` (soft clip), i.e. sine
  progressively hard-clips into a near-square as t/vari increase, `.normalize`d.
- **fam 4 — BELL** (213–219): inharmonic bell partials — for `k` in
  `0..(2+vari+(t*9)).round`, place amplitude `(k+1).reciprocal` at harmonic index
  `idx = ((k+1)**(1.38+(vari*0.08)) - 1).round.min(nh-1)` (a power-law stretched
  partial series, non-integer-ratio = inharmonic/bell-like), summed if indices
  collide, then normalized `sineFill`.
- **fam 5 — FORMANT** (221–225): a single spectral bump — Gaussian-shaped
  amplitude envelope `amps[i] = exp(-((i-centre)/w)**2)` where `centre = 1 +
  (t*(nh-8)) + (vari*2)` (bump position slides upward with t) and `w = 2 +
  (vari*2) + (t*6)` (bump widens with t).
- **fam 6 — ORGAN** (226–235): fixed set of harmonic indices
  `[0,1,3,7,15,31]` (octave-doubling drawbar positions), each weighted by
  `amps[idx] = max(0, 1-|((o/5)-t)*1.6|) * (o+1).reciprocal.sqrt` (a triangular
  crossfade window over `t` selects which drawbar dominates as t sweeps 0→1,
  scanning through the 6 "stops"), plus if `vari>1` boost harmonic index 2 by
  `t*0.4`; falls back to `amps[0]=1` if the sum is ever ≤0 (guards silence).
- **fam 7 — NOISY (default/else branch)** (237–244): dense, quasi-random,
  RANDOM-PHASE spectrum — `r[i] = 1.0.rand` (uniform 0-1, but seeded
  deterministically per-wave per §4.2 setup so reproducible), amplitude
  `i<dens ? r[i]*(i+1)**-(1.4-t).max(0.1) : 0`, phases `phs[i] = 2pi.rand`
  (also seeded), fed as the 3rd arg to `sineFill` (phase-randomized additive
  synthesis → noisy/inharmonic texture that gets "less rolled-off"/brighter and
  more phase-random-sounding as t increases).

**Determinism requirement for the JS port**: `thisThread.randSeed = wave*977+13`
must be replicated with an equivalent seeded PRNG in JS (the exact algorithm
SuperCollider's `.rand`/`.rand2` use is a specific LCG — must either reimplement
that LCG exactly bit-for-bit, or accept that fam 4's random components and fam 7
(NOISY family) will differ slightly from the SC version; if visual/sonic parity
matters, the safest path is to **precompute all 32×64 tables once offline in real
SuperCollider and ship them as static JSON/binary data** rather than
reimplementing the RNG — this sidesteps both the RNG-fidelity problem and the
"does the browser even have `VOsc`" problem from §2.2, at the cost of a larger
static asset (32 waves × 64 tables × 512 samples × 4 bytes ≈ 4.2MB raw, likely
compressible).

### 4.3 `~az.loadWave(layer, wave)` — send-to-server logic (lines 257–287)

1. No-op if `layer > 2` (NOISE has no waves) or this layer already has this wave
   loaded (`curWave[layer] == wave`).
2. Compute (or reuse cached) all 64 tables: `waveCache[wave] = Array.fill(64, i =>
   tableFor(wave, i/63).normalize.asWavetable)` — note `.asWavetable` converts the
   512-sample `Signal` into SC's interleaved amp/slope wavetable format (1024
   values) consumed by `VOsc`/`Osc`.
3. Batch-send to server buffers in groups of 8 via `s.sendBundle` (`setnMsg` per
   buffer) — explicitly documented performance rationale: sending all 64
   individually would cost ~40ms/msg round-trip = ~2.5s total (perceptible
   freeze); batching in groups of 8 gets it under 25ms.

**Port implication**: if precomputing tables offline (recommended, per §4.2),
this whole step becomes "upload the wavetable data for the selected wave to
SuperSonic's buffers via as few OSC `/b_setn` (or SuperSonic equivalent) messages
as possible, batched." If SuperSonic doesn't support `VOsc`-style
consecutive-buffer wavetable morphing at all, this data may instead need to
drive a client-side Web Audio `PeriodicWave`/custom `AudioWorklet` oscillator
bank running independently, with the position parameter (`pos`/`posY` — see
§2.2 step 5) computed in JS and used to crossfade between the two nearest
precomputed tables in the worklet (a standard "wavetable synth" implementation
pattern) — this is the fallback if native SuperSonic wavetable support is
unavailable.

---

## 5. NOISE Layer

### 5.1 10 selectable sources

`~az.noiseSrcNames` (309): `["RAIN","WIND","OCEAN","STREAM","FIRE","FOREST",
"THUNDER","NIGHT","LINE IN","WAV FILE"]` — indices 0-7 map to the 8 synthesized
generators (`az_noise0..7`, §2.3), index 8 = LINE IN (live mic/line input,
recorded into `recBuf` then played back via `az_noisebuf2`), index 9 = WAV FILE
(user-loaded file, played back via `az_noisebuf1` or `az_noisebuf2` depending on
channel count).

### 5.2 LINE IN mode

Not fully detailed in visible GUI code beyond the source dropdown and the
`az_rec` SynthDef (§2.5) — recording is presumably triggered elsewhere (search
didn't surface a dedicated "start line-in capture" GUI button distinct from the
top-bar REC button, which records the MASTER OUTPUT to disk, not the input buffer
— these are two different recording features). **Not portable natively**: no
"line in" concept in a browser; closest equivalent is `navigator.mediaDevices.
getUserMedia({audio:true})` capturing the mic, written into a Web Audio buffer,
then that buffer's PCM data pushed into a SuperSonic buffer via OSC (`/b_setn`)
to be played back by `az_noisebuf2`, OR fed directly into a parallel Web Audio
graph if SuperSonic can't accept live-streamed buffer writes.

### 5.3 WAV FILE mode — `~az.loadSample` (lines 1035–1050)

```
loadSample(path, whenDone):
  if File.exists(path):
    Buffer.read(server, path, action: b => {
      free old usrBuf if any
      usrBuf = b
      usrChans = b.numChannels.min(2)   // caps at stereo even if the file has more
      noiseSrc = 9
      layerOff(3)                        // stop any currently playing NOISE voices
      whenDone?.()
    })
  else: log "file not found"
```
GUI trigger: "Load Sample..." button (visible only when NOISE layer selected,
replacing the structure dropdown position) opens `Dialog.openPanel` (native
macOS file picker), or selecting "WAV FILE" in the source dropdown auto-opens the
same picker if nothing is loaded yet (line 1616).

**Browser equivalent**: `<input type="file" accept="audio/*">` (or
drag-and-drop), read via `FileReader`/`decodeAudioData` (Web Audio API) to get
PCM + channel count + sample rate, resample if needed to match SuperSonic's
sample rate, then upload the PCM data into a SuperSonic buffer via OSC
(`/b_allocRead`-equivalent or manual `/b_alloc` + `/b_setn`). No filesystem path
persistence is possible in-browser — patch save/load (§8) storing "the sample was
loaded from `/path/to/file.wav`" cannot be replayed automatically on load; the
JS patch format should instead either (a) store the actual audio data (base64 or
IndexedDB blob) so it truly round-trips, or (b) explicitly note "please re-load
your sample" on patch load if that data isn't embedded, since a native file path
means nothing in a browser sandbox.

---

## 6. FX Chain

(Topology and full slot-type parameter tables already covered in §1.7 and §2.6 —
this section covers the switching/instantiation mechanics.)

### 6.1 `~az.setSlotType(slotIdx, typeIdx)` (lines 1017–1030)

1. Record `slotType[slotIdx] = typeIdx`.
2. Free the existing slot Synth if any.
3. Determine `inBus` = `mixBus` if `slotIdx==0` else `slotBus[slotIdx-1]` (chains
   off the previous slot's output); `outBus = slotBus[slotIdx]`.
4. Instantiate `Synth(slotDefs[typeIdx], [\in, inBus, \out, outBus],
   slotGrp[slotIdx])` — **note**: only `in`/`out` are passed at creation; all
   other params (including `active`) immediately fall back to the SynthDef's own
   hardcoded defaults until the GUI's `refreshSlot` (line 2082) explicitly
   `.set()`s each one from `slotParams[slotIdx]` right after.
5. `slotParams[slotIdx]` is rebuilt as an `IdentityDictionary` seeded from
   `slotSpecs[typeIdx]`'s defaults (bookkeeping so `active`/param values are known
   without an async round-trip to the server for patch-save purposes — the JS
   port doesn't need this workaround since JS state IS the source of truth, not
   a remote server).

Default chain at boot (line 1326): `slotType = [0, 1, 3]` → FX1=REVERB,
FX2=CHORUS, FX3=DELAY.

### 6.2 `active` semantics

`active` is NOT a hard bypass (i.e. it does not disconnect the synth) — it's
baked into the `mix*active` (or bare `active`) term of each effect's final
`XFade2.ar(dry, wet, ((mix*active).clip(0,1)*2)-1)`. Setting `active=0` forces
the crossfade fully to `dry`, functionally equivalent to bypass but the wet
processing chain (delays, reverb tanks, etc.) KEEPS RUNNING in the background
(still consuming CPU) — this matters for e.g. a delay's feedback tail: bypassing
mid-decay does NOT freeze/silence the tail instantly in the way a true
audio-graph bypass would, since the DSP graph is unconditional and only the
final blend changes. **Port note**: if reimplementing in Web Audio (not pure
SuperSonic OSC), preserve this exact "always-processing, blend at the end"
behavior rather than a hard disconnect, or the tails will behave audibly
differently in edge cases (a delay bypassed and re-enabled will not have kept
building up its feedback tail in a true-bypass implementation).

---

## 7. Sequencer

### 7.1 Data model

`~az.seqDivs = [0.25, 0.5, 1, 1.5, 2, 3, 4, 6, 8]` (line 1167) — these are
**beat-divisor multipliers relative to the TempoClock's beat**, indexed by the
`div` dropdown; `~az.seqDivNames = ["1/1","1/2","1/4","1/4.","1/8","1/8t","1/16",
"1/16t","1/32"]` (display strings — index 6 "1/16" = div value 4 = the DEFAULT).
One step's duration in beats = `1 / seqDivs[div]`.

`~az.newStep()` (1174): `{ on: false, notes: [60], vel: 0.8, len: 0.9, locks: {} }`
- `on` (bool) — step active/inactive.
- `notes` (array of MIDI note numbers) — **always an array**, even for a single
  note, to uniformly support chords; legacy patches used a scalar `note:` key,
  migrated on load (§8.3).
- `vel` (0-1) — velocity for all notes in this step.
- `len` (float, step-units — 1.0 = fills exactly one step's duration; can exceed
  1.0 up to 8.0 for tied/overlapping notes, or be less for staccato) — gate
  length as a MULTIPLE of the step's beat duration, not an absolute time.
- `locks` (dict, `specId → value`) — parameter-lock overrides for this step only
  (§7.3).

`~az.seqTrack(i)` (1178): `{ steps: Array(64) of newStep(), length: 16, div: 7,
pos: 0, stepTime: 0, mute: false }` — one per layer (`~az.seq = Array.fill(4,
seqTrack)`), i.e. 4 INDEPENDENT tracks (one per DRONE/PAD/ATMOS/NOISE), each
with its OWN length (1-64 active steps out of the 64 always-allocated), its own
clock division, and independently playing/looping. `pos` = 0-based index of the
currently-sounding step (updated live during playback, used for GUI/Launchpad
playhead + p-lock display).

Default `div=7` maps to `seqDivNames[7] = "1/16t"` — wait, cross-check: divPop's
GUI default is `.value_(6)` (line 1736) = "1/16" (index 6), but `seqTrack`'s
struct literal default is `div: 7` (index 7 = "1/16t"). **This is a real
discrepancy in the source**: a freshly-created track (before any GUI touches it)
defaults to div=7 (1/16 triplet), but the sequencer panel's div dropdown widget
itself initializes to display index 6 (1/16 straight) — since `refreshSeq` (1811)
sets `divPop.value_(t.div)` on layer-tab switch, the displayed value will actually
correct itself to show 7 once a layer is selected, so in practice the widget
follows the data (7), the `.value_(6)` (6) is simply a redundant/dead initializer
overwritten before the user could observe it. **Port recommendation**: default
`div = 7` (1/16t) for new tracks, to match actual runtime behavior, not the
momentarily-set 6.

### 7.2 Clock / tempo (README-documented bugfix, lines 1203–1225, 1182)

**Critical historical bug** (README lines 291-299): the original sequencer step
loop ran in a bare `fork {}`, which defaults to `SystemClock` (1 unit = 1 real
second, tempo-independent) — so tempo changes affected note-off timing (which was
separately, manually tempo-corrected) but NEVER affected step advancement. Fixed
by moving both onto `TempoClock.default`, where `.wait` genuinely interprets time
in beats. Verified: 240bpm gives exactly 4× the step rate of 60bpm.

**Current (correct) implementation**:
- `~az.trackLoop(track)` (1203–1220): a `Routine` on `TempoClock.default`:
  ```
  t.pos = -1
  loop:
    wait(1 / seqDivs[t.div])          // beats, tempo-relative
    t.pos = (t.pos + 1) % t.length
    t.stepTime = Main.elapsedTime      // wall-clock timestamp of this step's start, for REC-timing math
    trigStep(track, t.pos)
    refresh GUI/pad step highlight
  ```
- `~az.trigStep(track, idx)` (1188–1200): if the step is `on` and the track isn't
  muted, fires `noteOn` for every note in `steps[idx].notes` (passing
  `steps[idx].locks` as p-lock overrides), then a separate `Routine` waits
  `beats = (1/seqDivs[t.div]) * st.len` beats and fires `noteOff` for each note —
  i.e. **gate length is computed independently of the main loop's step-advance
  timer**, allowing `len` > 1 step-unit to let a note ring into subsequent steps
  (overlapping/tied notes) without blocking step advancement.
- `~az.startSeq()` / `~az.stopSeq()` (1222–1241): starts/stops all 4 tracks'
  independent Routines simultaneously; stop also force-releases all layer voices
  (`layerOff` for all 4 layers) AND clears any Launchpad-latched notes (so no LED
  is left glowing for a note that's actually silent).
- `~az.stepDur(track)` (1182): `(1/seqDivs[t.div]) / TempoClock.default.tempo` —
  converts one step's beat-duration into **wall-clock seconds**, used only by the
  real-time-recording nearest-step math (§7.4), not by the main playback loop
  itself (which stays in beat-space via `TempoClock.wait`).

**Port note**: in JS there is no direct equivalent of `TempoClock` — you'll need
your own scheduler. The critical property to preserve is that step advancement
timing is calculated **in beats, converted to wall-clock ms only at the point of
scheduling** (`msPerBeat = 60000/bpm`; step interval = `msPerBeat / seqDivs[div]`),
recalculated live if tempo changes mid-playback (so a tempo change takes effect
immediately, not just for the next Routine iteration — SC's `TempoClock.tempo =`
retroactively reinterprets pending `.wait`s already, so a literal JS `setTimeout`
per step must be either re-computed/rescheduled on every tempo change, or use a
lookahead/Web-Audio-clock-based scheduler (the standard "robust JS audio
sequencer" pattern — sample-accurate scheduling against `AudioContext.currentTime`
with a lookahead loop) rather than naive `setInterval`.

### 7.3 Parameter-lock (p-lock) system

**Storage**: `steps[i].locks` is a dict from spec `id` (matches `~az.specById`
keys, e.g. `\cutoff`, `\harmonic`) → raw parameter value (already in real units,
not normalized 0-1). Any subset of the 25 specs can be locked per step
independently; NOT limited to pitch (README explicitly separates "note number"
from "p-lock", i.e. note/pitch is its own `notes` field, and p-locks cover the
OTHER 24 continuous params — technically a pitch-related lock isn't directly
supported through this system since pitch is set via `notes`, though the generic
`pitch` (transpose in cents) spec CAN still be locked since it's a distinct spec
from `notes`/note-number).

**Application** (line 968-996, esp. 980-988): when `noteOn(layer, note, vel,
locks)` fires from the sequencer (`trigStep` passes `st.locks`), the synth args
are built as: `[out, revB, hz, vel, gate=1]` + full spread of `~az.lp[layer]`
(the layer's LIVE/GUI-set values) + **then** the lock overrides are appended,
overwriting any layer-default values for the SAME arg name (later key in an SC
`Synth.new` arg list wins) — done by iterating `locks.keysValuesDo` and looking
up `specById[paramId][1]` (the arg name) for each. **This is non-destructive**:
`~az.lp[layer]` itself is never touched; the override exists only for that one
`Synth.new` call's argument list, so other simultaneously-sounding notes on the
same layer (e.g. from a chord, or from manual play) are unaffected.

**GUI editing paths** (two, both write to the same `steps[i].locks` dict):
1. **PARAM LOCK panel** (§9, lines 1832-1889): dropdown selects which spec,
   slider sets value, SET LOCK button writes `steps[selectedStep].locks[spec.id]
   = computedValue`, CLR LOCK removes that key.
2. **REC-armed live knob-move** (§9, lines 1651-1657): if `recArm` is true and a
   step is selected, moving ANY layer parameter slider immediately writes
   `steps[selectedStep].locks[spec.id] = v` as a side effect of the slider's
   normal action (in addition to updating the live `~az.lp[layerSel]` value) —
   this is the "REC" fast-path described in the README, letting you sculpt a
   step's sound by ear while it plays.

**Port requirement**: locks must be applied as OSC `/s_new` argument overrides
computed at note-trigger time (not stored as separate automation), exactly
mirroring the "spread defaults then override with locks" merge order.

### 7.4 Real-time recording from the Launchpad KEYS mode

(Detailed further in §10; data-model-relevant parts here.) `~az.uiRefs.recordNote`
(2014-2043) has two distinct behaviors:
- **Sequencer stopped**: writes to `selectedStep` (or step 0 if none selected),
  then auto-advances `selectedStep` to the next step UNLESS this note is
  "joining" an already-open chord on the current step (tracked via
  `~az.padHeld`/`~az.padLatched` entries whose `.step` matches).
- **Sequencer running**: computes `frac = (elapsedTime - t.stepTime) /
  stepDur(track)`, clipped 0-1; if `frac > 0.5` targets `(t.pos+1) % t.length`
  (the UPCOMING step) else targets `t.pos` (the currently-sounding step) — i.e.
  a keypress played slightly late snaps forward to the next step rather than
  landing behind where you meant it, a standard MPC-style nearest-step
  quantization.
- Chord detection: if another currently-held/latched note already wrote to the
  same target step (`joining`), the new note is appended to `notes` (dedup'd);
  otherwise the step's prior content is REPLACED (not layered).
- On key-release, `~az.uiRefs.recordLength(layer, step, secs)` converts the
  held-duration (wall-clock seconds) into step-length units via `stepDur`,
  clipped to [0.1, 8.0].

---

## 8. Patch Save/Load

### 8.1 Storage location & format

sclang: `~/ambient_zero_sc_patches/<name>.azpatch`, written via
`Object:writeArchive` (sclang's built-in binary object serializer — NOT
human-readable, NOT JSON). Directory auto-created if missing
(`~az.ensurePatchDir`). **Browser equivalent**: `localStorage` keyed patches
(e.g. key `azpatch:<name>` holding a JSON string), or IndexedDB if patch data
grows large (embedding sample audio, per §5.3's recommendation, would push this
toward IndexedDB). `~az.listPatches` (1064-1070) scans the directory for
`.azpatch` files and returns sorted basenames — JS equivalent: enumerate
`localStorage` keys matching the patch-key prefix, or an IndexedDB index.

### 8.2 Exact serialized shape — `~az.serializePatch()` (lines 1072–1093)

```js
{
  layerStruct: [int, int, int, int],      // ~az.structure.copy — structure index per layer (0-5 for DRONE/PAD/ATMOS; value for NOISE index 3 is present but semantically unused since NOISE has no "structure")
  layerWave:   [int, int, int],           // ~az.curWave.copy — wave index (0-31) per TONAL layer only (3 entries: DRONE/PAD/ATMOS)
  noiseSrc:    int,                        // 0-9, NOISE layer's active source
  lp: [ {..25 spec keys + ftype/modShape/l1dest/l2dest..} x4 ],  // one dict per layer, full live-parameter snapshot
  slotType:   [int, int, int],             // FX1/FX2/FX3 type index (0-9 each)
  slotParams: [ {..type's params + active..} x3 ],  // one dict per FX slot, keyed by that slot's CURRENT type's param names
  revShimParams: { active, size, decay, damp, shimmer, mix },
  masterParams:  { active, threshold, ratio, attack, release, makeup, ceiling },
  tempo: float,                            // TempoClock.default.tempo (beats/SECOND, i.e. bpm/60 — NOT the raw bpm number shown in the GUI)
  maxVoices: int,                          // polyphony cap (1-16)
  keyRoot: int,                            // 0-11, Launchpad KEYS mode root note
  keyScale: int,                           // 0-9, Launchpad KEYS mode scale index
  keyBase: int,                            // ~az.padKeyBase, MIDI note of the bottom-left KEYS pad
  seq: [                                   // one entry per layer/track
    {
      steps: [ {on: bool, notes: [int,...], vel: float, len: float, locks: {specId: value, ...}} x64 ],
      length: int,   // 1-64, active step count
      div: int       // 0-8 index into seqDivs
    } x4
  ]
}
```

**Important unit note**: `tempo` is stored as SC's internal `TempoClock.tempo`
(beats per SECOND), while the GUI NumberBox displays/edits **BPM** (beats per
minute) via `tempo = bpm/60` (line 1473) and reads back via `bpm =
(tempo*60).round(1)` (line 2218). **The JS patch schema should decide explicitly
which unit to store** — recommend storing BPM directly (more human-readable/
portable) and converting at the scheduler boundary, rather than replicating SC's
internal beats/sec convention.

### 8.3 Load logic & legacy migration — `~az.loadPatch(name)` (lines 1107–1164)

Load order matters (some steps are deliberately deferred to a `Task` on
`AppClock` to avoid blocking the GUI thread on the wavetable-buffer resend, lines
1122-1125):
1. Copy `lp[i]` for all 4 layers directly from the archive.
2. Set `structure[i]` for layers 0-2, and force `curWave[i] = -1` (invalidate) so
   the subsequent `loadWave` call is guaranteed to actually re-send buffers even
   if the value coincidentally matches what's already loaded (defends against a
   stale/incorrect assumption that "same wave index = already correct").
3. Set `noiseSrc`.
4. **Deferred task**: for each tonal layer, call `loadWave(i, layerWave[i])` then
   `layerGrp[i].set(bank, bankBase[i])`, waiting 0.02s between each (avoid
   flooding the OSC pipe with 3 simultaneous 64-buffer batch-sends); then, after
   all 3 waves are loaded, apply every key in the restored `lp[i]` dict to the
   live synth group via `.set` (ensures the actual DSP catches up to match the
   restored data, not just the bookkeeping dict).
5. For each FX slot: `setSlotType(i, data.slotType[i])` (rebuilds the Synth for
   that type), THEN immediately overwrite `slotParams[i]` with the archive's
   values (overriding the type-default bookkeeping `setSlotType` just seeded) and
   `.set()` each onto the live synth.
6. Apply `revShimParams`/`masterParams` directly (dicts + `.set()` onto the
   already-existing, never-recreated fixed synths).
7. `TempoClock.default.tempo = data.tempo`; `maxVoices = data.maxVoices`.
8. **Legacy-safe** key-lookup for KEYS settings: `keyRoot = data.keyRoot ?
   ~az.keyRoot` (keeps current value if the archive predates this feature) — same
   pattern for `keyScale`/`padKeyBase`. **Port note**: any JS patch loader must
   apply the same "missing key → keep current default" fallback logic for
   forward-compatibility as the schema evolves.
9. Per-track step restore, with **legacy single-note migration**: `notes:
   (s.notes ?? { [s.note ? 60] }).copy` — if an old patch stored a scalar `note:`
   key (pre-chord-support format) instead of an array `notes:` key, wrap it into
   a 1-element array on load; if even `note` is missing, default to 60 (middle
   C). **The JS schema should just always use the `notes` array format going
   forward** — this migration note exists only so a human porting old `.azpatch`
   files understands the legacy shape they might need to convert.
10. Set `currentPatchName = name`; trigger a full GUI refresh
    (`uiRefs.refreshAfterLoad`) if present.

### 8.4 Save behavior

`~az.savePatch(name)` (1098-1105): **always overwrites without confirmation** if
a patch with that name already exists (`writeArchive` has no "file exists" check)
— this is explicitly a deliberate design choice per the README ("Ha ugyanazt a
nevet használod, automatikusan felülír" / "same name = automatic overwrite, no
confirmation"). Port this behavior as-is (no "are you sure?" dialog) unless the
user requests otherwise.

GUI SAVE vs SAVE AS distinction (README lines 213-227, code lines 1522-1538):
- **SAVE**: uses `currentPatchName` if a patch is currently loaded, else falls
  back to whatever's typed in the name field.
- **SAVE AS**: ALWAYS uses the name-field text, even if a different patch is
  currently loaded — lets you save a variant under a new name without
  overwriting the original you started from.

---

## 9. GUI Structure

Built by `~az.buildGUI` (lines 1428–2238), a single ~1010×910px Qt `Window`.
Below: every widget, its screen region (informational — Web layout need not match
pixel-for-pixel, but the same GROUPING/adjacency is worth preserving for
usability parity), bound parameter, and behavior.

### 9.1 Top transport bar (y≈10-50)

| Widget | Type | Bound to | Behavior |
|---|---|---|---|
| "ambient_zero" label | static text | — | title |
| PLAY/STOP | 2-state button | `~az.playing` via `startSeq`/`stopSeq` | toggles all 4 track loops; also triggers Launchpad blink-state refresh |
| tempo | NumberBox | `TempoClock.default.tempo` (stored ÷60) | range 20-400 BPM, step 1; action fires on every change (Enter/arrow/scroll/drag) — chosen deliberately over TextField because TextField only commits on Enter (this was the original "tempo doesn't do anything" bug) |
| vol | Slider (0-1) | `masterSynth.set(\amp, ...)` | `linlin(0,1, 0,2)` — i.e. slider 0.5 = amp 1.0 (unity), slider 1.0 = amp 2.0 (+6dB headroom above unity) |
| REC (● REC when active) | 2-state button | `s.isRecording` (polled, not a separate flag) | starts/stops MASTER-OUTPUT-to-disk .wav recording (`~az.startRec`/`stopRec`); label shows current recording's filename; polled every 0.5s via AppClock so external `s.stopRecording` calls also reflect in the UI |
| poly | NumberBox | `~az.maxVoices` | range 1-16 |
| patch (dropdown) | PopUpMenu | list of saved patch names | populated by `listPatches` |
| LOAD | button | — | loads dropdown-selected patch, updates name field |
| name field | TextField | — | patch name to save under, defaults "untitled" |
| SAVE | button | — | see §8.4 |
| SAVE AS | button | — | see §8.4 |
| QUIT | button | — | `~az.quit` — stop everything, close server |

### 9.2 Layer tabs (y≈42-66)

4 buttons (`DRONE`/`PAD`/`ATMOS`/`NOISE`), radio-style (mutually exclusive
`.value_` sync in the action handler, lines 1695-1703), selects `layerSel` and
triggers `refreshParams`/`refreshSeq`. Right-aligned above: 4 mute buttons
(`M1`-`M4`, one per layer, independent toggles — NOT tied to tab selection),
red when active; muting force-releases that layer's voices and un-latches any
Launchpad-latched notes on it.

### 9.3 Per-layer parameter panel (y≈76-450, left ~500px)

- **Struct label** — shows `"<LAYER> -- <structure name or 'NOISE'>"`.
- **Structure dropdown** (`structPop`, tonal layers only, hidden for NOISE) —
  6 items (`~az.structures`), switching forces `layerOff` (stop current voices)
  then refresh.
- **Load Sample... button** (NOISE only, same screen position as structPop,
  visibility-toggled) — opens native file picker (§5.3).
- **Wave/Source dropdown** (`wavePop`) — repurposed per layer type: shows the 32
  `waveNames` for tonal layers (calls `loadWave` + rebinds `bank`), or the 10
  `noiseSrcNames` for NOISE (sets `noiseSrc`, stops voices, auto-opens file
  picker if "WAV FILE" chosen with nothing loaded).
- **filter dropdown** (`filterPop`, 3 items `~az.filterNames`) — sets
  `lp[layerSel][\ftype]` + live `.set`.
- **mod shape dropdown** (`mod1Pop`, 10 items `~az.modShapes`) — sets
  `lp[layerSel][\modShape]`.
- **lfo1 dest / lfo2 dest dropdowns** (`l1destPop`/`l2destPop`, 6 items
  `~az.lfoDests` each) — set `lp[layerSel][\l1dest]`/`[\l2dest]`.
- **25 parameter sliders** — one row per `~az.specs` entry, laid out 2 columns ×
  13 rows (`col = i.div(13), row = i%13`), each row = label + `Slider` (0-1
  internal range, mapped through warp/linear formula per spec, §3) + numeric
  readout (`value.round(0.01) + unit`). Slider action: computes real value from
  normalized position, writes to `lp[layerSel][key]`, live `.set`s the layer
  group, updates the readout text, AND (if REC-armed + a step selected) also
  writes a p-lock for that step (§7.3), else (if Launchpad is in PARAM mode)
  triggers a pad LED refresh. **Same widget set is shared/re-pointed across all 4
  layer tabs** (not 4 separate slider sets) — switching tabs just changes which
  layer's `lp` dict the sliders read/write (`refreshParams` re-syncs slider
  positions from the newly-selected layer's stored values).

### 9.4 Sequencer panel (y≈76-460, right side, x≈560-1000)

- **"SEQUENCER" label**.
- **keys / root dropdown / scale dropdown / oct NumberBox** — Launchpad KEYS-mode
  musical key settings (root 0-11 `~az.rootNames`, scale 0-9 `~az.scaleNames`,
  octave -1..7 mapping to `padKeyBase = (oct+1)*12`). Screen-only has no
  keyboard widget itself (the physical Launchpad IS the keyboard) — these
  controls exist purely because the Launchpad has no display of its own.
- **note dropdown** (`notePop`, 61 items `~az.noteNames`, C0-C5) — when a step is
  selected, editing this immediately retunes that step's FIRST note (chord notes
  beyond the first are untouched — DEL STEP + re-enter needed to fully replace a
  chord).
- **len NumberBox** (1-64) — sets the CURRENT track's active step count
  (`~az.seq[layerSel].length`).
- **REC button** (2-state, red when armed) — toggles `recArm`, gates whether
  slider moves / Launchpad key input write into the sequencer (§7.3/§7.4).
- **div dropdown** (9 items `~az.seqDivNames`) — sets `~az.seq[layerSel].div`.
- **RND button** — randomizes the current track: each step (up to `length`) gets
  a 30% chance to be `on` (`0.3.coin`), note = `notePop.value+12` plus a random
  offset from `[0,3,5,7,10]` (minor-pentatonic-ish scale-degree jump in
  semitones) — NOT constrained by the Launchpad's active key/scale settings,
  just this fixed interval set.
- **DEL STEP button** — clears only `selectedStep`'s `on` flag (step content
  otherwise untouched).
- **CLR TRACK button** — wipes ALL steps (fresh `newStep()` for every index) on
  the current track, including all locks; deliberately visually distinct
  (full-width red label) from DEL STEP per a documented historical UX bug where
  the two were easily confused.
- **8×8 step grid** (`seqButtons`, 20×20px buttons, 4-state visual: off / on /
  on+selected / playhead — see color table in §10 for the Launchpad-equivalent
  palette, screen version uses Qt `Color` literals at lines 1775-1779) — click
  behavior: empty step → turns on using current `notePop` value AND selects it
  for editing; already-on step → does NOT toggle off, just selects it for
  editing (updates `notePop` to show its pitch). Only ONE step can be "selected"
  at a time (grid enforces exclusivity by resetting any other step's visual
  state from 2→1 on new selection). Steps beyond the track's current `length`
  are disabled (greyed, non-clickable).
- **chord text readout** — shows the full note list + velocity + length of the
  selected step (since `notePop` only shows the first note of a chord).

### 9.5 Parameter lock panel (y≈346-460, below the grid)

"PARAM LOCK" label, then: spec-name dropdown (`lockParamPop`, all 25 specs by
display name), value slider (`lockValueSlider`, warp/linear per selected spec),
numeric readout, **SET LOCK** button (writes `steps[selectedStep].locks[id] =
computedValue`), **CLR LOCK** button (removes that key), and a status line
listing all currently-locked param names on the selected step
(`"locks: cutoff, harmonic"` style, or `"no locks on this step"` /
`"(select a step)"`).

### 9.6 FX chain panel (y≈536-730)

"FX CHAIN" label, then 3 identical boxes side-by-side (`mkSlotBox`, x=16/280/544,
titled FX1/FX2/FX3):
- Type dropdown (10 items `~az.slotTypeNames`) — switching calls `setSlotType`
  then rebuilds the slider rows.
- ON/BYP button (2-state) — toggles `active` (0/1) on the slot's synth.
- 7 slider rows (labels + values), only as many VISIBLE as the current type's
  param count (5, 6, or 7 — COMP/LIM is the only 7-param type, due to `makeup`);
  unused rows hidden. Each slider: warp/linear per that type's spec row, `.set`s
  the live synth AND updates `slotParams[slotIdx]` bookkeeping, refreshes
  Launchpad if it's currently showing this FX's columns.

### 9.7 Fixed effect boxes (y≈732+, bottom row)

Two boxes built by the shared `mkFixedBox` helper (no type dropdown, just
ON/BYP + N sliders, wired straight to a persistent synth — not recreated on
type-switch since there's no type to switch):
- **"REVERB + SHIMMER"** (x=16) — 5 sliders (size, decay, damp, shimmer, mix)
  bound to `~az.revShimSynth`/`~az.revShimParams`; this is the 4th Launchpad
  FX-focus target (`fxIdx=3`).
- **"MASTER (comp+lim)"** (x=544) — 6 sliders (threshold, ratio, attack, release,
  makeup, ceiling) bound to `~az.masterSynth`/`~az.masterParams`; NOT a
  Launchpad FX target (`fxIdx` omitted) — the Launchpad's 4 FX-select slots only
  cover FX1/FX2/FX3/REVERB+SHIMMER, master is GUI-only.

### 9.8 Master meter (y≈732, bottom-right corner, beside MASTER box)

Static text, updated via `OSCFunc` listening for `/az_master_meter` replies
(§2.8): displays input level, gain-reduction, output level, all in dB, refreshed
~8×/sec. **Port**: either relay SuperSonic's `SendReply` OSC message to JS (if
the SuperSonic host bridges OSC replies to JS callbacks) or compute equivalent
metering client-side via a Web Audio `AnalyserNode`/`ScriptProcessorNode` tapped
on the final output.

---

## 10. Launchpad Pro MIDI Mapping

Full section: lines 2242–3347. Device: Launchpad Pro (any generation — code
explicitly detects "launchpad" in the device name, doesn't hardcode a specific
generation). Protocol: raw MIDI + Novation SysEx (NOT the monome/grid `serialosc`
protocol) — requires switching the device into **Programmer Mode** via SysEx on
connect, and switching it back to factory Note-mode SysEx on disconnect/quit
(so other software finds it in its expected default state afterward).

### 10.1 Physical layout / addressing (lines 2250-2265)

Programmer-mode button numbering is base-10-per-row:
```
        91 92 93 94 95 96 97 98        <- top row (round buttons, CC messages)
     80 [81 82 83 84 85 86 87 88] 89   <- 8x8 grid (note messages) + right column (round, CC-adjacent but actually note-numbered like the grid — see below)
     70 [71 .. .. .. .. .. .. 78] 79
     ..                            ..
     10 [11 12 13 14 15 16 17 18] 19
         1  2  3  4  5  6  7  8
```
- **8×8 grid**: note numbers 11-88 where tens-digit = row (1=bottom .. 8=top),
  ones-digit = column (1=left..8=right) — i.e. `num = 10*(rowFrom1) +
  colFrom1`. Code converts to 0-based `(row0, col0)` via: `col = (num%10)-1`;
  `row = 7 - (num.div(10)-1)` (so row0=0 is the TOP row, row0=7 is the BOTTOM
  row — inverted from the device's bottom-up row numbering).
- **Right column** (the physical column of round "scene launch" buttons,
  addressed as `num=19,29,...,89`, sent as regular note-on/off, not CC) — 8
  buttons, `row = 7-(num.div(10)-1)` same convention.
- **Left column** (round buttons `num=10,20,...,80`, ALSO note-numbered like the
  grid/right-column despite being physically separate — same `row0` formula) —
  8 buttons, top-to-bottom: SHIFT(80,row0=0), then rows 1-4 = param pages,
  row0=5/6 = octave up/down, row0=7 = RECORD.
- **Top row** (round buttons `91`-`98`, sent as **CC messages**, not note) —
  8 buttons, device's own printed labels: UP(91) DOWN(92) LEFT(93) RIGHT(94)
  SESSION(95) NOTE(96) DEVICE(97) USER(98).
- **Bottom row** (segments `1`-`8`, likely also note-numbered like a row-0
  extension, used purely as an 8-segment position/progress bar — not
  interactive, LED-output only).
- **SHIFT** = CC 80 specifically (the topmost LEFT-column round button; the code
  treats CC 80 specially in the CC dispatcher, separate from the other 7
  left-column CCs which ARE note-numbered, so SHIFT is the ONE left-column
  button that's actually CC not note — worth double-checking against a real
  device, since the doc-comment block (2262-2265) also lists SHIFT under "left
  column" CC numbering consistent with `padCCIn`'s special-case for `num==80`).

**Port note**: this exact addressing scheme is Launchpad-Pro-specific
(Novation's programmer-mode protocol). A Web MIDI port to browser JS needs to
replicate: (a) the SysEx handshake to enter programmer mode (§10.6), (b) this
exact note/CC number→(row,col) decode, (c) SysEx-based individual/batch RGB LED
setting (§10.5).

### 10.2 Top-level mode state (lines 2355-2396)

| State var | Values | Meaning |
|---|---|---|
| `padMode` | 0=STEP, 1=PARAM, 2=KEYS | which content the 8×8 grid shows (only meaningful when `padFocus==\eng`) |
| `padFocus` | `\eng` or `\fx` | whether the right-column/grid currently targets an ENGINE (layer) or an FX slot |
| `padFx` | 0-3 | which FX target: 0/1/2=FX1/FX2/FX3, 3=REVERB+SHIMMER |
| `padPage` | 0-3 | which page of 8 params (of the 25) is shown in PARAM mode |
| `padShift` | bool | raw SHIFT held state |
| `padShiftGrace` | timestamp | grace period after SHIFT release during which combos still register (handles velocity-sensitive round buttons whose CC value can transiently dip to 0 mid-press) |
| `padLatchMode[0..3]` | bool per layer | LATCH mode toggle, independent per engine/layer |
| `padScaleEdit` | bool | whether the root/scale editor overlay is showing instead of the KEYS keyboard |
| `padHeld` | dict, grid-index→note-info | momentarily (finger-held) pressed keys, for KEYS mode note-off + chord/length tracking |
| `padLatched` | list of note-info | latch-held notes, tracked by **(layer, pitch)** not grid position, so they survive layout changes |
| `padBlinkOn` | bool | current phase of the PLAY-button tempo-synced blink |
| `padCCState` | dict, ccNum→{val,t} | debounce state per CC button |
| `padCCDebounce` | 0.12s | minimum gap between two accepted presses of the same CC button |
| `padShiftGraceTime` | 0.25s | grace window length |

### 10.3 Full button mapping table

| Device label | Number | Type | No-SHIFT function | SHIFT function |
|---|---|---|---|---|
| 8×8 grid | 11-88 | note | context-dependent: STEP mode=toggle/select step; PARAM mode=set column's param to row-derived 0-7/7 value; KEYS mode=play scale-locked note (or, if scale-editor open, pick root/scale); FX-focus=set that FX param column | (no distinct SHIFT behavior noted for grid itself; SHIFT+grid-key in KEYS mode = latch that single note, see below) |
| Right col, rows 0-3 (top 4) | 19,29,39,49 | note | select engine (layer 0-3), releases momentary-held keys first | toggle mute on that engine |
| Right col, rows 4-7 (bottom 4) | 59,69,79,89 | note | select FX focus (FX1/FX2/FX3/REVSHIM = row-4) | toggle bypass on that FX |
| Left col row0=0 | 80 | CC | SHIFT (hold modifier) | — |
| Left col row0=1-4 | 70,60,50,40 | CC | select PARAM mode, page = row0-1 (pages 0-3) | (same — no separate SHIFT function noted) |
| Left col row0=5 | 30 | CC | octave up (+12, clamped ≤96), KEYS mode only | (same) |
| Left col row0=6 | 20 | CC | octave down (-12, clamped ≥0), KEYS mode only | (same) |
| Left col row0=7 (device label: RECORD) | 10 | CC | toggle REC-arm | (same) |
| 91 UP | 91 | CC | track length +1 | track length +8 |
| 92 DOWN | 92 | CC | track length -1 | track length -8 |
| 93 LEFT | 93 | CC | DEL STEP (selected step only) | CLR TRACK (entire track) |
| 94 RIGHT | 94 | CC | PLAY/STOP toggle | (same — no distinct SHIFT function) |
| 95 SESSION | 95 | CC | switch to STEP page (grid=sequencer) | RND (randomize track) |
| 96 NOTE | 96 | CC | switch to KEYS page (scale-locked keyboard) | toggle scale-editor overlay (root+scale picker) |
| 97 DEVICE | 97 | CC | switch to PARAM page | (same — no distinct SHIFT function) |
| 98 USER | 98 | CC | toggle LATCH mode on the CURRENTLY SELECTED engine | disable LATCH everywhere + release ALL held/latched notes (panic/all-notes-off) |
| any grid key, KEYS mode | 11-88 | note | play note (momentary, or step-record per REC-arm state) | latch that ONE note (single-note latch, independent of LATCH-mode toggle) |
| bottom row | 1-8 | (LED only) | — (not a button; position/progress indicator, 8 segments) | — |

Cross-check against README table (README.md lines 253-266): **consistent** —
README's table names match the code's CC/behavior exactly (95 SESSION=STEP/SHIFT
RND, 96 NOTE=keys/SHIFT scale-editor, 94 RIGHT=PLAY-STOP blink green/red,
91/92=length ±1/SHIFT ±8, 93 LEFT=DEL STEP/SHIFT CLR TRACK, 97 DEVICE=PARAM,
98 USER=LATCH toggle/SHIFT all-off, 10 RECORD=rec-arm red/dim, 80 SHIFT=modifier,
right column top4=engine-select/mute, bottom4=fx-select/bypass, grid+SHIFT=latch
single key). No corrections needed to the README's table; the code comment block
(2242-2354) is itself effectively an expanded, synchronized version of the same
table, confirmed line-by-line against the actual `padPress`/`padCCIn` dispatcher
logic (lines 2919-3089).

### 10.4 8×8 grid content by mode (detailed, lines 2574-2656)

- **ENGINE + STEP** (default): each of 64 cells = one sequencer step of the
  selected layer's track, colored: off=dim grey (`cDim`), on=blue (`cStepOn`),
  on+has-p-locks=amber (`cStepLock`), on+multi-note(chord)=green (`cStepChord`),
  selected=bright yellow (`cStepSel`), currently-playing(playhead)=white
  (`cPlayhead`) — **precedence order matters**: playhead beats selected beats
  locked/chord beats plain-on beats off, i.e. if the playhead lands on the
  selected step it shows white not yellow.
- **ENGINE + KEYS + scale-editor open**: rows 0-1 = 12 chromatic root buttons (C
  at col0/row0 up to B), lit bright if it's the current `keyRoot` else dim; rows
  3-4 = 10 scale-name buttons (`scaleNames`), lit `cModeOn` if current
  `keyScale` else `cModeOff`; row 2 and rows 5-7 unused/off.
- **ENGINE + KEYS (no scale editor)**: scale-locked keyboard — `col` = scale
  degree within the row, `row` = octave (row0=7 is LOWEST, row0=0 is HIGHEST —
  bottom-up like a real keyboard), computed via `padKeyDegree(col,row) = ((7-row)
  * scaleSize) + col` and `padKeyPitch = padKeyBase + keyRoot + (degree.div(scaleSize)
  * 12) + scaleIntervals[degree % scaleSize]`. Root-of-scale cells lit at full
  engine color, other scale degrees dimmed (÷5) same hue; a momentarily-held key
  shows white (`cTip`); a latched key shows amber (`cKeyLatch`) — checked via
  `padFindLatched(layer, pitch)` so it's independent of which grid CELL you're
  looking at (a latched note stays lit correctly even after octave/scale/layer
  changes move it to a different cell or off-grid entirely, in which case it
  simply doesn't show since `pitch>127` cells are always off).
- **ENGINE + PARAM**: 8 columns = params `page*8 .. page*8+7` (of the 25 specs,
  4 pages of ≤8 each: page0=specs 0-7, page1=8-15, page2=16-23, page3=24 only
  [25th spec, "glide" or "noisemix" whichever is last — verify against §3's
  ordered table: index 24 = `noisemix`]). Each column is a vertical bar-graph:
  bottom cell=0%, filling upward, TOP-most lit cell in a distinct "tip" color
  (`cTip`), filled-below cells in `cFill`, empty-above cells dim (`cDim`).
  Pressing a cell in this mode sets that param's normalized value to
  `(7-row)/7` (i.e. discrete 8-step resolution, NOT continuous — this is the
  Launchpad's inherent resolution limit vs the GUI's continuous slider).
- **FX focus** (any of the 4 FX targets): same column-bar-graph presentation as
  PARAM mode, but sourced from that FX slot/fixed-box's current param list
  (5-7 columns depending on type) and filled in cyan (`cFxFill`) instead of the
  generic PARAM fill color.

### 10.5 LED color palette — `~az.padC` (lines 2400–2440)

All colors as `[R,G,B]` in **0-63 range** (Launchpad Pro RGB LEDs are 6-bit per
channel, NOT 0-255 — a critical detail for exact color reproduction; the JS
port's Web MIDI SysEx sender must clip/scale to 0-63, not 0-255, when talking to
the real device, though an on-screen "virtual Launchpad" UI mockup could use
0-255 freely and just divide by 63/255 for the real-device path).

| Key | RGB (0-63) | Used for |
|---|---|---|
| cOff | [0,0,0] | LED off |
| cDim | [1,1,1] | barely-lit "inactive but present" |
| cStepOn | [0,28,50] | step on (blue) |
| cStepLock | [45,34,0] | step on + has p-lock(s) (amber) |
| cStepSel | [63,55,0] | selected step (bright yellow) |
| cStepChord | [0,50,32] | step on + multi-note chord (green) |
| cKeyRoot | [63,63,63] | (brightness reference only — actual root-key color uses engine color) |
| cOctBtn | [20,14,40] | octave up/down buttons (KEYS mode) |
| cPlayhead | [63,63,63] | currently-playing step / position-bar segment (white) |
| cEngine[0..3] | DRONE=[0,45,12] green, PAD=[50,22,0] orange, ATMOS=[0,8,55] deep blue, NOISE=[40,0,45] purple | per-engine identity color |
| cFx | [0,50,48] | FX selected/active (cyan — shared by all 4 FX targets, deliberately a different color family from the 4 engine colors) |
| cFxDim | [0,7,7] | FX not selected |
| cFxFill | [0,32,30] | FX param bar-graph fill |
| cMuteOn | [55,0,0] | engine muted / FX bypassed (red) |
| cMuteOff | [7,1,1] | engine active / FX enabled, shown during SHIFT-hold state-preview |
| cShiftOn | [63,63,63] | SHIFT button lit while held (white) |
| cPlayOn | [0,55,10] | PLAY button, blink-on phase (green) |
| cPlayDim | [0,10,2] | PLAY button, blink-off phase (dim green, NEVER fully black) |
| cPlayOff | [55,0,0] | PLAY button, stopped (solid red) |
| cHoldOn | [0,55,20] | LATCH mode active (green) |
| cHoldOff | [4,8,4] | LATCH mode inactive |
| cKeyLatch | [63,34,0] | a latched KEYS-mode note (amber) |
| cFill | [0,30,30] | PARAM-mode bar-graph fill |
| cTip | [63,63,63] | bar-graph "current value" topmost lit cell (white) |
| cModeOn / cModeOff | [0,50,20] / [3,8,5] | mode-select button lit/dim state |
| cRecOn / cRecOff | [55,0,0] / [8,2,2] | REC-arm button lit/dim |
| cPageOn / cPageOff | [30,20,50] / [4,3,6] | PARAM-page-select button lit/dim |
| cWarn | [50,18,0] | warning tint (93 LEFT while SHIFT held, since that combo = destructive CLR TRACK) |

### 10.6 SysEx protocol (lines 2449-2471, 3223-3236)

Header: `[0xF0, 0x00, 0x20, 0x29, 0x02, 0x10, <payload...>, 0xF7]` (Novation
manufacturer ID `00 20 29`, product/family `02 10` = Launchpad Pro programmer
protocol).

Connect sequence (with mandatory ~100-150ms gaps between messages — device needs
processing time, sending them back-to-back drops messages):
1. `[0x21, 0x01]` — enter Standalone (not Ableton-Live-controlled) mode.
2. `[0x2c, 0x03]` — layout 3 = Programmer mode.
3. `[0x0e, 0x00]` — all LEDs off (clean slate).
4. (invalidate local LED cache, then do a full unconditional redraw.)

Disconnect sequence (`~az.padDisconnect`, lines 3123-3140):
1. `[0x0e, 0x00]` — all LEDs off.
2. `[0x2c, 0x00]` — layout 0 = back to factory Note mode (so other software sees
   the device in its expected default state).

**Multi-LED set command**: `0x0B` opcode + repeating `(index, R, G, B)` quads,
batched in chunks of **24 quads per SysEx message** (larger batches get silently
dropped by some firmware revisions per the code comment at 2489-2491).

**LED diffing** (`padCache`, lines 2500-2523): before sending, compare against
the last-sent color per index; only send actually-CHANGED LEDs. This is
described as the single most important perf optimization — a full 96-LED
redraw at playhead-step-rate (~12/sec) would be ~1150 LED-commands/sec, which
the real firmware can't keep up with (visible stutter + dropped button presses);
diffing cuts a typical playhead-step redraw down to 2-4 LEDs.

**Redraw throttling** (`padRefresh`, lines 2753-2775): coalescing scheduler,
max ~33 redraws/sec (`padMinRedraw = 0.03s`); calls within the throttle window
don't queue multiple redraws, just ensure ONE trailing redraw fires after the
window closes, guaranteeing final-state consistency without a redraw storm.

**Port requirements for Web MIDI**:
- Send the identical SysEx byte sequences via `MIDIOutput.send(Uint8Array)`.
- Implement the same LED-diff cache (keyed by the same button-index scheme) and
  throttle scheduler (a `requestAnimationFrame`- or `setTimeout`-based coalescer
  is a natural JS equivalent of the AppClock-scheduled trailing redraw).
- Device discovery: enumerate `navigator.requestMIDIAccess()` inputs/outputs,
  filter by name containing "launchpad" (case-insensitive), prefer a port whose
  name contains "standalone" if multiple are present (the device exposes
  multiple logical MIDI ports — Standalone/MIDI/Live — and LEDs+input must be on
  the SAME one or the device lights up but doesn't respond to presses, a bug
  explicitly called out and fixed in the source, lines 3157-3169).
- Debounce: replicate `padCCDebounce` (0.12s min gap between accepted presses of
  the same CC) and `padShiftGraceTime` (0.25s grace after SHIFT release) exactly
  — these exist to work around genuine pressure-sensitivity quirks of the
  physical round buttons (a single physical press can emit multiple CC messages
  with fluctuating values, including transient dips to 0 mid-press) and were
  tuned empirically; using different constants risks reintroducing the
  historical "buttons need two presses" bug this code explicitly fixes.
- Hot-plug handling: `setupMIDI` retries device discovery up to 16× at 0.25s
  intervals (`midiScanTask`) to tolerate CoreMIDI's async device enumeration —
  Web MIDI's `onstatechange` event is the natural equivalent (listen for device
  connect events rather than polling, though a short polling fallback for
  browsers/OSes with flaky `onstatechange` firing may still be prudent).
- Graceful loss handling: any failed SysEx send should immediately null out the
  cached output port reference and log a reconnect hint, exactly as
  `~az.padLost` does — never let a failed send leave the app's internal "pad
  connected" state true when it isn't (this was the specific bug class the
  extensive `try`/`padLost` machinery exists to prevent, per the code comments
  at 2451-2471).

### 10.7 GUI/Launchpad synchronization principle (lines 2351-2354, 1918-1924)

**Design invariant, worth preserving in the JS port**: Launchpad button presses
NEVER touch application state directly — they always invoke the exact same
function/handler a GUI widget's own action would invoke (`~az.uiRefs.*`
indirection layer, lines 1925-2052). This guarantees the on-screen GUI and the
physical controller can never desync, and that side effects (p-lock recording,
voice-stopping on mute, etc.) automatically apply no matter which input path
triggered them. **In the JS port, structure the code the same way**: a single
set of state-mutating functions (`setLayerParam`, `toggleStepAt`, `selectLayer`,
etc.) that BOTH the HTML control event handlers and the Web-MIDI button handlers
call — never let the MIDI handler layer duplicate/shadow logic that also lives
in an HTML `<input>`'s change handler.

---

## 11. Non-Portable Behaviors & Browser Equivalents

| # | Behavior | Where | Why it can't port as-is | Suggested browser equivalent |
|---|---|---|---|---|
| 1 | Native output-device picker at startup | lines 1384-1420, `ServerOptions.outDevices` | No OS-level audio device enumeration/selection from a web page beyond what the OS audio stack routes by default | Skip entirely — browsers route to the OS-selected default output; at most expose `AudioContext.setSinkId()` (Chrome-only, behind a device picker UI) as a stretch goal |
| 2 | Native file dialog (`Dialog.openPanel`) for sample loading | line 1598, §5.3 | No filesystem access API with native chrome in a sandboxed page | `<input type="file" accept="audio/*">` or drag-and-drop `DataTransfer`, read via `FileReader`/`decodeAudioData` |
| 3 | Persisted absolute file path for a loaded sample | patch schema `noiseSrc`/related | A saved path is meaningless across machines/sessions in a browser sandbox; also files aren't re-readable without user re-selection (browser security) | Either (a) embed the actual decoded audio (base64 PCM or an IndexedDB blob keyed by patch) so the patch is truly self-contained, or (b) store just the filename as a label and prompt "please re-select this file" on load |
| 4 | `~/ambient_zero_sc_patches/*.azpatch` files on disk | §8.1 | No arbitrary filesystem write access from a web page | `localStorage` (simple, size-limited ~5-10MB) or IndexedDB (larger, async, better for embedding sample audio per #3) |
| 5 | `Object:writeArchive`/`readArchive` binary SC-archive format | §8.1 | sclang-specific serializer, not usable outside SC | Plain JSON (human-readable, portable, trivially versioned) |
| 6 | Master-output-to-disk recording (`s.record`) | lines 1264-1278, §9.1 REC button | No direct "write .wav to an arbitrary disk folder" from a page | `MediaRecorder` API capturing a `MediaStreamAudioDestinationNode` tapped off the final mix, producing a downloadable Blob (triggering a save-as via a user-gesture-initiated `<a download>` — note this download interaction is fine on a real deployed site even though it's blocked inside the Artifacts sandbox specifically) |
| 7 | Live hardware line-in / mic capture into a buffer (`SoundIn.ar`, `az_rec` SynthDef) | §2.5, §5.2 | No direct scsynth-hardware-input equivalent in a WASM sandbox without explicit user permission | `navigator.mediaDevices.getUserMedia({audio:true})`, decode into a buffer, push PCM into a SuperSonic buffer via OSC/`/b_setn`, or process via a parallel Web Audio graph |
| 8 | `SendReply`-based master meter OSC feedback to the GUI | §2.8, §9.8 | Depends on whether SuperSonic's WASM host bridges scsynth `SendReply`/OSC-reply traffic back out to JS at all — needs verifying against SuperSonic's actual capabilities | If unsupported: compute equivalent input/output/gain-reduction metering client-side via a Web Audio `AnalyserNode`/`ScriptProcessorNode`/`AudioWorkletNode` tapped on input and output of the master stage (gain-reduction specifically would need either a parallel JS-side compressor-detector or accepting a less precise approximation) |
| 9 | Qt-native windowing/menus, `PopUpMenu`, `NumberBox` scroll/drag semantics, native color pickers etc. | throughout §9 | Entirely OS/Qt-specific widget toolkit | Standard HTML form controls: `<select>` for PopUpMenu, `<input type="range">` for Slider (with the same warp/linear value-mapping math layered on top, §3), `<input type="number">` for NumberBox (with scroll-wheel + arrow-key step handling added via JS, since native `<input type=number>` doesn't do drag-to-adjust) |
| 10 | `VOsc` wavetable-morph oscillator (if unsupported in SuperSonic) | §2.2, §4.3 | Central to all 6 tonal-layer SynthDefs; unclear if SuperSonic's UGen set includes it | See §4.3's fallback: precomputed tables + client-side Web Audio/AudioWorklet wavetable oscillator bank running in parallel to (or entirely instead of, for the tonal layers) SuperSonic, OR find/confirm a SuperSonic-native equivalent before committing to an architecture |
| 11 | SC's internal seeded-RNG (`thisThread.randSeed`, `.rand`, `.rand2`) exact bit-for-bit behavior | §4.2 (wave families 4 and 7) | JS's RNGs (even seeded ones like `mulberry32`/`sfc32`) won't match SC's specific LCG algorithm output stream unless deliberately reimplemented | Precompute and ship the 32×64 table data as a static asset generated once from real SuperCollider, rather than regenerating client-side (recommended — also sidesteps #10) |
| 12 | macOS "Audio MIDI Setup" sample-rate mismatch troubleshooting | README lines 330-339 | OS-level audio device configuration, not applicable to a browser (browsers/OS handle SR conversion transparently) | N/A — not a porting concern |
| 13 | Re-run guard / stale-MIDIFunc cleanup for repeated `Cmd+Return` evaluation | lines 80-144 | Artifact of sclang's persistent-environment-variable re-evaluation model; a web page reload naturally tears down all JS state and MIDI listeners | N/A — a page refresh already gives a clean slate; just ensure `beforeunload`/component-teardown code releases the Web MIDI port and any Web Audio nodes cleanly if the app supports in-page "restart" without a full reload |
| 14 | `Platform.userHomeDir`, `PathName`, other sclang filesystem path utilities | throughout | No filesystem path concept in a browser | N/A — replaced entirely by localStorage/IndexedDB keys (#4) |

---

## Appendix A: Quick data-shape reference for JS state modeling

```js
// Suggested top-level shape (not prescriptive, but captures every piece of
// state enumerated above)
const AZ = {
  layers: ["DRONE","PAD","ATMOS","NOISE"],
  layerSel: 0,               // currently-active GUI tab
  structure: [0,2,4,0],      // per layer (index 3 unused)
  curWave:   [-1,-1,-1],     // per tonal layer
  noiseSrc:  0,               // NOISE layer's source index (0-9)
  usrChans:  2,
  muted: [false,false,false,false],
  maxVoices: 6,
  tempoBpm: 120,
  lp: [ /* 4x: {harmonic,balance,detune,pitch,ratio,fmAmt,ringAmt,modRate,
                modDepth,atk,dec,sus,rel,cut,res,egAmt,l1rate,l1depth,l2rate,
                l2depth,level,pan,revSend,glide,noiseMix,
                ftype,modShape,l1dest,l2dest} */ ],
  slotType: [0,1,3],          // FX1/FX2/FX3 type index
  slotParams: [ /* 3x: {...type's params..., active} */ ],
  revShimParams: {active:1,size:0.7,decay:0.72,damp:0.35,shimmer:0.3,mix:1.0},
  masterParams:  {active:1,threshold:0.15,ratio:4,attack:0.01,release:0.15,makeup:1,ceiling:0.95},
  keyRoot: 0, keyScale: 1, padKeyBase: 36,
  seq: [ /* 4x: {steps:[64x {on,notes:[],vel,len,locks:{}}], length:16, div:7,
                 pos:0, stepTime:0, mute:false} */ ],
  playing: false,
  voices: [ /* 4x: Map<midiNote, synthNodeId> */ ],
  held:   [ /* 4x: [midiNote,...] oldest-first */ ],
};
```

## Appendix B: File cross-reference

- **Primary source**: `supercollider_standalone/ambient_zero_sc.scd` (this spec's
  line numbers refer here).
- **User manual (Hungarian)**: `supercollider_standalone/README.md` — cross-checked
  against code in §10.3; no material discrepancies found beyond what's noted.
- **Companion instrument** (NOT covered by this spec): `granular_zero_sc.scd` /
  `README_granular_zero.md` — a separate granular-synthesis Launchpad-only
  instrument sharing the same Launchpad button-numbering conventions (with FREEZE
  on SHIFT+94 and RND-undo on SHIFT+97 instead of this instrument's mappings) —
  out of scope for this port unless requested separately.
- **Original hardware/norns reference** (not deeply cross-referenced for this
  spec, per task instructions — the `.scd` file is authoritative for behavior):
  `norns_monome/ambient_zero.lua`, `norns_monome/lib/Engine_AmbientZero.sc`,
  `norns_monome/README.md`. Consult these only if a specific synthesis detail in
  the `.scd` file's comments references them for "the full explanation" (several
  comments in `ambient_zero_sc.scd` explicitly defer detailed UGen-graph
  rationale to `Engine_AmbientZero.sc`, e.g. lines 460-465, 514-518).
