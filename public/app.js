const TOKEN_KEY = 'yomu_token';
const MIC_DEVICE_KEY = 'yomu_mic_device';
const TTS_VOICE_KEY = 'yomu_tts_voice'; // TODO: move to a per-user DB setting once accounts need it
const CONFETTI_ENABLED_KEY = 'yomu_confetti_enabled'; // read by child.js
const ORBY_INTRO_KEY = 'yomu_orby_intro_played'; // read by child.js
const PIPELINE_MODE_KEY = 'yomu_pipeline_mode';

// Maps a recorder pipeline mode to the { pipeline, resultKey } pairs it should
// submit as. 'both' submits twice (linked by a shared comparisonGroupId) so
// the same spoken word gets scored by both pipelines for comparison.
const PIPELINE_SUBMISSIONS = {
  native: [{ resultKey: 'native', pipeline: 'tier0-native' }],
  gtcrn: [{ resultKey: 'gtcrn', pipeline: 'tier1-gtcrn' }],
  both: [
    { resultKey: 'native', pipeline: 'tier0-native' },
    { resultKey: 'gtcrn', pipeline: 'tier1-gtcrn' },
  ],
};

function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

function logout() {
  localStorage.removeItem(TOKEN_KEY);
  renderAuthState();
}

async function fetchJSON(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(path, { ...opts, headers });
  return res.json();
}

function renderAuthState() {
  const loggedIn = !!getToken();
  document.getElementById('logged-out').style.display = loggedIn ? 'none' : '';
  document.getElementById('logged-in').style.display = loggedIn ? '' : 'none';
}

let selectedWord = null;

function selectWord(word) {
  selectedWord = word;
  document.getElementById('selected-word').textContent = word;
}

function readWordNative() {
  if (!selectedWord) {
    alert('Select a word first.');
    return;
  }
  speechSynthesis.cancel(); // stop anything already playing
  speechSynthesis.speak(new SpeechSynthesisUtterance(selectedWord));
}

