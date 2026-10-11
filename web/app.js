const player = document.querySelector('#player');
const nameEl = document.querySelector('#pkg-name');
const statusEl = document.querySelector('#status');
const pkgList = document.querySelector('#pkg-list');
const eventLog = document.getElementById('event-log');
const xapiLog = document.getElementById('xapi-log');
const scoreLog = document.getElementById('score-log');
const resizeHandle = document.getElementById('resize-handle');
const bottomPanel = document.getElementById('bottom-panel');

const setStatus = (text) => { statusEl.textContent = text; };

// --- Tab switching ---
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content > div').forEach(d => d.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(btn.dataset.tab).classList.add('active');
  });
});

// --- Resize bottom panel ---
let resizing = false;
resizeHandle.addEventListener('mousedown', (e) => {
  resizing = true;
  e.preventDefault();
});
document.addEventListener('mousemove', (e) => {
  if (!resizing) return;
  const rect = bottomPanel.getBoundingClientRect();
  const newHeight = window.innerHeight - e.clientY;
  bottomPanel.style.height = Math.max(80, Math.min(400, newHeight)) + 'px';
});
document.addEventListener('mouseup', () => { resizing = false; });

// --- Event logging ---
const EVENT_KEY = 'h5pv-events';
function logEvent(target, msg) {
  const empty = target.querySelector('.empty-msg');
  if (empty) empty.remove();
  const line = document.createElement('div');
  line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  if (target === eventLog) {
    try {
      const saved = JSON.parse(sessionStorage.getItem(EVENT_KEY) || '[]');
      sessionStorage.setItem(EVENT_KEY, JSON.stringify([...saved, line.textContent].slice(-100)));
    } catch { /* Storage may be unavailable. */ }
  }
  target.appendChild(line);
  target.scrollTop = target.scrollHeight;
}

try {
  for (const text of JSON.parse(sessionStorage.getItem(EVENT_KEY) || '[]')) {
    eventLog.querySelector('.empty-msg')?.remove();
    const line = document.createElement('div');
    line.textContent = text;
    eventLog.appendChild(line);
  }
} catch { /* Storage may be unavailable. */ }

// --- Package list ---
async function loadPackageList() {
  try {
    const res = await fetch('/api/packages', { cache: 'no-store' });
    const data = await res.json();
    pkgList.innerHTML = '';
    if (!data.packages || data.packages.length === 0) {
      pkgList.innerHTML = '<div id="pkg-empty">No packages found.<br>Copy .h5p files to the<br><code>packages/</code> folder.</div>';
      return;
    }
    for (const pkg of data.packages) {
      const div = document.createElement('div');
      div.className = 'pkg-item';
      div.dataset.name = pkg.name;
      const sizeKB = (pkg.size / 1024).toFixed(0);
      div.innerHTML = `<span class="pkg-title">${esc(pkg.title)}</span><span class="pkg-meta">${esc(pkg.name)} &middot; ${sizeKB} KB</span>`;
      div.addEventListener('click', () => loadPackage(pkg.name, div));
      pkgList.appendChild(div);
    }
  } catch (e) {
    pkgList.innerHTML = '<div id="pkg-empty">Cannot reach server.</div>';
  }
}

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s || '';
  return d.innerHTML;
}

// --- Load a package via API ---
async function loadPackage(name, el) {
  setStatus('Loading ' + name + '...');
  logEvent(eventLog, 'Loading: ' + name);
  try {
    const res = await fetch('/api/load', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name })
    });
    const data = await res.json();
    if (data.error) {
      setStatus('Error: ' + data.error);
      logEvent(eventLog, 'ERROR: ' + data.error);
      return;
    }
    // Update active state
    document.querySelectorAll('.pkg-item').forEach(i => i.classList.remove('active'));
    if (el) el.classList.add('active');
    nameEl.textContent = data.title || data.name || name;
    // Navigate the whole page to the new token URL so the SW scope matches
    if (data.url) {
      logEvent(eventLog, 'Loaded: ' + (data.title || data.name) + ' (gen ' + data.generation + ')');
      window.location.href = data.url;
    }
  } catch (e) {
    setStatus('Error: ' + e.message);
    logEvent(eventLog, 'ERROR: ' + e.message);
  }
}

// --- Player events ---
player.addEventListener('ready', () => {
  setStatus('Ready');
  logEvent(eventLog, 'Player ready');
});
player.addEventListener('progress', (event) => {
  if (player.state === 'ready') return;
  const p = event.detail;
  setStatus(p?.fraction == null ? `Loading ${p?.phase || 'package'}...` : `Loading ${Math.round(p.fraction * 100)}%`);
});
player.addEventListener('error', (event) => {
  setStatus('Error: ' + (event.detail?.message || 'Unable to load package'));
  logEvent(eventLog, 'ERROR: ' + (event.detail?.message || 'Unable to load package'));
});

