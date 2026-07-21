import * as db from '../lib/db.js';
import { workspaceSort } from '../lib/util.js';

const $ = (id) => document.getElementById(id);

function send(msg) {
  return chrome.runtime.sendMessage(msg);
}

function openMap(journeyId) {
  const url = chrome.runtime.getURL(`journey/journey.html${journeyId ? '?j=' + journeyId : ''}`);
  chrome.tabs.create({ url });
  window.close();
}

async function render() {
  const state = await send({ type: 'get-state' });
  const journey = state.journey;

  $('active-name').textContent = journey ? journey.name : 'Setting up…';
  const c = state.counts || { nodes: 0, edges: 0 };
  $('active-meta').textContent = state.paused
    ? `Paused · ${c.nodes} pages · ${c.edges} connections`
    : `Capturing · ${c.nodes} pages · ${c.edges} connections`;

  $('pause-btn').textContent = state.paused ? 'Resume' : 'Pause';
  $('pause-btn').onclick = async () => {
    await send({ type: 'set-paused', paused: !state.paused });
    render();
  };

  $('panel-btn').onclick = async () => {
    const win = await chrome.windows.getCurrent();
    await chrome.sidePanel.open({ windowId: win.id });
    window.close();
  };
  $('open-map-btn').onclick = () => openMap(journey?.id);

  $('ws-create').onclick = createWorkspace;
  $('ws-name').onkeydown = (e) => {
    if (e.key === 'Enter') createWorkspace();
  };

  renderWorkspaces(journey?.id);
}

async function createWorkspace() {
  const name = $('ws-name').value.trim();
  if (!name) {
    $('ws-name').focus();
    return;
  }
  await send({ type: 'create-workspace', name });
  $('ws-name').value = '';
  render();
}

async function renderWorkspaces(activeId) {
  const journeys = (await db.getAll('journeys')).sort(workspaceSort).slice(0, 10);
  const container = $('ws-list');
  container.textContent = '';
  if (journeys.length < 2) return;

  const label = document.createElement('div');
  label.className = 'past-label';
  label.textContent = 'Switch workspace';
  container.appendChild(label);

  for (const j of journeys) {
    if (j.id === activeId) continue;
    const nodes = await db.getByIndex('nodes', 'byJourney', j.id);
    const item = document.createElement('div');
    item.className = 'past-item';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = j.name;
    const count = document.createElement('span');
    count.className = 'count';
    count.textContent = `${nodes.length} pages`;
    item.append(name, count);
    item.onclick = async () => {
      await send({ type: 'switch-workspace', journeyId: j.id });
      render();
    };
    container.appendChild(item);
  }
}

async function checkOllama() {
  const dot = $('ollama-dot');
  try {
    const status = await send({ type: 'ollama-status' });
    if (status.ok) {
      dot.className = 'dot ok';
      dot.title = status.aiPaused
        ? `Ollama connected · AI paused · ${status.pending} queued`
        : `Ollama connected · ${status.pending} jobs queued`;
    } else {
      dot.className = 'dot bad';
      dot.title = 'Ollama unreachable';
      const hint = $('ollama-hint');
      hint.hidden = false;
      hint.innerHTML =
        'Ollama not reachable — summaries will queue until it is. If Ollama is running, allow extension access:<br><code>launchctl setenv OLLAMA_ORIGINS "chrome-extension://*"</code><br>then restart Ollama.';
    }
  } catch {
    dot.className = 'dot bad';
  }
}

render();
checkOllama();

// ---------- Amtshelfer quick actions ----------
// Talks straight to the Amtshelfer content script in the active tab (top
// frame). Full controls (glossary, ask-the-page, settings) live in the
// side panel's Amtshelfer card.
const AH_TOP = { frameId: 0 };

async function ahSend(msg) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return null;
  try {
    return await chrome.tabs.sendMessage(tab.id, msg, AH_TOP);
  } catch {
    return null;
  }
}

async function renderAmtshelfer() {
  const status = await ahSend({ type: 'status' });
  const toggle = $('ah-toggle-btn');
  const translate = $('ah-translate-btn');
  if (!status) {
    translate.disabled = true;
    translate.title = "Amtshelfer can't run on this page";
    return;
  }
  translate.disabled = !status.active;
  toggle.hidden = false;
  toggle.textContent = status.active ? 'Amtshelfer: on' : 'Amtshelfer: off';
  toggle.title = status.active
    ? 'Disable DE\u2192EN translation on this page'
    : 'Enable DE\u2192EN translation on this page';
  toggle.onclick = async () => {
    await ahSend({ type: 'setOverride', value: status.active ? 'off' : 'on' });
    renderAmtshelfer();
  };
}

$('ah-translate-btn').onclick = async () => {
  await ahSend({ type: 'pageTranslate' });
  window.close();
};

renderAmtshelfer();
