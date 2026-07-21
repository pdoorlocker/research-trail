// Research Trail — journey page: graph, timeline, drawer, settings, exports.

import * as db from '../lib/db.js';
import {
  baseDomain, formatDuration, faviconUrl, getSettings, saveSettings, truncate,
} from '../lib/util.js';

const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);

let journey = null;
let nodes = [];
let edges = [];

// Temporary domain scope, mirroring the side panel's lens: while non-empty,
// the graph and timeline show only these domains' pages. Ephemeral by
// design — cleared on workspace switch, never persisted.
const domainScope = new Set();

// Same key node ring colors hash on (host sans www), so the chip strip's
// colors match the rings exactly.
function domainKeyOf(n) {
  return n.host.replace(/^www\./, '');
}

function visibleNodes() {
  return domainScope.size ? nodes.filter((n) => domainScope.has(domainKeyOf(n))) : nodes;
}
let cy = null;
let selectedNodeId = null;
let connectFromId = null;
let graphSignature = '';
let journeyJobs = {}; // pending AI work for this journey: { synthesize, connections }
let tabMap = { byNode: {}, activeNodeId: null }; // which nodes have live tabs
const hooksRequested = new Set(); // workspaces we've asked to backfill handles for
const topicsRequested = new Set(); // scratch workspaces we've asked to organize
let allNodes = []; // unfiltered; `nodes` is the topic-filtered view in Scratch
let topics = [];
let selectedTopicId = null; // which Scratch topic's map is open (null = topic list)
let activeSuggestion = null; // split suggestion being previewed
let previewActive = false;
let scratchLiteActive = false; // viewing Scratch while lite processing is on

function isScratchJourney(j) {
  return j?.kind === 'scratch' || j?.name === 'Scratch';
}

// ---------- Bootstrap ----------

async function init() {
  wireTopbar();
  wireDrawer();
  wireSettings();
  wirePreview();
  wireSearch();
  $('topics-back').onclick = () => {
    selectedTopicId = null;
    graphSignature = '';
    cy?.elements().remove();
    loadData(journey.id);
  };

  const journeys = (await db.getAll('journeys')).sort((a, b) => b.createdAt - a.createdAt);
  const requested = new URLSearchParams(location.search).get('j');
  const current = journeys.find((j) => j.id === requested) || journeys[0] || null;

  const select = $('journey-select');
  select.textContent = '';
  for (const j of journeys) {
    const opt = document.createElement('option');
    opt.value = j.id;
    opt.textContent = j.name;
    select.appendChild(opt);
  }
  if (!journeys.length) {
    const opt = document.createElement('option');
    opt.textContent = 'No journeys yet';
    select.appendChild(opt);
    select.disabled = true;
  }
  select.onchange = () => switchJourney(select.value);

  if (current) {
    select.value = current.id;
    await switchJourney(current.id);
  } else {
    $('empty-state').hidden = false;
  }

  // Arriving via a suggestion notification (?suggest=<id>): jump straight
  // into the split preview, switching workspaces first if needed.
  const suggestId = new URLSearchParams(location.search).get('suggest');
  if (suggestId) {
    const res = await send({ type: 'list-suggestions' });
    const s = (res.suggestions || []).find((x) => x.id === suggestId);
    if (s) {
      if (s.journeyId !== journey?.id) {
        select.value = s.journeyId;
        await switchJourney(s.journeyId);
      }
      enterPreview(s);
    }
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'trail-updated' && msg.journeyId === journey?.id) scheduleReload();
    if (msg.type === 'tabs-updated' && journey) scheduleReload();
  });
  pollJobStatus();
  setInterval(pollJobStatus, 6000);
}

async function switchJourney(id) {
  history.replaceState(null, '', `?j=${id}`);
  // Splits and promotions mint workspaces mid-session — keep the picker honest.
  const select = $('journey-select');
  if (![...select.options].some((o) => o.value === id)) {
    const j = await db.get('journeys', id);
    if (j) {
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = j.name;
      select.prepend(opt);
    }
  }
  select.value = id;
  selectedNodeId = null;
  connectFromId = null;
  selectedTopicId = null;
  domainScope.clear();
  previewActive = false;
  activeSuggestion = null;
  $('preview-banner').hidden = true;
  graphSignature = '';
  cy?.elements().remove();
  closeDrawer();
  await loadData(id);
}

let reloadTimer = null;
function scheduleReload() {
  // Generous debounce: while the AI queue is draining, jobs finish every few
  // seconds and each reload re-reads the whole workspace — don't storm it.
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => loadData(journey.id), 1500);
}

async function loadData(id) {
  journey = await db.get('journeys', id);
  if (!journey) return;
  allNodes = (await db.getByIndex('nodes', 'byJourney', id)).sort((a, b) => a.createdAt - b.createdAt);
  edges = await db.getByIndex('edges', 'byJourney', id);
  const scratch = isScratchJourney(journey);
  scratchLiteActive = scratch && (await getSettings()).scratchLite !== false;
  topics = scratch ? await db.getByIndex('topics', 'byJourney', id) : [];
  if (selectedTopicId && !topics.some((t) => t.id === selectedTopicId) && selectedTopicId !== '__unsorted') {
    selectedTopicId = null; // topic got merged away or deleted
  }
  nodes = scratch && selectedTopicId
    ? allNodes.filter((n) => (selectedTopicId === '__unsorted'
        ? !n.topicId || !topics.some((t) => t.id === n.topicId)
        : n.topicId === selectedTopicId))
    : allNodes;

  const state = await send({ type: 'get-state' });
  tabMap = state.activeJourneyId === id
    ? await send({ type: 'tab-map' })
    : { byNode: {}, activeNodeId: null };
  const chip = $('status-chip');
  if (state.activeJourneyId === id) {
    chip.textContent = state.paused ? 'paused' : '● recording';
    chip.className = state.paused ? 'chip' : 'chip recording';
  } else {
    chip.textContent = journey.status === 'done' ? 'finished' : 'idle';
    chip.className = 'chip';
  }

  // Pages summarized before handles existed: ask for a backfill once.
  // Not for Scratch — the condition matches excerpt-only pages, and lite
  // mode deliberately avoids spending the chat model on ambient browsing.
  if (!scratch && !hooksRequested.has(id)
      && allNodes.filter((n) => (n.summary?.length || n.excerpt) && !n.hook).length >= 2) {
    hooksRequested.add(id);
    send({ type: 'refresh-hooks', journeyId: id });
  }
  // Scratch with unorganized pages OR topics stuck without names (e.g. the
  // naming call failed while Ollama was unreachable): kick the organizer
  // once per session.
  if (scratch && !topicsRequested.has(id)
      && (allNodes.filter((n) => !n.topicId).length >= 3
        || topics.some((t) => !t.name))) {
    topicsRequested.add(id);
    send({ type: 'refresh-topics', journeyId: id });
  }

  // Split suggestions live on named workspaces only.
  if (!scratch && !previewActive) {
    const res = await send({ type: 'list-suggestions', journeyId: id });
    renderSuggestStrip(res.suggestions?.[0] || null);
  } else {
    renderSuggestStrip(null);
  }

  // Scratch's graph tab opens as the topic list; a selected topic shows its map.
  const showTopics = scratch && !selectedTopicId;
  $('topics-view').hidden = !showTopics || !allNodes.length;
  $('topics-back').hidden = !(scratch && selectedTopicId);
  const topicChip = $('topic-name');
  if (scratch && selectedTopicId) {
    topicChip.hidden = false;
    topicChip.textContent = selectedTopicId === '__unsorted'
      ? 'Not yet organized'
      : (topics.find((t) => t.id === selectedTopicId)?.name || 'Organizing…');
  } else {
    topicChip.hidden = true;
  }

  renderSynthesis();
  if (showTopics) {
    $('domain-strip').hidden = true;
    renderTopicsView();
  } else {
    renderDomainStrip();
    renderGraph();
  }
  // The timeline measures DOM positions, so it only renders while visible;
  // switching to the tab re-renders it (and skipping it here saves a full
  // DOM rebuild on every background update).
  if (!$('timeline-view').hidden) renderTimeline();
  $('empty-state').hidden = nodes.length > 0 || showTopics;
  if (selectedNodeId) renderDrawer();
  if (openEdgeId && $('edge-modal').open && !populateEdgeModal(openEdgeId)) {
    $('edge-modal').close(); // edge got deleted under us
  }
}

// ---------- Search ----------
// One box, every workspace: matches hooks, titles, summaries, notes, tags,
// hosts and URLs. Picking a result jumps there — switching workspace (and
// Scratch topic) if needed — then selects, centers, and opens the drawer.

let searchIndex = null;
let searchIndexAt = 0;
let searchTimer = null;

async function buildSearchIndex() {
  if (searchIndex && Date.now() - searchIndexAt < 30000) return searchIndex;
  const [allN, allJ] = await Promise.all([db.getAll('nodes'), db.getAll('journeys')]);
  const wsName = new Map(allJ.map((j) => [j.id, j.name]));
  searchIndex = allN.map((n) => ({
    id: n.id,
    journeyId: n.journeyId,
    topicId: n.topicId || null,
    title: n.title || '',
    hook: n.hook || '',
    host: n.host,
    url: n.url,
    notes: n.notes || '',
    tags: (n.tags || []).join(' '),
    summary: (n.summary || []).join(' '),
    ws: wsName.get(n.journeyId) || '',
  }));
  searchIndexAt = Date.now();
  return searchIndex;
}

