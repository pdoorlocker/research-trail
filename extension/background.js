// Research Trail — background service worker.
//
// Responsibilities:
//  - track navigation while a journey is active and build the node/edge graph
//  - account time-on-page for the focused tab
//  - inject the capture script to extract readable text
//  - run the Ollama job queue (summaries, embeddings, connection labels, synthesis)

import * as db from './lib/db.js';
import {
  canonicalUrl, hostOf, baseDomain, isCapturable, uid, cosine, truncate, getSettings,
} from './lib/util.js';
import * as ollama from './lib/ollama.js';

const MAX_JOB_ATTEMPTS = 4;

// ---------- Session state helpers ----------
// All cross-event state lives in chrome.storage.session so it survives
// service-worker restarts (and clears when the browser closes).

async function sget(key, fallback) {
  const obj = await chrome.storage.session.get(key);
  return obj[key] ?? fallback;
}
async function sset(key, value) {
  await chrome.storage.session.set({ [key]: value });
}

async function getActive() {
  const { activeJourneyId = null, paused = false } = await chrome.storage.local.get([
    'activeJourneyId', 'paused',
  ]);
  return { activeJourneyId, paused };
}

// ---------- Badge & context menu ----------

async function refreshBadge() {
  // Always-on model: capturing is the normal state, so only the exception
  // (paused) gets a badge.
  const { paused } = await getActive();
  if (paused) {
    await chrome.action.setBadgeText({ text: '❚❚' });
    await chrome.action.setBadgeBackgroundColor({ color: '#b08a00' });
  } else {
    await chrome.action.setBadgeText({ text: '' });
  }
}

function setupContextMenu() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'save-highlight',
      title: 'Save highlight to Research Trail',
      contexts: ['selection'],
    });
  });
}

// Always-on model: there is always a current workspace. If none is active
// (first run, or the old journey model left it unset), fall back to an
// existing workspace or create "Scratch".
async function ensureActiveWorkspace() {
  const { activeJourneyId } = await getActive();
  if (activeJourneyId && (await db.get('journeys', activeJourneyId))) return activeJourneyId;
  const all = (await db.getAll('journeys')).sort((a, b) => b.createdAt - a.createdAt);
  let ws = all[0];
  if (!ws) {
    ws = {
      id: uid(), name: 'Scratch', kind: 'scratch', status: 'active',
      createdAt: Date.now(), endedAt: null, synthesis: null,
    };
    await db.put('journeys', ws);
  }
  await chrome.storage.local.set({ activeJourneyId: ws.id });
  await refreshBadge();
  return ws.id;
}

// Scratch is the catch-all workspace ambient browsing lands in. (Name-based
// fallback covers Scratch journeys created before the `kind` flag existed.)
function isScratch(j) {
  return j?.kind === 'scratch' || j?.name === 'Scratch';
}

async function ensureScratch() {
  const all = await db.getAll('journeys');
  let s = all.find(isScratch);
  if (!s) {
    s = {
      id: uid(), name: 'Scratch', kind: 'scratch', status: 'active',
      createdAt: Date.now(), endedAt: null, synthesis: null,
    };
    await db.put('journeys', s);
  }
  return s.id;
}

// After a browser restart, re-associate already-open tabs with their nodes
// so the panel can light them up without waiting for a navigation — and put
// them straight into the workspace's tab group.
async function rebuildTabState() {
  const journeyId = await ensureActiveWorkspace();
  const tabs = await chrome.tabs.query({});
  const tabState = {};
  for (const tab of tabs) {
    if (!tab.url || tab.incognito) continue;
    const canon = canonicalUrl(tab.url);
    const node = await db.getOneByIndex('nodes', 'byJourneyUrl', [journeyId, canon]);
    if (node) tabState[tab.id] = { nodeId: node.id, url: canon };
  }
  await sset('tabState', tabState);
  const settings = await getSettings();
  if (settings.tabGroupSync) {
    for (const tabId of Object.keys(tabState)) {
      await ensureTabInWorkspaceGroup(Number(tabId), journeyId);
    }
  }
  notifyTabsUpdated();
}

// Capture an already-open tab into a workspace without any navigation —
// used when a workspace is created (adopt the tab you're on) and when a tab
// is dragged into the workspace's tab group by hand.
async function adoptTab(tab, journeyId) {
  const settings = await getSettings();
  if (!tab?.id || !tab.url || tab.incognito || !isCapturable(tab.url, settings.blocklist)) return false;
  const canon = canonicalUrl(tab.url);
  const node = await upsertNode(journeyId, canon, tab.url);
  if (!node.title && tab.title) node.title = tab.title;
  if (!node.visits.length) node.visits.push({ at: Date.now(), from: null });
  await db.put('nodes', node);
  const tabState = await sget('tabState', {});
  tabState[tab.id] = { nodeId: node.id, url: canon };
  await sset('tabState', tabState);
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['vendor/Readability.js', 'capture.js'],
    });
  } catch { /* not scriptable (PDF viewer etc.) — keep the bare node */ }
  await ensureTabInWorkspaceGroup(tab.id, journeyId);
  maybeCaptureThumb(tab.id, node.id);
  // Adopting a tab is deliberate workspace activity — reset the quiet-gap
  // clock so auto-return doesn't fire right after.
  await chrome.storage.local.set({ lastCaptureAt: Date.now() });
  notifyTrailUpdated(journeyId);
  notifyTabsUpdated();
  return true;
}

function onBoot() {
  setupContextMenu();
  refreshBadge();
  chrome.alarms.create('process-jobs', { periodInMinutes: 1 });
  ensureActiveWorkspace();
  // Scratch must always exist — it's the escape hatch every workspace list
  // pins first, and auto-return's destination. Installs that predate the
  // Scratch concept never had one.
  ensureScratch();
}
chrome.runtime.onInstalled.addListener(onBoot);
chrome.runtime.onStartup.addListener(() => {
  onBoot();
  rebuildTabState();
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'open-panel') {
    const win = await chrome.windows.getLastFocused();
    chrome.sidePanel.open({ windowId: win.id });
  }
});

// Broadcasts are coalesced: navigation and tab events can fire in bursts,
// and every message makes the map/panel reload and hit browser-process APIs.
let tabsNotifyTimer = null;
function notifyTabsUpdated() {
  if (tabsNotifyTimer) return;
  tabsNotifyTimer = setTimeout(() => {
    tabsNotifyTimer = null;
    chrome.runtime.sendMessage({ type: 'tabs-updated' }).catch(() => {});
  }, 300);
}

async function switchWorkspace(journeyId) {
  await flushFocusTime();
  await setFocus(null, null);
  await sset('openers', {});
  await chrome.storage.local.set({ activeJourneyId: journeyId, paused: false });
  await refreshBadge();
  // Re-associate open tabs with this workspace's nodes (where they exist).
  await rebuildTabState();
  // Mirror in the tab strip: collapse other workspaces' groups, expand this one.
  const settings = await getSettings();
  if (settings.tabGroupSync) {
    const wsGroups = await sget('wsGroups', {});
    for (const [key, gid] of Object.entries(wsGroups)) {
      const jid = key.slice(key.indexOf(':') + 1);
      try {
        await chrome.tabGroups.update(gid, { collapsed: jid !== journeyId });
      } catch { /* group already gone */ }
    }
  }
  notifyTrailUpdated(journeyId);
}

