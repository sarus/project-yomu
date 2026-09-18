// Shared recording pipeline: mic capture, VAD-driven auto-stop/trim, and WAV
// encoding. Used by both app.js (dev harness) and child.js.
//
// Supports 3 capture modes, chosen per-recording via `getMode`:
//   'native' (default) — one stream with the browser's native noiseSuppression/
//     echoCancellation/autoGainControl requested explicitly (Tier 0).
//   'gtcrn'  — one stream with noiseSuppression left off, denoised instead by
//     the GTCRN neural model running as a WASM AudioWorklet (Tier 1).
//   'both'   — both of the above, captured concurrently from 2 independent
//     getUserMedia() streams so the same spoken word can be compared across
//     pipelines. Voice-activity detection is always driven by the native
//     stream when present (it's the better-tested signal); the GTCRN stream
//     free-runs alongside it and shares the same detected speech boundaries
//     when the WAV is built (see buildWav) — computing trim boundaries
//     independently per pipeline was the root cause of a real bug: GTCRN's
//     denoised signal has a different noise floor than the native signal, so
//     an amplitude-threshold VAD picked a different (wrong) speech-onset
//     point for it specifically, clipping the front of the word.
// onStop always receives an object `{ native?: Blob, gtcrn?: Blob }` with
// whichever pipeline(s) were active.

function floatTo16BitPCM(float32) {
  const out = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

function downsampleTo16k(samples, inputRate) {
  if (inputRate === 16000) return samples;
  const ratio = inputRate / 16000;
  const outLength = Math.floor(samples.length / ratio);
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i++) {
    out[i] = samples[Math.floor(i * ratio)];
  }
  return out;
}

