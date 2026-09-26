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
  container.classList.add('ah-card');

  // One translate button that always offers the next step (same as the
  // popup), with the rarer page controls behind ⋯, then "ask this page".
  const row = el('div', 'ah-card-row');
  const translateBtn = el('button', 'ah-card-btn ah-card-main', 'Translate to English');
  const moreWrap = el('div', 'ah-card-more');
  const moreBtn = el('button', 'ah-card-btn ah-card-icon', '⋯');
  moreBtn.setAttribute('aria-label', 'More translation options');
  moreBtn.setAttribute('aria-haspopup', 'menu');
  const moreMenu = el('div', 'ah-card-menu');
  moreMenu.setAttribute('role', 'menu');
  moreMenu.hidden = true;
  moreWrap.append(moreBtn, moreMenu);
  row.append(translateBtn, moreWrap);
  container.append(row);
  moreBtn.onclick = (e) => { e.stopPropagation(); moreMenu.hidden = !moreMenu.hidden; };
  document.addEventListener('click', (e) => { if (!moreWrap.contains(e.target)) moreMenu.hidden = true; });

  const askRow = el('form', 'ah-card-row');
  const askInput = el('input', 'ah-card-input');
  askInput.type = 'text';
  askInput.placeholder = 'Ask this page: which documents do I need?';
  askInput.setAttribute('aria-label', 'Ask this page');
  askRow.append(askInput);
  container.append(askRow);

  // Action feedback: a silent no-op reads as "broken", so every page action
  // reports what actually happened.
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
    if (res === null) flash('Translation can’t run on this page.');
    else if (res.inactive) flash('Translation is off on this site. Turn it on under ⋯.');
    return res;
  }

  askRow.onsubmit = async (e) => {
    e.preventDefault();
    const q = askInput.value.trim();
    if (!q) return;
    askInput.value = '';
    const res = await pageAction({ type: 'pageAsk', q });
    if (res && !res.inactive) flash('Asking… the answer appears on the page.');
  };

  async function renderStatus() {
    const status = await sendToPage({ type: 'status' });
    container.hidden = !status; // pages it can't run on: nothing to offer
    if (!status) return;
    if (status.hidden) {
      translateBtn.textContent = 'Show English';
      translateBtn.title = 'Put the saved English translations back on this page';
      translateBtn.onclick = async () => { await sendToPage({ type: 'setTranslationsHidden', value: false }); renderStatus(); };
    } else if (status.active && status.translated) {
      translateBtn.textContent = 'Show German';
      translateBtn.title = 'Show the original German (your translations stay saved)';
      translateBtn.onclick = async () => { await sendToPage({ type: 'setTranslationsHidden', value: true }); renderStatus(); };
    } else {
      translateBtn.textContent = 'Translate to English';
      translateBtn.title = 'Translate every paragraph on this page, each with its own DE/EN toggle';
      translateBtn.onclick = async () => {
        if (!status.active) await sendToPage({ type: 'setOverride', value: 'on' });
        await pageAction({ type: 'pageTranslate' });
        setTimeout(renderStatus, 800);
      };
    }
    const items = [];
    if (status.active && status.translated && !status.hidden) items.push(['Translate the rest of the page', () => pageAction({ type: 'pageTranslate' })]);
    if (status.active) items.push(['Add a one-line gist under each paragraph', () => pageAction({ type: 'pageGists' })]);
    if (status.hidden && status.translated) {
      items.push(['Reload page (restarts the page’s own scripts)', async () => { const tab = await activeTab(); if (tab?.id) chrome.tabs.reload(tab.id); }]);
    }
    items.push([status.active ? 'Turn translation off on this site' : 'Turn translation on for this site', async () => {
      const res = await sendToPage({ type: 'setOverride', value: status.active ? 'off' : 'on' });
      if (res === null) flash('Lost contact with the page. Reload the tab and try again.');
      renderStatus();
    }]);
    moreMenu.textContent = '';
    for (const [label, run] of items) {
      const b = el('button', null, label);
      b.setAttribute('role', 'menuitem');
      b.onclick = () => { moreMenu.hidden = true; run(); };
      moreMenu.append(b);
    }
  }

  // --- glossary (rendered into the panel's sheet on request) ---
  let glossaryList = null;
  async function renderGlossary(body) {
    if (body) { glossaryList = el('div', 'ah-card-glossary'); body.append(glossaryList); }
    if (!glossaryList?.isConnected) return;
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

  // --- settings (rendered into the panel's sheet on request) ---
  async function renderSettings(body) {
    const settingsBody = el('div', 'ah-card-settings');
    body.append(settingsBody);
    const s = await getSettings();

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
      ['chrome', 'On-device (Chrome only, not Brave)'],
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
  // Follow tab switches so the per-page toggle always describes the tab
  // the user is looking at.
  chrome.tabs.onActivated.addListener(renderStatus);
  chrome.tabs.onUpdated.addListener((_id, info) => {
    if (info.status === 'complete') renderStatus();
  });
  return { renderGlossary, renderSettings };
}