// ---------- Native tab-group mirroring ----------
// The active workspace shows up in the tab strip as a real tab group:
// captured tabs join it, its name/color identify the workspace, and dragging
// a tab into the group by hand is an explicit "add this page to the map".

const GROUP_COLORS = ['blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange', 'grey'];

function groupColorFor(journeyId) {
  let h = 0;
  for (const ch of journeyId) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return GROUP_COLORS[h % GROUP_COLORS.length];
}

async function ensureTabInWorkspaceGroup(tabId, journeyId) {
  const settings = await getSettings();
  if (!settings.tabGroupSync) return;
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return;
  }
  if (tab.pinned || tab.incognito) return;
  const wsGroups = await sget('wsGroups', {});
  const key = `${tab.windowId}:${journeyId}`;
  const ourGroupIds = new Set(Object.values(wsGroups));
  // Never yank a tab out of a group the user made themselves.
  if (tab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE && !ourGroupIds.has(tab.groupId)) return;
  let groupId = wsGroups[key];
  if (groupId != null) {
    try {
      await chrome.tabGroups.get(groupId);
    } catch {
      groupId = null;
    }
  }
  if (groupId != null && tab.groupId === groupId) return;
  try {
    if (groupId != null) {
      await chrome.tabs.group({ tabIds: tabId, groupId });
    } else {
      const journey = await db.get('journeys', journeyId);
      groupId = await chrome.tabs.group({ tabIds: tabId, createProperties: { windowId: tab.windowId } });
      await chrome.tabGroups.update(groupId, {
        title: journey?.name || 'Research Trail',
        color: groupColorFor(journeyId),
      });
      wsGroups[key] = groupId;
      await sset('wsGroups', wsGroups);
    }
  } catch { /* window closing or group racing away — next navigation retries */ }
}

chrome.tabGroups.onRemoved.addListener(async (group) => {
  const wsGroups = await sget('wsGroups', {});
  let changed = false;
  for (const [key, gid] of Object.entries(wsGroups)) {
    if (gid === group.id) {
      delete wsGroups[key];
      changed = true;
    }
  }
  if (changed) await sset('wsGroups', wsGroups);
});

// Dragging a tab into the workspace's group by hand = "capture this page".
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.groupId === undefined || changeInfo.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE) return;
  const wsGroups = await sget('wsGroups', {});
  const entry = Object.entries(wsGroups).find(([, gid]) => gid === changeInfo.groupId);
  if (!entry) return;
  const journeyId = entry[0].slice(entry[0].indexOf(':') + 1);
  const { activeJourneyId, paused } = await getActive();
  if (paused || journeyId !== activeJourneyId) return;
  const tabState = await sget('tabState', {});
  if (tabState[tabId]?.nodeId) return; // already on the map
  await adoptTab(tab, journeyId);
});

// ---------- Time-on-page accounting ----------
// `focus` = { tabId, nodeId, since } for the currently focused, captured tab.

async function flushFocusTime() {
  const focus = await sget('focus', null);
  if (focus?.nodeId && focus.since) {
    const dur = (Date.now() - focus.since) / 1000;
    // Ignore sub-second blips and absurd gaps (sleep, forgotten tabs).
    if (dur >= 1 && dur < 4 * 60 * 60) {
      await db.update('nodes', focus.nodeId, (n) => {
        n.timeSpent = (n.timeSpent || 0) + dur;
        return n;
      });
    }
  }
}

async function setFocus(tabId, nodeId) {
  await sset('focus', nodeId ? { tabId, nodeId, since: Date.now() } : null);
}

async function refocusTab(tabId) {
  await flushFocusTime();
  const tabState = await sget('tabState', {});
  await setFocus(tabId, tabState[tabId]?.nodeId || null);
}

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  await refocusTab(tabId);
  const tabState = await sget('tabState', {});
  if (tabState[tabId]?.nodeId) maybeCaptureThumb(tabId, tabState[tabId].nodeId);
  notifyTabsUpdated();
});

chrome.windows.onFocusChanged.addListener(async (windowId) => {
  await flushFocusTime();
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    await setFocus(null, null);
    return;
  }
  const [tab] = await chrome.tabs.query({ active: true, windowId });
  if (tab) await refocusTab(tab.id);
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const focus = await sget('focus', null);
  if (focus?.tabId === tabId) {
    await flushFocusTime();
    await setFocus(null, null);
  }
  const tabState = await sget('tabState', {});
  if (tabState[tabId]) {
    delete tabState[tabId];
    await sset('tabState', tabState);
  }
  notifyTabsUpdated();
});

// ---------- Navigation capture ----------

// A link opened in a new tab: remember which node it branched from.
chrome.webNavigation.onCreatedNavigationTarget.addListener(async (details) => {
  const tabState = await sget('tabState', {});
  const sourceNode = tabState[details.sourceTabId]?.nodeId;
  if (sourceNode) {
    const openers = await sget('openers', {});
    openers[details.tabId] = sourceNode;
    await sset('openers', openers);
  }
});

chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId !== 0) return;
  handleNavigation(details).catch((e) => console.error('onCommitted', e));
});

// SPA navigations (History API) — treated as in-tab link navigations.
chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
  if (details.frameId !== 0) return;
  handleNavigation({ ...details, transitionType: 'link' }).catch((e) =>
    console.error('onHistoryStateUpdated', e),
  );
});

async function handleNavigation(details) {
  const { tabId, url, transitionType } = details;
  const { activeJourneyId, paused } = await getActive();
  const focus = await sget('focus', null);
  let tabState = await sget('tabState', {});
  const canon = canonicalUrl(url);

  // Same-page navigation (hash change, canonical-equal SPA update): nothing to do.
  if (tabState[tabId]?.url === canon) return;

  if (focus?.tabId === tabId) await flushFocusTime();

  const settings = await getSettings();
  if (!activeJourneyId || paused || !isCapturable(url, settings.blocklist)) {
    delete tabState[tabId];
    await sset('tabState', tabState);
    if (focus?.tabId === tabId) await setFocus(tabId, null);
    notifyTabsUpdated();
    return;
  }

  // Never capture incognito, even if the user enabled the extension there.
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.incognito) return;
  } catch {
    return; // tab already gone
  }

  const prevNodeId = tabState[tabId]?.nodeId || null;
  const openers = await sget('openers', {});
  const cameFromTracked = !!openers[tabId]
    || (prevNodeId && ['link', 'form_submit', 'client_redirect', 'server_redirect'].includes(transitionType));

  // Auto-return to Scratch: a fresh entry point (typed URL, search, new tab
  // — NOT a link clicked from a tracked page) after a long quiet stretch
  // means the named-workspace session is over; ambient browsing belongs in
  // Scratch, not in whatever workspace happened to be left active. Clicking
  // onward from a workspace page never triggers this, no matter how long
  // you spent reading.
  let journeyId = activeJourneyId;
  if (!cameFromTracked) {
    const gapMs = (settings.autoReturnMinutes ?? 30) * 60 * 1000;
    const { lastCaptureAt = 0 } = await chrome.storage.local.get('lastCaptureAt');
    if (gapMs > 0 && lastCaptureAt && Date.now() - lastCaptureAt > gapMs) {
      const active = await db.get('journeys', activeJourneyId);
      if (active && !isScratch(active)) {
        journeyId = await ensureScratch();
        await switchWorkspace(journeyId);
        // switchWorkspace rebuilt the tab bookkeeping for Scratch — our
        // local copy is stale; re-read before we write to it below.
        tabState = await sget('tabState', {});
      }
    }
  }
  await chrome.storage.local.set({ lastCaptureAt: Date.now() });

  const node = await upsertNode(journeyId, canon, url);

  // Work out where this page came from.
  let edgeFrom = null;
  let edgeType = null;
  if (openers[tabId]) {
    edgeFrom = openers[tabId];
    edgeType = 'branched';
    delete openers[tabId];
    await sset('openers', openers);
  } else if (prevNodeId && ['link', 'form_submit', 'client_redirect', 'server_redirect'].includes(transitionType)) {
    edgeFrom = prevNodeId;
    edgeType = 'navigated';
  }
  if (edgeFrom && edgeFrom !== node.id) {
    await upsertEdge(journeyId, edgeFrom, node.id, edgeType);
  }

  node.visits.push({ at: Date.now(), from: edgeFrom });
  await db.put('nodes', node);

  tabState[tabId] = { nodeId: node.id, url: canon };
  await sset('tabState', tabState);
  if (!focus || focus.tabId === tabId) await setFocus(tabId, node.id);

  ensureTabInWorkspaceGroup(tabId, journeyId).catch(() => {});
  notifyTrailUpdated(journeyId);
}

