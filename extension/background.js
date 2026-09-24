import { captureEvidence } from './evidence/capture-background.js';
import { openBoard, resumeBoard, reopenAfterReload, forgetTab } from './evidence/open.js';
import { showCaptureToast } from './evidence/capture-toast.js';
import { evidenceCard, noteCard, saveBoard } from './evidence/workspace.js';
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
  makeConnectorClassifier, embedInput, isEmbeddable,
} from './lib/util.js';
import * as ollama from './lib/ollama.js';
// Amtshelfer (DE→EN translation + Explain for Austrian gov sites) runs as a
// self-contained module: it registers its own port listener and never touches
// this file's message protocol.
import './amtshelfer/background.js';

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
    // One way to save a passage: it keeps the page anchor, lands in the
    // evidence inbox, and shows on the page in the browsing trail.
    chrome.contextMenus.create({ id: 'save-passage', title: 'Save passage as evidence', contexts: ['selection'] });
    chrome.contextMenus.create({ id: 'capture-evidence', title: 'Save screenshot as evidence', contexts: ['page', 'selection'] });
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
    if (node) tabState[tab.id] = { nodeId: node.id, url: canon, rawUrl: tab.url };
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
  tabState[tab.id] = { nodeId: node.id, url: canon, rawUrl: tab.url };
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
// Reloading or updating the extension closes its pages: reopen the boards
// that were open, each at its last view.
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'update') reopenAfterReload().catch((e) => console.warn('[Research Trail] reopen boards', e));
});
chrome.tabs.onRemoved.addListener((tabId) => { forgetTab(tabId).catch(() => {}); });
chrome.runtime.onStartup.addListener(() => {
  onBoot();
  // Tab ids don't survive a browser restart; restored tabs re-register.
  chrome.storage.local.set({ openBoards: {} });
  rebuildTabState();
});

// ---------- Re-canonicalization ----------
//
// canonicalUrl gains rules over time (most recently: search URLs collapse to
// their query, so one Google AI Mode conversation stops minting a page per
// turn). Pages captured under the older rules keep their old URLs, so this
// folds each group that now canonicalizes the same way into one page, carrying
// everything attached to any of them. Runs once per rule version, on whatever
// event wakes the worker first.
const CANON_VERSION = 2;

async function migrateCanonicalUrls() {
  const { canonVersion = 0 } = await chrome.storage.local.get('canonVersion');
  if (canonVersion >= CANON_VERSION) return;

  const groups = new Map(); // journey + canonical URL -> the pages that share it
  for (const node of await db.getAll('nodes')) {
    const canon = canonicalUrl(node.url);
    const key = `${node.journeyId}\n${canon}`;
    if (!groups.has(key)) groups.set(key, { canon, nodes: [] });
    groups.get(key).nodes.push(node);
  }

  let merged = 0;
  const touched = new Set();
  for (const { canon, nodes } of groups.values()) {
    if (nodes.length === 1 && nodes[0].url === canon) continue;
    merged += await mergeNodeGroup(canon, nodes);
    touched.add(nodes[0].journeyId);
  }

  await chrome.storage.local.set({ canonVersion: CANON_VERSION });
  if (merged) {
    console.log(`[Research Trail] merged ${merged} duplicate page${merged === 1 ? '' : 's'}`);
    for (const id of touched) notifyTrailUpdated(id);
    notifyTabsUpdated();
  }
}

