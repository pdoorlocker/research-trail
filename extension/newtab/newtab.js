// Research Trail — new tab page: the ambush point for research tangents.
// Every tangent starts with a new tab, so this is where you get one gentle
// prompt to scope it into a workspace before you wander off and forget.

import * as db from '../lib/db.js';
import { workspaceSort } from '../lib/util.js';

const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);

function tick() {
  $('clock').textContent = new Date().toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  });
}
tick();
setInterval(tick, 15000);

async function openPanel() {
  const win = await chrome.windows.getCurrent();
  await chrome.sidePanel.open({ windowId: win.id });
}

async function start() {
  const name = $('ws-name').value.trim();
  if (!name) {
    $('ws-name').focus();
    return;
  }
  await send({ type: 'create-workspace', name });
  const started = $('started');
  started.hidden = false;
  started.textContent = `“${name}” is live — everything you browse now lands on its map.`;
  $('ws-name').value = '';
  await openPanel();
  render();
}

async function render() {
  const state = await send({ type: 'get-state' });
  const journey = state.journey;

  $('current-name').textContent = journey ? journey.name : '…';
  const c = state.counts || { nodes: 0, edges: 0 };
  $('current-meta').textContent =
    `${c.nodes} page${c.nodes === 1 ? '' : 's'} · ${c.edges} connection${c.edges === 1 ? '' : 's'}`;
  if (journey) $('map-link').href = `../journey/journey.html?j=${journey.id}`;

  const pausedNote = $('paused-note');
  pausedNote.hidden = !state.paused;
  $('resume-btn').onclick = async () => {
    await send({ type: 'set-paused', paused: false });
    render();
  };

  // Recent workspaces as one-click switch chips.
  const list = $('ws-list');
  list.textContent = '';
  const journeys = (await db.getAll('journeys'))
    .sort(workspaceSort)
    .filter((j) => j.id !== journey?.id)
    .slice(0, 6);
  if (journeys.length) {
    const label = document.createElement('div');
    label.className = 'ws-label';
    label.textContent = 'Switch workspace';
    list.appendChild(label);
    for (const j of journeys) {
      const chip = document.createElement('button');
      chip.textContent = j.name;
      chip.onclick = async () => {
        await send({ type: 'switch-workspace', journeyId: j.id });
        await openPanel();
        render();
      };
      list.appendChild(chip);
    }
  }
}

$('start-btn').onclick = start;
$('ws-name').onkeydown = (e) => {
  if (e.key === 'Enter') start();
};
$('panel-btn').onclick = openPanel;

render();