function searchScore(entry, terms) {
  let score = 0;
  const fields = [
    [entry.hook, 4], [entry.title, 3], [entry.tags, 2], [entry.notes, 2],
    [entry.summary, 1], [entry.host, 1], [entry.url, 0.5],
  ];
  for (const term of terms) {
    let termScore = 0;
    for (const [text, weight] of fields) {
      if (text && text.toLowerCase().includes(term)) termScore = Math.max(termScore, weight);
    }
    if (!termScore) return 0; // every term must match somewhere
    score += termScore;
  }
  return score;
}

async function runSearch(q) {
  const box = $('search-results');
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) {
    box.hidden = true;
    return;
  }
  const index = await buildSearchIndex();
  const hits = index
    .map((e) => ({ e, score: searchScore(e, terms) }))
    .filter((h) => h.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 12);

  box.textContent = '';
  if (!hits.length) {
    const empty = document.createElement('div');
    empty.className = 'search-empty';
    empty.textContent = 'No pages match.';
    box.appendChild(empty);
  }
  hits.forEach(({ e }, i) => {
    const item = document.createElement('div');
    item.className = 'search-item' + (i === 0 ? ' hot' : '');
    const img = document.createElement('img');
    img.src = faviconUrl(e.url, 16);
    img.alt = '';
    const main = document.createElement('div');
    main.className = 's-main';
    const title = document.createElement('div');
    title.className = 's-title';
    title.textContent = e.hook || e.title || e.host;
    const sub = document.createElement('div');
    sub.className = 's-sub';
    sub.textContent = e.hook && e.title ? `${e.title} · ${e.host}` : e.host;
    main.append(title, sub);
    const ws = document.createElement('span');
    ws.className = 's-ws';
    ws.textContent = e.ws;
    item.append(img, main, ws);
    item.onclick = () => openSearchResult(e);
    box.appendChild(item);
  });
  box.hidden = false;
}

async function openSearchResult(entry) {
  $('search-results').hidden = true;
  $('search').value = '';
  searchIndex = null; // next search re-reads fresh data
  if (entry.journeyId !== journey?.id) {
    await switchJourney(entry.journeyId);
  }
  if (isScratchJourney(journey)) {
    const target = entry.topicId || '__unsorted';
    if (selectedTopicId !== target) {
      selectedTopicId = target;
      graphSignature = '';
      cy?.elements().remove();
      await loadData(journey.id);
    }
  }
  selectedNodeId = entry.id;
  renderDrawer();
  if (cy) {
    cy.elements(':selected').unselect();
    const el = cy.getElementById(entry.id);
    if (el.length) {
      el.select();
      cy.animate({ center: { eles: el }, duration: 250, easing: 'ease-out' });
    }
  }
}

function wireSearch() {
  const input = $('search');
  input.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => runSearch(input.value.trim()), 200);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const first = $('search-results').querySelector('.search-item');
      first?.click();
    } else if (e.key === 'Escape') {
      $('search-results').hidden = true;
      input.blur();
    }
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#search-wrap')) $('search-results').hidden = true;
  });
  // "/" from anywhere focuses search, like every good tool.
  document.addEventListener('keydown', (e) => {
    if (e.key !== '/') return;
    const t = document.activeElement;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if ($('settings-modal').open || $('edge-modal').open) return;
    e.preventDefault();
    input.focus();
  });
}

// ---------- Scratch topics view ----------

function renderTopicsView() {
  const list = $('topics-list');
  list.textContent = '';
  const topicById = new Map(topics.map((t) => [t.id, t]));
  const groups = new Map(); // topicId | '__unsorted' -> nodes
  for (const n of allNodes) {
    const key = n.topicId && topicById.has(n.topicId) ? n.topicId : '__unsorted';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(n);
  }
  const lastVisit = (ns) => Math.max(...ns.map((n) => n.visits[n.visits.length - 1]?.at ?? n.createdAt));
  const entries = [...groups.entries()].sort((a, b) => lastVisit(b[1]) - lastVisit(a[1]));

  for (const [key, members] of entries) {
    const topic = topicById.get(key);
    const card = document.createElement('div');
    card.className = 'topic-card';
    card.onclick = () => {
      selectedTopicId = key;
      graphSignature = '';
      cy?.elements().remove();
      loadData(journey.id);
    };

    const main = document.createElement('div');
    main.className = 'topic-main';
    const name = document.createElement('div');
    if (key === '__unsorted') {
      name.className = 'topic-name pending';
      name.textContent = 'Not yet organized';
    } else if (!topic.name) {
      name.className = 'topic-name pending';
      name.textContent = 'Organizing…';
    } else {
      name.className = 'topic-name';
      name.textContent = topic.name;
    }
    const meta = document.createElement('div');
    meta.className = 'topic-meta';
    const times = members.map((n) => n.visits[0]?.at ?? n.createdAt);
    const fmt = (t) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    const from = fmt(Math.min(...times));
    const to = fmt(lastVisit(members));
    meta.textContent = `${members.length} page${members.length === 1 ? '' : 's'} · ${from === to ? from : `${from} – ${to}`}`;
    main.append(name, meta);
    const sampleHooks = members.map((n) => n.hook).filter(Boolean).slice(0, 2);
    if (sampleHooks.length) {
      const hooks = document.createElement('div');
      hooks.className = 'topic-hooks';
      hooks.textContent = sampleHooks.join('  ·  ');
      main.appendChild(hooks);
    }

    const favs = document.createElement('div');
    favs.className = 'topic-favs';
    const seen = new Set();
    for (const n of members) {
      const h = n.host.replace(/^www\./, '');
      if (seen.has(h) || seen.size >= 6) continue;
      seen.add(h);
      const img = document.createElement('img');
      img.src = faviconUrl(n.url, 16);
      img.alt = '';
      favs.appendChild(img);
    }

    card.append(main, favs);
    if (key !== '__unsorted' && topic?.name) {
      const promote = document.createElement('button');
      promote.textContent = 'Make workspace';
      promote.title = 'Move these pages into a real workspace of their own';
      promote.onclick = async (e) => {
        e.stopPropagation();
        const res = await send({ type: 'promote-topic', topicId: key });
        if (res.error) toast(`Couldn't promote: ${res.error}`);
        else {
          toast(`“${topic.name}” is now its own workspace.`);
          switchJourney(res.journeyId);
        }
      };
      card.appendChild(promote);
    }
    list.appendChild(card);
  }
}

// ---------- Split suggestions ----------

function renderSuggestStrip(suggestion) {
  const strip = $('suggest-strip');
  if (!suggestion) {
    strip.hidden = true;
    return;
  }
  strip.hidden = false;
  $('suggest-text').textContent =
    `Looks like a separate thread: “${suggestion.name}” — ${suggestion.nodeIds.length} pages`;
  $('suggest-review').onclick = () => enterPreview(suggestion);
}

function enterPreview(suggestion) {
  activeSuggestion = suggestion;
  previewActive = true;
  renderSuggestStrip(null);
  $('preview-name').textContent = `“${suggestion.name}”`;
  $('preview-meta').textContent =
    `The highlighted ${suggestion.nodeIds.length} pages would move into a new workspace. Everything else stays.`;
  $('preview-banner').hidden = false;
  applyPreviewDim();
}

function applyPreviewDim() {
  if (!previewActive || !cy || !activeSuggestion) return;
  const members = cy.collection(
    activeSuggestion.nodeIds.map((id) => cy.getElementById(id)).filter((n) => n.length),
  );
  cy.batch(() => {
    cy.elements().addClass('dimmed');
    const focus = members.union(members.edgesWith(members)).union(members.ancestors());
    focus.removeClass('dimmed');
    focus.edges().addClass('spotlit');
  });
}

async function exitPreview() {
  previewActive = false;
  activeSuggestion = null;
  $('preview-banner').hidden = true;
  clearSpotlight();
  loadData(journey.id);
}

function wirePreview() {
  $('preview-split').onclick = async () => {
    const res = await send({ type: 'resolve-suggestion', id: activeSuggestion.id, accept: true });
    if (res.error) {
      toast(`Couldn't split: ${res.error}`);
      exitPreview();
      return;
    }
    const target = res.journeyId;
    await exitPreview();
    toast('Split off into its own workspace.');
    switchJourney(target);
  };
  $('preview-keep').onclick = async () => {
    await send({ type: 'resolve-suggestion', id: activeSuggestion.id, accept: false });
    exitPreview();
    toast('Kept together — this exact set won\'t be suggested again.');
  };
}

// ---------- Top bar ----------

