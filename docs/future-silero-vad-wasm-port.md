# Proposal: a GTCRN-style compiled WASM port of Silero VAD

Status: not started — future project, tracked here for when we pick it up.
Owner: TBD. Written after evaluating Silero VAD for Yomu's recorder pipeline
and finding the size cost too high to ship broadly (Sept 2026).

## Problem

Yomu's recorder (`public/recorder.js`) needs to know where a spoken word
starts and ends — both to auto-stop recording after silence and to trim the
captured audio before it's sent to Azure Pronunciation Assessment. Today that
job is done by a fixed RMS amplitude threshold (`SPEECH_RMS_THRESHOLD` and
friends), which is cheap but crude: it doesn't distinguish speech from
speech-shaped noise, and it can be miscalibrated between differently-processed
audio streams. We hit exactly that miscalibration going from Tier 0 (native
browser noise suppression) to Tier 1 (GTCRN neural denoising) — the same
fixed threshold picked a different, wrong speech-onset point on the
denoised signal, clipping the front of the word.

Silero VAD (a small trained neural network, MIT-licensed, via
[snakers4/silero-vad](https://github.com/snakers4/silero-vad)) is the right
tool for this — a per-frame speech probability instead of a fixed amplitude
cutover, robust across differently-processed audio. The problem is entirely
one of packaging: every existing way to run it in a browser goes through
**onnxruntime-web**, whose WASM runtime alone is ~14.2MB (measured directly
from the published `onnxruntime-web@1.30.0` package — `ort-wasm-simd-threaded.wasm`).
Add the model weights (~1.8–2.3MB depending on version) and a Silero VAD
integration costs **~16–17MB**, roughly 80x the size of the GTCRN denoiser
we already ship (~207KB total). We checked whether an older or different
onnxruntime-web build is meaningfully smaller — the oldest published version
we could find (1.14.0, from 2023) still has a ~9.1MB minimum (`ort-wasm-threaded.wasm`)
— so this isn't a "pick an older version" fix.

For now (Sept 2026) we're using **WebRTC VAD** instead — a classical,
GMM-based detector with no neural network and no ONNX runtime, tens of KB —
as a stopgap that's a real improvement over the RMS threshold without the
size cost. But it's weaker than Silero specifically on non-stationary noise
(music, other people talking) — the exact case Yomu's rooms will actually
have. This document is the plan for closing that gap properly later.

## The idea

GTCRN (`@sapphi-red/web-noise-suppressor`'s `GtcrnWorkletNode`) is small
specifically because [sapphi-red/gtcrn-wasm](https://github.com/sapphi-red/gtcrn-wasm)
didn't use onnxruntime-web at all — it ran GTCRN's official ONNX export
through **`onnx2c`** (converts an ONNX graph to plain C), compiled that C
directly to WASM via Emscripten, and bundled a small FFT library (`pffft`)
for the STFT framing GTCRN needs. No generic ONNX interpreter, no ~14MB
runtime — just the model's own compiled inference code. The resulting
binary is ~197KB.

We looked for an equivalent already built for Silero VAD and didn't find
one. Several Rust ports exist (`silero-vad-rs`, `silero-vad-web`,
`silero-rs`/`silero-vad-core`), but every one we checked still routes
through either the `ort` crate (native) or onnxruntime-web/`@huggingface/transformers`
(browser) under the hood — nobody has done the onnx2c-style transpile for
Silero specifically. The proposal is to do that ourselves: build a
`silero-vad-wasm`-equivalent package, following the same recipe as
`gtcrn-wasm`, and wire it into `recorder.js` as a peer to `GtcrnWorkletNode`.

## Why this should work

Silero VAD's architecture is, if anything, simpler than GTCRN's — GTCRN
is itself a "grouped temporal convolutional **recurrent** network," so
onnx2c already has to handle recurrent/stateful ops to produce `gtcrn-wasm`
today. That's the main technical risk for this kind of transpile (onnx2c
needs op coverage for whatever layers the model uses), and it's already
proven out on a model in the same family. There's no fundamental reason
Silero's network should compile any less cleanly.

## What needs figuring out

- **Which model version to target.** Silero ships a `legacy` model
  (1536-sample frames @ 16kHz, ~1.8MB weights) and newer `v5`/`v6` models
  (512-sample frames @ 16kHz, ~2.3MB weights, same architecture, different
  weights). Smaller/older vs. newer/more-accurate is a real tradeoff to make
  before starting, not after.
- **Preprocessing.** GTCRN needs STFT/iSTFT framing (hence bundling `pffft`);
  need to confirm what preprocessing (if any) Silero's graph expects — it's
  plausible it operates directly on raw waveform frames, which would make
  this *simpler* than GTCRN (no FFT library needed at all), but that's
  unverified and should be confirmed against the actual ONNX graph before
  scoping the work.
- **onnx2c op coverage.** Need to actually run Silero's ONNX export through
  onnx2c and see what, if anything, it chokes on — this is the main
  feasibility check and should happen before committing to the rest of the
  project.
- **Packaging.** Decide whether this lives as our own small internal
  package (simplest, no external maintenance burden) or as a standalone
  open-source package in the spirit of `gtcrn-wasm` (more work, but useful
  to the same community that already benefits from `gtcrn-wasm` existing).

## Expected payoff

Landing anywhere near GTCRN's size (order of a few hundred KB, vs. today's
~16–17MB) would remove the size objection entirely — at that point there's
no reason to scope Silero VAD to dev-harness-only the way we're scoping
onnxruntime-web-based Silero today. It could become the default VAD for
*all* of Yomu's recording, including `child.js`'s real kid-facing flow, not
just something we A/B in `app.js`.

## Where it plugs in once it exists

Same integration point WebRTC VAD occupies today: `recorder.js`'s
`driveAutoStop`/trim-boundary logic, replacing the amplitude-threshold
state machine with per-frame speech probability from this model. Given the
clipping bug that motivated this whole investigation, the trim boundaries
it produces should be computed once (on the driver pipeline) and reused for
every active pipeline's WAV output, rather than computed independently per
pipeline — that was the actual root cause of the GTCRN clipping bug, and
holds regardless of which VAD approach is driving it.
