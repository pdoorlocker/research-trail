// Amtshelfer card for the Research Trail side panel: page-level actions
// (translate / gists / ask-this-page), the per-page on/off override, the
// glossary, and the module's few settings. Talks straight to the content
// script in the active tab (top frame) — same protocol the standalone
// popup used.

import { getSettings, saveSettings } from '../lib/util.js';

const TOP = { frameId: 0 };

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function sendToPage(msg) {
  const tab = await activeTab();
  if (!tab?.id) return null;
  try {
    return await chrome.tabs.sendMessage(tab.id, msg, TOP);
  } catch {
    return null;
  }
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

export function mountAmtshelferCard(container) {
  container.textContent = '';

  const summaryRow = el('div', 'ah-card-head');
  summaryRow.append(el('span', 'ah-card-title', 'Amtshelfer · DE→EN'));
  const statusText = el('span', 'ah-card-status', '');
  summaryRow.append(statusText);
  container.append(summaryRow);

  // --- per-page status + toggle ---
  const statusRow = el('div', 'ah-card-row');
  const toggleBtn = el('button', 'ah-card-btn', '…');
  statusRow.append(toggleBtn);
  container.append(statusRow);

  // Action feedback — a silent no-op reads as "broken", so every page
  // action reports what actually happened.
  const note = el('div', 'ah-card-muted');
  note.hidden = true;
  container.append(note);
  let noteTimer = null;
  function flash(text) {
    note.textContent = text;
    note.hidden = false;
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => { note.hidden = true; }, 4000);
  }

  async function pageAction(msg) {
    const res = await sendToPage(msg);
    if (res === null) flash("Amtshelfer can't run on this page (browser-internal or blocked).");
    else if (res.inactive) flash('Amtshelfer is off on this page — use "Enable on this page" above.');
    return res;
  }

  async function renderStatus() {
    const status = await sendToPage({ type: 'status' });
    if (!status) {
      statusText.textContent = 'n/a on this page';
      toggleBtn.hidden = true;
      return;
    }
    toggleBtn.hidden = false;
    statusText.textContent = status.active ? 'on' : 'off';
    toggleBtn.textContent = status.active ? 'Disable on this page' : 'Enable on this page';
    toggleBtn.onclick = async () => {
      const res = await sendToPage({ type: 'setOverride', value: status.active ? 'off' : 'on' });
      if (res === null) flash('Lost contact with the page — reload the tab and try again.');
      else if (!status.active && !res.active) flash('Could not activate — reload the tab and try again.');
      renderStatus();
    };
  }

  // --- ask-this-page ---
  const askRow = el('div', 'ah-card-row');
  const askInput = el('input', 'ah-card-input');
  askInput.type = 'text';
  askInput.placeholder = 'Ask this page… ("which documents do I need?")';
  const askBtn = el('button', 'ah-card-btn ah-card-btn-accent', 'Ask');
  const ask = async () => {
    const q = askInput.value.trim();
    if (!q) return;
    askInput.value = '';
    await pageAction({ type: 'pageAsk', q });
  };
  askBtn.onclick = ask;
  askInput.onkeydown = (e) => { if (e.key === 'Enter') ask(); };
  askRow.append(askInput, askBtn);
  container.append(askRow);

  // --- page actions ---
  const actionsRow = el('div', 'ah-card-row');
  const translateBtn = el('button', 'ah-card-btn ah-card-btn-primary', 'Translate page');
  translateBtn.onclick = () => pageAction({ type: 'pageTranslate' });
  const gistsBtn = el('button', 'ah-card-btn', 'AI gists');
  gistsBtn.title = 'One local-model pass over the whole page; a one-line English gist appears under each paragraph';
  gistsBtn.onclick = () => pageAction({ type: 'pageGists' });
  actionsRow.append(translateBtn, gistsBtn);
  container.append(actionsRow);

  // --- glossary ---
  const glossaryDetails = el('details', 'ah-card-sub');
  glossaryDetails.append(el('summary', null, 'Glossary'));
  const glossaryList = el('div', 'ah-card-glossary');
  glossaryDetails.append(glossaryList);
  container.append(glossaryDetails);

  async function renderGlossary() {
    const { glossary = {} } = await chrome.storage.local.get('glossary');
    glossaryList.textContent = '';
    const terms = Object.entries(glossary).sort((a, b) => (b[1].ts || 0) - (a[1].ts || 0));
    if (!terms.length) {
      glossaryList.append(el('div', 'ah-card-muted',
        'No terms yet. Select a German word on a page and click ＋ Glossary.'));
      return;
    }
    for (const [term, info] of terms) {
      const row = el('div', 'ah-card-glossary-row');
      row.append(el('span', 'ah-card-glossary-term', term));
      row.append(el('span', 'ah-card-glossary-en', info.translation || ''));
      const del = el('button', 'ah-card-glossary-del', '×');
      del.title = 'Remove term';
      del.onclick = async () => {
        const { glossary: g = {} } = await chrome.storage.local.get('glossary');
        delete g[term];
        await chrome.storage.local.set({ glossary: g });
        renderGlossary();
      };
      row.append(del);
      glossaryList.append(row);
    }
  }

  // --- settings ---
  const settingsDetails = el('details', 'ah-card-sub');
  settingsDetails.append(el('summary', null, 'Amtshelfer settings'));
  const settingsBody = el('div', 'ah-card-settings');
  settingsDetails.append(settingsBody);
  container.append(settingsDetails);

  async function renderSettings() {
    const s = await getSettings();
    settingsBody.textContent = '';

    const mkSelect = (label, key, options, current) => {
      const row = el('label', 'ah-card-setting');
      row.append(el('span', null, label));
      const select = document.createElement('select');
      for (const [value, text] of options) {
        const o = document.createElement('option');
        o.value = value;
        o.textContent = text;
        if (value === current) o.selected = true;
        select.append(o);
      }
      select.onchange = () => saveSettings({ [key]: select.value });
      row.append(select);
      return row;
    };

    settingsBody.append(mkSelect('Translate with', 'translateBackend', [
      ['chrome', 'On-device (Chrome)'],
      ['ollama', 'Ollama (trail model)'],
    ], s.translateBackend || 'chrome'));
    settingsBody.append(mkSelect('Explain with', 'explainBackend', [
      ['ollama', 'Ollama (trail model)'],
      ['gemini', 'Gemini (needs key)'],
    ], s.explainBackend || 'ollama'));

    const keyRow = el('label', 'ah-card-setting');
    keyRow.append(el('span', null, 'Gemini key'));
    const keyInput = document.createElement('input');
    keyInput.type = 'password';
    keyInput.placeholder = 'optional';
    keyInput.value = s.geminiKey || '';
    keyInput.onchange = () => saveSettings({ geminiKey: keyInput.value.trim() });
    keyRow.append(keyInput);
    settingsBody.append(keyRow);

    // Data import from the standalone Amtshelfer extension's export file.
    const importRow = el('div', 'ah-card-setting');
    const importBtn = el('button', 'ah-card-btn', 'Import Amtshelfer export…');
    importBtn.title = 'Restore glossary, saved translations, and per-page overrides exported from the standalone Amtshelfer extension';
    const file = document.createElement('input');
    file.type = 'file';
    file.accept = '.json,application/json';
    file.hidden = true;
    importBtn.onclick = () => file.click();
    file.onchange = async () => {
      const f = file.files?.[0];
      if (!f) return;
      try {
        const data = JSON.parse(await f.text());
        const patch = {};
        if (data.pages) patch.pages = data.pages;
        if (data.glossary) patch.glossary = data.glossary;
        if (data.overrides) patch.overrides = data.overrides;
        await chrome.storage.local.set(patch);
        // Only the module's own settings cross over — never the trail's.
        const s2 = data.settings || {};
        await saveSettings({
          ...(s2.translateBackend ? { translateBackend: s2.translateBackend } : {}),
          ...(s2.explainBackend ? { explainBackend: s2.explainBackend } : {}),
          ...(s2.geminiKey ? { geminiKey: s2.geminiKey } : {}),
        });
        importBtn.textContent = 'Imported ✓';
        renderGlossary();
      } catch {
        importBtn.textContent = 'Import failed — not an Amtshelfer export';
      }
    };
    importRow.append(importBtn, file);
    settingsBody.append(importRow);
  }

  renderStatus();
  renderGlossary();
  renderSettings();
  // Follow tab switches so the per-page toggle always describes the tab
  // the user is looking at.
  chrome.tabs.onActivated.addListener(renderStatus);
  chrome.tabs.onUpdated.addListener((_id, info) => {
    if (info.status === 'complete') renderStatus();
  });
}