// --- xAPI statement capture ---
// The H5P player dispatches xAPI events via H5P.externalDispatcher
// We intercept these and send them to the server
let captureStarted = false;
function setupXapiCapture() {
  if (captureStarted) return;
  captureStarted = true;
  // Wait for H5P to be available (it's inside the player's iframe)
  // We use a polling approach since the player uses a service worker
  let captured = false;

  function tryCapture() {
    try {
      const iframe = player.querySelector('iframe') || player.shadowRoot?.querySelector('iframe');
      if (!iframe || !iframe.contentWindow) return false;
      const innerWin = iframe.contentWindow;
      if (!innerWin.H5P || !innerWin.H5P.externalDispatcher) return false;

      if (captured) return true;
      captured = true;

      // Hook into the xAPI event dispatcher
      innerWin.H5P.externalDispatcher.on('xAPI', (event) => {
        try {
          // Send to server
          const posted = fetch('/api/xapi', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(event.data || event)
          }).then(res => {
            if (!res.ok) throw new Error(`xAPI POST failed: ${res.status}`);
          });

          // Display in xAPI log
          const stmt = event.data?.statement || event.data || event;
          const obj = stmt?.object?.definition?.name?.['en-US'] || stmt?.object?.id || 'unknown';
          const verb = stmt?.verb?.display?.['en-US'] || stmt?.verb?.id || 'unknown';
          const score = stmt?.result?.score;
          const scoreStr = score ? ` raw=${score.raw ?? '?'}/${score.max ?? '?'} scaled=${score.scaled ?? '?'}` : '';
          const success = stmt?.result?.success !== undefined ? ` success=${stmt.result.success}` : '';
          const completion = stmt?.result?.completion !== undefined ? ` completion=${stmt.result.completion}` : '';
          logEvent(xapiLog, `${verb}: ${obj}${scoreStr}${success}${completion}`);

          // If scored, update score panel
          if (score || stmt?.result?.success !== undefined) {
            posted.then(updateScores).catch(e => logEvent(eventLog, 'ERROR: ' + e.message));
          } else {
            posted.catch(e => logEvent(eventLog, 'ERROR: ' + e.message));
          }
        } catch (e) {
          // Ignore capture errors
        }
      });
      logEvent(eventLog, 'xAPI capture active');
      return true;
    } catch (e) {
      return false;
    }
  }

  // Poll until H5P is available
  const interval = setInterval(() => {
    if (tryCapture()) clearInterval(interval);
  }, 500);

  // Stop after 30 seconds
  setTimeout(() => clearInterval(interval), 30000);
}

// --- Update score panel from server ---
async function updateScores() {
  try {
    const res = await fetch('/api/scores', { cache: 'no-store' });
    const data = await res.json();
    scoreLog.innerHTML = '';
    if (!data.scores || data.scores.length === 0) {
      scoreLog.innerHTML = '<span class="empty-msg">No scores yet.</span>';
      return;
    }
    for (const s of data.scores) {
      const row = document.createElement('div');
      row.className = 'score-row';
      const sc = s.score;
      const scoreStr = sc ? `${sc.raw ?? '?'}/${sc.max ?? '?'} (scaled: ${sc.scaled ?? '?'})` : 'no score';
      row.innerHTML = `<span class="score-obj">${esc(s.object)}</span> <span class="score-val">${scoreStr}</span>${s.success !== undefined ? ` success=${s.success}` : ''}${s.completion !== undefined ? ` completion=${s.completion}` : ''}<br><span class="score-raw">${new Date(s.time).toLocaleTimeString()}</span>`;
      scoreLog.appendChild(row);
    }
    scoreLog.scrollTop = scoreLog.scrollHeight;
  } catch (e) {
    // Ignore
  }
}

// --- Reload button ---
document.querySelector('#reload').addEventListener('click', () => {
  player.removeAttribute('src');
  location.reload();
});

// --- Refresh packages button ---
document.querySelector('#refresh-pkgs').addEventListener('click', loadPackageList);

// --- Clear xAPI button ---
document.querySelector('#clear-xapi').addEventListener('click', async () => {
  try {
    const res = await fetch('/api/xapi/clear', { method: 'POST' });
    if (!res.ok) throw new Error(`Clear failed: ${res.status}`);
    xapiLog.innerHTML = '<span class="empty-msg">No xAPI statements yet.</span>';
    scoreLog.innerHTML = '<span class="empty-msg">No scores yet.</span>';
    logEvent(eventLog, 'xAPI log cleared (package still loaded)');
  } catch (e) {
    logEvent(eventLog, 'ERROR clearing: ' + e.message);
  }
});

// --- Config loading (fetches ./config.json relative to page URL) ---
async function loadConfig() {
  try {
    const config = await (await fetch('./config.json', { cache: 'no-store' })).json();
    nameEl.textContent = config.title || config.name || 'No package selected';
    if (config.packageUrl) {
      player.src = config.packageUrl;
      setStatus('Loading package...');
    } else {
      setStatus('Select a package from the sidebar');
    }
  } catch (error) {
    setStatus('Waiting for package...');
  }
}

// --- Initialize ---
loadPackageList();
loadConfig();

// Set up xAPI capture when player becomes ready
player.addEventListener('ready', () => {
  setTimeout(setupXapiCapture, 500);
});