async function upsertNode(journeyId, canon, rawUrl) {
  const existing = await db.getOneByIndex('nodes', 'byJourneyUrl', [journeyId, canon]);
  if (existing) return existing;
  const node = {
    id: uid(),
    journeyId,
    url: canon,
    host: hostOf(rawUrl),
    title: '',
    excerpt: '',
    text: '',
    visits: [],
    timeSpent: 0,
    summary: [],
    tags: [],
    embedding: null,
    notes: '',
    highlights: [],
    createdAt: Date.now(),
  };
  await db.put('nodes', node);
  return node;
}

async function upsertEdge(journeyId, from, to, type, label = '') {
  const existing = await db.getOneByIndex('edges', 'byJourneyPair', [journeyId, from, to, type]);
  if (existing) {
    existing.count += 1;
    await db.put('edges', existing);
    return existing;
  }
  const edge = { id: uid(), journeyId, from, to, type, label, count: 1, createdAt: Date.now() };
  await db.put('edges', edge);
  return edge;
}

// Once the page finishes loading, extract its readable text.
chrome.webNavigation.onCompleted.addListener(async (details) => {
  if (details.frameId !== 0) return;
  const { activeJourneyId, paused } = await getActive();
  if (!activeJourneyId || paused) return;
  const tabState = await sget('tabState', {});
  if (!tabState[details.tabId]) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId: details.tabId },
      files: ['vendor/Readability.js', 'capture.js'],
    });
  } catch {
    // Page not scriptable (PDF viewer, CSP-restricted, etc.) — fine, we keep the bare node.
  }
  const entry = tabState[details.tabId];
  if (entry?.nodeId) maybeCaptureThumb(details.tabId, entry.nodeId);
});

// ---------- Moving pages between workspaces ----------
// Relocates pages with everything attached to them. Edges fully inside the
// moved set travel along; edges straddling the boundary are dropped
// (cross-workspace edges aren't a thing). Pending AI jobs follow their page.

async function moveNodes(nodeIds, toJourneyId) {
  const idSet = new Set(nodeIds);
  let fromJourneyId = null;
  for (const id of nodeIds) {
    const n = await db.get('nodes', id);
    if (!n) continue;
    fromJourneyId = n.journeyId;
    await db.update('nodes', id, (x) => {
      x.journeyId = toJourneyId;
      delete x.topicId; // topic assignments are per-workspace
      return x;
    });
  }
  if (!fromJourneyId) return null;
  const edges = await db.getByIndex('edges', 'byJourney', fromJourneyId);
  for (const e of edges) {
    const a = idSet.has(e.from);
    const b = idSet.has(e.to);
    if (a && b) {
      await db.update('edges', e.id, (x) => {
        x.journeyId = toJourneyId;
        return x;
      });
    } else if (a || b) {
      await db.remove('edges', e.id);
    }
  }
  const jobs = await db.getByIndex('jobs', 'byJourney', fromJourneyId);
  for (const j of jobs) {
    if (j.nodeId && idSet.has(j.nodeId)) {
      await db.update('jobs', j.id, (x) => {
        x.journeyId = toJourneyId;
        return x;
      });
    }
  }
  // Landing in a real workspace makes these pages intentional research —
  // backfill the summaries that Scratch-lite skipped (hooks follow via the
  // summarize→hooks chain). This is the one choke point behind topic
  // promotion, split acceptance, and manual moves.
  const dest = await db.get('journeys', toJourneyId);
  if (dest && !isScratch(dest)) {
    let queued = 0;
    for (const id of nodeIds) {
      const n = await db.get('nodes', id);
      if (n && !n.summary?.length && (n.text || n.excerpt)) {
        await enqueueJob(toJourneyId, 'summarize', n.id);
        queued++;
      }
    }
    if (queued) kickQueue();
  }
  notifyTrailUpdated(fromJourneyId);
  notifyTrailUpdated(toJourneyId);
  notifyTabsUpdated();
  return fromJourneyId;
}

async function createWorkspace(name) {
  const journey = {
    id: uid(),
    name: (name || 'Untitled workspace').trim() || 'Untitled workspace',
    status: 'active',
    createdAt: Date.now(),
    endedAt: null,
    synthesis: null,
  };
  await db.put('journeys', journey);
  return journey;
}

// ---------- Page thumbnails ----------
// A small screenshot makes pages recognizable at a glance. We can only
// capture the visible tab, so we shoot when a captured page finishes loading
// in the active tab, or when a background tab gets its first activation.

async function maybeCaptureThumb(tabId, nodeId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab.active || tab.incognito) return;
    const node = await db.get('nodes', nodeId);
    if (!node || node.thumb) return;
    await sleep(700); // let the page paint
    const [nowActive] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
    if (nowActive?.id !== tabId) return; // user already moved on
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 60 });
    const thumb = await downscaleThumb(dataUrl, 360);
    await db.update('nodes', nodeId, (n) => {
      n.thumb = thumb;
      return n;
    });
    notifyTrailUpdated(node.journeyId);
  } catch { /* rate-limited or tab gone — a later visit will catch it */ }
}

async function downscaleThumb(dataUrl, width) {
  const blob = await (await fetch(dataUrl)).blob();
  const bmp = await createImageBitmap(blob);
  const scale = width / bmp.width;
  const canvas = new OffscreenCanvas(width, Math.max(1, Math.round(bmp.height * scale)));
  canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
  const out = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.7 });
  const bytes = new Uint8Array(await out.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return `data:image/jpeg;base64,${btoa(bin)}`;
}