// Fold a group of duplicate pages into one. The survivor is whichever copy has
// the most to lose (text, then a summary, then age) — everything the others
// hold (visits, reading time, notes, highlights, tags, edges) moves onto it.
// Returns how many pages disappeared.
async function mergeNodeGroup(canon, nodes) {
  const richness = (n) => (n.text || '').length + (n.summary?.length ? 5000 : 0)
    + (n.notes ? 3000 : 0) + (n.highlights?.length || 0) * 1000;
  const ordered = [...nodes].sort((a, b) => richness(b) - richness(a) || a.createdAt - b.createdAt);
  const [keep, ...drop] = ordered;

  for (const other of drop) {
    keep.visits = [...(keep.visits || []), ...(other.visits || [])];
    keep.timeSpent = (keep.timeSpent || 0) + (other.timeSpent || 0);
    keep.highlights = [...(keep.highlights || []), ...(other.highlights || [])];
    keep.tags = [...new Set([...(keep.tags || []), ...(other.tags || [])])].slice(0, 8);
    keep.createdAt = Math.min(keep.createdAt, other.createdAt);
    if (other.notes) keep.notes = keep.notes ? `${keep.notes}\n\n${other.notes}` : other.notes;
    for (const field of ['title', 'excerpt', 'text', 'thumb', 'hook', 'embedding', 'topicId']) {
      if (!keep[field] && other[field]) keep[field] = other[field];
    }
    if (!keep.summary?.length && other.summary?.length) keep.summary = other.summary;
  }
  keep.visits.sort((a, b) => a.at - b.at);
  // One arrival recorded twice (the same navigation landing on two copies) is
  // one visit; anything with a distinct timestamp really was a separate visit.
  keep.visits = keep.visits.filter((v, i) => i === 0 || v.at !== keep.visits[i - 1].at);
  const seenHighlights = new Set();
  keep.highlights = keep.highlights.filter((h) => !seenHighlights.has(h.text) && seenHighlights.add(h.text));

  await rewireEdges(keep, new Map(drop.map((n) => [n.id, keep.id])));

  for (const other of drop) {
    for (const job of await db.getByIndex('jobs', 'byJourney', other.journeyId)) {
      if (job.nodeId === other.id) await db.remove('jobs', job.id);
    }
    await db.remove('nodes', other.id);
  }
  // Only now: the [journey, url] index is unique, so the copies have to be
  // gone before the survivor can take the canonical URL.
  keep.url = canon;
  await db.put('nodes', keep);
  return drop.length;
}

// Point every edge that touched a merged-away page at the survivor, dropping
// the self-edges that creates and folding duplicates into one with a count.
async function rewireEdges(keep, idMap) {
  for (const edge of await db.getByIndex('edges', 'byJourney', keep.journeyId)) {
    const from = idMap.get(edge.from) || edge.from;
    const to = idMap.get(edge.to) || edge.to;
    if (from === edge.from && to === edge.to) continue;
    if (from === to) {
      await db.remove('edges', edge.id);
      continue;
    }
    const existing = await db.getOneByIndex('edges', 'byJourneyPair', [edge.journeyId, from, to, edge.type]);
    if (existing && existing.id !== edge.id) {
      existing.count = (existing.count || 1) + (edge.count || 1);
      await db.put('edges', existing);
      await db.remove('edges', edge.id);
    } else {
      edge.from = from;
      edge.to = to;
      await db.put('edges', edge);
    }
  }
}

migrateCanonicalUrls().catch((e) => console.error('[Research Trail] canonical migration failed', e));

chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'resume-board') {
    resumeBoard().catch((e) => console.warn('[Research Trail] resume board', e));
    return;
  }
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

// SPA navigations (History API) — treated as in-tab link navigations. These
// never fire onCompleted, so without an explicit capture the nodes they mint
// stay title-less and text-less forever: no embedding, invisible to
// clustering, permanent residents of "Not yet organized" (Netflix, Gemini,
// and every app-shell screen). Capture only when a NEW page was tracked —
// the same-canonical path schedules its own recapture with streaming-aware
// timing, and racing it here would capture a half-streamed answer and then
// let capture.js's per-href guard block the properly-timed read.
chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
  if (details.frameId !== 0) return;
  handleNavigation({ ...details, transitionType: 'link' })
    .then((tracked) => { if (tracked) captureSpaSoon(details.tabId); })
    .catch((e) => console.error('onHistoryStateUpdated', e));
});