function wireTopbar() {
  $('synthesize-btn').onclick = async () => {
    if (!journey) return;
    journeyJobs.synthesize = true;
    updateAiButtons();
    renderSynthesis();
    await send({ type: 'synthesize', journeyId: journey.id });
  };
  $('similarity-btn').onclick = async () => {
    if (!journey) return;
    const res = await send({ type: 'recompute-similarity', journeyId: journey.id });
    if (res.error) {
      toast(`Similarity failed: ${res.error}`);
    } else if (res.tooFew) {
      toast('Need at least two captured pages to find connections.');
    } else if (res.queuedLlm) {
      journeyJobs.connections = true;
      updateAiButtons();
      toast('The model is reading through the pages to propose connections — they\'ll appear on the map when it finishes.');
    } else if (res.queuedEmbeds) {
      toast(`Queued ${res.queuedEmbeds} embedding job${res.queuedEmbeds === 1 ? '' : 's'} — ${res.created} connection${res.created === 1 ? '' : 's'} so far, click again once they finish.`);
    } else {
      toast(`${res.created} new connection${res.created === 1 ? '' : 's'} found across ${res.comparable} pages.`);
    }
  };

  $('export-btn').onclick = (e) => {
    e.stopPropagation();
    $('export-menu').hidden = !$('export-menu').hidden;
  };
  document.addEventListener('click', () => { $('export-menu').hidden = true; });
  for (const btn of document.querySelectorAll('#export-menu button')) {
    btn.onclick = () => exportJourney(btn.dataset.export);
  }

  $('settings-btn').onclick = openSettings;
  // Collapsed, the summary is a slim vertical strip: click anywhere on it to
  // expand; expanded, click its header to collapse.
  $('synthesis-panel').addEventListener('click', (e) => {
    if (!journey) return;
    const collapsed = synthesisCollapsed();
    if (!collapsed && !e.target.closest('.panel-head')) return;
    localStorage.setItem(`rt-syncol-${journey.id}`, collapsed ? '0' : '1');
    renderSynthesis();
  });
  $('e-close').onclick = () => $('edge-modal').close();

  for (const tab of document.querySelectorAll('.tab')) {
    tab.onclick = () => {
      document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
      $('graph-view').style.display = tab.dataset.tab === 'graph' ? '' : 'none';
      $('timeline-view').hidden = tab.dataset.tab !== 'timeline';
      if (tab.dataset.tab === 'graph' && cy) cy.resize();
      // Connector positions can only be measured while the timeline is visible.
      if (tab.dataset.tab === 'timeline' && journey) renderTimeline();
    };
  }

  $('connect-cancel').onclick = cancelConnectMode;

  // Legend chips filter connections by type.
  for (const chip of document.querySelectorAll('.legend-toggle')) {
    chip.classList.toggle('off', hiddenEdgeTypes.has(chip.dataset.type));
    chip.onclick = () => {
      const type = chip.dataset.type;
      if (hiddenEdgeTypes.has(type)) hiddenEdgeTypes.delete(type);
      else hiddenEdgeTypes.add(type);
      localStorage.setItem('rt-hidden-edges', JSON.stringify([...hiddenEdgeTypes]));
      chip.classList.toggle('off', hiddenEdgeTypes.has(type));
      applyEdgeFilter();
    };
  }

  const zoomStep = (factor) => {
    if (!cy) return;
    cy.zoom({
      level: cy.zoom() * factor,
      renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 },
    });
  };
  $('zoom-in').onclick = () => zoomStep(1.3);
  $('zoom-out').onclick = () => zoomStep(1 / 1.3);
  $('zoom-fit').onclick = () => cy?.fit(undefined, 50);
  $('relayout').onclick = () => cy && runLayout();
  updatePhysicsButton();
  $('physics-toggle').onclick = () => {
    physicsFrozen = !physicsFrozen;
    localStorage.setItem('rt-physics-frozen', physicsFrozen ? '1' : '0');
    updatePhysicsButton();
    if (!physicsFrozen) wakePhysics();
    toast(physicsFrozen
      ? 'Physics off — pages stay exactly where they are. New pages still drop in next to their source.'
      : 'Physics on — the map breathes again.');
  };
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) wakePhysics();
  });

  // Select a page or a cluster box, hit Delete/Backspace, and it's pruned
  // from the map (never fires while typing notes or in a dialog).
  document.addEventListener('keydown', async (e) => {
    if (e.key !== 'Delete' && e.key !== 'Backspace') return;
    const t = document.activeElement;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (!cy || !journey) return;
    if ($('settings-modal').open || $('edge-modal').open) return;
    const selected = cy.nodes(':selected');
    if (!selected.length) return;
    e.preventDefault();
    const pageIds = new Set();
    selected.forEach((n) => {
      if (n.data('isGroup')) {
        n.descendants().forEach((d) => {
          if (!d.data('isGroup')) pageIds.add(d.id());
        });
      } else {
        pageIds.add(n.id());
      }
    });
    if (!pageIds.size) return;
    const what = selected.length === 1 && selected[0].data('isGroup')
      ? `all ${pageIds.size} page${pageIds.size === 1 ? '' : 's'} in “${selected[0].data('label')}”`
      : `${pageIds.size} page${pageIds.size === 1 ? '' : 's'}`;
    if (!window.confirm(`Remove ${what} from the map? Their notes and highlights are deleted too.`)) return;
    const res = await send({ type: 'delete-nodes', nodeIds: [...pageIds] });
    if (res?.error) {
      toast(`Couldn't remove: ${res.error}`);
      return;
    }
    // Reflect immediately rather than waiting for the broadcast round-trip.
    nodes = nodes.filter((n) => !pageIds.has(n.id));
    edges = edges.filter((e) => !pageIds.has(e.from) && !pageIds.has(e.to));
    renderGraph();
    $('empty-state').hidden = nodes.length > 0;
    if (selectedNodeId && pageIds.has(selectedNodeId)) closeDrawer();
    toast(`Removed ${res?.removed ?? pageIds.size} page${pageIds.size === 1 ? '' : 's'}.`);
    scheduleReload();
  });
}

let physicsFrozen = localStorage.getItem('rt-physics-frozen') === '1';

function updatePhysicsButton() {
  $('physics-toggle').textContent = physicsFrozen ? 'Physics: off' : 'Physics: on';
}

// ---------- Edge modal ----------

const EDGE_META = {
  navigated: { title: 'Clicked link', explain: (e) => `You clicked from the first page to the second${e.count > 1 ? ` (${e.count} times)` : ''}.` },
  branched: { title: 'Opened in new tab', explain: () => 'You opened the second page in a new tab from the first.' },
  similar: { title: 'AI connection', explain: (e) => `The AI thinks these pages cover related ground${e.similarity ? ` (similarity ${e.similarity.toFixed(2)})` : ''}.` },
  manual: { title: 'Your connection', explain: () => 'You connected these pages yourself.' },
};

let openEdgeId = null;
const describingEdges = new Set();

function openEdgeModal(edgeId) {
  if (populateEdgeModal(edgeId)) {
    openEdgeId = edgeId;
    $('edge-modal').showModal();
  }
}

// Fills the modal; also called on data refresh so an open modal picks up the
// AI's description when it lands.
function populateEdgeModal(edgeId) {
  const e = edges.find((x) => x.id === edgeId);
  if (!e) return false;
  const a = nodes.find((n) => n.id === e.from);
  const b = nodes.find((n) => n.id === e.to);
  if (!a || !b) return false;

  const meta = EDGE_META[e.type] || EDGE_META.manual;
  $('e-type').textContent = meta.title;
  $('e-explain').textContent = meta.explain(e);
  fillEdgePage($('e-page-a'), a);
  fillEdgePage($('e-page-b'), b);

  const label = $('e-label');
  label.hidden = !e.label;
  label.textContent = e.label ? `“${e.label}”` : '';

  const desc = $('e-desc');
  const describe = $('e-describe');
  if (e.description) {
    describingEdges.delete(e.id);
    desc.hidden = false;
    desc.textContent = e.description;
    describe.hidden = true;
  } else if (describingEdges.has(e.id)) {
    desc.hidden = false;
    desc.textContent = 'The model is writing an explanation…';
    describe.hidden = true;
  } else {
    desc.hidden = true;
    describe.hidden = false;
    describe.onclick = async () => {
      describingEdges.add(e.id);
      populateEdgeModal(e.id);
      await send({ type: 'describe-edge', edgeId: e.id });
    };
  }

  const del = $('e-delete');
  del.hidden = !(e.type === 'similar' || e.type === 'manual');
  del.onclick = async () => {
    await send({ type: 'delete-edge', edgeId: e.id });
    $('edge-modal').close();
  };

  const edit = $('e-edit-label');
  edit.hidden = e.type !== 'manual';
  edit.onclick = async () => {
    const next = window.prompt('Label this connection:', e.label || '');
    if (next === null) return;
    await send({ type: 'set-edge-label', edgeId: e.id, label: next });
  };
  return true;
}

function fillEdgePage(btn, node) {
  btn.textContent = '';
  const img = document.createElement('img');
  img.src = faviconUrl(node.url, 16);
  img.alt = '';
  const title = document.createElement('span');
  title.className = 'title';
  title.textContent = truncate(node.title || node.url, 90);
  const host = document.createElement('span');
  host.className = 'host';
  host.textContent = node.host;
  btn.append(img, title, host);
  btn.onclick = () => {
    $('edge-modal').close();
    selectedNodeId = node.id;
    renderDrawer();
    cy?.elements(':selected').unselect();
    cy?.getElementById(node.id).select();
  };
}

const JOB_VERBS = {
  summarize: (t) => `summarizing ${t ? `“${truncate(t, 60)}”` : 'a page'}`,
  embed: () => 'indexing pages for similarity',
  'similar-label': () => 'labeling a connection',
  connections: () => 'reading pages to find connections',
  synthesize: () => 'writing the journey summary',
  'edge-describe': () => 'explaining a connection',
  hooks: () => 'writing recognizable page handles',
  organize: () => 'organizing Scratch into topics',
  'tangent-scan': () => 'checking for off-theme threads',
};