// ---------- Highlights ----------

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'save-highlight' || !info.selectionText || !tab?.url) return;
  const { activeJourneyId } = await getActive();
  if (!activeJourneyId) return;
  const canon = canonicalUrl(tab.url);
  let node = await db.getOneByIndex('nodes', 'byJourneyUrl', [activeJourneyId, canon]);
  if (!node) node = await upsertNode(activeJourneyId, canon, tab.url);
  node.highlights.push({ text: info.selectionText.trim(), at: Date.now() });
  if (!node.title && tab.title) node.title = tab.title;
  await db.put('nodes', node);
  notifyTrailUpdated(activeJourneyId);
});

// ---------- Messages ----------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg, sender)
    .then((result) => sendResponse(result ?? { ok: true }))
    .catch((e) => sendResponse({ error: String(e?.message || e) }));
  return true;
});

async function handleMessage(msg, sender) {
  switch (msg.type) {
    case 'page-captured':
      return onPageCaptured(msg.payload, sender);

    case 'get-state': {
      const { activeJourneyId, paused } = await getActive();
      const journey = activeJourneyId ? await db.get('journeys', activeJourneyId) : null;
      let counts = null;
      if (journey) {
        const nodes = await db.getByIndex('nodes', 'byJourney', journey.id);
        const edges = await db.getByIndex('edges', 'byJourney', journey.id);
        counts = { nodes: nodes.length, edges: edges.length };
      }
      return { activeJourneyId, paused, journey, counts };
    }

    case 'start-journey':
    case 'create-workspace': {
      const journey = {
        id: uid(),
        name: (msg.name || 'Untitled workspace').trim() || 'Untitled workspace',
        status: 'active',
        createdAt: Date.now(),
        endedAt: null,
        synthesis: null,
      };
      await db.put('journeys', journey);
      await switchWorkspace(journey.id);
      // Make the new workspace tangible right away: adopt the tab you're on
      // as its first page (which also creates its tab group).
      const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (activeTab) await adoptTab(activeTab, journey.id);
      return { journey };
    }

    case 'switch-workspace': {
      await switchWorkspace(msg.journeyId);
      return {};
    }

    // Which nodes currently have real tabs, and where the user is.
    case 'tab-map': {
      const tabState = await sget('tabState', {});
      let activeNodeId = null;
      const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (activeTab) {
        if (tabState[activeTab.id]) {
          activeNodeId = tabState[activeTab.id].nodeId;
        } else if (activeTab.url) {
          // Bookkeeping can lag or miss (worker restarts, tabs opened from
          // the panel): resolve the active tab by URL and repair the map.
          const { activeJourneyId } = await getActive();
          const canon = canonicalUrl(activeTab.url);
          const node = activeJourneyId
            ? await db.getOneByIndex('nodes', 'byJourneyUrl', [activeJourneyId, canon])
            : null;
          if (node) {
            activeNodeId = node.id;
            tabState[activeTab.id] = { nodeId: node.id, url: canon };
            await sset('tabState', tabState);
          }
        }
      }
      const byNode = {};
      for (const [tabId, entry] of Object.entries(tabState)) {
        if (!entry?.nodeId) continue;
        (byNode[entry.nodeId] ||= []).push(Number(tabId));
      }
      return { byNode, activeNodeId };
    }

    // Click on the map: focus the page's tab if one is open, else reopen it.
    case 'focus-node': {
      const node = await db.get('nodes', msg.nodeId);
      if (!node) return {};
      const tabState = await sget('tabState', {});
      const entry = Object.entries(tabState).find(([, e]) => e?.nodeId === msg.nodeId);
      if (entry) {
        const tabId = Number(entry[0]);
        try {
          const tab = await chrome.tabs.get(tabId);
          await chrome.tabs.update(tabId, { active: true });
          await chrome.windows.update(tab.windowId, { focused: true });
          return { focused: true };
        } catch {
          delete tabState[entry[0]];
          await sset('tabState', tabState);
        }
      }
      await chrome.tabs.create({ url: node.url, active: true });
      return { reopened: true };
    }

    // Close every mapped tab except the active one; their nodes stay parked.
    case 'park-others': {
      const tabState = await sget('tabState', {});
      const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      const doomed = Object.keys(tabState)
        .map(Number)
        .filter((id) => id !== activeTab?.id);
      let parked = 0;
      for (const tabId of doomed) {
        try {
          await chrome.tabs.remove(tabId);
          parked++;
        } catch { /* already gone */ }
      }
      return { parked };
    }

    case 'set-paused': {
      await flushFocusTime();
      await setFocus(null, null);
      await chrome.storage.local.set({ paused: !!msg.paused });
      await refreshBadge();
      return {};
    }

    case 'stop-journey': {
      const { activeJourneyId } = await getActive();
      await flushFocusTime();
      await setFocus(null, null);
      await sset('tabState', {});
      if (activeJourneyId) {
        await db.update('journeys', activeJourneyId, (j) => {
          j.status = 'done';
          j.endedAt = Date.now();
          return j;
        });
      }
      await chrome.storage.local.set({ activeJourneyId: null, paused: false });
      await refreshBadge();
      return {};
    }

    case 'save-note':
      await db.update('nodes', msg.nodeId, (n) => {
        n.notes = msg.notes;
        return n;
      });
      return {};

    case 'add-manual-edge': {
      const edge = await upsertEdge(msg.journeyId, msg.from, msg.to, 'manual', msg.label || '');
      notifyTrailUpdated(msg.journeyId);
      return { edge };
    }

    case 'delete-edge': {
      const edge = await db.get('edges', msg.edgeId);
      await db.remove('edges', msg.edgeId);
      if (edge) notifyTrailUpdated(edge.journeyId);
      return {};
    }

    case 'describe-edge': {
      const edge = await db.get('edges', msg.edgeId);
      if (edge) {
        await enqueueJob(edge.journeyId, 'edge-describe', null, { edgeId: edge.id });
        kickQueue();
      }
      return {};
    }

    case 'set-edge-label': {
      const edge = await db.update('edges', msg.edgeId, (e) => {
        e.label = msg.label;
        return e;
      });
      if (edge) notifyTrailUpdated(edge.journeyId);
      return {};
    }

    case 'delete-node': {
      const node = await db.get('nodes', msg.nodeId);
      if (node) {
        await db.remove('nodes', msg.nodeId);
        const edges = await db.getByIndex('edges', 'byJourney', node.journeyId);
        await db.removeKeys(
          'edges',
          edges.filter((e) => e.from === msg.nodeId || e.to === msg.nodeId).map((e) => e.id),
        );
        // Drop any queued AI work for the deleted page too.
        const jobs = await db.getByIndex('jobs', 'byJourney', node.journeyId);
        await db.removeKeys('jobs', jobs.filter((j) => j.nodeId === msg.nodeId).map((j) => j.id));
        notifyTrailUpdated(node.journeyId);
      }
      return {};
    }

    case 'delete-nodes': {
      const ids = msg.nodeIds || [];
      if (!ids.length) return {};
      let journeyId = null;
      for (const id of ids) {
        const n = await db.get('nodes', id);
        if (n) {
          journeyId = n.journeyId;
          break;
        }
      }
      if (!journeyId) return { error: 'none of these pages exist in the database' };
      const idSet = new Set(ids);
      await db.removeKeys('nodes', ids);
      const edges = await db.getByIndex('edges', 'byJourney', journeyId);
      await db.removeKeys('edges', edges.filter((e) => idSet.has(e.from) || idSet.has(e.to)).map((e) => e.id));
      const jobs = await db.getByIndex('jobs', 'byJourney', journeyId);
      await db.removeKeys('jobs', jobs.filter((j) => j.nodeId && idSet.has(j.nodeId)).map((j) => j.id));
      // Unlight any tabs that pointed at the deleted pages.
      const tabState = await sget('tabState', {});
      let changed = false;
      for (const [tid, entry] of Object.entries(tabState)) {
        if (entry && idSet.has(entry.nodeId)) {
          delete tabState[tid];
          changed = true;
        }
      }
      if (changed) await sset('tabState', tabState);
      notifyTrailUpdated(journeyId);
      notifyTabsUpdated();
      return { removed: ids.length };
    }

    case 'delete-journey': {
      await db.deleteWhere('nodes', 'byJourney', msg.journeyId);
      await db.deleteWhere('edges', 'byJourney', msg.journeyId);
      await db.deleteWhere('jobs', 'byJourney', msg.journeyId);
      await db.deleteWhere('topics', 'byJourney', msg.journeyId);
      await db.remove('journeys', msg.journeyId);
      const { activeJourneyId } = await getActive();
      if (activeJourneyId === msg.journeyId) {
        await chrome.storage.local.set({ activeJourneyId: null, paused: false });
        await refreshBadge();
      }
      return {};
    }

    case 'resummarize': {
      const node = await db.get('nodes', msg.nodeId);
      if (node) {
        await enqueueJob(node.journeyId, 'summarize', node.id);
        await enqueueJob(node.journeyId, 'embed', node.id);
        kickQueue();
      }
      return {};
    }

    case 'recompute-similarity':
      return recomputeSimilarity(msg.journeyId);

    case 'synthesize': {
      await enqueueJob(msg.journeyId, 'synthesize', null);
      kickQueue();
      return {};
    }

    // Backfill recognition handles for pages summarized before the feature
    // existed (deduped: at most one pending hooks job per workspace).
    case 'refresh-hooks': {
      await enqueueJob(msg.journeyId, 'hooks', null);
      kickQueue();
      return {};
    }

    case 'refresh-topics': {
      await enqueueJob(msg.journeyId, 'organize', null);
      kickQueue();
      return {};
    }

    case 'move-nodes': {
      let toJourneyId = msg.toJourneyId;
      if (!toJourneyId && msg.newName) {
        toJourneyId = (await createWorkspace(msg.newName)).id;
      }
      if (!toJourneyId) return { error: 'no destination workspace' };
      await moveNodes(msg.nodeIds || [], toJourneyId);
      return { journeyId: toJourneyId };
    }

    // Turn a Scratch topic into a real workspace of its own.
    case 'promote-topic': {
      const topic = await db.get('topics', msg.topicId);
      if (!topic) return { error: 'topic no longer exists' };
      const nodes = await db.getByIndex('nodes', 'byJourney', topic.journeyId);
      const members = nodes.filter((n) => n.topicId === topic.id).map((n) => n.id);
      if (!members.length) return { error: 'topic has no pages' };
      const ws = await createWorkspace(topic.name || 'Untitled workspace');
      await moveNodes(members, ws.id);
      await db.remove('topics', topic.id);
      return { journeyId: ws.id };
    }

    case 'list-suggestions': {
      const { suggestions = [] } = await chrome.storage.local.get('suggestions');
      return {
        suggestions: msg.journeyId
          ? suggestions.filter((s) => s.journeyId === msg.journeyId)
          : suggestions,
      };
    }

    // Accept splits the suggested pages into their own workspace; dismiss
    // remembers the exact set so the scanner never re-suggests it.
    case 'resolve-suggestion': {
      const stored = await chrome.storage.local.get(['suggestions', 'dismissedSuggestionKeys']);
      const suggestions = stored.suggestions || [];
      const s = suggestions.find((x) => x.id === msg.id);
      if (!s) return { error: 'suggestion no longer exists' };
      const remaining = suggestions.filter((x) => x.id !== msg.id);
      let journeyId = null;
      if (msg.accept) {
        const ws = await createWorkspace(s.name);
        await moveNodes(s.nodeIds, ws.id);
        journeyId = ws.id;
      } else {
        const dismissed = (stored.dismissedSuggestionKeys || []).slice(-49);
        dismissed.push(s.key);
        await chrome.storage.local.set({ dismissedSuggestionKeys: dismissed });
      }
      await chrome.storage.local.set({ suggestions: remaining });
      notifyTrailUpdated(s.journeyId);
      return { journeyId };
    }

    case 'ollama-status': {
      const ok = await ollama.ollamaAvailable();
      let models = [];
      if (ok) {
        try {
          models = await ollama.listModels();
        } catch { /* reachable but listing failed; report ok anyway */ }
      }
      const pendingJobs = await db.getByIndex('jobs', 'byStatus', 'pending');
      const pending = pendingJobs.length;
      const journeyJobs = msg.journeyId
        ? {
            synthesize: pendingJobs.some((j) => j.journeyId === msg.journeyId && j.type === 'synthesize'),
            connections: pendingJobs.some((j) => j.journeyId === msg.journeyId && j.type === 'connections'),
          }
        : null;
      const erroredJobs = await db.getByIndex('jobs', 'byStatus', 'error');
      const resolved = ok ? await ollama.resolveModels() : null;
      // A dedicated embedding model showing up un-disables similarity.
      let { embedDisabled = null } = await chrome.storage.local.get('embedDisabled');
      if (embedDisabled && models.some(ollama.looksLikeEmbedModel)) {
        await chrome.storage.local.remove('embedDisabled');
        embedDisabled = null;
      }
      const { aiPaused } = await getSettings();
      let current = null;
      if (queueCurrent) {
        current = { type: queueCurrent.type, title: '' };
        if (queueCurrent.nodeId) {
          const n = await db.get('nodes', queueCurrent.nodeId);
          current.title = n?.title || n?.host || '';
        }
      }
      return {
        ok, models, pending, resolved, embedDisabled, journeyJobs, aiPaused, current,
        errored: erroredJobs.length,
        lastError: erroredJobs[erroredJobs.length - 1]?.lastError || null,
      };
    }

    case 'retry-jobs': {
      // A manual retry also re-tests embedding support (settings/models may
      // have changed since it was disabled).
      await chrome.storage.local.remove('embedDisabled');
      const errored = await db.getByIndex('jobs', 'byStatus', 'error');
      for (const job of errored) {
        job.status = 'pending';
        job.attempts = 0;
        await db.put('jobs', job);
      }
      kickQueue();
      return { retried: errored.length };
    }

    default:
      throw new Error(`Unknown message type: ${msg.type}`);
  }
}