async function handleNavigation(details) {
  const { tabId, url, transitionType } = details;
  const { activeJourneyId, paused } = await getActive();
  const focus = await sget('focus', null);
  let tabState = await sget('tabState', {});
  const canon = canonicalUrl(url);

  // Same page as far as the map is concerned (hash change, canonical-equal SPA
  // update): no new node, no new edge. But if the raw URL moved, the page
  // itself probably did too — a Google AI Mode chat rewrites its session token
  // on every turn while the answer text keeps growing — so re-read the page and
  // let the node carry the whole conversation instead of only its first turn.
  if (tabState[tabId]?.url === canon) {
    if (tabState[tabId].rawUrl !== url) {
      tabState[tabId].rawUrl = url;
      await sset('tabState', tabState);
      recaptureSoon(tabId);
    }
    return;
  }

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

  tabState[tabId] = { nodeId: node.id, url: canon, rawUrl: url };
  await sset('tabState', tabState);
  if (!focus || focus.tabId === tabId) await setFocus(tabId, node.id);

  ensureTabInWorkspaceGroup(tabId, journeyId).catch(() => {});
  notifyTrailUpdated(journeyId);
  return true; // a new page is now tracked in this tab (callers may capture it)
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

// Re-read a page that changed under a URL the map already knows (chat-style
// surfaces: every answer rewrites the query string but it's still one page).
// Delayed, because the new answer is usually still streaming in, and throttled
// per tab so a fast conversation doesn't re-parse the DOM on every turn.
// Best-effort by design: if the worker sleeps before the timer fires, the next
// turn schedules another one.
const RECAPTURE_DELAY_MS = 6000;
const RECAPTURE_MIN_GAP_MS = 20000;
const recaptureAt = new Map();

// Read an SPA's new view once it has had a moment to render. Debounced per
// tab, with the timer RESET on each route change (unlike recaptureSoon's
// min-gap, which would drop captures): skimming quickly through app screens
// coalesces into one capture of the page the user actually settled on —
// intermediate views seen for two seconds aren't worth text anyway.
// onPageCaptured routes the text by the page's own URL, so a capture always
// lands on whichever node owns what the tab is showing when the timer fires.
const SPA_CAPTURE_DELAY_MS = 2500;
const spaCaptureTimers = new Map();

function captureSpaSoon(tabId) {
  clearTimeout(spaCaptureTimers.get(tabId));
  spaCaptureTimers.set(tabId, setTimeout(async () => {
    spaCaptureTimers.delete(tabId);
    // Recording may have paused or stopped in the settle window — the
    // onCompleted path re-checks this before injecting, so must we.
    const { activeJourneyId, paused } = await getActive();
    if (!activeJourneyId || paused) return;
    const tabState = await sget('tabState', {});
    if (!tabState[tabId]?.nodeId) return;
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['vendor/Readability.js', 'capture.js'],
      });
    } catch { /* tab gone or not scriptable — nothing lost */ }
  }, SPA_CAPTURE_DELAY_MS));
}

function recaptureSoon(tabId) {
  const now = Date.now();
  if (now - (recaptureAt.get(tabId) || 0) < RECAPTURE_MIN_GAP_MS) return;
  recaptureAt.set(tabId, now);
  setTimeout(async () => {
    const tabState = await sget('tabState', {});
    if (!tabState[tabId]?.nodeId) return;
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['vendor/Readability.js', 'capture.js'],
      });
    } catch { /* tab gone or not scriptable — nothing lost */ }
  }, RECAPTURE_DELAY_MS);
}

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

// Captures go to the workspace of the board you last had open, so a passage
// meant for your argument doesn't land in Scratch after auto-return. The
// in-page confirmation offers the active workspace instead when it differs.
async function captureTarget() {
  const { lastBoard } = await chrome.storage.local.get('lastBoard');
  const active = await ensureActiveWorkspace();
  const target = lastBoard?.journeyId && (await db.get('journeys', lastBoard.journeyId)) ? lastBoard.journeyId : active;
  const [journey, activeJourney] = await Promise.all([db.get('journeys', target), db.get('journeys', active)]);
  return { journeyId: target, journeyName: journey?.name || 'this workspace', alternative: active !== target && activeJourney && !isScratch(activeJourney) ? { id: active, name: activeJourney.name } : null };
}