function encodeWav(int16Samples, sampleRate) {
  const buffer = new ArrayBuffer(44 + int16Samples.length * 2);
  const view = new DataView(buffer);

  function writeString(offset, str) {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  }

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + int16Samples.length * 2, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeString(36, 'data');
  view.setUint32(40, int16Samples.length * 2, true);

  let offset = 44;
  for (let i = 0; i < int16Samples.length; i++, offset += 2) {
    view.setInt16(offset, int16Samples[i], true);
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

// Cosmetic only (e.g. child.js scales the Orby orb by this) — has no bearing
// on auto-stop or trim decisions any more; those come from the fvad-wasm VAD.
function chunkRms(chunk) {
  let sumSquares = 0;
  for (let i = 0; i < chunk.length; i++) sumSquares += chunk[i] * chunk[i];
  return Math.sqrt(sumSquares / chunk.length);
}

function playChime(frequency, duration, audioContext, delay = 0) {
  const oscillator = audioContext.createOscillator();
  const gain = audioContext.createGain();
  oscillator.frequency.value = frequency;
  oscillator.connect(gain);
  gain.connect(audioContext.destination);
  const startTime = audioContext.currentTime + delay;
  gain.gain.setValueAtTime(0.15, startTime);
  gain.gain.exponentialRampToValueAtTime(0.001, startTime + duration);
  oscillator.start(startTime);
  oscillator.stop(startTime + duration);
  return oscillator;
}

// Auto-stop tuning: MIN_SUSTAINED_FRAMES consecutive fvad "speech" frames
// (~270ms) are required before onset counts as real speech, so brief
// pops/breaths/mic bumps don't trigger it. SILENCE_HOLD_MS is how long a
// silence run has to last, once speech has started, before auto-stopping —
// generous, since kids sounding out a word can pause mid-word. MAX is a hard
// safety cap in case silence never registers at all.
const MIN_SUSTAINED_FRAMES = 9;
const SILENCE_HOLD_MS = 2500;
const MAX_RECORDING_MS = 15000;

// Padding kept on each side of the detected speech window before trimming,
// generous enough to also absorb GTCRN's small added algorithmic latency
// when its boundaries are reused from the driver pipeline (see 'both' mode
// above) rather than exactly compensated for.
const TRIM_PADDING_MS = 200;

// Tier 0 / Tier 1 constraint sets. echoCancellation stays on for both — it
// addresses speaker bleed (e.g. a TTS prompt), a different problem from room
// noise, so it shouldn't be a confound when comparing the two pipelines.
// Only noiseSuppression/autoGainControl vary: the native stream leans on the
// browser's own suppressor, the GTCRN stream leaves that off so GTCRN is the
// sole denoiser being evaluated on that path.
const TIER0_NATIVE_CONSTRAINTS = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
const TIER1_GTCRN_CONSTRAINTS = { echoCancellation: true, noiseSuppression: false, autoGainControl: true };

const GTCRN_ASSET_BASE = '/vendor/gtcrn';
const FVAD_ASSET_BASE = '/vendor/fvad';

// One AudioContext sample rate is used for every mode (not just GTCRN-
// involving ones): fvad-wasm only accepts 8000/16000/32000/48000Hz — 44100,
// a common browser default, isn't valid — and GTCRN's worklet likewise only
// accepts 16000/48000Hz. 48000 satisfies both and is near-universally
// supported for input capture.
const AUDIO_CONTEXT_SAMPLE_RATE = 48000;
const FVAD_FRAME_MS = 30; // fvad-wasm only accepts exactly 10, 20, or 30ms frames
const FVAD_FRAME_SAMPLES = (AUDIO_CONTEXT_SAMPLE_RATE * FVAD_FRAME_MS) / 1000; // 1440
const FVAD_MODE = 0; // libfvad's own default ("quality") — least aggressive, biased
// toward not misclassifying real speech as noise (the failure mode this whole
// VAD swap exists to avoid). Revisit if it proves too lenient on real recordings.

// Wraps the fvad-wasm module: buffers arbitrary-length incoming chunks and
// returns one speech/non-speech decision per complete FVAD_FRAME_SAMPLES
// frame it can slice off (fvad requires exact frame lengths, so leftover
// samples shorter than a full frame carry over to the next push).
async function createFvadDetector() {
  const fvadFactory = (await import(`${FVAD_ASSET_BASE}/fvad.js`)).default;
  const Module = await fvadFactory();

  const inst = Module._fvad_new();
  Module._fvad_set_sample_rate(inst, AUDIO_CONTEXT_SAMPLE_RATE);
  Module._fvad_set_mode(inst, FVAD_MODE);
  const framePtr = Module._malloc(FVAD_FRAME_SAMPLES * Int16Array.BYTES_PER_ELEMENT);

  let pending = new Float32Array(0);

  function processFrame(frame) {
    const heapOffset = framePtr >> 1;
    for (let i = 0; i < FVAD_FRAME_SAMPLES; i++) {
      const s = Math.max(-1, Math.min(1, frame[i]));
      Module.HEAP16[heapOffset + i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return Module._fvad_process(inst, framePtr, FVAD_FRAME_SAMPLES);
  }

  return {
    pushSamples(chunk) {
      const combined = new Float32Array(pending.length + chunk.length);
      combined.set(pending);
      combined.set(chunk, pending.length);

      const decisions = [];
      let offset = 0;
      while (combined.length - offset >= FVAD_FRAME_SAMPLES) {
        decisions.push(processFrame(combined.subarray(offset, offset + FVAD_FRAME_SAMPLES)));
        offset += FVAD_FRAME_SAMPLES;
      }
      pending = combined.slice(offset);
      return decisions;
    },
    destroy() {
      Module._fvad_free(inst);
      Module._free(framePtr);
    },
  };
}

// Target peak for normalizePeak() below. GTCRN's denoising mask reduces
// overall level as a side effect of suppressing noise (measured: ~2-3x lower
// peak/RMS than the native stream for the same recording) — well below what
// 16-bit PCM can represent cleanly, on top of just sounding quiet. Normalizing
// both pipelines to the same target keeps that comparison apples-to-apples
// rather than introducing yet another asymmetry between them.
const TARGET_PEAK = 0.9;
// Below this, treat the recording as having no meaningful signal to normalize
// against (e.g. the "no speech detected at all" fallback in stop(), which
// submits the untrimmed buffer as-is) — normalizing near-silence would just
// amplify noise/hiss up to full volume instead of restoring real speech.
const MIN_PEAK_TO_NORMALIZE = 0.01;

function normalizePeak(samples) {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const abs = Math.abs(samples[i]);
    if (abs > peak) peak = abs;
  }
  if (peak < MIN_PEAK_TO_NORMALIZE) return samples;

  const scale = TARGET_PEAK / peak;
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = samples[i] * scale;
  return out;
}

// Merges one pipeline's captured chunks, slices to `sampleRange` (padded)
// when given, then normalizes/downsamples/encodes. `sampleRange` — when
// present — comes from the driver pipeline's VAD and is applied identically
// to every active pipeline, so 'both' mode produces 2 WAVs covering the same
// time window rather than 2 independently (and inconsistently) trimmed ones.
function buildWav(chunks, audioContext, sampleRange) {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const merged = new Float32Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }

  let sliced = merged;
  if (sampleRange) {
    const padding = Math.round((TRIM_PADDING_MS / 1000) * audioContext.sampleRate);
    const start = Math.max(0, sampleRange.start - padding);
    const end = Math.min(merged.length, sampleRange.end + padding);
    if (start < end) sliced = merged.subarray(start, end);
  }

  const normalized = normalizePeak(sliced);
  const downsampled = downsampleTo16k(normalized, audioContext.sampleRate);
  const pcm = floatTo16BitPCM(downsampled);
  return encodeWav(pcm, 16000);
}

// Creates a recorder instance. `getDeviceConstraint` (optional) returns the
// `audio` constraint for getUserMedia (deviceId selection only — pipeline
// constraints are layered on top of it here); `getMode` (optional) returns
// 'native' | 'gtcrn' | 'both', defaulting to 'native'; `onStatus` fires with
// 'waiting' | 'speaking' | 'quiet' | 'stopped' as recording progresses;
// `onStop` fires once with `{ native?: Blob, gtcrn?: Blob }` when recording
// ends (manual stop, silence auto-stop, or the max-duration safety cap).
function createRecorder({ getDeviceConstraint, getMode, onStatus, onStop } = {}) {
  let audioContext;
  let pipelines = {}; // { native?: {...}, gtcrn?: {...} }
  let driverKey = 'native';
  let isRecording = false;
  let fvadDetector = null;

  // VAD state, all in terms of the driver pipeline's own absolute sample
  // count (not chunk-array index), so buildWav can slice a flat merged
  // buffer directly.
  let driverSampleCount = 0;
  let vadFrameCount = 0;
  let consecutiveSpeechFrames = 0;
  let hasDetectedSpeech = false;
  let speechStartSample = null;
  let lastSpeechFrameEnd = null;
  let silenceStartTime = null;
  let stopSample = null;
  let maxDurationTimer = null;

  function withPipelineConstraints(overrides) {
    const base = getDeviceConstraint ? getDeviceConstraint() : true;
    const deviceOnly = typeof base === 'object' && base !== null ? base : {};
    return { ...deviceOnly, ...overrides };
  }

  // Runs the VAD hysteresis state machine off the driver pipeline's latest
  // chunk. Only the driver pipeline calls this, so 'both' mode has a single,
  // unambiguous timing decision applied to both streams.
  function driveAutoStop(chunk, rms) {
    const decisions = fvadDetector.pushSamples(chunk);
    driverSampleCount += chunk.length;

    for (const decision of decisions) {
      const frameStartSample = vadFrameCount * FVAD_FRAME_SAMPLES;
      vadFrameCount++;

      const isSpeech = decision === 1;
      consecutiveSpeechFrames = isSpeech ? consecutiveSpeechFrames + 1 : 0;
      const sustainedSpeech = consecutiveSpeechFrames >= MIN_SUSTAINED_FRAMES;

      if (sustainedSpeech) {
        if (!hasDetectedSpeech) {
          hasDetectedSpeech = true;
          // Back-date onset to the start of the sustained run rather than
          // the frame that finally confirmed it — otherwise every recording
          // would clip its own first ~270ms of real speech.
          speechStartSample = Math.max(0, frameStartSample - (MIN_SUSTAINED_FRAMES - 1) * FVAD_FRAME_SAMPLES);
        }
        // Tracks "audio is confirmed real speech up to at least this point" —
        // used below as the trim end instead of wherever the recording
        // happens to be once the silence-hold timer finally elapses.
        lastSpeechFrameEnd = frameStartSample + FVAD_FRAME_SAMPLES;
        silenceStartTime = null;
        onStatus?.('speaking', rms);
      } else if (hasDetectedSpeech) {
        if (silenceStartTime === null) silenceStartTime = performance.now();
        onStatus?.('quiet', rms);
        if (performance.now() - silenceStartTime >= SILENCE_HOLD_MS) {
          // Trim to where speech actually last was, not to "now" — "now" is
          // necessarily ~SILENCE_HOLD_MS after the word ended, since that
          // whole hold duration had to elapse before auto-stop could fire.
          stopSample = lastSpeechFrameEnd;
          stop();
          return;
        }
      } else {
        onStatus?.('waiting', rms);
      }
    }
  }

  async function loadGtcrnNode() {
    const { loadGtcrn, GtcrnWorkletNode } = await import(`${GTCRN_ASSET_BASE}/index.js`);
    await audioContext.audioWorklet.addModule(`${GTCRN_ASSET_BASE}/workletProcessor.js`);
    const wasmBinary = await loadGtcrn({ url: `${GTCRN_ASSET_BASE}/gtcrn.wasm` });
    return new GtcrnWorkletNode(audioContext, { wasmBinary, maxChannels: 1 });
  }

  async function openPipeline(key, constraint, { insertGtcrn } = {}) {
    const mediaStream = await navigator.mediaDevices.getUserMedia({ audio: constraint });
    const sourceNode = audioContext.createMediaStreamSource(mediaStream);
    const gtcrnNode = insertGtcrn ? await loadGtcrnNode() : null;

    const scriptNode = audioContext.createScriptProcessor(4096, 1, 1);
    const pipeline = { mediaStream, sourceNode, gtcrnNode, scriptNode, samples: [] };

    scriptNode.onaudioprocess = (e) => {
      const chunk = new Float32Array(e.inputBuffer.getChannelData(0));
      pipeline.samples.push(chunk);
      if (key === driverKey) driveAutoStop(chunk, chunkRms(chunk));
    };

    (gtcrnNode ?? sourceNode).connect(scriptNode);
    if (gtcrnNode) sourceNode.connect(gtcrnNode);
    // Connecting to destination (silently — nothing is written to the
    // output buffer) is what keeps a ScriptProcessorNode's onaudioprocess
    // firing at all; it's not audio monitoring/feedback.
    scriptNode.connect(audioContext.destination);

    return pipeline;
  }

  async function start() {
    pipelines = {};
    isRecording = true;
    driverSampleCount = 0;
    vadFrameCount = 0;
    consecutiveSpeechFrames = 0;
    hasDetectedSpeech = false;
    speechStartSample = null;
    lastSpeechFrameEnd = null;
    silenceStartTime = null;
    stopSample = null;

    const mode = getMode ? getMode() : 'native';
    const wantsNative = mode === 'native' || mode === 'both';
    const wantsGtcrn = mode === 'gtcrn' || mode === 'both';
    driverKey = wantsNative ? 'native' : 'gtcrn';

    audioContext = new AudioContext({ sampleRate: AUDIO_CONTEXT_SAMPLE_RATE });
    playChime(700, 0.12, audioContext);
    fvadDetector = await createFvadDetector();

    const opens = [];
    if (wantsNative) {
      opens.push(
        openPipeline('native', withPipelineConstraints(TIER0_NATIVE_CONSTRAINTS)).then((p) => {
          pipelines.native = p;
        }),
      );
    }
    if (wantsGtcrn) {
      opens.push(
        openPipeline('gtcrn', withPipelineConstraints(TIER1_GTCRN_CONSTRAINTS), { insertGtcrn: true }).then((p) => {
          pipelines.gtcrn = p;
        }),
      );
    }

    // Both streams are requested concurrently (not sequentially) so a "Both"
    // recording is one take of the word, not two separate ones — but if
    // either getUserMedia() call fails (e.g. device busy from the other
    // concurrent request), this rejects and the caller sees the failure
    // rather than silently falling back to a partial/mismatched recording.
    await Promise.all(opens);

    maxDurationTimer = setTimeout(stop, MAX_RECORDING_MS);
    onStatus?.('waiting');
  }

  function stop() {
    if (!isRecording) return; // avoid double-stop from auto-detect racing a manual stop
    isRecording = false;
    clearTimeout(maxDurationTimer);

    // A manual stop or the max-duration cap can fire without the VAD's own
    // silence-hold path ever setting stopSample — fall back to "everything
    // captured so far" in that case (no trailing trim needed).
    if (hasDetectedSpeech && stopSample === null) stopSample = driverSampleCount;

    for (const pipeline of Object.values(pipelines)) {
      pipeline.scriptNode.disconnect();
      pipeline.gtcrnNode?.disconnect();
      pipeline.sourceNode.disconnect();
      pipeline.mediaStream.getTracks().forEach((t) => t.stop());
    }
    fvadDetector?.destroy();

    playChime(500, 0.1, audioContext);
    const lastChime = playChime(800, 0.15, audioContext, 0.1);
    lastChime.onended = () => audioContext.close();

    // No speech detected at all — submit un-trimmed rather than trim to nothing.
    const sampleRange = hasDetectedSpeech ? { start: speechStartSample, end: stopSample } : null;

    const results = {};
    if (pipelines.native) results.native = buildWav(pipelines.native.samples, audioContext, sampleRange);
    if (pipelines.gtcrn) results.gtcrn = buildWav(pipelines.gtcrn.samples, audioContext, sampleRange);

    onStatus?.('stopped');
    onStop?.(results);
  }

  return {
    start,
    stop,
    get isRecording() {
      return isRecording;
    },
  };
}