async function onPageCaptured(payload, sender) {
  const { activeJourneyId, paused } = await getActive();
  if (!activeJourneyId || paused) return {};
  const canon = canonicalUrl(payload.url);
  const node = await db.getOneByIndex('nodes', 'byJourneyUrl', [activeJourneyId, canon]);
  if (!node) return {};

  const settings = await getSettings();
  const hadContent = !!(node.text || node.excerpt);
  node.title = payload.title || node.title;
  node.excerpt = payload.excerpt || node.excerpt;
  if (settings.captureText) node.text = payload.text || node.text;
  await db.put('nodes', node);

  // Only queue AI work the first time we get real content for this node;
  // revisits and already-summarized pages don't re-run. In Scratch (lite
  // mode), skip the expensive per-page summary entirely — auto-organization
  // only needs embeddings, and pages get summarized later if they're ever
  // promoted into a real workspace.
  if (!hadContent && !node.summary?.length && (node.text || node.excerpt)) {
    const journey = await db.get('journeys', activeJourneyId);
    const lite = settings.scratchLite && isScratch(journey);
    if (!lite) await enqueueJob(activeJourneyId, 'summarize', node.id);
    await enqueueJob(activeJourneyId, 'embed', node.id);
    kickQueue();
  }
  notifyTrailUpdated(activeJourneyId);
  return {};
}

