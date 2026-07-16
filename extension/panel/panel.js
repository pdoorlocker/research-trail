// Research Trail — side panel: the live "you are here" view.
//
// Shows the active workspace as a compact graph. Node states mirror real
// tabs: the page you're on is enlarged with a green accent ring, open tabs
// get a stronger border, everything else is parked (one click to reopen).

import * as db from '../lib/db.js';
import { baseDomain, faviconUrl, truncate, workspaceSort } from '../lib/util.js';

const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);

let journeyId = null;
let nodes = [];
let edges = [];
let tabMap = { byNode: {}, activeNodeId: null };
let cy = null;
let graphSignature = '';

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

// ---------- Boot ----------

async function init() {
  $('map-btn').onclick = () => {
    chrome.tabs.create({ url: chrome.runtime.getURL(`journey/journey.html${journeyId ? '?j=' + journeyId : ''}`) });
  };
  $('park-btn').onclick = async () => {
    const res = await send({ type: 'park-others' });
    if (res.parked) flashParkButton(`Parked ${res.parked} tab${res.parked === 1 ? '' : 's'}`);
  };
  $('pause-btn').onclick = async () => {
    const state = await send({ type: 'get-state' });
    await send({ type: 'set-paused', paused: !state.paused });
    renderHeader();
  };
  $('ws-select').onchange = async () => {
    await send({ type: 'switch-workspace', journeyId: $('ws-select').value });
    graphSignature = '';
    cy?.elements().remove();
    await reload();
  };

  $('close-btn').onclick = () => window.close();

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'trail-updated' || msg.type === 'tabs-updated') scheduleReload();
  });
  // Follow tab activity directly too — the "you are here" ring must never
  // depend on relayed messages alone.
  chrome.tabs.onActivated.addListener(() => scheduleReload());
  chrome.tabs.onUpdated.addListener((tabId, info) => {
    if (info.status === 'complete' || info.url) scheduleReload();
  });

  await reload();
}

let reloadTimer = null;
function scheduleReload() {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(reload, 350);
}

async function reload() {
  const state = await send({ type: 'get-state' });
  const switched = state.activeJourneyId !== journeyId;
  journeyId = state.activeJourneyId;
  if (!journeyId) return;
  if (switched && cy) {
    cy.elements().remove();
    graphSignature = '';
  }
  nodes = await db.getByIndex('nodes', 'byJourney', journeyId);
  edges = await db.getByIndex('edges', 'byJourney', journeyId);
  tabMap = await send({ type: 'tab-map' });
  renderHeader(state);
  renderGraph();
  renderHere();
  renderSuggestNote();
  $('empty').hidden = nodes.length > 0;
}

// A split suggestion for the active workspace shows as a small amber note;
// reviewing happens on the full map, where the pages get spotlit.
async function renderSuggestNote() {
  const note = $('suggest-note');
  const res = await send({ type: 'list-suggestions', journeyId });
  const s = res.suggestions?.[0];
  if (!s) {
    note.hidden = true;
    return;
  }
  note.hidden = false;
  $('suggest-note-text').textContent = `Separate thread? “${s.name}” — ${s.nodeIds.length} pages`;
  $('suggest-open').onclick = () => {
    chrome.tabs.create({
      url: chrome.runtime.getURL(`journey/journey.html?j=${s.journeyId}&suggest=${s.id}`),
    });
  };
}

async function renderHeader(state) {
  if (!state) state = await send({ type: 'get-state' });
  const select = $('ws-select');
  const journeys = (await db.getAll('journeys')).sort(workspaceSort);
  select.textContent = '';
  for (const j of journeys) {
    const opt = document.createElement('option');
    opt.value = j.id;
    opt.textContent = j.name;
    select.appendChild(opt);
  }
  if (journeyId) select.value = journeyId;
  const pause = $('pause-btn');
  pause.textContent = state.paused ? 'Resume' : 'Pause';
  pause.title = state.paused ? 'Capture paused — click to resume' : 'Pause capture';
  pause.classList.toggle('paused', state.paused);
}

// ---------- Graph ----------