function renderAiStrip(s) {
  const strip = $('ai-strip');
  const text = $('ai-strip-text');
  const toggle = $('ai-strip-toggle');
  if (s.aiPaused && (s.pending || s.errored)) {
    strip.hidden = false;
    strip.classList.add('paused');
    text.textContent = `AI paused — ${s.pending} job${s.pending === 1 ? '' : 's'} waiting. Your computer is all yours.`;
    toggle.textContent = 'Resume AI';
  } else if (s.pending || s.current) {
    strip.hidden = false;
    strip.classList.remove('paused');
    const verb = s.current ? (JOB_VERBS[s.current.type] || (() => 'working'))(s.current.title) : 'warming up';
    const left = s.pending ? ` · ${s.pending} job${s.pending === 1 ? '' : 's'} left` : '';
    text.textContent = s.ok
      ? `AI working: ${verb}${left}. This uses your local Ollama — pause it if the machine feels slow.`
      : `${s.pending} AI job${s.pending === 1 ? '' : 's'} waiting for Ollama to come back.`;
    toggle.textContent = 'Pause AI';
  } else {
    strip.hidden = true;
  }
  toggle.onclick = async () => {
    const cur = await getSettings();
    await saveSettings({ aiPaused: !cur.aiPaused });
    if (!cur.aiPaused) {
      toast('AI paused — the job Ollama is mid-way through will still finish, then everything waits.');
    } else {
      await send({ type: 'retry-jobs' });
      toast('AI resumed.');
    }
    pollJobStatus();
  };
}

async function pollJobStatus() {
  try {
    const s = await send({ type: 'ollama-status', journeyId: journey?.id });
    journeyJobs = s.journeyJobs || {};
    if (journey) {
      updateAiButtons();
      renderSynthesis();
    }
    renderAiStrip(s);
    // The small top-bar text is reserved for things that need a decision.
    const el = $('job-status');
    if (s.errored) {
      el.textContent = `${s.errored} AI job${s.errored === 1 ? '' : 's'} failed — click to retry`;
      el.className = 'job-status err';
      el.title = s.lastError || '';
      el.onclick = async () => {
        await send({ type: 'retry-jobs' });
        toast(s.lastError ? `Retrying. Last error: ${s.lastError}` : 'Retrying failed jobs.');
      };
    } else if (!s.ok && !s.pending) {
      el.textContent = 'Ollama offline';
      el.className = 'job-status';
      el.onclick = null;
    } else {
      el.textContent = '';
      el.onclick = null;
    }
  } catch { /* background asleep or busy; try again next tick */ }
}

// ---------- Synthesis panel ----------

function synthesisCollapsed() {
  return journey && localStorage.getItem(`rt-syncol-${journey.id}`) === '1';
}

function renderSynthesis() {
  const panel = $('synthesis-panel');
  const collapsed = synthesisCollapsed();
  panel.classList.toggle('collapsed', collapsed);
  panel.title = collapsed ? 'Show the journey summary' : '';
  if (journey?.synthesis?.text) {
    panel.hidden = false;
    $('synthesis-body').innerHTML = mdToHtml(journey.synthesis.text);
    $('synthesis-date').textContent = journeyJobs.synthesize
      ? 'updating…'
      : new Date(journey.synthesis.updatedAt).toLocaleString();
  } else if (journeyJobs.synthesize) {
    // Work is in flight but nothing written yet: show that, don't leave the
    // user wondering whether the button did anything.
    panel.hidden = false;
    $('synthesis-date').textContent = '';
    $('synthesis-body').innerHTML =
      '<p class="muted">The model is reading your pages and writing an overview — usually a minute or two. It will appear here.</p>';
  } else {
    panel.hidden = true;
  }
}

function updateAiButtons() {
  const synth = $('synthesize-btn');
  synth.disabled = !!journeyJobs.synthesize;
  synth.textContent = journeyJobs.synthesize ? 'Summarizing…' : 'Summarize journey';
  const sim = $('similarity-btn');
  sim.disabled = !!journeyJobs.connections;
  sim.textContent = journeyJobs.connections ? 'Finding connections…' : 'Find connections';
}

// Tiny, safe markdown renderer: escapes everything, then supports ##/###
// headings, bullets, and **bold** only.
function mdToHtml(md) {
  const esc = md
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const out = [];
  let inList = false;
  const closeList = () => { if (inList) { out.push('</ul>'); inList = false; } };
  for (const raw of esc.split('\n')) {
    const line = raw.trim();
    const bold = (s) => s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    if (!line) { closeList(); continue; }
    if (line.startsWith('### ')) { closeList(); out.push(`<h3>${bold(line.slice(4))}</h3>`); }
    else if (line.startsWith('## ')) { closeList(); out.push(`<h2>${bold(line.slice(3))}</h2>`); }
    else if (line.startsWith('# ')) { closeList(); out.push(`<h2>${bold(line.slice(2))}</h2>`); }
    else if (/^[-*•]\s+/.test(line)) {
      if (!inList) { out.push('<ul>'); inList = true; }
      out.push(`<li>${bold(line.replace(/^[-*•]\s+/, ''))}</li>`);
    } else { closeList(); out.push(`<p>${bold(line)}</p>`); }
  }
  closeList();
  return out.join('');
}

// ---------- Graph ----------

const PALETTE = [
  '#2f81f7', '#3fb950', '#d29922', '#a371f7', '#f778ba',
  '#56d4dd', '#e3684c', '#6e7681', '#7ee787', '#79c0ff',
];

