const TOKEN_KEY = 'yomu_token'; // must match app.js's key — same origin, same localStorage

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

let currentPage = 1;
const PAGE_SIZE = 25;

async function playAudio(id, button) {
  button.disabled = true;
  try {
    const token = getToken();
    const res = await fetch(`/attempts/${id}/audio`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) return;
    const blob = await res.blob();
    await new Audio(URL.createObjectURL(blob)).play();
  } finally {
    button.disabled = false;
  }
}

function buildRow(attempt) {
  const tr = document.createElement('tr');
  if (attempt.flaggedIncorrect) tr.className = 'flagged';

  const cells = [
    new Date(attempt.createdAt).toLocaleString(),
    attempt.userDisplayName || attempt.userEmail,
    attempt.word,
    attempt.gradeLevel || '',
    attempt.correct ? '✅' : '❌',
    attempt.accuracyScore ?? '',
    attempt.flaggedIncorrect ? '🚩 Flagged' : '—',
  ];
  for (const text of cells) {
    const td = document.createElement('td');
    td.textContent = text;
    tr.appendChild(td);
  }

  const audioTd = document.createElement('td');
  const playBtn = document.createElement('button');
  playBtn.textContent = '▶';
  playBtn.addEventListener('click', () => playAudio(attempt.id, playBtn));
  audioTd.appendChild(playBtn);
  tr.appendChild(audioTd);

  const columnCount = document.querySelectorAll('thead th').length;

  const detailsRow = document.createElement('tr');
  detailsRow.style.display = 'none';
  const detailsTd = document.createElement('td');
  detailsTd.colSpan = columnCount;
  const pre = document.createElement('pre');
  pre.textContent = JSON.stringify(attempt.rawProviderResponse, null, 2);
  detailsTd.appendChild(pre);
  detailsRow.appendChild(detailsTd);

  const toggleTd = document.createElement('td');
  const toggleBtn = document.createElement('button');
  toggleBtn.textContent = '▶ JSON';
  toggleBtn.addEventListener('click', () => {
    const showing = detailsRow.style.display !== 'none';
    detailsRow.style.display = showing ? 'none' : 'table-row';
    toggleBtn.textContent = showing ? '▶ JSON' : '▼ JSON';
  });
  toggleTd.appendChild(toggleBtn);
  tr.appendChild(toggleTd);

  return [tr, detailsRow];
}

async function loadPage() {
  const flaggedOnly = document.getElementById('flagged-only').checked;
  const data = await fetchJSON(
    `/attempts/audit?page=${currentPage}&pageSize=${PAGE_SIZE}&flaggedOnly=${flaggedOnly}`,
  );

  const rows = document.getElementById('rows');
  rows.innerHTML = '';
  for (const attempt of data.attempts) {
    const [tr, detailsRow] = buildRow(attempt);
    rows.appendChild(tr);
    rows.appendChild(detailsRow);
  }

  const totalPages = Math.max(1, Math.ceil(data.total / PAGE_SIZE));
  document.getElementById('page-label').textContent = `Page ${currentPage} of ${totalPages} (${data.total} total)`;
  document.getElementById('prev-page').disabled = currentPage <= 1;
  document.getElementById('next-page').disabled = currentPage >= totalPages;
}

async function clearAllResults() {
  const typed = prompt(
    'This permanently deletes ALL audit results for ALL users, including their recorded audio. This cannot be undone.\n\nType DELETE to confirm:',
  );
  if (typed !== 'DELETE') return;

  await fetchJSON('/attempts', { method: 'DELETE' });
  currentPage = 1;
  loadPage();
}

document.addEventListener('DOMContentLoaded', () => {
  renderAuthState();

  document.getElementById('clear-all-btn').addEventListener('click', clearAllResults);
  document.getElementById('flagged-only').addEventListener('change', () => {
    currentPage = 1;
    loadPage();
  });
  document.getElementById('prev-page').addEventListener('click', () => {
    currentPage--;
    loadPage();
  });
  document.getElementById('next-page').addEventListener('click', () => {
    currentPage++;
    loadPage();
  });

  if (getToken()) loadPage();
});