async function readWordAzure() {
  if (!selectedWord) {
    alert('Select a word first.');
    return;
  }
  const voice = document.getElementById('azure-voice').value;
  const token = getToken();
  const res = await fetch(`/tts?word=${encodeURIComponent(selectedWord)}&voice=${voice}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) {
    alert(`Azure TTS request failed: ${res.status}`);
    return;
  }
  const blob = await res.blob();
  new Audio(URL.createObjectURL(blob)).play();
}

async function loadWords() {
  const grade = document.getElementById('grade').value;
  const path = grade === 'all' ? '/words' : `/words?grade=${grade}`;
  const data = await fetchJSON(path);
  document.getElementById('words-output').textContent = JSON.stringify(data, null, 2);

  const words = Array.isArray(data.words) ? data.words : Object.values(data).flat();
  const list = document.getElementById('word-list');
  list.innerHTML = '';
  for (const word of words) {
    const btn = document.createElement('button');
    btn.textContent = word;
    btn.addEventListener('click', () => selectWord(word));
    list.appendChild(btn);
  }
}

// --- Microphone device selection + live level meter ---

async function populateMicDevices() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const mics = devices.filter((d) => d.kind === 'audioinput');
  const select = document.getElementById('mic-device');
  const previous = select.value || localStorage.getItem(MIC_DEVICE_KEY);
  select.innerHTML = '';
  for (const [i, mic] of mics.entries()) {
    const opt = document.createElement('option');
    opt.value = mic.deviceId;
    opt.textContent = mic.label || `Microphone ${i + 1}`;
    select.appendChild(opt);
  }
  if (previous) select.value = previous; // no-op if that device is no longer available
}

function getSelectedDeviceConstraint() {
  const deviceId = document.getElementById('mic-device').value;
  return deviceId ? { deviceId: { exact: deviceId } } : true;
}

let testStream, testAudioContext, testAnalyser, testRafId;

async function startMicTest() {
  testStream = await navigator.mediaDevices.getUserMedia({ audio: getSelectedDeviceConstraint() });
  await populateMicDevices(); // labels only populate once permission has been granted

  testAudioContext = new AudioContext();
  const source = testAudioContext.createMediaStreamSource(testStream);
  testAnalyser = testAudioContext.createAnalyser();
  testAnalyser.fftSize = 2048;
  source.connect(testAnalyser);

  const data = new Uint8Array(testAnalyser.fftSize);
  const meter = document.getElementById('mic-level');
  const tick = () => {
    testAnalyser.getByteTimeDomainData(data);
    let sumSquares = 0;
    for (let i = 0; i < data.length; i++) {
      const v = (data[i] - 128) / 128;
      sumSquares += v * v;
    }
    const rms = Math.sqrt(sumSquares / data.length);
    meter.value = Math.min(100, Math.round(rms * 300));
    testRafId = requestAnimationFrame(tick);
  };
  tick();

  document.getElementById('test-mic').disabled = true;
  document.getElementById('stop-test-mic').disabled = false;
}

function stopMicTest() {
  cancelAnimationFrame(testRafId);
  testStream.getTracks().forEach((t) => t.stop());
  testAudioContext.close();
  document.getElementById('mic-level').value = 0;
  document.getElementById('test-mic').disabled = false;
  document.getElementById('stop-test-mic').disabled = true;
}

// --- Recording: capture mic audio and encode as 16kHz mono 16-bit PCM WAV ---
// (shared pipeline lives in recorder.js)

let recordedResults = null; // { native?: Blob, gtcrn?: Blob }, set by recorder.js's onStop

function setRecordStatus(text) {
  document.getElementById('record-status').textContent = text;
}

const RECORD_STATUS_TEXT = {
  waiting: 'Recording... (waiting for you to speak)',
  speaking: 'Recording... (hearing speech)',
  quiet: 'Recording... (quiet, about to stop)',
  stopped: 'Not recording',
};

function getSelectedPipelineMode() {
  return document.getElementById('pipeline-mode').value;
}

const recorder = createRecorder({
  getDeviceConstraint: getSelectedDeviceConstraint,
  getMode: getSelectedPipelineMode,
  onStatus: (status) => setRecordStatus(RECORD_STATUS_TEXT[status] ?? status),
  onStop: (results) => {
    recordedResults = results;
    document.getElementById('playback-native').src = results.native ? URL.createObjectURL(results.native) : '';
    document.getElementById('playback-gtcrn').src = results.gtcrn ? URL.createObjectURL(results.gtcrn) : '';
    document.getElementById('start-recording').disabled = false;
    document.getElementById('stop-recording').disabled = true;
  },
});

function startRecording() {
  recordedResults = null;
  document.getElementById('start-recording').disabled = true;
  document.getElementById('stop-recording').disabled = false;
  // 'Both' mode opens 2 concurrent getUserMedia() streams — this can reject
  // (e.g. a device that won't allow a 2nd concurrent capture), so surface
  // that instead of leaving the UI stuck in "recording" state.
  recorder.start().catch((err) => {
    alert(`Failed to start recording: ${err.message}`);
    document.getElementById('start-recording').disabled = false;
    document.getElementById('stop-recording').disabled = true;
  });
}

function stopRecording() {
  recorder.stop();
}

function renderComparisonTable(rows) {
  const table = document.getElementById('comparison-table');
  const body = document.getElementById('comparison-table-body');
  body.innerHTML = '';
  if (rows.length < 2) {
    table.style.display = 'none';
    return;
  }
  for (const { pipeline, data } of rows) {
    const tr = document.createElement('tr');
    const cell = (text) => {
      const td = document.createElement('td');
      td.style.padding = '0.25rem 0.5rem';
      td.textContent = text;
      return td;
    };
    tr.append(
      cell(pipeline),
      cell(data.correct ? '✅' : '❌'),
      cell(data.accuracyScore ?? '—'),
      cell(data.recognizedText ?? ''),
    );
    body.appendChild(tr);
  }
  table.style.display = '';
}

async function submitAttempt() {
  const mode = getSelectedPipelineMode();
  const submissions = PIPELINE_SUBMISSIONS[mode].filter((s) => recordedResults?.[s.resultKey]);
  if (!selectedWord || submissions.length === 0) {
    alert('Select a word and record an attempt first.');
    return;
  }

  const grade = document.getElementById('grade').value;
  // Only tag a comparisonGroupId when this is genuinely a multi-pipeline
  // submission of the same recording — a single-pipeline submit has nothing to link.
  const comparisonGroupId = submissions.length > 1 ? crypto.randomUUID() : undefined;

  const submitButton = document.getElementById('submit-attempt');
  const spinner = document.getElementById('submit-spinner');
  submitButton.disabled = true;
  spinner.classList.add('active');
  try {
    const results = await Promise.all(
      submissions.map(({ resultKey, pipeline }) => {
        const formData = new FormData();
        formData.append('word', selectedWord);
        if (grade !== 'all') formData.append('gradeLevel', grade);
        formData.append('pipeline', pipeline);
        if (comparisonGroupId) formData.append('comparisonGroupId', comparisonGroupId);
        formData.append('audio', recordedResults[resultKey], 'attempt.wav');
        return fetchJSON('/attempts', { method: 'POST', body: formData });
      }),
    );
    document.getElementById('submit-output').textContent = JSON.stringify(results, null, 2);
    renderComparisonTable(results.map((data, i) => ({ pipeline: submissions[i].pipeline, data })));
  } finally {
    submitButton.disabled = false;
    spinner.classList.remove('active');
  }
}

async function loadHistory() {
  const data = await fetchJSON('/attempts/history');
  document.getElementById('history-output').textContent = JSON.stringify(data, null, 2);
}

async function loadSummary() {
  const data = await fetchJSON('/attempts/summary');
  document.getElementById('summary-output').textContent = JSON.stringify(data, null, 2);
}

document.addEventListener('DOMContentLoaded', () => {
  renderAuthState();
  populateMicDevices();
  navigator.mediaDevices.addEventListener('devicechange', populateMicDevices);
  document.getElementById('mic-device').addEventListener('change', (e) => {
    localStorage.setItem(MIC_DEVICE_KEY, e.target.value);
  });
  const voiceSelect = document.getElementById('azure-voice');
  const storedVoice = localStorage.getItem(TTS_VOICE_KEY);
  if (storedVoice) voiceSelect.value = storedVoice; // no-op if no longer a valid option
  voiceSelect.addEventListener('change', (e) => {
    localStorage.setItem(TTS_VOICE_KEY, e.target.value);
  });
  const pipelineModeSelect = document.getElementById('pipeline-mode');
  const storedPipelineMode = localStorage.getItem(PIPELINE_MODE_KEY);
  if (storedPipelineMode) pipelineModeSelect.value = storedPipelineMode; // no-op if no longer a valid option
  pipelineModeSelect.addEventListener('change', (e) => {
    localStorage.setItem(PIPELINE_MODE_KEY, e.target.value);
  });
  const confettiCheckbox = document.getElementById('confetti-enabled');
  confettiCheckbox.checked = localStorage.getItem(CONFETTI_ENABLED_KEY) !== 'false'; // default on
  confettiCheckbox.addEventListener('change', (e) => {
    localStorage.setItem(CONFETTI_ENABLED_KEY, e.target.checked ? 'true' : 'false');
  });
  document.getElementById('replay-orby-intro').addEventListener('click', () => {
    localStorage.removeItem(ORBY_INTRO_KEY);
  });
  document.getElementById('logout').addEventListener('click', logout);
  document.getElementById('load-words').addEventListener('click', loadWords);
  document.getElementById('read-word-native').addEventListener('click', readWordNative);
  document.getElementById('read-word-azure').addEventListener('click', readWordAzure);
  document.getElementById('test-mic').addEventListener('click', startMicTest);
  document.getElementById('stop-test-mic').addEventListener('click', stopMicTest);
  document.getElementById('start-recording').addEventListener('click', startRecording);
  document.getElementById('stop-recording').addEventListener('click', stopRecording);
  document.getElementById('submit-attempt').addEventListener('click', submitAttempt);
  document.getElementById('load-history').addEventListener('click', loadHistory);
  document.getElementById('load-summary').addEventListener('click', loadSummary);
});