// There is no zoom or scroll here: the whole workspace must always be
// visible at once in a fixed-size box. Node/label size is set AFTER layout,
// by fillPanelSpace() below, which divides the panel's area into one cell
// per page and sizes circles to the cell — so filled space translates into
// bigger, more legible circles rather than the same small ones with more
// air between them. buildElements() intentionally leaves size/fontSize/
// labelMax out of the data it returns, so refreshing labels/state never
// stomps on whatever fillPanelSpace() last computed.
function buildElements() {
  const elements = [];
  const nodeIds = new Set(nodes.map((n) => n.id));
  for (const n of nodes) {
    const host = n.host.replace(/^www\./, '');
    const open = !!tabMap.byNode[n.id]?.length;
    const active = tabMap.activeNodeId === n.id;
    elements.push({
      data: {
        id: n.id,
        // Hooks are written to be short (4-9 words) — let them land in full
        // so they're actually referenceable; only the raw title/host
        // fallback needs a tight cap. Mirrors the full map.
        label: n.hook ? truncate(n.hook, 80) : truncate(n.title || host, 28),
        color: domainColor(host),
        favicon: faviconUrl(n.url, 32),
        state: active ? 'active' : open ? 'open' : 'parked',
        // Kept only for the hover preview — the node's shape stays the same
        // favicon-in-a-ring circle everywhere, matching the full map.
        thumb: n.thumb || undefined,
      },
    });
  }
  for (const e of edges) {
    if (!nodeIds.has(e.from) || !nodeIds.has(e.to)) continue;
    // AI-similarity links are the majority of edges once "Find connections"
    // has run, and in this narrow space they turn into an illegible hairball
    // — the full map is where you go to see that whole web. The panel stays
    // focused on your actual navigation path: what you clicked, what you
    // opened, what you connected yourself.
    if (e.type === 'similar') continue;
    elements.push({
      data: { id: e.id, source: e.from, target: e.to, type: e.type },
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
        // Static fallback until the first layout pass computes real values —
        // see node[size] etc. below, which override once fillPanelSpace runs.
        width: 28,
        height: 28,
        label: 'data(label)',
        color: fg,
        'font-size': 8,
        'text-valign': 'bottom',
        'text-margin-y': 4,
        'text-wrap': 'wrap',
        'text-max-width': 90,
        'border-width': 2,
        'border-color': 'data(color)',
        'transition-property': 'opacity',
        'transition-duration': '0.15s',
      },
    },
    {
      selector: 'node[size]',
      style: { width: 'data(size)', height: 'data(size)' },
    },
    {
      selector: 'node[fontSize]',
      style: { 'font-size': 'data(fontSize)' },
    },
    {
      selector: 'node[labelMax]',
      style: { 'text-max-width': 'data(labelMax)' },
    },
    // No persistent dimming: parked pages render at full strength, and the
    // active page is identified by enlargement plus the green accent ring.
    // Dimming is reserved for the hover spotlight, same as the full map.
    { selector: 'node[state="open"]', style: { 'border-width': 3.5 } },
    {
      selector: 'node[state="active"]',
      style: {
        'border-width': 5,
        'border-color': cssVar('--accent') || '#1a7f37',
        'font-weight': 700,
      },
    },
    {
      selector: 'edge',
      style: {
        width: 1.5,
        'line-color': muted,
        'line-opacity': 0.45,
        'curve-style': 'bezier',
        'target-arrow-shape': 'triangle',
        'target-arrow-color': muted,
        'arrow-scale': 0.7,
      },
    },
    { selector: 'edge.branched', style: { 'line-color': '#0969da', 'target-arrow-color': '#0969da' } },
    { selector: 'edge.similar', style: { 'line-style': 'dashed', 'line-color': '#8957e5', 'target-arrow-shape': 'none' } },
    { selector: 'edge.manual', style: { 'line-color': '#d4770c', 'target-arrow-shape': 'none', width: 2.5 } },
    // Hover spotlight, same as the full map: everything outside the hovered
    // neighborhood fades back.
    { selector: '.dimmed', style: { opacity: 0.13 } },
    { selector: 'edge.spotlit', style: { 'line-opacity': 1, width: 2.5 } },
  ];
}

function renderGraph() {
  const elements = buildElements();
  const signature = elements.map((el) => el.data.id).sort().join(',');

  if (!cy) {
    cy = cytoscape({
      container: $('cy'),
      elements,
      style: graphStyle(),
      // No zoom, no pan: the whole workspace is always fully visible in this
      // fixed box, so there is nothing for the user to scroll or zoom to.
      minZoom: 1,
      maxZoom: 1,
      userZoomingEnabled: false,
      userPanningEnabled: false,
      boxSelectionEnabled: false,
    });
    cy.on('tap', 'node', (evt) => send({ type: 'focus-node', nodeId: evt.target.id() }));
    cy.on('tap', hideHoverPreview);
    // Nodes stay plain favicon circles everywhere (matches the full map) —
    // the screenshot is a hover-only "peek", not a different node shape.
    cy.on('mouseover', 'node', (evt) => scheduleHoverPreview(evt.target));
    cy.on('mouseout', 'node', hideHoverPreview);
    runLayout(false);
    graphSignature = signature;
    return;
  }

  const structureChanged = signature !== graphSignature;
  if (structureChanged) {
    // Elements can vanish mid-hover and never fire mouseout — don't leave
    // the panel stuck dimmed.
    hideHoverPreview();
    const existingIds = new Set(cy.elements().map((el) => el.id()));
    const added = elements.filter((el) => !existingIds.has(el.data.id));
    cy.add(added);
    placeNewNodes(added);
    const incoming = new Set(elements.map((el) => el.data.id));
    cy.elements().filter((el) => !incoming.has(el.id())).remove();
    graphSignature = signature;
  }
  // Refresh every node's data unconditionally — a page count change shifts
  // the shared size/font tier for ALL nodes, not just ones that were added.
  for (const el of elements) {
    const ex = cy.getElementById(el.data.id);
    if (ex.length) ex.data(el.data);
  }
  // Only re-run the layout when the node/edge set actually changed — a pure
  // state change (which tab is active) just needs the data refresh above.
  if (structureChanged) runLayout(true);
}