// The passage also shows on its page in the browsing trail (linked to the
// capture, so the inbox doesn't list it twice). Only for pages already in
// that workspace's trail: saving never adds pages to a trail.
async function recordOnTrail(capture) {
  if (!capture.quote) return;
  const node = await db.getOneByIndex('nodes', 'byJourneyUrl', [capture.journeyId, canonicalUrl(capture.url)]);
  if (!node) return;
  node.highlights = [...(node.highlights || []), { text: capture.quote, at: capture.capturedAt, captureId: capture.id }];
  await db.put('nodes', node);
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!['save-passage', 'capture-evidence'].includes(info.menuItemId)) return;
  const screenshot = info.menuItemId === 'capture-evidence';
  const target = await captureTarget();
  let toast;
  try {
    const capture = await captureEvidence(tab, info, target.journeyId, screenshot);
    await recordOnTrail(capture);
    notifyTrailUpdated(target.journeyId);
    toast = { journeyId: target.journeyId, journeyName: target.journeyName, captureId: capture.id, quote: capture.quote, screenshot,
      warning: capture.view === 'translated' ? 'Saved from the translated view: switch to the original wording to link to the exact passage.' : capture.view === 'legacy-unverified' ? 'The exact wording couldn’t be checked on this page.' : '',
      moveTo: target.alternative };
  } catch (error) {
    if (error.cancelled) return;
    toast = { journeyId: target.journeyId, error: error.message };
  }
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: showCaptureToast, args: [toast] });
  } catch {
    // Pages we can't draw on (browser pages, PDFs): show the result on the board.
    await openBoard({ j: target.journeyId }, toast.error ? { inbox: '1', captureError: toast.error } : { inbox: '1' });
  }
});

// Attach a captured passage under a line of a board. If the board is open,
// its tab applies the change (undo works, no save conflict); otherwise the
// board is updated here.
async function attachCapture({ captureId, boardId, lineId, word }) {
  const viaTab = await chrome.runtime.sendMessage({ type: 'attach-capture', captureId, boardId, lineId, word }).catch(() => null);
  if (viaTab?.ok) return { ok: true };
  const [record, capture] = await Promise.all([db.get('evidenceBoards', boardId), db.get('evidenceCaptures', captureId)]);
  if (!record || !capture) throw new Error('That board or passage no longer exists.');
  const content = structuredClone(record.content), line = content.nodes.find((n) => n.id === lineId);
  if (!line) throw new Error('That line is no longer on the board.');
  let card = content.nodes.find((n) => n.sourceCaptureId === capture.id);
  if (!card) {
    const at = { x: line.x + 340, y: line.y };
    card = capture.kind === 'note' ? noteCard(capture, at) : evidenceCard(capture, at);
    Object.assign(card, { auto: true, ord: Date.now() });
    content.nodes.push(card);
  }
  if (!content.links.some((l) => (l.from === lineId && l.to === card.id) || (l.from === card.id && l.to === lineId))) {
    // Reads "[line] because [passage]" (or "one objection"; an answer under a question).
    content.links.push({ id: uid(), from: lineId, to: card.id, word: line.type === 'gap' ? 'answer' : word === 'objection' ? 'objection' : 'because', label: '' });
  }
  await saveBoard(boardId, record.revision, content);
  return { ok: true };
}

// The lines of a workspace's board a passage can be attached to: the board
// you last used there, else the most recently edited one.
async function attachOptions({ journeyId, boardId }) {
  const boards = await db.getByIndex('evidenceBoards', 'byJourney', journeyId);
  if (!boards.length) return { lines: [] };
  const { lastBoardByJourney = {} } = await chrome.storage.local.get('lastBoardByJourney');
  const board = boards.find((b) => b.id === (boardId || lastBoardByJourney[journeyId])) || boards.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
  const c = board.content, order = new Map(c.steps.map((id, i) => [id, i]));
  const lines = c.nodes.filter((n) => n.type !== 'evidence' && (n.text || '').trim())
    .sort((a, b) => (order.get(a.id) ?? 1e6) - (order.get(b.id) ?? 1e6) || a.y - b.y || a.x - b.x)
    .map((n) => ({ id: n.id, type: n.type, text: n.text }));
  return { boardId: board.id, boardTitle: c.title, lines };
}

// ---------- Messages ----------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg, sender)
    .then((result) => sendResponse(result ?? { ok: true }))
    .catch((e) => sendResponse({ error: String(e?.message || e) }));
  return true;
});