function domainColor(domain) {
  let h = 0;
  for (const ch of domain) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function buildElements() {
  const elements = [];
  const cleanHost = (h) => h.replace(/^www\./, '');
  // The domain lens filters here, at the source — group boxes, edges, and
  // counts all follow from the scoped node set with no special cases.
  const scoped = visibleNodes();

  // Two-level clustering: pages group by hostname; hostname boxes nest inside
  // a registrable-domain box only when several distinct hosts share it
  // (wien.gv.at and oesterreich.gv.at stay separate; docs.foo.com and
  // blog.foo.com nest under foo.com).
  const hostCount = new Map();
  const domainHosts = new Map();
  for (const n of scoped) {
    const h = cleanHost(n.host);
    const d = baseDomain(n.host);
    hostCount.set(h, (hostCount.get(h) || 0) + 1);
    if (!domainHosts.has(d)) domainHosts.set(d, new Set());
    domainHosts.get(d).add(h);
  }
  const domainGroups = new Set(
    [...domainHosts.entries()].filter(([, hosts]) => hosts.size >= 2).map(([d]) => d),
  );
  for (const d of domainGroups) {
    elements.push({ data: { id: `domain:${d}`, label: d, isGroup: true, level: 'domain' } });
  }
  for (const [h, count] of hostCount) {
    if (count >= 2) {
      const d = baseDomain(h);
      elements.push({
        data: {
          id: `host:${h}`,
          label: h,
          isGroup: true,
          level: 'host',
          parent: domainGroups.has(d) ? `domain:${d}` : undefined,
        },
      });
    }
  }

  for (const n of scoped) {
    const h = cleanHost(n.host);
    const d = baseDomain(n.host);
    const parent = hostCount.get(h) >= 2
      ? `host:${h}`
      : domainGroups.has(d) ? `domain:${d}` : undefined;
    const size = Math.min(64, 30 + Math.log2(1 + (n.timeSpent || 0) / 20 + n.visits.length) * 7);
    const state = tabMap.activeNodeId === n.id ? 'active' : tabMap.byNode[n.id]?.length ? 'open' : 'parked';
    elements.push({
      data: {
        id: n.id,
        // Hooks are already written to be short (4-9 words) — only the raw
        // title/host fallback needs a hard cap to stay glanceable.
        label: n.hook ? truncate(n.hook, 80) : truncate(n.title || n.host, 28),
        parent,
        color: domainColor(h),
        favicon: faviconUrl(n.url, 32),
        size,
        state,
        domainKey: h,
      },
    });
  }
  const nodeIds = new Set(scoped.map((n) => n.id));
  for (const e of edges) {
    if (!nodeIds.has(e.from) || !nodeIds.has(e.to)) continue;
    elements.push({
      data: {
        id: e.id,
        source: e.from,
        target: e.to,
        type: e.type,
        label: e.type === 'similar' || e.type === 'manual' ? (e.label || '') : '',
      },
      classes: e.type,
    });
  }
  return elements;
}

function graphStyle() {
  const fg = cssVar('--fg') || '#1f2328';
  const muted = cssVar('--muted') || '#656d76';
  return [
    {
      selector: 'node',
      style: {
        'background-color': cssVar('--card') || '#f6f8fa',
        'background-image': 'data(favicon)',
        'background-fit': 'none',
        'background-width': '62%',
        'background-height': '62%',
        'background-clip': 'node',
        width: 'data(size)',
        height: 'data(size)',
        label: 'data(label)',
        color: fg,
        'font-size': 10,
        'text-valign': 'bottom',
        'text-margin-y': 5,
        'text-wrap': 'wrap',
        'text-max-width': 135,
        'border-width': 3,
        'border-color': 'data(color)',
        'border-opacity': 0.85,
        'transition-property': 'opacity',
        'transition-duration': '0.15s',
      },
    },
    {
      selector: 'node[?isGroup]',
      style: {
        // Literal size overrides: compounds auto-size to their children, but
        // without these the base data(size) mapping warns on every render.
        width: 30,
        height: 30,
        'background-image': 'none',
        'background-color': muted,
        'background-opacity': 0.06,
        'border-width': 1.5,
        'border-style': 'dashed',
        'border-color': muted,
        'border-opacity': 0.7,
        label: 'data(label)',
        color: muted,
        'font-size': 12,
        'font-weight': 700,
        'text-valign': 'top',
        'text-margin-y': -6,
        shape: 'round-rectangle',
      },
    },
    {
      selector: 'node[level="domain"]',
      style: {
        'border-style': 'dotted',
        'border-opacity': 0.45,
        'background-opacity': 0.03,
        'font-size': 11,
        'font-weight': 400,
      },
    },
    {
      selector: 'node[state="open"]',
      style: { 'border-width': 4, 'border-opacity': 1 },
    },
    {
      selector: 'node[state="active"]',
      style: {
        'border-width': 5,
        'border-opacity': 1,
        'border-color': cssVar('--accent') || '#1a7f37',
      },
    },
    {
      selector: 'node:selected',
      style: { 'border-width': 4, 'border-opacity': 1, 'border-color': fg },
    },
    {
      selector: 'edge',
      style: {
        width: 2,
        'line-color': muted,
        'line-opacity': 0.55,
        'curve-style': 'bezier',
        'target-arrow-shape': 'triangle',
        'target-arrow-color': muted,
        'arrow-scale': 0.9,
        'font-size': 9.5,
        color: muted,
        label: 'data(label)',
        'text-wrap': 'wrap',
        'text-max-width': 140,
        'text-background-color': cssVar('--bg') || '#fff',
        'text-background-opacity': 0.85,
        'text-background-padding': 2,
        'transition-property': 'opacity',
        'transition-duration': '0.15s',
      },
    },
    { selector: 'edge.branched', style: { 'line-color': '#0969da', 'target-arrow-color': '#0969da' } },
    {
      selector: 'edge.similar',
      style: {
        'line-style': 'dashed',
        'line-color': '#8957e5',
        'target-arrow-shape': 'none',
        'line-opacity': 0.75,
      },
    },
    {
      selector: 'edge.manual',
      style: { 'line-color': '#d4770c', 'target-arrow-shape': 'none', width: 3, 'line-opacity': 0.9 },
    },
    // Hover focus: everything outside the hovered neighborhood fades back.
    { selector: '.dimmed', style: { opacity: 0.13 } },
    { selector: 'edge.spotlit', style: { 'line-opacity': 1, width: 3 } },
    // Legend filter: hidden connection types disappear entirely.
    { selector: '.type-hidden', style: { display: 'none' } },
  ];
}

// ---------- Connection-type filter ----------

// ---------- Domain strip ----------
// One chip per domain in the current view, in the domain's ring color — the
// legend that filters, same interaction as the side panel: click to scope,
// click more to widen, "All" (or emptying the selection) clears. Hovering a
// chip previews its pages through the regular spotlight.

function renderDomainStrip() {
  const strip = $('domain-strip');
  const counts = new Map();
  for (const n of nodes) {
    const key = domainKeyOf(n);
    const entry = counts.get(key);
    if (entry) entry.count += 1;
    else counts.set(key, { count: 1, url: n.url });
  }
  for (const key of [...domainScope]) {
    if (!counts.has(key)) domainScope.delete(key);
  }
  if (counts.size < 2) {
    domainScope.clear();
    strip.hidden = true;
    return;
  }
  strip.hidden = false;
  strip.textContent = '';

  const apply = () => {
    renderDomainStrip();
    renderGraph();
    // Bring the reshaped view into frame — and keep it there: the diff path
    // wakes the physics simulation, which goes on nudging pages for a second
    // or so after a single fit would have snapshotted, drifting them
    // off-viewport. Refit a few times across the settle window (late passes
    // are no-ops once everything is calm).
    for (const delay of [60, 450, 1000, 1800]) {
      setTimeout(() => {
        if (cy?.elements().length) cy.fit(undefined, 50);
      }, delay);
    }
  };

  if (domainScope.size) {
    const all = document.createElement('button');
    all.className = 'domain-chip domain-chip-all';
    all.textContent = 'All';
    all.title = 'Clear the domain filter';
    all.onclick = () => {
      domainScope.clear();
      apply();
    };
    strip.appendChild(all);
  }

  const sorted = [...counts.entries()].sort((a, b) => b[1].count - a[1].count);
  for (const [key, info] of sorted) {
    const chip = document.createElement('button');
    const scoped = domainScope.has(key);
    chip.className = 'domain-chip' + (scoped ? ' scoped' : '') +
      (domainScope.size && !scoped ? ' excluded' : '');
    chip.style.setProperty('--chip-color', domainColor(key));
    chip.title = scoped
      ? `Showing ${key} — click to remove it from the filter`
      : `Show only ${key}${domainScope.size ? ' (and the other selected domains)' : ''}`;
    const icon = document.createElement('img');
    icon.src = faviconUrl(info.url, 16);
    icon.alt = '';
    const name = document.createElement('span');
    name.className = 'domain-chip-name';
    name.textContent = key;
    const count = document.createElement('span');
    count.className = 'domain-chip-count';
    count.textContent = info.count;
    chip.append(icon, name, count);
    chip.onclick = () => {
      if (domainScope.has(key)) domainScope.delete(key);
      else domainScope.add(key);
      apply();
    };
    chip.onmouseenter = () => {
      if (!cy || previewActive) return;
      const mine = cy.nodes(`[domainKey = "${key}"]`);
      if (mine.length) spotlight(mine.union(mine.ancestors()));
    };
    chip.onmouseleave = clearSpotlight;
    strip.appendChild(chip);
  }
}

let hiddenEdgeTypes = new Set(JSON.parse(localStorage.getItem('rt-hidden-edges') || '[]'));

function applyEdgeFilter() {
  if (!cy) return;
  cy.batch(() => {
    cy.edges().forEach((e) => {
      e.toggleClass('type-hidden', hiddenEdgeTypes.has(e.data('type')));
    });
  });
}

// ---------- Hover focus ----------
// Deliberate hovers only: the spotlight waits before engaging so sweeping
// the cursor across the map doesn't strobe.

const SPOTLIGHT_DELAY = 300;
let spotlightTimer = null;

function scheduleSpotlight(buildFocus) {
  if (previewActive) return; // split preview owns the dimming right now
  clearTimeout(spotlightTimer);
  spotlightTimer = setTimeout(() => spotlight(buildFocus()), SPOTLIGHT_DELAY);
}

function spotlight(focus) {
  cy.batch(() => {
    cy.elements().addClass('dimmed');
    focus.removeClass('dimmed');
    focus.edges().addClass('spotlit');
  });
}

function clearSpotlight() {
  clearTimeout(spotlightTimer);
  spotlightTimer = null;
  if (previewActive) return; // hover-out must not clear the split preview
  if (!cy) return;
  cy.batch(() => {
    cy.elements().removeClass('dimmed spotlit');
  });
}

function renderGraph() {
  const elements = buildElements();
  const signature = elements.map((el) => el.data.id).sort().join(',');

  if (!cy) {
    cy = cytoscape({
      container: $('cy'),
      elements,
      style: graphStyle(),
      minZoom: 0.08,
      maxZoom: 2.5,
    });
    cy.on('tap', 'node[!isGroup]', (evt) => onNodeTap(evt.target.id()));
    cy.on('tap', 'edge', (evt) => openEdgeModal(evt.target.id()));
    cy.on('tap', (evt) => {
      if (evt.target === cy) {
        closeDrawer();
        cancelConnectMode();
      }
    });
    cy.on('grab', 'node', (evt) => { grabbedId = evt.target.id(); wakePhysics(); });
    cy.on('drag', 'node', () => wakePhysics());
    cy.on('free', 'node', () => { grabbedId = null; wakePhysics(); });
    // Hover a page: spotlight it, its connections, and what they connect to.
    cy.on('mouseover', 'node[!isGroup]', (evt) => {
      const n = evt.target;
      scheduleSpotlight(() => {
        const hood = n.closedNeighborhood();
        return hood.union(hood.nodes().ancestors());
      });
    });
    // Hover a connection: spotlight it and its two pages.
    cy.on('mouseover', 'edge', (evt) => {
      const e = evt.target;
      scheduleSpotlight(() => {
        const ends = e.connectedNodes();
        return e.union(ends).union(ends.ancestors());
      });
    });
    cy.on('mouseout', 'node[!isGroup]', clearSpotlight);
    cy.on('mouseout', 'edge', clearSpotlight);
    runLayout();
    graphSignature = signature;
    applyEdgeFilter();
    return;
  }

  if (signature !== graphSignature) {
    // Elements may vanish mid-hover and never fire mouseout; don't leave the
    // map stuck dimmed.
    clearSpotlight();
    // Diff instead of rebuilding, so pages you've already placed don't get
    // scrambled every time a new one arrives.
    const hadElements = cy.elements().length > 0;
    const existingIds = new Set(cy.elements().map((el) => el.id()));
    const addedEls = elements.filter((el) => !existingIds.has(el.data.id));
    cy.add(addedEls);
    for (const el of elements) {
      if (!existingIds.has(el.data.id)) continue;
      const ex = cy.getElementById(el.data.id);
      if (!ex.length) continue;
      if (ex.isNode()) {
        const newParent = el.data.parent ?? null;
        if ((ex.data('parent') ?? null) !== newParent) ex.move({ parent: newParent });
      }
      const { parent, ...rest } = el.data;
      ex.data(rest);
    }
    const incoming = new Set(elements.map((el) => el.data.id));
    cy.elements().filter((el) => !incoming.has(el.id())).remove();
    if (hadElements) {
      // Drop new pages next to what they link from and let the physics
      // spread them out — no full re-arrangement, no scrambling.
      placeNewNodes(addedEls);
      wakePhysics();
    } else {
      runLayout();
    }
    graphSignature = signature;
  } else {
    // Structure unchanged: refresh labels/sizes in place, keep positions.
    for (const el of elements) {
      const existing = cy.getElementById(el.data.id);
      if (existing.length) {
        const { parent, ...rest } = el.data;
        existing.data(rest);
      }
    }
  }
  if (selectedNodeId) cy.getElementById(selectedNodeId).select();
  applyEdgeFilter();
  if (previewActive) applyPreviewDim();
}

// Full arrangement from scratch (first render and the Rearrange button). Day-to-day
// movement is handled by the gentle physics below, not by re-running this.
function runLayout() {
  physicsPaused = true;
  let layout;
  try {
    layout = cy.layout({
      name: 'fcose',
      quality: 'default',
      animate: true,
      animationDuration: 450,
      randomize: true,
      fit: true,
      padding: 50,
      nodeDimensionsIncludeLabels: true,
      idealEdgeLength: 110,
    });
  } catch {
    layout = cy.layout({ name: 'cose', animate: false, padding: 50 });
  }
  layout.one('layoutstop', () => {
    // fit-to-viewport on a handful of nodes zooms in absurdly; keep it sane.
    if (cy.zoom() > 1.2) {
      cy.zoom(1.2);
      cy.center();
    }
    physicsPaused = false;
    wakePhysics();
  });
  layout.run();
}

// New pages start next to a page they're connected to; the physics finds
// them room from there.
function placeNewNodes(addedEls) {
  for (const el of addedEls) {
    if (el.data.isGroup || el.data.source) continue;
    const node = cy.getElementById(el.data.id);
    if (!node.length) continue;
    const neighbor = node.neighborhood('node').filter((n) => !n.data('isGroup')).first();
    const angle = Math.random() * Math.PI * 2;
    if (neighbor && neighbor.length) {
      const p = neighbor.position();
      node.position({ x: p.x + Math.cos(angle) * 130, y: p.y + Math.sin(angle) * 130 });
    } else {
      const ext = cy.extent();
      node.position({
        x: (ext.x1 + ext.x2) / 2 + Math.cos(angle) * 100,
        y: (ext.y1 + ext.y2) / 2 + Math.sin(angle) * 100,
      });
    }
  }
}

// ---------- Gentle physics (Corral-style relaxation) ----------
// After the initial arrangement, a soft simulation keeps the map organic:
// pages keep breathing room (label-aware rectangles), edges act as loose
// springs, cluster-mates reel back together — with dead zones between the
// forces so they never fight. The loop sleeps once everything settles and
// wakes on any change or drag.

let physicsPaused = false;
let physicsRAF = null;
let calmFrames = 0;
let grabbedId = null;

const PHYS = {
  gap: 18,       // min air between page rectangles
  maxPush: 3.2,  // px per frame per pair — separation always wins
  unitPad: 16,   // cluster bbox padding
  unitGap: 36,   // mandatory air between cluster boxes
  unitPush: 3.0,
  // Springs act between whole units across clear air beyond a dead zone.
  springDead: { navigated: 60, branched: 60, manual: 90, similar: 130 },
  springK: 0.03,
  maxPull: 1.2,
  compactK: 0.06, // members drift back toward their cluster's centroid
  maxCompact: 1.6,
  frameBudget: 1800, // hard stop per wake — never simulate forever
};

let physicsFrames = 0;

function wakePhysics() {
  if (physicsFrozen) return;
  calmFrames = 0;
  physicsFrames = 0;
  if (!physicsRAF && cy && !physicsPaused) physicsRAF = requestAnimationFrame(stepPhysics);
}

function stepPhysics() {
  physicsRAF = null;
  if (!cy || physicsPaused || physicsFrozen || document.hidden) return;
  if (++physicsFrames > PHYS.frameBudget) return; // never simulate forever

  const kids = cy.nodes().filter((n) => !n.data('isGroup'));
  const rects = kids.map((n) => {
    const p = n.position();
    const size = n.data('size') || 30;
    const w = Math.max(size + 10, 143); // labels hang below, up to ~135px wide
    const h = size + 48;                // …and can wrap to three lines now
    return { n, id: n.id(), x: p.x - w / 2, y: p.y - size / 2 - 2, w, h, dx: 0, dy: 0 };
  });
  const byId = new Map(rects.map((r) => [r.id, r]));

  // Pairwise separation.
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i];
      const b = rects[j];
      const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) + PHYS.gap;
      const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) + PHYS.gap;
      if (ox > 0 && oy > 0) {
        if (ox < oy) {
          const dir = a.x + a.w / 2 < b.x + b.w / 2 ? -1 : 1;
          const push = Math.min(ox * 0.5, PHYS.maxPush);
          a.dx += dir * push;
          b.dx -= dir * push;
        } else {
          const dir = a.y + a.h / 2 < b.y + b.h / 2 ? -1 : 1;
          const push = Math.min(oy * 0.5, PHYS.maxPush);
          a.dy += dir * push;
          b.dy -= dir * push;
        }
      }
    }
  }

  // Units: each page belongs to its innermost cluster (or stands alone).
  // All cross-cluster forces act on units as wholes — a page is never
  // dragged out of its cluster, clusters stay compact, and boxes can't
  // tear open or shove unrelated clusters into the distance.
  const units = new Map();
  for (const r of rects) {
    const key = r.n.data('parent') || `solo:${r.id}`;
    if (!units.has(key)) units.set(key, { members: [], isSolo: !r.n.data('parent') });
    units.get(key).members.push(r);
  }
  const unitOfNode = new Map();
  for (const [key, u] of units) {
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    let sx = 0, sy = 0;
    for (const m of u.members) {
      x1 = Math.min(x1, m.x);
      y1 = Math.min(y1, m.y);
      x2 = Math.max(x2, m.x + m.w);
      y2 = Math.max(y2, m.y + m.h);
      sx += m.x + m.w / 2;
      sy += m.y + m.h / 2;
      unitOfNode.set(m.id, key);
    }
    const pad = u.isSolo ? 0 : PHYS.unitPad;
    u.x = x1 - pad;
    u.y = y1 - pad;
    u.w = x2 - x1 + 2 * pad;
    u.h = y2 - y1 + 2 * pad;
    u.cx = sx / u.members.length;
    u.cy = sy / u.members.length;
  }

  // Compactness: members drift back toward their cluster's centroid, so a
  // cluster's box has a bounded size.
  for (const u of units.values()) {
    if (u.members.length < 2) continue;
    const radius = 40 + 30 * Math.sqrt(u.members.length);
    for (const m of u.members) {
      const dx = u.cx - (m.x + m.w / 2);
      const dy = u.cy - (m.y + m.h / 2);
      const d = Math.hypot(dx, dy);
      if (d > radius) {
        const pull = Math.min((d - radius) * PHYS.compactK, PHYS.maxCompact);
        m.dx += (dx / d) * pull;
        m.dy += (dy / d) * pull;
      }
    }
  }

  // Springs between units, aggregated over their cross edges: related
  // clusters hover near each other, but only across clear air.
  const airBetween = (A, B) => {
    const gx = Math.max(A.x, B.x) - Math.min(A.x + A.w, B.x + B.w);
    const gy = Math.max(A.y, B.y) - Math.min(A.y + A.h, B.y + B.h);
    return Math.max(gx, gy, 0);
  };
  const pairSprings = new Map();
  cy.edges().forEach((e) => {
    if (e.hasClass('type-hidden')) return; // filtered-out connections don't pull
    const ua = unitOfNode.get(e.source().id());
    const ub = unitOfNode.get(e.target().id());
    if (!ua || !ub || ua === ub) return;
    const key = ua < ub ? `${ua}|${ub}` : `${ub}|${ua}`;
    const dead = PHYS.springDead[e.data('type')] || 90;
    const cur = pairSprings.get(key);
    if (!cur || dead < cur.dead) pairSprings.set(key, { a: ua, b: ub, dead });
  });
  for (const { a, b, dead } of pairSprings.values()) {
    const A = units.get(a);
    const B = units.get(b);
    const air = airBetween(A, B);
    if (air > dead) {
      const pull = Math.min((air - dead) * PHYS.springK, PHYS.maxPull);
      const dx = B.cx - A.cx;
      const dy = B.cy - A.cy;
      const d = Math.hypot(dx, dy) || 1;
      for (const m of A.members) { m.dx += (dx / d) * pull; m.dy += (dy / d) * pull; }
      for (const m of B.members) { m.dx -= (dx / d) * pull; m.dy -= (dy / d) * pull; }
    }
  }

  // Unit separation: boxes (and boxes vs loose pages) never overlap.
  const unitList = [...units.values()];
  for (let i = 0; i < unitList.length; i++) {
    for (let j = i + 1; j < unitList.length; j++) {
      const A = unitList[i];
      const B = unitList[j];
      if (A.isSolo && B.isSolo) continue; // plain node pairs handled above
      const ox = Math.min(A.x + A.w, B.x + B.w) - Math.max(A.x, B.x) + PHYS.unitGap;
      const oy = Math.min(A.y + A.h, B.y + B.h) - Math.max(A.y, B.y) + PHYS.unitGap;
      if (ox > 0 && oy > 0) {
        const push = Math.min((ox < oy ? ox : oy) * 0.5, PHYS.unitPush);
        if (ox < oy) {
          const dir = A.cx < B.cx ? -1 : 1;
          for (const m of A.members) m.dx += dir * push;
          for (const m of B.members) m.dx -= dir * push;
        } else {
          const dir = A.cy < B.cy ? -1 : 1;
          for (const m of A.members) m.dy += dir * push;
          for (const m of B.members) m.dy -= dir * push;
        }
      }
    }
  }

  // Apply, skipping whatever the user is holding.
  let maxMove = 0;
  cy.startBatch();
  for (const r of rects) {
    if (r.id === grabbedId || (!r.dx && !r.dy)) continue;
    // Clamp so a pile-up of springs can never out-muscle separation.
    const dx = Math.max(-4, Math.min(4, r.dx));
    const dy = Math.max(-4, Math.min(4, r.dy));
    const p = r.n.position();
    r.n.position({ x: p.x + dx, y: p.y + dy });
    maxMove = Math.max(maxMove, Math.abs(dx), Math.abs(dy));
  }
  cy.endBatch();

  calmFrames = maxMove < 0.08 ? calmFrames + 1 : 0;
  if (calmFrames < 40) physicsRAF = requestAnimationFrame(stepPhysics);
}