// ---------- Hover preview ----------
// A brief, deliberate hover (not a passover) shows the page's screenshot —
// same 300ms intent delay as the full map's hover-focus, so the two surfaces
// feel like one product even though this one has no drawer to click into.

const PREVIEW_DELAY = 300;
let previewTimer = null;

function scheduleHoverPreview(node) {
  clearTimeout(previewTimer);
  // Always give feedback on hover — a title/hook card at minimum. Most
  // pages won't have a screenshot yet (capture is opportunistic and needs
  // the tab to sit active for a moment), and a hover that silently does
  // nothing for those reads as broken rather than "no image available."
  previewTimer = setTimeout(() => showHoverPreview(node), PREVIEW_DELAY);
}

function showHoverPreview(node) {
  const el = $('hover-preview');
  const thumb = node.data('thumb');
  const img = $('hover-preview-img');
  img.hidden = !thumb;
  if (thumb) img.src = thumb;
  $('hover-preview-title').textContent = node.data('label') || '';

  const pos = node.renderedPosition();
  const wrapW = $('graph-wrap').clientWidth;
  const wrapH = $('graph-wrap').clientHeight;
  const previewW = 200;
  const previewH = thumb ? 150 : 46; // rough estimate; clamped below anyway
  let left = pos.x + 18;
  if (left + previewW > wrapW - 6) left = pos.x - previewW - 18;
  left = Math.max(6, Math.min(wrapW - previewW - 6, left));
  let top = pos.y - previewH / 2;
  top = Math.max(6, Math.min(wrapH - previewH - 6, top));
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
  el.hidden = false;

  // Spotlight, same as the full map: fade everything except the hovered
  // page, its connections, and the pages on their other ends.
  const hood = node.closedNeighborhood();
  cy.batch(() => {
    cy.elements().addClass('dimmed');
    hood.removeClass('dimmed');
    hood.edges().addClass('spotlit');
  });
}

function hideHoverPreview() {
  clearTimeout(previewTimer);
  $('hover-preview').hidden = true;
  if (cy) cy.batch(() => cy.elements().removeClass('dimmed spotlit'));
}

// Lays the whole graph out directly into the container's exact pixel
// dimensions — both axes — so it always fully fits with zoom permanently
// locked at 1. `reuse` keeps current node positions as the starting point
// (a gentler re-settle) instead of fully re-randomizing on every change.
function runLayout(reuse) {
  if (!cy.elements().length) return;
  let layout;
  try {
    layout = cy.layout({
      name: 'fcose',
      quality: 'default',
      animate: false,
      randomize: !reuse,
      fit: false,
      nodeDimensionsIncludeLabels: false,
      idealEdgeLength: 55,
      nodeRepulsion: 3200,
    });
  } catch {
    layout = cy.layout({ name: 'cose', animate: false, fit: false });
  }
  layout.one('layoutstop', () => {
    // Cytoscape's own boundingBox/fit machinery preserves aspect ratio (one
    // shared scale for both axes) — exactly the behavior that left height
    // unused here, since the algorithm's natural layout is wider than tall
    // and a narrow panel means the width constraint wins. Stretching x and y
    // independently is the only way to actually use both dimensions fully.
    stretchToFillContainer();
    fillPanelSpace();
    cy.zoom(1);
    cy.pan({ x: 0, y: 0 });
  });
  layout.run();
}

// Independently rescales x and y so the graph's bounding box exactly matches
// the container, edge to edge — deliberately not aspect-preserving. A
// starburst layout is naturally wider than tall; this is what actually
// fills a narrow, tall panel on both axes instead of leaving height unused.
function stretchToFillContainer() {
  const eles = cy.nodes();
  if (!eles.length) return;
  const bb = eles.boundingBox();
  const pad = 12;
  const availW = Math.max(cy.width() - pad * 2, 20);
  const availH = Math.max(cy.height() - pad * 2, 20);
  const scaleX = availW / Math.max(bb.w, 1);
  const scaleY = availH / Math.max(bb.h, 1);
  eles.positions((node) => {
    const p = node.position();
    return {
      x: pad + (p.x - bb.x1) * scaleX,
      y: pad + (p.y - bb.y1) * scaleY,
    };
  });
}

