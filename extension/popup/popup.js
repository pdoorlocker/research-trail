import * as db from '../lib/db.js';
import { workspaceSort } from '../lib/util.js';
import { openBoard, resumeBoard, lastBoard } from '../evidence/open.js';

// The popup answers three things, in the order you reach for them:
// where pages are going (the workspace, recording or paused), what you can do
// with the page you're on (star it, read it in English), and where to go next
// (resume a board, the trail, the side panel).

const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);
const activeTab = async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0];

function openMap(journeyId) {
  chrome.tabs.create({ url: chrome.runtime.getURL(`journey/journey.html${journeyId ? '?j=' + journeyId : ''}`) });
  window.close();
}

// ---------- Workspace: recording into, pause, switch ----------

let state = null;

async function renderWorkspace() {
  state = await send({ type: 'get-state' });
  const journey = state.journey;
  const c = state.counts || { nodes: 0, edges: 0 };
  $('ws-name').textContent = journey ? journey.name : 'Setting up…';
  $('rec-label').textContent = state.paused ? 'Paused · not recording' : 'Recording into';
  $('rec-dot').classList.toggle('paused', !!state.paused);
  $('ws-meta').textContent = `${c.nodes} page${c.nodes === 1 ? '' : 's'} · ${c.edges} connection${c.edges === 1 ? '' : 's'}`;
  const pause = $('pause-btn');
  pause.innerHTML = state.paused
    ? '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M5 3.5v9l7-4.5z" fill="currentColor"/></svg>'
    : '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><rect x="4" y="3.5" width="2.6" height="9" rx=".8" fill="currentColor"/><rect x="9.4" y="3.5" width="2.6" height="9" rx=".8" fill="currentColor"/></svg>';
  pause.title = pause.ariaLabel = state.paused ? 'Resume recording' : 'Pause recording';
  pause.classList.toggle('on', !!state.paused);
  pause.onclick = async () => {
    await send({ type: 'set-paused', paused: !state.paused });
    renderWorkspace();
  };
  $('open-map-btn').onclick = () => openMap(journey?.id);
  $('open-evidence-btn').onclick = () => openBoard(journey ? { j: journey.id } : {}).finally(() => window.close());
}

function setMenu(open) {
  $('ws-menu').hidden = !open;
  $('ws-toggle').setAttribute('aria-expanded', String(open));
  if (open) renderWorkspaceList();
  else { $('ws-new-name').hidden = true; $('ws-new-btn').hidden = false; }
}
$('ws-toggle').onclick = () => setMenu($('ws-menu').hidden);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('ws-menu').hidden) { e.preventDefault(); setMenu(false); } });

async function renderWorkspaceList() {
  const journeys = (await db.getAll('journeys')).sort(workspaceSort);
  const list = $('ws-list');
  list.textContent = '';
  for (const j of journeys) {
    const pages = (await db.getByIndex('nodes', 'byJourney', j.id)).length;
    const item = document.createElement('button');
    item.className = 'ws-item' + (j.id === state?.activeJourneyId ? ' current' : '');
    item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', String(j.id === state?.activeJourneyId));
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = j.name;
    const count = document.createElement('span');
    count.className = 'count';
    count.textContent = j.id === state?.activeJourneyId ? '✓' : pages ? `${pages} page${pages === 1 ? '' : 's'}` : '';
    item.append(name, count);
    item.onclick = async () => {
      if (j.id !== state?.activeJourneyId) await send({ type: 'switch-workspace', journeyId: j.id });
      setMenu(false);
      renderWorkspace();
      renderResume();
    };
    list.appendChild(item);
  }
}

$('ws-new-btn').onclick = () => {
  $('ws-new-btn').hidden = true;
  $('ws-new-name').hidden = false;
  $('ws-new-name').focus();
};
$('ws-new').onsubmit = async (e) => {
  e.preventDefault();
  const name = $('ws-new-name').value.trim();
  if (!name) { $('ws-new-name').focus(); return; }
  await send({ type: 'create-workspace', name });
  $('ws-new-name').value = '';
  setMenu(false);
  renderWorkspace();
};

// ---------- This page: star, translate ----------

async function renderPage() {
  const tab = await activeTab();
  if (!tab?.url || !/^https?:/.test(tab.url)) return; // browser pages: nothing to do here
  $('page').hidden = false;
  $('page-host').textContent = 'This page · ' + new URL(tab.url).hostname.replace(/^www\./, '');
  renderStar(tab);
  renderTranslate();
}