function onNodeTap(nodeId) {
  if (connectFromId && connectFromId !== nodeId) {
    finishManualEdge(nodeId);
    return;
  }
  selectedNodeId = nodeId;
  renderDrawer();
}

// ---------- Manual connections ----------

function startConnectMode() {
  connectFromId = selectedNodeId;
  $('connect-banner').hidden = false;
}

function cancelConnectMode() {
  connectFromId = null;
  $('connect-banner').hidden = true;
}

async function finishManualEdge(toId) {
  const label = window.prompt('How are these pages connected? (optional label)') ?? '';
  await send({ type: 'add-manual-edge', journeyId: journey.id, from: connectFromId, to: toId, label });
  cancelConnectMode();
  toast('Connection added.');
}

// ---------- Drawer ----------

function wireDrawer() {
  $('drawer-close').onclick = closeDrawer;
  $('d-goto').onclick = () => send({ type: 'focus-node', nodeId: selectedNodeId });
  $('d-connect').onclick = startConnectMode;
  $('d-resummarize').onclick = async () => {
    await send({ type: 'resummarize', nodeId: selectedNodeId });
    toast('Queued for re-summarization.');
  };
  $('d-delete').onclick = async () => {
    if (!window.confirm('Remove this page and its connections from the journey?')) return;
    await send({ type: 'delete-node', nodeId: selectedNodeId });
    closeDrawer();
  };

  let noteTimer = null;
  $('d-notes').addEventListener('input', () => {
    const nodeId = selectedNodeId;
    const notes = $('d-notes').value;
    const node = nodes.find((n) => n.id === nodeId);
    if (node) node.notes = notes;
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => send({ type: 'save-note', nodeId, notes }), 500);
  });
}