let trailNotifyTimer = null;
const trailNotifyPending = new Set();
function notifyTrailUpdated(journeyId) {
  trailNotifyPending.add(journeyId);
  if (trailNotifyTimer) return;
  trailNotifyTimer = setTimeout(() => {
    trailNotifyTimer = null;
    for (const id of trailNotifyPending) {
      chrome.runtime.sendMessage({ type: 'trail-updated', journeyId: id }).catch(() => {
        // No listener open (journey page closed) — fine.
      });
    }
    trailNotifyPending.clear();
  }, 300);
}

// ---------- Similarity edges ----------

async function recomputeSimilarity(journeyId) {
  const settings = await getSettings();
  const allNodes = await db.getByIndex('nodes', 'byJourney', journeyId);
  const nodes = allNodes.filter((n) => n.embedding);
  const { embedDisabled } = await chrome.storage.local.get('embedDisabled');

  // No embeddings to work with (no embed-capable model, or none computed
  // yet): have the chat model read the page summaries and propose connected
  // pairs directly in one batch call.
  if (embedDisabled || nodes.length < 2) {
    const candidates = allNodes.filter((n) => n.title || n.summary?.length || n.excerpt);
    if (candidates.length < 2) return { tooFew: true };
    await enqueueJob(journeyId, 'connections', null);
    kickQueue();
    return { queuedLlm: true };
  }

  // Backfill: queue embeddings for captured pages that don't have one yet
  // (e.g. everything captured while the embed model was missing).
  let queuedEmbeds = 0;
  for (const n of allNodes) {
    if (!n.embedding && (n.text || n.excerpt)) {
      await enqueueJob(journeyId, 'embed', n.id);
      queuedEmbeds++;
    }
  }
  if (queuedEmbeds) kickQueue();

  const edges = await db.getByIndex('edges', 'byJourney', journeyId);
  const connected = new Set(edges.map((e) => [e.from, e.to].sort().join('|')));

  // Collect candidates first, then keep only the strongest few per run —
  // every new edge costs a chat-model call for its label, and a dozen weak
  // "kind of related" edges just clutter the map.
  const candidates = [];
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i];
      const b = nodes[j];
      // Same registrable domain already clusters visually; skip those pairs.
      if (baseDomain(a.host) === baseDomain(b.host)) continue;
      if (connected.has([a.id, b.id].sort().join('|'))) continue;
      const sim = cosine(a.embedding, b.embedding);
      if (sim >= settings.simThreshold) candidates.push({ a, b, sim });
    }
  }
  candidates.sort((x, y) => y.sim - x.sim);
  let created = 0;
  for (const { a, b, sim } of candidates.slice(0, 8)) {
    const edge = await upsertEdge(journeyId, a.id, b.id, 'similar');
    edge.similarity = sim;
    await db.put('edges', edge);
    await enqueueJob(journeyId, 'similar-label', null, { edgeId: edge.id });
    created++;
  }
  if (created) kickQueue();
  notifyTrailUpdated(journeyId);
  return { created, comparable: nodes.length, queuedEmbeds };
}

// ---------- Ollama job queue ----------

async function enqueueJob(journeyId, type, nodeId, payload = {}) {
  // Avoid queueing duplicate work for the same target.
  const pending = await db.getByIndex('jobs', 'byStatus', 'pending');
  if (pending.some((j) => j.type === type && j.nodeId === nodeId && j.journeyId === journeyId
      && JSON.stringify(j.payload) === JSON.stringify(payload))) {
    return;
  }
  await db.put('jobs', {
    id: uid(), journeyId, nodeId, type, payload,
    status: 'pending', attempts: 0, lastError: null, createdAt: Date.now(),
  });
}

let queueRunning = false;
let queueCurrent = null; // { type, nodeId } of the job Ollama is chewing on

const CHAT_JOB_TYPES = new Set(['summarize', 'similar-label', 'connections', 'synthesize', 'edge-describe', 'hooks', 'organize', 'tangent-scan']);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Be polite: while the user is actively using the machine, leave generous
// gaps between chat-model jobs so Ollama doesn't monopolize the CPU. Run
// full speed only when they've stepped away.
async function breather() {
  const state = await new Promise((resolve) => chrome.idle.queryState(30, resolve));
  await sleep(state === 'active' ? 8000 : 400);
}

function kickQueue() {
  processQueue().catch((e) => console.error('processQueue', e));
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'process-jobs') kickQueue();
});

async function processQueue() {
  if (queueRunning) return;
  queueRunning = true;
  try {
    while (true) {
      const settings = await getSettings();
      if (settings.aiPaused) break; // user paused AI work; jobs wait

      const pending = (await db.getByIndex('jobs', 'byStatus', 'pending'))
        .sort((a, b) => a.createdAt - b.createdAt);
      if (!pending.length) break;

      // Run all embeddings before any chat job, in batches: interleaving them
      // makes Ollama swap the chat and embedding models in and out of memory
      // on every job, which grinds the whole machine.
      const batch = pending.filter((j) => j.type === 'embed').slice(0, 8);
      const job = batch.length ? null : pending[0];
      const affected = batch.length ? batch : [job];
      queueCurrent = batch.length ? { type: 'embed' } : { type: job.type, nodeId: job.nodeId };
      try {
        if (batch.length) {
          await runEmbedBatch(batch);
          await db.removeKeys('jobs', batch.map((j) => j.id));
          // Fresh embeddings are what organization runs on: Scratch gets
          // silently re-clustered, named workspaces get scanned for tangents.
          for (const jid of new Set(batch.map((j) => j.journeyId))) {
            const j = await db.get('journeys', jid);
            if (!j) continue;
            await enqueueJob(jid, isScratch(j) ? 'organize' : 'tangent-scan', null);
          }
        } else {
          await runJob(job);
          await db.remove('jobs', job.id);
        }
        notifyTrailUpdated(affected[0].journeyId);
        if (job && CHAT_JOB_TYPES.has(job.type)) await breather();
        else await sleep(250);
      } catch (e) {
        if (ollama.isOfflineError(e)) {
          // Ollama unreachable: leave the queue alone, the alarm retries later.
          break;
        }
        if (batch.length && ollama.isEmbedUnsupportedError(e)) {
          // The installed model can't embed, period. Not a transient failure:
          // disable similarity until an embedding model shows up, and drop all
          // embed work so it doesn't clutter the queue as errors.
          await chrome.storage.local.set({ embedDisabled: String(e?.message || e) });
          const jobs = await db.getAll('jobs');
          await db.removeKeys('jobs', jobs.filter((j) => j.type === 'embed').map((j) => j.id));
          notifyTrailUpdated(affected[0].journeyId);
          continue;
        }
        let erroredAny = false;
        for (const j of affected) {
          j.attempts += 1;
          j.lastError = String(e?.message || e);
          if (j.attempts >= MAX_JOB_ATTEMPTS) {
            j.status = 'error';
            erroredAny = true;
          }
          await db.put('jobs', j);
        }
        if (erroredAny) notifyTrailUpdated(affected[0].journeyId);
      } finally {
        queueCurrent = null;
      }
    }
  } finally {
    queueRunning = false;
    queueCurrent = null;
  }
}