// The force layout leaves clumps — knots of near-touching nodes separated by
// voids — and any sizing derived from measured spacing inherits that
// tininess. So instead of measuring, ALLOCATE: the panel's area divided by N
// gives each page a cell; circles are sized to the cell, and a separation
// pass pushes nodes apart until everyone actually claims their cell. Big,
// evenly spread, always inside the box — by construction.
function fillPanelSpace() {
  const eles = cy.nodes();
  const n = eles.length;
  if (n === 0) return;
  const pad = 16;
  const W = Math.max(cy.width() - pad * 2, 40);
  const H = Math.max(cy.height() - pad * 2, 40);
  const cell = Math.sqrt((W * H) / n);

  const size = Math.max(15, Math.min(52, cell * 0.42));
  const fontSize = Math.max(6.5, Math.min(12, size * 0.3));
  // Wide enough that a full 4-9 word hook wraps to ~2-3 lines, not a tower.
  const labelMax = Math.round(Math.min(cell * 1.15, size * 3.5));
  eles.forEach((ele) => {
    const state = ele.data('state');
    const bump = state === 'active' ? 1.25 : state === 'open' ? 1.1 : 1;
    ele.data({ size: Math.round(size * bump), fontSize, labelMax });
  });
  if (n === 1) {
    eles.position({ x: pad + W / 2, y: pad + H / 2 });
    return;
  }

  // Separation resolves COLLISIONS only — room for each circle plus its
  // label — not uniform cell spacing. Uniform spacing erases the layout's
  // grouping, and the grouping IS the information: related pages huddle
  // together, whitespace between huddles marks a topic change. So tight
  // groups stay tight (just no overlap) and the gaps between them survive.
  const minDist = Math.max(size * 2.2, labelMax * 0.85);
  const items = eles.map((e) => ({ e, p: { ...e.position() } }));
  for (let iter = 0; iter < 60; iter++) {
    let moved = false;
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const a = items[i].p;
        const b = items[j].p;
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let d = Math.hypot(dx, dy);
        if (d >= minDist) continue;
        if (d < 0.01) {
          dx = Math.random() - 0.5;
          dy = Math.random() - 0.5;
          d = Math.hypot(dx, dy);
        }
        const push = ((minDist - d) / 2) / d;
        a.x -= dx * push;
        a.y -= dy * push;
        b.x += dx * push;
        b.y += dy * push;
        moved = true;
      }
    }
    for (const it of items) {
      it.p.x = Math.max(pad, Math.min(pad + W, it.p.x));
      it.p.y = Math.max(pad, Math.min(pad + H, it.p.y));
    }
    if (!moved) break;
  }
  for (const it of items) it.e.position(it.p);
}

// A rough starting spot for a brand-new node, near whatever it connects to —
// runLayout() immediately refines this into the final exactly-fit box, so
// precision doesn't matter here, just avoiding an exact dead-on overlap.
function placeNewNodes(addedEls) {
  for (const el of addedEls) {
    if (el.data.source) continue;
    const node = cy.getElementById(el.data.id);
    if (!node.length) continue;
    const neighbor = node.neighborhood('node').first();
    const angle = Math.random() * Math.PI * 2;
    if (neighbor && neighbor.length) {
      const p = neighbor.position();
      node.position({ x: p.x + Math.cos(angle) * 40, y: p.y + Math.sin(angle) * 40 });
    } else {
      const ext = cy.extent();
      node.position({
        x: (ext.x1 + ext.x2) / 2 + Math.cos(angle) * 20,
        y: (ext.y1 + ext.y2) / 2 + Math.sin(angle) * 20,
      });
    }
  }
}

// ---------- "You are here" footer ----------

function renderHere() {
  const footer = $('here');
  const node = nodes.find((n) => n.id === tabMap.activeNodeId);
  if (!node) {
    footer.hidden = true;
    return;
  }
  footer.hidden = false;
  $('here-title').textContent = node.title || node.url;
  const inbound = edges.find(
    (e) => e.to === node.id && (e.type === 'navigated' || e.type === 'branched'),
  );
  const parent = inbound && nodes.find((n) => n.id === inbound.from);
  $('here-from').textContent = parent
    ? `${inbound.type === 'branched' ? 'new tab from' : 'from'} ${truncate(parent.title || parent.host, 52)}`
    : 'entry point';
}

let flashTimer = null;
function flashParkButton(text) {
  const btn = $('park-btn');
  const original = 'Park other tabs';
  btn.textContent = text;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { btn.textContent = original; }, 2000);
}

window.addEventListener('resize', () => {
  if (!cy) return;
  cy.resize();
  runLayout(true); // container size changed — re-fit into the new dimensions
});

init();