async function renderStar(tab) {
  const btn = $('star-btn');
  const { starred } = await send({ type: 'star-status', tabId: tab.id });
  btn.classList.toggle('on', !!starred);
  btn.textContent = starred ? '★ Starred' : '☆ Star';
  btn.title = starred ? 'Starred: click to unstar (Alt+S)' : 'Star this page so it’s easy to find again (Alt+S)';
  btn.onclick = async () => {
    const res = await send({ type: 'star-toggle', tabId: tab.id });
    if (res?.error) { btn.textContent = 'Can’t star this page'; btn.title = res.error; return; }
    renderStar(tab);
  };
}

// Amtshelfer talks straight to the content script in the tab's top frame.
// Full controls (glossary, ask the page, settings) live in the side panel.
async function ahSend(msg) {
  const tab = await activeTab();
  if (!tab?.id) return null;
  try { return await chrome.tabs.sendMessage(tab.id, msg, { frameId: 0 }); } catch { return null; }
}

async function renderTranslate() {
  const status = await ahSend({ type: 'status' });
  const btn = $('translate-btn'), more = $('more-btn');
  if (!status) return; // Amtshelfer can't run here (PDF, store page…): just the star
  btn.hidden = false;
  more.hidden = false;
  // One button that always offers the next useful step: translate, then
  // flip between German and English.
  if (status.hidden) {
    btn.textContent = 'Show English';
    btn.title = 'Put the saved English translations back on this page';
    btn.onclick = async () => { await ahSend({ type: 'setTranslationsHidden', value: false }); renderTranslate(); };
  } else if (status.active && status.translated) {
    btn.textContent = 'Show German';
    btn.title = 'Show the original German (your translations stay saved)';
    btn.onclick = async () => { await ahSend({ type: 'setTranslationsHidden', value: true }); renderTranslate(); };
  } else {
    btn.textContent = 'Translate to English';
    btn.title = 'Translate every paragraph on this page, each with its own DE/EN toggle';
    btn.onclick = async () => {
      if (!status.active) await ahSend({ type: 'setOverride', value: 'on' });
      await ahSend({ type: 'pageTranslate' });
      window.close();
    };
  }
  // The rarer controls live behind ⋯.
  const items = [];
  if (status.active && status.translated && !status.hidden) {
    items.push(['Translate the rest of the page', async () => { await ahSend({ type: 'pageTranslate' }); window.close(); }]);
  }
  if (status.hidden && status.translated) {
    items.push(['Reload page (restarts the page’s own scripts)', async () => { const t = await activeTab(); if (t?.id) chrome.tabs.reload(t.id); window.close(); }]);
  }
  items.push([status.active ? 'Turn Amtshelfer off on this site' : 'Turn Amtshelfer on for this site', async () => {
    await ahSend({ type: 'setOverride', value: status.active ? 'off' : 'on' });
    renderTranslate();
  }]);
  const menu = $('more-menu');
  menu.textContent = '';
  for (const [label, run] of items) {
    const b = document.createElement('button');
    b.setAttribute('role', 'menuitem');
    b.textContent = label;
    b.onclick = () => { setMore(false); run(); };
    menu.appendChild(b);
  }
}

function setMore(open) {
  $('more-menu').hidden = !open;
  $('more-btn').setAttribute('aria-expanded', String(open));
}
$('more-btn').onclick = (e) => { e.stopPropagation(); setMore($('more-menu').hidden); };
document.addEventListener('click', (e) => { if (!e.target.closest('.more-wrap')) setMore(false); });

// ---------- Where to go next ----------

// Resume works whatever workspace is active (auto-return may have moved
// you to Scratch) and lands on the exact view you left.
async function renderResume() {
  const last = await lastBoard();
  $('resume-btn').hidden = !last;
  if (!last) return;
  $('resume-title').textContent = last.title === 'What am I trying to establish?' ? 'Untitled question' : last.title;
  $('resume-where').textContent = `${last.journeyName} · Alt+Shift+R`;
  $('resume-btn').onclick = () => resumeBoard().finally(() => window.close());
}

$('panel-btn').onclick = async () => {
  const win = await chrome.windows.getCurrent();
  await chrome.sidePanel.open({ windowId: win.id });
  window.close();
};

// ---------- AI status, in words ----------

async function renderAi() {
  const el = $('ai-status');
  try {
    const status = await send({ type: 'ollama-status' });
    if (status.ok) {
      el.className = 'ai-status ok';
      el.textContent = status.aiPaused ? `AI paused · ${status.pending} queued`
        : status.pending ? `Ollama ready · ${status.pending} queued` : 'Ollama ready';
      return;
    }
  } catch { /* fall through */ }
  el.className = 'ai-status bad';
  el.textContent = 'Ollama not reachable';
  const hint = $('ollama-hint');
  hint.hidden = false;
  hint.innerHTML = 'Summaries queue until it’s back. If Ollama is running, allow the extension, then restart Ollama:<br><code>launchctl setenv OLLAMA_ORIGINS "chrome-extension://*"</code>';
}

renderWorkspace();
renderPage();
renderResume();
renderAi();
