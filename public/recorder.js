// Shared recording pipeline: mic capture, silence-based auto-stop, silence
// trimming, and WAV encoding. Used by both app.js (dev harness) and child.js.

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

function chunkRms(chunk) {
  let sumSquares = 0;
  for (let i = 0; i < chunk.length; i++) sumSquares += chunk[i] * chunk[i];
  return Math.sqrt(sumSquares / chunk.length);
}

// Auto-stop tuning: RMS above SPEECH_RMS_THRESHOLD counts as the initial
// onset of speech. Once speech has started, a HIGHER bar (SPEECH_RESUME_RMS_THRESHOLD)
// is required to interrupt the "winding down" countdown — background noise is
// usually quieter than actual speech, so this hysteresis stops stray room
// noise from resetting the timer and running the recording on indefinitely.
// Either threshold also requires MIN_SUSTAINED_CHUNKS consecutive chunks
// above it before counting as real speech, so brief pops/breaths/mic bumps
// don't trigger it either. MAX is a hard safety cap in case silence never
// registers at all.
const SPEECH_RMS_THRESHOLD = 0.02;
const SPEECH_RESUME_RMS_THRESHOLD = 0.05;
const MIN_SUSTAINED_CHUNKS = 3; // ~250-280ms at typical mic sample rates
const SILENCE_HOLD_MS = 2500; // generous — kids sounding out a word can pause mid-word
const MAX_RECORDING_MS = 15000;

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

// How many chunks of padding to keep on each side of detected speech, so the
// trim doesn't clip the word's actual onset/offset. ~2 chunks ≈ 185ms at 44.1kHz.
const TRIM_PADDING_CHUNKS = 2;

function trimSilence(chunks) {
  const rms = chunks.map(chunkRms);
  const start = rms.findIndex((v) => v > SPEECH_RMS_THRESHOLD);
  if (start === -1) return chunks; // no speech detected at all — submit as-is rather than trim to nothing

  let end = rms.length - 1;
  while (end > start && rms[end] <= SPEECH_RMS_THRESHOLD) end--;

  const paddedStart = Math.max(0, start - TRIM_PADDING_CHUNKS);
  const paddedEnd = Math.min(chunks.length - 1, end + TRIM_PADDING_CHUNKS);
  return chunks.slice(paddedStart, paddedEnd + 1);
}

// Creates a recorder instance. `getDeviceConstraint` (optional) returns the
// `audio` constraint for getUserMedia; `onStatus` fires with
// 'waiting' | 'speaking' | 'quiet' | 'stopped' as recording progresses;
// `onStop` fires once with the final WAV Blob when recording ends (manual
// stop, silence auto-stop, or the max-duration safety cap).
function createRecorder({ getDeviceConstraint, onStatus, onStop } = {}) {
  let audioContext, mediaStream, scriptNode, sourceNode;
  let recordedSamples = [];
  let isRecording = false;
  let hasDetectedSpeech = false;
  let silenceStartTime = null;
  let maxDurationTimer = null;
  let consecutiveLoudChunks = 0;

  async function start() {
    recordedSamples = [];
    isRecording = true;
    hasDetectedSpeech = false;
    silenceStartTime = null;
    consecutiveLoudChunks = 0;

    const constraint = getDeviceConstraint ? getDeviceConstraint() : true;
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: constraint });
    audioContext = new AudioContext();
    playChime(700, 0.12, audioContext);

    sourceNode = audioContext.createMediaStreamSource(mediaStream);
    scriptNode = audioContext.createScriptProcessor(4096, 1, 1);
    scriptNode.onaudioprocess = (e) => {
      const chunk = new Float32Array(e.inputBuffer.getChannelData(0));
      recordedSamples.push(chunk);
      const rms = chunkRms(chunk);

      // Once speech has already started, require a louder, sustained sound to
      // interrupt the countdown — quieter background noise just counts as silence.
      const threshold = hasDetectedSpeech ? SPEECH_RESUME_RMS_THRESHOLD : SPEECH_RMS_THRESHOLD;
      consecutiveLoudChunks = rms > threshold ? consecutiveLoudChunks + 1 : 0;
      const sustainedSpeech = consecutiveLoudChunks >= MIN_SUSTAINED_CHUNKS;

      if (sustainedSpeech) {
        hasDetectedSpeech = true;
        silenceStartTime = null;
        onStatus?.('speaking', rms);
      } else if (hasDetectedSpeech) {
        if (silenceStartTime === null) silenceStartTime = performance.now();
        onStatus?.('quiet', rms);
        if (performance.now() - silenceStartTime >= SILENCE_HOLD_MS) {
          stop();
        }
      } else {
        onStatus?.('waiting', rms);
      }
    };
    sourceNode.connect(scriptNode);
    scriptNode.connect(audioContext.destination);

    maxDurationTimer = setTimeout(stop, MAX_RECORDING_MS);
    onStatus?.('waiting');
  }

  function stop() {
    if (!isRecording) return; // avoid double-stop from auto-detect racing a manual stop
    isRecording = false;
    clearTimeout(maxDurationTimer);

    scriptNode.disconnect();
    sourceNode.disconnect();
    mediaStream.getTracks().forEach((t) => t.stop());

    playChime(500, 0.1, audioContext);
    const lastChime = playChime(800, 0.15, audioContext, 0.1);
    lastChime.onended = () => audioContext.close();

    const trimmedChunks = trimSilence(recordedSamples);
    const totalLength = trimmedChunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const merged = new Float32Array(totalLength);
    let offset = 0;
    for (const chunk of trimmedChunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }

    const downsampled = downsampleTo16k(merged, audioContext.sampleRate);
    const pcm = floatTo16BitPCM(downsampled);
    const wavBlob = encodeWav(pcm, 16000);

    onStatus?.('stopped');
    onStop?.(wavBlob);
  }

  return {
    start,
    stop,
    get isRecording() {
      return isRecording;
    },
  };
}