function closeDrawer() {
  selectedNodeId = null;
  $('drawer').hidden = true;
  cy?.elements(':selected').unselect();
}

function renderDrawer() {
  const node = nodes.find((n) => n.id === selectedNodeId);
  if (!node) { closeDrawer(); return; }
  $('drawer').hidden = false;

  $('d-favicon').src = faviconUrl(node.url);
  $('d-title').textContent = node.title || node.url;
  $('d-title').href = node.url;
  $('d-meta').textContent =
    `${node.host} · ${node.visits.length} visit${node.visits.length === 1 ? '' : 's'} · ${formatDuration(node.timeSpent)} reading`;

  const hook = $('d-hook');
  hook.hidden = !node.hook;
  hook.textContent = node.hook || '';

  const thumb = $('d-thumb');
  thumb.hidden = !node.thumb;
  if (node.thumb) thumb.src = node.thumb;

  const tags = $('d-tags');
  tags.textContent = '';
  for (const t of node.tags || []) {
    const chip = document.createElement('span');
    chip.className = 'tag';
    chip.textContent = t;
    tags.appendChild(chip);
  }

  const summary = $('d-summary');
  summary.textContent = '';
  if (node.summary?.length) {
    for (const b of node.summary) {
      const li = document.createElement('li');
      li.textContent = b;
      summary.appendChild(li);
    }
  } else {
    const li = document.createElement('li');
    li.className = 'muted';
    if (!node.text && !node.excerpt) {
      li.textContent = 'No text captured for this page.';
    } else if (scratchLiteActive) {
      li.textContent = 'Scratch pages skip summaries to save compute — Redo summarizes just this page; promoting the topic to a workspace summarizes everything.';
    } else {
      li.textContent = 'Waiting for Ollama to summarize…';
    }
    summary.appendChild(li);
  }

  if (document.activeElement !== $('d-notes')) $('d-notes').value = node.notes || '';

  const hl = $('d-highlights');
  hl.textContent = '';
  if (node.highlights?.length) {
    hl.className = '';
    for (const h of node.highlights) {
      const div = document.createElement('div');
      div.className = 'highlight';
      div.textContent = h.text;
      hl.appendChild(div);
    }
  } else {
    hl.className = 'muted small';
    hl.textContent = 'Select text on the page → right-click → “Save highlight to Research Trail”.';
  }

  const conns = $('d-connections');
  conns.textContent = '';
  const related = edges.filter((e) => e.from === node.id || e.to === node.id);
  if (!related.length) {
    const li = document.createElement('li');
    li.className = 'muted';
    li.textContent = 'No connections yet.';
    conns.appendChild(li);
  }
  for (const e of related) {
    const otherId = e.from === node.id ? e.to : e.from;
    const other = nodes.find((n) => n.id === otherId);
    if (!other) continue;
    const li = document.createElement('li');
    const type = document.createElement('span');
    type.className = `etype ${e.type}`;
    type.textContent = { navigated: 'link', branched: 'new tab', similar: 'AI', manual: 'yours' }[e.type] || e.type;
    type.title = EDGE_META[e.type]?.title || e.type;
    const link = document.createElement('a');
    link.textContent = truncate(other.title || other.host, 42);
    link.onclick = () => { selectedNodeId = otherId; renderDrawer(); cy?.elements(':selected').unselect(); cy?.getElementById(otherId).select(); };
    li.append(type, link);
    if (e.label) {
      const lab = document.createElement('span');
      lab.className = 'elabel';
      lab.textContent = `— ${e.label}`;
      li.appendChild(lab);
    }
    if (e.type === 'similar' || e.type === 'manual') {
      const del = document.createElement('button');
      del.className = 'ghost';
      del.textContent = 'remove';
      del.title = 'Remove this connection';
      del.onclick = () => send({ type: 'delete-edge', edgeId: e.id });
      li.appendChild(del);
    }
    conns.appendChild(li);
  }
}

// ---------- Timeline ----------

function renderTimeline() {
  const container = $('timeline-view');
  container.textContent = '';
  const visits = [];
  // The domain lens applies here too — one filter, both views agree.
  for (const n of visibleNodes()) {
    for (const v of n.visits) visits.push({ at: v.at, from: v.from, node: n });
  }
  visits.sort((a, b) => a.at - b.at);

  if (!visits.length) {
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = 'No visits recorded yet.';
    container.appendChild(p);
    return;
  }

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const edgeType = new Map();
  for (const e of edges) edgeType.set(`${e.from}|${e.to}`, e.type);

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.id = 'tl-svg';
  container.appendChild(svg);

  // Provenance is resolved in chronological order ("from" points at the
  // most recent earlier visit of the source page)…
  const items = visits.map((v) => ({ v, fromIdx: null, adjacent: false, branched: false }));
  const lastIdxByNode = new Map();
  items.forEach((item, i) => {
    const v = item.v;
    item.branched = !!(v.from && edgeType.get(`${v.from}|${v.node.id}`) === 'branched');
    if (v.from != null && lastIdxByNode.has(v.from)) {
      item.fromIdx = lastIdxByNode.get(v.from);
      item.adjacent = item.fromIdx === i - 1;
    }
    lastIdxByNode.set(v.node.id, i);
  });
  // …then rendered newest-first: reading down the page goes back in time.
  items.reverse();
  const oldToNew = [];
  items.forEach((item, i) => { oldToNew[items.length - 1 - i] = i; });
  for (const item of items) {
    if (item.fromIdx != null) item.fromIdx = oldToNew[item.fromIdx];
  }

  // Each entry gets a site-colored dot on a left rail; real relationships
  // (clicked from / branched from) are drawn as connectors between dots.
  const entryMeta = [];
  let lastDay = '';
  items.forEach((item) => {
    const v = item.v;
    const day = new Date(v.at).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
    if (day !== lastDay) {
      const h = document.createElement('div');
      h.className = 'tl-day';
      h.textContent = day;
      container.appendChild(h);
      lastDay = day;
    }
    const entry = document.createElement('div');
    entry.className = 'tl-entry';
    entry.onclick = () => { selectedNodeId = v.node.id; renderDrawer(); };

    const dot = document.createElement('span');
    dot.className = 'tl-dot';
    dot.style.background = domainColor(v.node.host.replace(/^www\./, ''));

    const time = document.createElement('span');
    time.className = 'tl-time';
    time.textContent = new Date(v.at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

    const icon = document.createElement('img');
    icon.src = faviconUrl(v.node.url, 16);
    icon.alt = '';

    const main = document.createElement('div');
    main.className = 'tl-main';
    const title = document.createElement('div');
    title.className = 'tl-title';
    title.textContent = v.node.title || v.node.url;
    main.appendChild(title);

    if (v.from && byId.has(v.from)) {
      const from = document.createElement('div');
      from.className = 'tl-from';
      from.innerHTML = item.branched ? '<span class="branch">new tab from</span> ' : 'from ';
      from.appendChild(document.createTextNode(truncate(byId.get(v.from).title || byId.get(v.from).host, 60)));
      main.appendChild(from);
    }
    entry.append(dot, time, icon, main);
    container.appendChild(entry);

    entryMeta.push({ el: entry, fromIdx: item.fromIdx, adjacent: item.adjacent, branched: item.branched });
  });

  drawTimelineConnectors(container, svg, entryMeta);
}

function drawTimelineConnectors(container, svg, entryMeta) {
  // Dot centers in container coordinates (dot is 11px + 2px border, left:-26, top:13).
  const pts = entryMeta.map((m) => ({
    x: m.el.offsetLeft - 26 + 7.5,
    y: m.el.offsetTop + 13 + 7.5,
  }));
  const w = 80;
  const h = container.scrollHeight;
  svg.setAttribute('width', w);
  svg.setAttribute('height', h);
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);

  const muted = cssVar('--muted') || '#888';
  const parts = [];
  for (let i = 0; i < entryMeta.length; i++) {
    const m = entryMeta[i];
    if (m.fromIdx == null) continue;
    const a = pts[m.fromIdx];
    const b = pts[i];
    const color = m.branched ? '#0969da' : muted;
    // Direction-agnostic: with newest-first ordering, the source sits BELOW
    // its destination, so offsets/bulges derive from the actual geometry.
    const dir = b.y > a.y ? 1 : -1;
    if (m.adjacent) {
      // Came straight from the neighboring entry: a plain segment on the rail.
      parts.push(`<line x1="${a.x}" y1="${a.y + 9 * dir}" x2="${b.x}" y2="${b.y - 9 * dir}" stroke="${color}" stroke-width="2" opacity="0.6"/>`);
    } else {
      // A jump across the list: arc out to the left, dot at the landing.
      const bulge = Math.min(36, 14 + Math.abs(b.y - a.y) / 14);
      parts.push(
        `<path d="M ${a.x - 7} ${a.y} C ${a.x - bulge} ${a.y}, ${b.x - bulge} ${b.y}, ${b.x - 7} ${b.y}" fill="none" stroke="${color}" stroke-width="2" opacity="0.6"/>`,
        `<circle cx="${b.x - 7}" cy="${b.y}" r="2.5" fill="${color}"/>`,
      );
    }
  }
  svg.innerHTML = parts.join('');
}