async function handleMessage(msg, sender) {
  switch (msg.type) {
    case 'capture-attach-options':
      return attachOptions(msg);

    case 'capture-attach':
      return attachCapture(msg);

    case 'capture-toast-open':
      await openBoard({ j: msg.journeyId }, { inbox: '1' });
      return { ok: true };

    case 'capture-toast-move': {
      const capture = await db.get('evidenceCaptures', msg.captureId);
      if (!capture || !(await db.get('journeys', msg.journeyId))) return { ok: false };
      const from = capture.journeyId;
      await db.put('evidenceCaptures', { ...capture, journeyId: msg.journeyId });
      // Move its trail record along with it.
      for (const node of await db.getByIndex('nodes', 'byJourney', from)) {
        if (!node.highlights?.some((h) => h.captureId === capture.id)) continue;
        node.highlights = node.highlights.filter((h) => h.captureId !== capture.id);
        await db.put('nodes', node);
      }
      await recordOnTrail({ ...capture, journeyId: msg.journeyId });
      notifyTrailUpdated(from); notifyTrailUpdated(msg.journeyId);
      return { ok: true };
    }

    case 'jot-saved':
      notifyTrailUpdated(msg.journeyId);
      return { ok: true };

    case 'capture-evidence-from-panel': {
      const [tab] = await chrome.tabs.query({active:true,currentWindow:true});
      const journeyId = msg.journeyId || await ensureActiveWorkspace();
      const capture = await captureEvidence(tab, {}, journeyId, !!msg.screenshot);
      notifyTrailUpdated(journeyId);
      return {id:capture.id};
    }

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
            tabState[activeTab.id] = { nodeId: node.id, url: canon, rawUrl: activeTab.url };
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
      const tab = await chrome.tabs.create({ url: node.url, active: true });
      // Reopening a parked page from the map/panel is deliberate work on this
      // research, not a fresh entry point — record where it came from (itself)
      // so auto-return doesn't read it as ambient browsing and bounce the
      // session to Scratch. The self-reference creates no edge.
      const { activeJourneyId } = await getActive();
      if (node.journeyId === activeJourneyId) {
        const openers = await sget('openers', {});
        openers[tab.id] = node.id; // same workspace only — edges never cross one
        await sset('openers', openers);
      }
      await chrome.storage.local.set({ lastCaptureAt: Date.now() });
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
      await db.deleteWhere('evidenceBoards', 'byJourney', msg.journeyId);
      await db.deleteWhere('evidenceCaptures', 'byJourney', msg.journeyId);
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
  const prevLength = (node.text || '').length;
  node.title = payload.title || node.title;
  node.excerpt = payload.excerpt || node.excerpt;
  if (settings.captureText) node.text = payload.text || node.text;
  await db.put('nodes', node);

  // Only queue AI work the first time we get real content for this node;
  // revisits and already-summarized pages don't re-run. In Scratch (lite
  // mode), skip the expensive per-page summary entirely — auto-organization
  // only needs embeddings, and pages get summarized later if they're ever
  // promoted into a real workspace.
  //
  // The exception: a page whose content keeps growing under one URL (a Google
  // AI Mode chat, an infinite feed). Once it has half again as much text as
  // when we last read it, the old summary describes the first turn of a long
  // conversation — worth spending one job to redo.
  const grewSubstantially = hadContent && (node.text || '').length > prevLength * 1.5 + 500;
  if ((!hadContent && !node.summary?.length && (node.text || node.excerpt)) || grewSubstantially) {
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
  const same = (j) => j.type === type && j.nodeId === nodeId && j.journeyId === journeyId
      && JSON.stringify(j.payload) === JSON.stringify(payload);
  // Avoid queueing duplicate work for the same target.
  const pending = await db.getByIndex('jobs', 'byStatus', 'pending');
  if (pending.some(same)) return;
  // A fresh attempt supersedes parked failures of the same work: the auto
  // paths (embed batches, refresh-topics) re-mint jobs freely, and without
  // this the old errored copies pile up and keep the "N jobs failed" badge
  // lit even after a retry succeeds.
  const errored = (await db.getByIndex('jobs', 'byStatus', 'error')).filter(same);
  if (errored.length) await db.removeKeys('jobs', errored.map((j) => j.id));
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
        if (ollama.isTimeoutError(e)) {
          // Ollama is up but this call outran its budget (model still
          // loading, machine under load). The attempt is counted above so a
          // job that ALWAYS times out eventually parks as errored instead of
          // spinning forever — but retry on the alarm's schedule rather than
          // hammering a struggling Ollama right now.
          break;
        }
        // Genuine failure (unparsable output, HTTP error): leave a gap before
        // the next attempt so four strikes on the same job aren't
        // back-to-back full-price calls with zero breathing room.
        await sleep(3000);
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
    const input = embedInput(node);
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
      const response = await ollama.generate(prompt, { system, timeoutMs: 300000, numPredict: journeyNodes.length * 60 + 500 });
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

      // Self-heal embedding coverage before clustering. A node can have
      // content but no vector: capture landed after its one embed job ran
      // (SPA settle delay), or a batch skipped it but deleted the job
      // anyway. Re-queue those — mirroring runEmbedBatch's own >= 20 char
      // bar, so a node it would skip is never re-queued in an enqueue/skip
      // loop. This run clusters without the missing vectors; the embed batch
      // that fills them re-enqueues organize, which is how Scratch converges
      // instead of stranding pages. Deliberately NOT via enqueueJob: this
      // can queue hundreds of nodes (one shared jobs-table read beats a
      // per-node index scan), and enqueueJob's errored-supersede would
      // resurrect permanently-failing jobs with fresh attempts on every
      // organize run — defeating the attempt cap in an endless churn loop.
      // Parked failures stay parked; the failed-jobs UI is their retry path.
      // (Skipped entirely when the installed model can't embed — those jobs
      // would just be dropped again by the embed-unsupported handler.)
      const { embedDisabled } = await chrome.storage.local.get('embedDisabled');
      if (!embedDisabled) {
        const embedJobbed = new Set(
          (await db.getAll('jobs'))
            .filter((j) => j.type === 'embed' && j.journeyId === journey.id)
            .map((j) => j.nodeId),
        );
        for (const n of nodes) {
          if (n.embedding || embedJobbed.has(n.id)) continue;
          if (!isEmbeddable(n)) continue;
          await db.put('jobs', {
            id: uid(), journeyId: journey.id, nodeId: n.id, type: 'embed', payload: {},
            status: 'pending', attempts: 0, lastError: null, createdAt: Date.now(),
          });
        }
      }

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
      // Utility/hub pages (carts, sign-ins, search results, thin app shells,
      // high-traffic waypoints) never bind components — they'd weld
      // unrelated threads — and get labeled from a neighbor after the real
      // clusters form. The rules live in lib/util.js, shared with the
      // journey page so its "Not yet organized" breakdown can't drift from
      // what the organizer actually does.
      const isConnector = makeConnectorClassifier(edges);
      // Connector status is checked O(n²) times below; the regexes and visit
      // scans behind it are per-node facts, so compute them once.
      const connector = nodes.map(isConnector);
      for (const e of edges) {
        if (e.type === 'similar') continue; // raw cosine below is the better signal
        const a = idx.get(e.from);
        const b = idx.get(e.to);
        if (a == null || b == null) continue;
        if (connector[a] || connector[b]) continue;
        union(a, b);
      }

      // Search pages are connectors — as graph nodes they'd weld everything
      // they touch — but the QUERY they carry is the strongest topic signal
      // ambient browsing produces: two pages clicked from the same search are
      // almost always about the same thing. Dropping their edges wholesale
      // orphaned every search-mediated read (result-A ← search → result-B
      // contributed zero joins, and search is how most threads start).
      // Recover the signal without letting the hub bind: union pairs of real
      // pages whose click-throughs FROM the same search page landed in the
      // same sitting. Distinct queries are distinct nodes (canonicalUrl keeps
      // `q`), so this joins within one query, never across a whole engine.
      // The sitting window covers engines whose query param is stripped by
      // canonicalization — there one node spans many queries, and only
      // clicks minutes apart can be trusted to share an intent.
      // Query params only — a bare /results? path (pagination, sports
      // scores) is not a search page; every real engine we canonicalize
      // carries its query in one of these params (YouTube: search_query).
      const SEARCH_HUB_RE = /(\/search\?|[?&]q=|[?&]query=|[?&]search_query=)/i;
      const SEARCH_JOIN_WINDOW = 15 * 60 * 1000;
      const hubArrivals = new Map();
      nodes.forEach((n, i) => {
        if (connector[i] && SEARCH_HUB_RE.test(n.url)) hubArrivals.set(n.id, []);
      });
      nodes.forEach((n, i) => {
        if (connector[i]) return;
        for (const v of n.visits) {
          const arr = v.from && hubArrivals.get(v.from);
          if (arr) arr.push({ i, at: v.at });
        }
      });
      for (const arrivals of hubArrivals.values()) {
        arrivals.sort((a, b) => a.at - b.at);
        for (let k = 1; k < arrivals.length; k++) {
          if (arrivals[k].at - arrivals[k - 1].at <= SEARCH_JOIN_WINDOW) {
            union(arrivals[k - 1].i, arrivals[k].i);
          }
        }
      }

      // Similarity unions. nomic-embed's cosine range is compressed —
      // unrelated web pages score 0.4-0.6, same-genre product pages higher —
      // so a flat 0.55 single-linkage bar was below the noise floor for
      // shopping pages: ONE borderline pair anywhere merged two whole
      // threads, and transitivity grew a mega-topic that could never split.
      // Two changes: a floor the noise can't reach, and union only MUTUAL
      // top-K neighbors, so each page can pull in at most K others and a
      // single borderline pair no longer bridges two big clusters.
      const KNN_K = 3;
      const KNN_FLOOR = 0.66;
      const SESSION_FLOOR = 0.58; // same-sitting pages get a lower bar (time is corroborating evidence)
      const firstVisit = (n) => n.visits[0]?.at ?? n.createdAt;
      const real = [];
      for (let i = 0; i < nodes.length; i++) {
        if (!connector[i] && nodes[i].embedding) real.push(i);
      }
      const top = new Map(real.map((i) => [i, []]));
      const consider = (a, b, sim) => {
        const list = top.get(a);
        list.push({ j: b, sim });
        list.sort((x, y) => y.sim - x.sim);
        if (list.length > KNN_K) list.pop();
      };
      for (let x = 0; x < real.length; x++) {
        for (let y = x + 1; y < real.length; y++) {
          const i = real[x];
          const j = real[y];
          const sim = cosine(nodes[i].embedding, nodes[j].embedding);
          if (sim >= KNN_FLOOR) {
            consider(i, j, sim);
            consider(j, i, sim);
          }
          // The session rule is NOT an else-branch: a same-sitting pair above
          // the kNN floor must still union directly, or linkage would be
          // non-monotone — a 0.70 pair crowded out of both top-K lists by
          // denser neighbors would stay apart while a 0.60 pair unions here.
          // Time proximity chains transitively (page A ~ B ~ C … links a
          // whole evening into one mega-cluster), so it needs a stiff
          // similarity bar, not a loose one.
          if (sim >= SESSION_FLOOR
              && Math.abs(firstVisit(nodes[i]) - firstVisit(nodes[j])) < 10 * 60 * 1000) {
            union(i, j);
          }
        }
      }
      for (const [i, list] of top) {
        for (const { j } of list) {
          if (top.get(j)?.some((e) => e.j === i)) union(i, j);
        }
      }

      // Components form over REAL pages only; connectors are labeled
      // afterwards (pure labeling, no union — so a basket page touching two
      // threads can never weld them together).
      const comps = new Map();
      nodes.forEach((n, i) => {
        if (connector[i]) return;
        const root = find(i);
        if (!comps.has(root)) comps.set(root, []);
        comps.get(root).push(n);
      });

      const topics = await db.getByIndex('topics', 'byJourney', journey.id);
      const topicById = new Map(topics.map((t) => [t.id, t]));
      const toName = [];
      const liveTopicIds = new Set();
      let changed = false;
      // Biggest component first: a topic id (and its name) belongs to ONE
      // component, so when a cluster splits, the largest surviving piece
      // keeps the incumbent identity and the splinters mint fresh topics —
      // not whichever fragment map iteration happened to visit first.
      const ordered = [...comps.values()].sort((a, b) => b.length - a.length);
      for (const members of ordered) {
        // A lone page isn't a theme — it stays in "Not yet organized"
        // rather than minting single-page topic confetti (and a naming
        // call). If related pages show up later, it clusters then.
        if (members.length < 2) {
          for (const m of members) {
            if (m.topicId) {
              await db.update('nodes', m.id, (x) => {
                delete x.topicId;
                return x;
              });
              delete m.topicId;
              changed = true;
            }
          }
          continue;
        }
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
            m.topicId = topicId;
            changed = true;
          }
        }
        if (!topicById.get(topicId).name && !toName.some((e) => e.topic.id === topicId)) {
          toName.push({ topic: topicById.get(topicId), members });
        }
      }
      // Connectors (carts, sign-ins, search pages) display alongside a real
      // neighbor when one exists — a pure label, never a bridge.
      for (let ni = 0; ni < nodes.length; ni++) {
        const n = nodes[ni];
        if (!connector[ni]) continue;
        let label = null;
        for (const e of edges) {
          if (e.type === 'similar') continue;
          const otherId = e.from === n.id ? e.to : e.to === n.id ? e.from : null;
          if (!otherId) continue;
          const oi = idx.get(otherId);
          const other = oi != null ? nodes[oi] : null;
          if (other && !connector[oi] && other.topicId) {
            label = other.topicId;
            break;
          }
        }
        if ((n.topicId || null) !== label) {
          await db.update('nodes', n.id, (x) => {
            if (label) x.topicId = label;
            else delete x.topicId;
            return x;
          });
          n.topicId = label || undefined;
          changed = true;
        }
      }

      for (const t of topics) {
        if (!liveTopicIds.has(t.id)) await db.remove('topics', t.id);
      }

      if (toName.length) {
        // Name in small chunks, not one giant call: a batch covering dozens
        // of topics regularly outran the generate timeout, and one timeout
        // lost ALL the names. Chunks keep each call short, and names that DID
        // parse are saved immediately — a retry only re-names what's still
        // unnamed (toName is rebuilt from unnamed topics each run).
        const NAME_CHUNK = 6;
        const namedIds = new Set();
        try {
          for (let start = 0; start < toName.length; start += NAME_CHUNK) {
            const slice = toName.slice(start, start + NAME_CHUNK);
            // Sample the pages that actually describe the theme — hostname-only
            // entries tell the namer nothing.
            const clusters = slice.map((e, i) => ({
              n: i + 1,
              pages: e.members
                .filter((m) => m.hook || m.title)
                .concat(e.members.filter((m) => !m.hook && !m.title))
                .slice(0, 10)
                .map((m) => m.hook || m.title || m.host),
            }));
            const { system, prompt } = ollama.clusterNamesPrompt(clusters);
            const response = await ollama.generate(prompt, {
              system, timeoutMs: 120000, numPredict: slice.length * 50 + 200,
            });
            for (const { n, name } of ollama.parseClusterNames(response, slice.length)) {
              await db.update('topics', slice[n - 1].topic.id, (x) => {
                x.name = truncate(String(name).trim(), 60);
                x.updatedAt = Date.now();
                return x;
              });
              namedIds.add(slice[n - 1].topic.id);
              changed = true;
            }
          }
        } finally {
          // Whatever landed before a timeout or parse failure should show up
          // now, not after the retry settles. (Notify is debounced, so the
          // success path's notify at the end of this case doesn't double-fire.)
          if (changed) notifyTrailUpdated(journey.id);
        }
        // Any topic still unnamed is a failure, not a success — a model that
        // names 4 of 6 threads would otherwise leave real topics stuck at
        // "Organizing…" forever. Throwing lets the queue retry; assignments
        // and the names that did land are already saved, and the retry's
        // toName is rebuilt from whatever is still unnamed.
        const missing = toName.filter((e) => !namedIds.has(e.topic.id)).length;
        if (missing) {
          throw new Error(`topic naming: ${missing} of ${toName.length} topics still unnamed`);
        }
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
      const response = await ollama.generate(prompt, { system, numPredict: 400 });
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
      const response = await ollama.generate(prompt, { system, timeoutMs: 300000, numPredict: 2000 });
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
      const text = await ollama.generate(prompt, { system, timeoutMs: 300000, numPredict: 2400 });
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