async function runEmbedBatch(jobs) {
  const targets = [];
  for (const j of jobs) {
    const node = await db.get('nodes', j.nodeId);
    if (!node) continue;
    const input = truncate(`${node.title}\n${node.text || node.excerpt || ''}`, 8000);
    if (input.trim().length < 20) continue;
    targets.push({ node, input });
  }
  if (!targets.length) return;
  const vectors = await ollama.embedBatch(targets.map((t) => t.input));
  for (let i = 0; i < targets.length; i++) {
    if (!vectors[i]) continue;
    await db.update('nodes', targets[i].node.id, (n) => {
      n.embedding = vectors[i];
      return n;
    });
  }
}

async function runJob(job) {
  switch (job.type) {
    case 'summarize': {
      const node = await db.get('nodes', job.nodeId);
      if (!node || (!node.text && !node.excerpt)) return;
      const { system, prompt } = ollama.summarizePrompt(node);
      const response = await ollama.generate(prompt, { system });
      const { bullets, tags } = ollama.parseSummary(response);
      await db.update('nodes', node.id, (n) => {
        n.summary = bullets;
        n.tags = tags;
        return n;
      });
      // Refresh the mutually-distinct page handles once summaries land
      // (deduped: at most one hooks job pending per workspace).
      await enqueueJob(node.journeyId, 'hooks', null);
      return;
    }
    case 'hooks': {
      const journeyNodes = (await db.getByIndex('nodes', 'byJourney', job.journeyId))
        .filter((n) => n.title || n.summary?.length || n.excerpt)
        .sort((a, b) => a.createdAt - b.createdAt)
        .slice(-60);
      if (journeyNodes.length < 2) return;
      const { system, prompt } = ollama.hooksPrompt(journeyNodes);
      // ~40 tokens/entry is generous; without this Ollama's default output
      // cap truncates the JSON well before 60 entries and silently yields 0.
      const response = await ollama.generate(prompt, { system, timeoutMs: 300000, numPredict: journeyNodes.length * 40 + 200 });
      for (const { n, handle } of ollama.parseHooks(response, journeyNodes.length)) {
        await db.update('nodes', journeyNodes[n - 1].id, (x) => {
          x.hook = truncate(String(handle).trim(), 70);
          return x;
        });
      }
      return;
    }
    // Silent auto-organization of Scratch: cluster pages into topics by
    // link structure, embedding similarity, and visit timing, then name the
    // new topics in one batch call. Assignments are stable — a cluster that
    // mostly belongs to an existing topic keeps that topic.
    case 'organize': {
      const journey = await db.get('journeys', job.journeyId);
      if (!journey || !isScratch(journey)) return;
      const nodes = (await db.getByIndex('nodes', 'byJourney', journey.id))
        .sort((a, b) => a.createdAt - b.createdAt);
      if (nodes.length < 2) return;
      const edges = await db.getByIndex('edges', 'byJourney', journey.id);

      const idx = new Map(nodes.map((n, i) => [n.id, i]));
      const parent = nodes.map((_, i) => i);
      const find = (i) => {
        while (parent[i] !== i) {
          parent[i] = parent[parent[i]];
          i = parent[i];
        }
        return i;
      };
      const union = (a, b) => {
        const ra = find(a);
        const rb = find(b);
        if (ra !== rb) parent[ra] = rb;
      };
      for (const e of edges) {
        if (e.type === 'similar') continue; // raw cosine below is the better signal
        const a = idx.get(e.from);
        const b = idx.get(e.to);
        if (a != null && b != null) union(a, b);
      }
      const firstVisit = (n) => n.visits[0]?.at ?? n.createdAt;
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i];
          const b = nodes[j];
          if (!a.embedding || !b.embedding) continue;
          const sim = cosine(a.embedding, b.embedding);
          if (sim >= 0.55) union(i, j);
          // Time proximity chains transitively (page A ~ B ~ C … links a
          // whole evening into one mega-cluster), so it needs a stiff
          // similarity bar, not a loose one.
          else if (sim >= 0.5 && Math.abs(firstVisit(a) - firstVisit(b)) < 10 * 60 * 1000) union(i, j);
        }
      }

      const comps = new Map();
      nodes.forEach((n, i) => {
        const root = find(i);
        if (!comps.has(root)) comps.set(root, []);
        comps.get(root).push(n);
      });

      const topics = await db.getByIndex('topics', 'byJourney', journey.id);
      const topicById = new Map(topics.map((t) => [t.id, t]));
      const toName = [];
      const liveTopicIds = new Set();
      let changed = false;
      for (const members of comps.values()) {
        // Keep whichever existing topic most of this cluster already carries.
        const votes = new Map();
        for (const m of members) {
          if (m.topicId && topicById.has(m.topicId)) {
            votes.set(m.topicId, (votes.get(m.topicId) || 0) + 1);
          }
        }
        let topicId = null;
        let best = 0;
        for (const [tid, c] of votes) {
          if (liveTopicIds.has(tid)) continue; // a topic belongs to ONE component — when a cluster splits, the runner-up mints a new topic
          if (c > best) { best = c; topicId = tid; }
        }
        if (!topicId) {
          const t = { id: uid(), journeyId: journey.id, name: '', createdAt: Date.now(), updatedAt: Date.now() };
          await db.put('topics', t);
          topicById.set(t.id, t);
          topicId = t.id;
        }
        liveTopicIds.add(topicId);
        for (const m of members) {
          if (m.topicId !== topicId) {
            await db.update('nodes', m.id, (x) => {
              x.topicId = topicId;
              return x;
            });
            changed = true;
          }
        }
        if (!topicById.get(topicId).name && !toName.some((e) => e.topic.id === topicId)) {
          toName.push({ topic: topicById.get(topicId), members });
        }
      }
      for (const t of topics) {
        if (!liveTopicIds.has(t.id)) await db.remove('topics', t.id);
      }

      if (toName.length) {
        const clusters = toName.map((e, i) => ({
          n: i + 1,
          pages: e.members.slice(0, 10).map((m) => m.hook || m.title || m.host),
        }));
        const { system, prompt } = ollama.clusterNamesPrompt(clusters);
        const response = await ollama.generate(prompt, {
          system, timeoutMs: 180000, numPredict: toName.length * 30 + 150,
        });
        const parsed = ollama.parseClusterNames(response, toName.length);
        // A response with zero usable names is a failure, not a success —
        // throwing lets the queue retry instead of leaving topics stuck at
        // "Organizing…" forever. (Cluster assignments are already saved and
        // survive the retry.)
        if (!parsed.length) throw new Error('topic naming returned no parsable names');
        for (const { n, name } of parsed) {
          await db.update('topics', toName[n - 1].topic.id, (x) => {
            x.name = truncate(String(name).trim(), 60);
            x.updatedAt = Date.now();
            return x;
          });
        }
        changed = true;
      }
      if (changed) notifyTrailUpdated(journey.id);
      return;
    }
    // Off-theme detection in a NAMED workspace: pages that embed far from
    // the workspace's center of gravity, and cohere with each other, become
    // a split suggestion the user reviews on the map. Never moves anything
    // by itself.
    case 'tangent-scan': {
      const journey = await db.get('journeys', job.journeyId);
      if (!journey || isScratch(journey)) return;
      const nodes = await db.getByIndex('nodes', 'byJourney', journey.id);
      const emb = nodes.filter((n) => n.embedding);
      if (emb.length < 8) return; // too small to judge a theme

      const dim = emb[0].embedding.length;
      const centroid = new Array(dim).fill(0);
      for (const n of emb) {
        for (let i = 0; i < dim; i++) centroid[i] += n.embedding[i];
      }
      for (let i = 0; i < dim; i++) centroid[i] /= emb.length;

      const scored = emb.map((n) => ({ n, sim: cosine(n.embedding, centroid) }));
      const sims = scored.map((s) => s.sim).sort((a, b) => a - b);
      const median = sims[Math.floor(sims.length / 2)];
      // Off-theme = clearly below what's typical for this workspace.
      const cut = Math.min(0.5, median - 0.15);
      const candidates = scored.filter((s) => s.sim < cut).map((s) => s.n);
      if (candidates.length < 3) return;

      // The candidates must cohere with EACH OTHER (one stray page isn't a
      // thread) — largest mutually-similar group wins.
      const cparent = candidates.map((_, i) => i);
      const cfind = (i) => {
        while (cparent[i] !== i) {
          cparent[i] = cparent[cparent[i]];
          i = cparent[i];
        }
        return i;
      };
      for (let i = 0; i < candidates.length; i++) {
        for (let j = i + 1; j < candidates.length; j++) {
          if (cosine(candidates[i].embedding, candidates[j].embedding) >= 0.45) {
            const ra = cfind(i);
            const rb = cfind(j);
            if (ra !== rb) cparent[ra] = rb;
          }
        }
      }
      const groups = new Map();
      candidates.forEach((n, i) => {
        const root = cfind(i);
        if (!groups.has(root)) groups.set(root, []);
        groups.get(root).push(n);
      });
      let group = [];
      for (const g of groups.values()) {
        if (g.length > group.length) group = g;
      }
      if (group.length < 3) return;

      const key = group.map((n) => n.id).sort().join('|');
      const stored = await chrome.storage.local.get(['suggestions', 'dismissedSuggestionKeys']);
      const dismissed = stored.dismissedSuggestionKeys || [];
      if (dismissed.includes(key)) return;
      const suggestions = (stored.suggestions || []).filter((s) => s.journeyId !== journey.id);
      if ((stored.suggestions || []).some((s) => s.key === key)) return;

      const { system, prompt } = ollama.clusterNamesPrompt([
        { n: 1, pages: group.slice(0, 10).map((m) => m.hook || m.title || m.host) },
      ]);
      const response = await ollama.generate(prompt, { system, numPredict: 120 });
      const name = ollama.parseClusterNames(response, 1)[0]?.name?.trim() || 'A separate thread';
      suggestions.push({
        id: uid(),
        key,
        journeyId: journey.id,
        nodeIds: group.map((n) => n.id),
        name: truncate(name, 60),
        createdAt: Date.now(),
      });
      await chrome.storage.local.set({ suggestions });
      notifyTrailUpdated(journey.id);
      return;
    }
    case 'embed': {
      const node = await db.get('nodes', job.nodeId);
      if (!node) return;
      const input = truncate(`${node.title}\n${node.text || node.excerpt || ''}`, 8000);
      if (input.trim().length < 20) return;
      const embedding = await ollama.embed(input);
      await db.update('nodes', node.id, (n) => {
        n.embedding = embedding;
        return n;
      });
      return;
    }
    case 'similar-label': {
      const edge = await db.get('edges', job.payload.edgeId);
      if (!edge) return;
      const a = await db.get('nodes', edge.from);
      const b = await db.get('nodes', edge.to);
      if (!a || !b) return;
      const { system, prompt } = ollama.connectionLabelPrompt(a, b);
      const label = await ollama.generate(prompt, { system });
      await db.update('edges', edge.id, (e) => {
        e.label = truncate(label.replace(/^["']|["']$/g, ''), 90);
        return e;
      });
      return;
    }
    case 'edge-describe': {
      const edge = await db.get('edges', job.payload.edgeId);
      if (!edge) return;
      const a = await db.get('nodes', edge.from);
      const b = await db.get('nodes', edge.to);
      if (!a || !b) return;
      const { system, prompt } = ollama.connectionDescriptionPrompt(a, b, edge.label);
      const description = await ollama.generate(prompt, { system });
      await db.update('edges', edge.id, (e) => {
        e.description = truncate(description, 600);
        return e;
      });
      return;
    }
    case 'connections': {
      const journeyNodes = (await db.getByIndex('nodes', 'byJourney', job.journeyId))
        .filter((n) => n.title || n.summary?.length || n.excerpt)
        .sort((a, b) => a.createdAt - b.createdAt)
        .slice(-60); // batch prompt caps out; favor the most recent pages
      if (journeyNodes.length < 2) return;
      const { system, prompt } = ollama.connectionsBatchPrompt(journeyNodes);
      const response = await ollama.generate(prompt, { system, timeoutMs: 300000, numPredict: 1200 });
      const pairs = ollama.parseConnections(response, journeyNodes.length);
      const existing = await db.getByIndex('edges', 'byJourney', job.journeyId);
      const connected = new Set(existing.map((e) => [e.from, e.to].sort().join('|')));
      for (const { a, b, why } of pairs) {
        const na = journeyNodes[a - 1];
        const nb = journeyNodes[b - 1];
        if (baseDomain(na.host) === baseDomain(nb.host)) continue;
        const key = [na.id, nb.id].sort().join('|');
        if (connected.has(key)) continue;
        connected.add(key);
        await upsertEdge(job.journeyId, na.id, nb.id, 'similar', truncate(String(why || ''), 90));
      }
      return;
    }
    case 'synthesize': {
      const journey = await db.get('journeys', job.journeyId);
      if (!journey) return;
      const nodes = (await db.getByIndex('nodes', 'byJourney', journey.id))
        .sort((a, b) => a.createdAt - b.createdAt);
      if (!nodes.length) return;
      const { system, prompt } = ollama.synthesisPrompt(journey, nodes);
      const text = await ollama.generate(prompt, { system, timeoutMs: 300000, numPredict: 1600 });
      await db.update('journeys', journey.id, (j) => {
        j.synthesis = { text, updatedAt: Date.now() };
        return j;
      });
      return;
    }
    default:
      throw new Error(`Unknown job type: ${job.type}`);
  }
}