// ---------- Exports ----------

function download(filename, text, mime = 'text/plain') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: mime }));
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

function slug(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'journey';
}

function exportJourney(kind) {
  if (!journey) return;
  if (kind === 'json') {
    const data = {
      journey,
      nodes: nodes.map(({ embedding, text, thumb, ...rest }) => rest),
      edges,
      exportedAt: new Date().toISOString(),
    };
    download(`${slug(journey.name)}.json`, JSON.stringify(data, null, 2), 'application/json');
  } else if (kind === 'md') {
    download(`${slug(journey.name)}.md`, buildMarkdown(), 'text/markdown');
  } else if (kind === 'canvas') {
    download(`${slug(journey.name)}.canvas`, buildCanvas(), 'application/json');
  }
  toast('Exported.');
}

function buildMarkdown() {
  const lines = [`# ${journey.name}`, ''];
  const started = new Date(journey.createdAt).toLocaleString();
  lines.push(`*Started ${started} · ${nodes.length} pages · ${edges.length} connections*`, '');

  if (journey.synthesis?.text) {
    lines.push('## Synthesis', '', journey.synthesis.text, '');
  }

  lines.push('## Pages by site', '');
  const groups = new Map();
  for (const n of nodes) {
    const d = baseDomain(n.host);
    if (!groups.has(d)) groups.set(d, []);
    groups.get(d).push(n);
  }
  for (const [domain, group] of [...groups.entries()].sort((a, b) => b[1].length - a[1].length)) {
    lines.push(`### ${domain}`, '');
    for (const n of group) {
      lines.push(`- **[${n.title || n.url}](${n.url})** — ${formatDuration(n.timeSpent)}, ${n.visits.length} visit${n.visits.length === 1 ? '' : 's'}`);
      for (const b of n.summary || []) lines.push(`  - ${b}`);
      if (n.notes) lines.push(`  - 📝 *${n.notes.replace(/\n/g, ' ')}*`);
      for (const h of n.highlights || []) lines.push(`  - > ${h.text.replace(/\n/g, ' ')}`);
    }
    lines.push('');
  }

  const interesting = edges.filter((e) => e.type === 'similar' || e.type === 'manual');
  if (interesting.length) {
    lines.push('## Connections', '');
    const byId = new Map(nodes.map((n) => [n.id, n]));
    for (const e of interesting) {
      const a = byId.get(e.from);
      const b = byId.get(e.to);
      if (!a || !b) continue;
      const tag = e.type === 'manual' ? 'you' : 'AI';
      lines.push(`- **${a.title || a.host}** ⇄ **${b.title || b.host}**${e.label ? ` — ${e.label}` : ''} *(${tag})*`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function buildCanvas() {
  const scale = 1.6;
  const canvasNodes = nodes.map((n) => {
    const pos = cy?.getElementById(n.id)?.position() || { x: Math.random() * 1000, y: Math.random() * 800 };
    return {
      id: n.id,
      type: 'link',
      url: n.url,
      x: Math.round(pos.x * scale),
      y: Math.round(pos.y * scale),
      width: 300,
      height: 80,
    };
  });
  const ids = new Set(nodes.map((n) => n.id));
  const canvasEdges = edges
    .filter((e) => ids.has(e.from) && ids.has(e.to))
    .map((e) => ({
      id: e.id,
      fromNode: e.from,
      fromSide: 'right',
      toNode: e.to,
      toSide: 'left',
      ...(e.label ? { label: e.label } : {}),
    }));
  return JSON.stringify({ nodes: canvasNodes, edges: canvasEdges }, null, 2);
}

// ---------- Settings ----------

function wireSettings() {
  const modal = $('settings-modal');
  $('s-cancel').onclick = () => modal.close();
  $('s-threshold').oninput = () => { $('s-threshold-val').textContent = $('s-threshold').value; };

  $('s-save').onclick = async () => {
    await saveSettings({
      ollamaUrl: $('s-url').value.trim().replace(/\/$/, ''),
      chatModel: $('s-chat').value.trim(),
      embedModel: $('s-embed').value.trim(),
      simThreshold: parseFloat($('s-threshold').value),
      captureText: $('s-capture-text').checked,
      aiPaused: $('s-ai-paused').checked,
      scratchLite: $('s-scratch-lite').checked,
      tabGroupSync: $('s-tab-groups').checked,
      autoReturnMinutes: Math.max(0, parseInt($('s-auto-return').value, 10) || 0),
      blocklist: $('s-blocklist').value.split('\n').map((l) => l.trim()).filter(Boolean),
    });
    modal.close();
    // Settings changes usually mean "the model was wrong" — give failed jobs
    // another shot automatically.
    const res = await send({ type: 'retry-jobs' });
    toast(res.retried ? `Settings saved — retrying ${res.retried} failed AI job${res.retried === 1 ? '' : 's'}.` : 'Settings saved.');
  };

  $('s-retry-jobs').onclick = async () => {
    const res = await send({ type: 'retry-jobs' });
    toast(`Retrying ${res.retried} job${res.retried === 1 ? '' : 's'}.`);
  };

  $('s-delete-journey').onclick = async () => {
    if (!journey) return;
    if (!window.confirm(`Delete "${journey.name}" and all its pages, notes, and highlights? This cannot be undone.`)) return;
    await send({ type: 'delete-journey', journeyId: journey.id });
    modal.close();
    location.href = 'journey.html';
  };
}

async function openSettings() {
  const s = await getSettings();
  $('s-url').value = s.ollamaUrl;
  $('s-chat').value = s.chatModel;
  $('s-embed').value = s.embedModel;
  $('s-threshold').value = s.simThreshold;
  $('s-threshold-val').textContent = s.simThreshold;
  $('s-capture-text').checked = s.captureText;
  $('s-ai-paused').checked = !!s.aiPaused;
  $('s-scratch-lite').checked = s.scratchLite !== false;
  $('s-tab-groups').checked = !!s.tabGroupSync;
  $('s-auto-return').value = s.autoReturnMinutes ?? 30;
  $('s-blocklist').value = (s.blocklist || []).join('\n');
  $('settings-modal').showModal();

  const status = $('s-ollama-status');
  status.textContent = 'Checking Ollama…';
  const res = await send({ type: 'ollama-status' });
  if (res.ok) {
    const list = $('model-list');
    list.textContent = '';
    for (const m of res.models) {
      const opt = document.createElement('option');
      opt.value = m;
      list.appendChild(opt);
    }
    // Model names may carry a tag (llama3.1:latest); match on the base name.
    const have = (name) => res.models.some((m) => m === name || m.split(':')[0] === name.split(':')[0]);
    const missing = [s.chatModel, s.embedModel].filter((m) => m && !have(m));
    if (res.models.length && missing.length && res.resolved) {
      status.textContent =
        `Connected ✓ — ${missing.join(' and ')} not installed, so using ` +
        `${res.resolved.chat} for chat and ${res.resolved.embed} for embeddings. ` +
        (res.resolved.chat === res.resolved.embed
          ? 'Connections are found by the chat model reading page summaries; an embedding model (ollama pull nomic-embed-text) makes that faster and scales past ~60 pages.'
          : '');
    } else {
      status.textContent = `Connected ✓ ${res.models.length ? '· installed: ' + res.models.join(', ') : ''}`;
    }
  } else {
    status.textContent =
      'Not reachable. If Ollama is running, allow extension access: launchctl setenv OLLAMA_ORIGINS "chrome-extension://*" — then restart Ollama.';
  }
}

// ---------- Toast ----------

let toastTimer = null;
function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3500);
}

init();
