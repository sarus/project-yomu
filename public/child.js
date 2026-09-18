const TOKEN_KEY = 'yomu_token'; // must match app.js's key — same origin, same localStorage
const MIC_DEVICE_KEY = 'yomu_mic_device'; // reuse the mic preference set in the dev harness, if any
const TTS_VOICE_KEY = 'yomu_tts_voice'; // reuse the voice set in the dev harness, if any
const CONFETTI_ENABLED_KEY = 'yomu_confetti_enabled'; // toggled in the dev harness settings
const ORBY_INTRO_KEY = 'yomu_orby_intro_played';
const ORBY_INTRO_TEXT = "Hi! I'm Orby. Tap me, then say the word you see. I'll let you know if you got it right!";

function getToken() {
  return localStorage.getItem(TOKEN_KEY);
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

let currentWords = [];
let currentWord = null;
let lastAttemptId = null;
let wordQueue = []; // shuffled, work-through-the-deck order — avoids repeats until the list is exhausted

function shuffle(array) {
  const arr = array.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function pickNextWord() {
  if (currentWords.length === 0) return null;
  if (wordQueue.length === 0) {
    wordQueue = shuffle(currentWords);
    // Avoid an immediate repeat right across the reshuffle boundary.
    if (wordQueue.length > 1 && wordQueue[0] === currentWord) {
      const swapIndex = 1 + Math.floor(Math.random() * (wordQueue.length - 1));
      [wordQueue[0], wordQueue[swapIndex]] = [wordQueue[swapIndex], wordQueue[0]];
    }
  }
  return wordQueue.shift();
}

async function playWordAloud(word) {
  const voice = localStorage.getItem(TTS_VOICE_KEY) || 'jenny';
  const token = getToken();
  const res = await fetch(`/tts?word=${encodeURIComponent(word)}&voice=${voice}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) return; // no elaborate error handling — the word is still shown visually either way
  const blob = await res.blob();
  await new Audio(URL.createObjectURL(blob)).play();
}

// For sight words specifically (not arbitrary text like the Orby intro) —
// tries the pre-generated static cache first (no auth, no live Azure call),
// falling back to the live /tts endpoint on a cache miss.
function playCachedWord(word) {
  return new Promise((resolve) => {
    const voice = localStorage.getItem(TTS_VOICE_KEY) || 'jenny';
    const audio = new Audio(`/tts-cache/${voice}/${encodeURIComponent(word)}.mp3`);
    audio.addEventListener('error', () => {
      playWordAloud(word).then(resolve, resolve);
    });
    audio.addEventListener('ended', resolve);
    audio.play().catch(() => {}); // 'error' listener handles real cache-miss failures
  });
}

async function playOrbyIntro() {
  if (localStorage.getItem(ORBY_INTRO_KEY) === 'true') return;
  try {
    await playWordAloud(ORBY_INTRO_TEXT);
    localStorage.setItem(ORBY_INTRO_KEY, 'true');
  } catch {
    // Likely blocked by the browser's autoplay policy since this plays
    // before any click on the page — leave the flag unset so it tries
    // again next visit rather than silently never introducing Orby.
  }
}

const CONFETTI_COLORS = ['#e91e63', '#3f51b5', '#4caf50', '#ff9800', '#00bcd4', '#ffeb3b'];

function launchConfetti() {
  const container = document.createElement('div');
  container.className = 'confetti-container';
  document.body.appendChild(container);

  for (let i = 0; i < 60; i++) {
    const piece = document.createElement('div');
    piece.className = 'confetti-piece';
    piece.style.left = `${Math.random() * 100}vw`;
    piece.style.backgroundColor = CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)];
    piece.style.animationDelay = `${Math.random() * 0.4}s`;
    piece.style.animationDuration = `${2 + Math.random() * 1.5}s`;
    piece.style.transform = `rotate(${Math.random() * 360}deg)`;
    container.appendChild(piece);
  }

  setTimeout(() => container.remove(), 3500);
}

// Orb colors per state — deliberately shape/color/motion only, no text or icons.
const ORB_COLORS = {
  idle: '#90a4ae', // neutral, inviting — "tap me"
  waiting: '#ff9800', // warm — recording started, listening for you
  listening: '#4caf50', // green — hearing you, reacts to volume
  // Saturated base color so the hue-rotate animation reads clearly as a rainbow;
  // settles here (pink) once the one-shot rotation ends.
  celebrating: '#ec407a',
  sad: '#78909c', // dim, cool blue-gray for "not quite"
};

function setOrbState(state, rms = 0) {
  const orb = document.getElementById('orb');
  orb.classList.remove('breathing', 'spinning', 'not-clickable', 'celebrating', 'sad');

  if (state === 'idle') {
    orb.style.background = ORB_COLORS.idle;
    orb.style.transform = 'scale(1)';
    orb.classList.add('breathing');
  } else if (state === 'waiting') {
    orb.style.background = ORB_COLORS.waiting;
    orb.style.transform = 'scale(1)';
    orb.classList.add('not-clickable');
  } else if (state === 'listening') {
    orb.style.background = ORB_COLORS.listening;
    const scale = 1 + Math.min(rms * 6, 0.5);
    orb.style.transform = `scale(${scale})`;
    orb.classList.add('not-clickable');
  } else if (state === 'processing') {
    orb.style.background = 'conic-gradient(#5c6bc0, #c5cae9, #5c6bc0)';
    orb.style.transform = 'scale(0.85)';
    orb.classList.add('spinning', 'not-clickable');
  } else if (state === 'celebrating') {
    orb.style.background = ORB_COLORS.celebrating;
    orb.style.transform = 'scale(1)';
    orb.classList.add('celebrating', 'not-clickable');
  } else if (state === 'sad') {
    orb.style.background = ORB_COLORS.sad;
    orb.style.transform = 'scale(0.9)';
    orb.classList.add('sad', 'not-clickable');
  }
}

function resetForAttempt() {
  setOrbState('idle');
  const result = document.getElementById('result');
  result.textContent = '';
  result.className = '';
  document.getElementById('next-btn').style.display = 'none';
  document.getElementById('retry-btn').style.display = 'none';
  const flagBtn = document.getElementById('flag-btn');
  flagBtn.style.visibility = 'hidden';
  flagBtn.disabled = false;
  flagBtn.textContent = '🚩 Flag Azure response as wrong';
}

async function flagLastAttempt() {
  if (lastAttemptId == null) return;
  const flagBtn = document.getElementById('flag-btn');
  flagBtn.disabled = true;
  await fetchJSON(`/attempts/${lastAttemptId}/flag`, { method: 'POST' });
  flagBtn.textContent = '🚩 Flagged';
}

function showNextWord() {
  currentWord = pickNextWord();
  document.getElementById('word').textContent = currentWord ?? '—';
  resetForAttempt();
}

async function loadWordList() {
  const grade = document.getElementById('grade').value;
  const data = await fetchJSON(`/words?grade=${grade}`);
  currentWords = data.words ?? [];
  wordQueue = []; // new list — reshuffle from scratch instead of using the old grade's leftover queue
  showNextWord();
}

const ORB_STATUS_MAP = {
  waiting: 'waiting',
  speaking: 'listening',
  quiet: 'listening',
};

const recorder = createRecorder({
  getDeviceConstraint: () => {
    const deviceId = localStorage.getItem(MIC_DEVICE_KEY);
    return deviceId ? { deviceId: { exact: deviceId } } : true;
  },
  onStatus: (status, rms) => {
    const orbState = ORB_STATUS_MAP[status];
    if (orbState) setOrbState(orbState, rms);
  },
  onStop: async ({ native: wavBlob }) => {
    setOrbState('processing');

    const grade = document.getElementById('grade').value;
    const formData = new FormData();
    formData.append('word', currentWord);
    formData.append('gradeLevel', grade);
    formData.append('pipeline', 'tier0-native');
    formData.append('audio', wavBlob, 'attempt.wav');

    const data = await fetchJSON('/attempts', { method: 'POST', body: formData });

    document.getElementById('debug-output').textContent = JSON.stringify(data, null, 2);

    lastAttemptId = data.id;
    document.getElementById('flag-btn').style.visibility = 'visible';

    const result = document.getElementById('result');
    result.textContent = data.correct ? '✅ Correct!' : '❌ Not quite';
    result.className = data.correct ? 'correct' : 'incorrect';

    if (data.correct) {
      setOrbState('celebrating');
      document.getElementById('next-btn').style.display = 'inline-block';
      if (localStorage.getItem(CONFETTI_ENABLED_KEY) !== 'false') launchConfetti(); // default on
    } else {
      setOrbState('sad');
      document.getElementById('retry-btn').style.display = 'inline-block';
    }

    playCachedWord(currentWord); // follows a click, so autoplay is never blocked here
  },
});

function startRecordingFromOrb() {
  if (recorder.isRecording) return;
  recorder.start();
}

document.addEventListener('DOMContentLoaded', () => {
  renderAuthState();
  document.getElementById('grade').addEventListener('change', loadWordList);
  const orb = document.getElementById('orb');
  orb.addEventListener('click', startRecordingFromOrb);
  orb.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      startRecordingFromOrb();
    }
  });
  document.getElementById('next-btn').addEventListener('click', showNextWord);
  document.getElementById('retry-btn').addEventListener('click', resetForAttempt);
  document.getElementById('flag-btn').addEventListener('click', flagLastAttempt);
  document.getElementById('debug-btn').addEventListener('click', () => {
    document.getElementById('debug-popover').classList.toggle('open');
  });

  if (getToken()) {
    loadWordList();
    playOrbyIntro();
  }
});
