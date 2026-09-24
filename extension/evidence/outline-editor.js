// Outline: the low-friction way into a board. Jot thoughts as lines, then
// shape them: indenting a line puts it under the line above as a reason for
// it. The outline is a second view of the same cards and connections as the
// spatial board; nothing is stored separately.
//
// Tree rule: a card's first connection to another card (links array order)
// is its place in the outline. Any further connections are shown as
// "also …" references so nothing on the board is hidden here.

const DEFAULT_TITLE = 'What am I trying to establish?';
const TYPES = [['note', 'Thought'], ['fact', 'Fact'], ['claim', 'Claim'], ['conclusion', 'Conclusion'], ['gap', 'Question'], ['evidence', 'Quote']];
// The connective is derived, not chosen: it follows from the lower line's
// type, plus whether it argues for or against the line above. Read top to
// bottom it is plain English: "<line above> because <this line>".
// A later line arguing the same way as an earlier sibling reads as a
// continuation ("and because", "but also"); nothing extra is stored.
const stanceOf = kind => kind === 'challenges' ? 'against' : kind === 'questions' ? 'question' : 'for';
const SO = /^(and so|so|thus|therefore|ergo),?\s/i;
// "X, but Y" usually means "and there's also Y to reckon with", not "Y proves X
// wrong": the two become joint reasons for a line you then write.
const BUT = /^but,?\s/i;

// Extra connections, phrased from each end.
const ALSO_OUT = { reasoning: 'is also a reason why', supports: 'is also a source for', challenges: 'also objects to', questions: 'is also an open question for' };
const ALSO_IN = { reasoning: 'also because', supports: 'as another source says', challenges: 'another objection:', questions: 'which also raises the question' };
const PREFIX = { '?': 'gap', '>': 'evidence', '!': 'conclusion', '-': 'fact', '~': 'challenge' };
const COL = 410, GAP_Y = 36, TREE_GAP = 90;

export function init(api) {
  const view = document.getElementById('outline-view');
  if (!view) return;
  const esc = api.esc;
  let focus = null;          // { id, offset } to restore after a re-render
  let pending = null, timer = 0; // debounced text edit { id, value }
  // Cards that were never placed by hand get laid out the first time the
  // board is shown, not only after an outline edit.
  let needsLayout = api.board.nodes.some(n => n.auto), laying = false, dragId = null, inboxThoughts = [];

  // ---------- Model ----------

  function tree() {
    const b = api.board, ids = new Set(b.nodes.map(n => n.id));
    const parentOf = new Map(), primary = new Map();
    for (const l of b.links) {
      if (!ids.has(l.from) || !ids.has(l.to) || parentOf.has(l.from)) continue;
      let p = l.to, cycle = false;
      for (let i = 0; p && i < 600; i++) { if (p === l.from) { cycle = true; break; } p = parentOf.get(p); }
      if (cycle) continue;
      parentOf.set(l.from, l.to); primary.set(l.from, l);
    }
    ensureOrder();
    const children = new Map([[null, []]]);
    for (const n of b.nodes) {
      const p = parentOf.get(n.id) ?? null;
      if (!children.has(p)) children.set(p, []);
      children.get(p).push(n);
    }
    for (const list of children.values()) list.sort((a, b) => a.ord - b.ord);
    return { parentOf, primary, children, kids: id => children.get(id) || [] };
  }

  // Older cards have no outline order: derive it once from board position.
  function ensureOrder() {
    const missing = api.board.nodes.filter(n => !Number.isFinite(n.ord)).sort((a, b) => a.y - b.y || a.x - b.x);
    if (!missing.length) return;
    let next = Math.max(0, ...api.board.nodes.filter(n => Number.isFinite(n.ord)).map(n => n.ord + 1));
    for (const n of missing) n.ord = next++;
  }

  const kindFor = n => api.allowedKinds(n.type)[0];
  const textOf = n => n.type === 'evidence' ? (n.quote || n.displayedQuote || '') : n.text;
  const lockedQuote = n => n.type === 'evidence' && (n.sourceCaptureId || n.image || (!n.quote && n.displayedQuote));

  function isDescendant(id, ancestor, t) {
    for (let p = id; p; p = t.parentOf.get(p)) if (p === ancestor) return true;
    return false;
  }

  function setParent(id, parentId, t, kind) {
    const b = api.board, n = api.get(id), old = t.primary.get(id);
    if (old) b.links = b.links.filter(l => l !== old);
    if (!parentId) return;
    // Something is now a reason for this line, so it is being argued: a claim.
    const parent = api.get(parentId);
    if (parent.type === 'note') applyType(parent, 'claim');
    const existing = b.links.find(l => l.from === id && l.to === parentId);
    if (existing) { b.links = [existing, ...b.links.filter(l => l !== existing)]; if (kind) existing.kind = kind; return; }
    b.links.unshift({ id: api.uid(), from: id, to: parentId, kind: api.fitKind(n.type, kind || old?.kind || kindFor(n)), label: '' });
  }

  function orderBetween(list, index) {
    const before = list[index - 1]?.ord, after = list[index]?.ord;
    if (before === undefined && after === undefined) return 0;
    if (before === undefined) return after - 1;
    if (after === undefined) return before + 1;
    return (before + after) / 2;
  }

  function newCard(type, text) {
    const n = { id: api.uid(), type: 'note', text: '', x: 30, y: 100, auto: true };
    applyType(n, type || 'note');
    if (n.type === 'evidence') n.quote = text; else n.text = text;
    return n;
  }

  function applyType(n, type) {
    if (type === n.type) return;
    const text = textOf(n) || '';
    if (type === 'evidence') { n.quote = text; n.text = n.text && n.type === 'evidence' ? n.text : ''; n.tier = n.tier || 'Unreviewed'; n.highlights = n.highlights || []; }
    else if (n.type === 'evidence') { n.text = text; delete n.quote; }
    n.type = type;
    const steps = api.board.steps;
    if (['note', 'evidence'].includes(type)) api.board.steps = steps.filter(id => id !== n.id);
    else if (!steps.includes(n.id)) steps.push(n.id);
  }

  // ---------- Edits (each one is a single undo step) ----------

  function change(fn, nextFocus) {
    flushText();
    const t = tree();
    if (fn(t) === false) return;
    if (nextFocus !== undefined) focus = nextFocus;
    needsLayout = true;
    layout(false);
    api.persist();
    api.render();
  }

  function flushText() {
    clearTimeout(timer);
    if (!pending) return;
    const { id, value } = pending; pending = null;
    const n = api.get(id);
    if (!n) return;
    if (n.type === 'evidence') { if (!lockedQuote(n)) n.quote = value; } else n.text = value;
    api.persist();
  }

  function addLine(afterId, text = '', type = 'note') {
    change(t => {
      const b = api.board;
      if (b.nodes.length >= 500) { api.notify('This board has reached the 500-card limit.'); return false; }
      const after = afterId && api.get(afterId);
      const parent = after ? t.parentOf.get(after.id) ?? null : null;
      const siblings = t.kids(parent), index = after ? siblings.indexOf(after) + 1 : siblings.length;
      const n = newCard(type, text);
      n.ord = orderBetween(siblings, index);
      b.nodes.push(n);
      if (parent) setParent(n.id, parent, t);
      focus = { id: n.id, offset: text.length };
    });
  }

  const building = () => api.board.framing === 'build';

  // Build up: this line becomes a reason for the next line at its level.
  function indentBuild(id) {
    change(t => {
      const n = api.get(id), siblings = t.kids(t.parentOf.get(id) ?? null), next = siblings[siblings.indexOf(n) + 1];
      if (!next) return false;
      setParent(id, next.id, t);
      const kids = t.kids(next.id).filter(k => k.id !== id);
      n.ord = kids.length ? kids.at(-1).ord + 1 : 0;
    }, { id, offset: caretOffset() });
  }

  // Build up: "so …" turns the reasons written just above into reasons for
  // this line (the run of plain lines since the last conclusion drawn).
  function reasonsAbove(id, t = tree()) {
    const siblings = t.kids(t.parentOf.get(id) ?? null), run = [];
    for (let j = siblings.indexOf(api.get(id)) - 1; j >= 0 && !t.kids(siblings[j].id).length; j--) run.unshift(siblings[j]);
    return run;
  }
  function gather(id, offset = 0) {
    if (!reasonsAbove(id).length) { api.notify('Write the reasons first, then start the next line with “so”.'); return false; }
    change(t => { reasonsAbove(id, t).forEach((r, k) => { setParent(r.id, id, t); r.ord = k; }); }, { id, offset });
    return true;
  }

  function joinTarget(id, t = tree()) {
    const n = api.get(id), parentId = t.parentOf.get(id) ?? null, siblings = t.kids(parentId), i = siblings.indexOf(n);
    return i > 0 ? siblings[i - 1] : parentId ? api.get(parentId) : null;
  }
  function joinWithAbove(id) {
    const other = joinTarget(id);
    if (!other) return false;
    change(t => {
      const b = api.board, n = api.get(id), grand = t.parentOf.get(other.id) ?? null, oldKind = t.primary.get(other.id)?.kind;
      const joint = newCard('note', '');
      joint.ord = other.ord;
      b.nodes.push(joint);
      setParent(other.id, joint.id, t); other.ord = 0;
      setParent(id, joint.id, t); n.ord = 1;
      if (grand) setParent(joint.id, grand, t, oldKind);
      focus = { id: joint.id, offset: 0 };
    });
    api.notify('Made these two reasons for a new line. Write what they add up to.');
    return true;
  }

  function indent(id) {
    if (building()) return indentBuild(id);
    change(t => {
      const n = api.get(id), siblings = t.kids(t.parentOf.get(id) ?? null), i = siblings.indexOf(n);
      if (i < 1) return false;
      const newParent = siblings[i - 1];
      setParent(id, newParent.id, t);
      const kids = t.kids(newParent.id);
      n.ord = kids.length ? kids.at(-1).ord + 1 : 0;
    }, { id, offset: caretOffset() });
  }

  function outdent(id) {
    if (building() && !tree().parentOf.get(id)) return gather(id, caretOffset());
    change(t => {
      const parent = t.parentOf.get(id);
      if (!parent) return false;
      const grand = t.parentOf.get(parent) ?? null, siblings = t.kids(grand), p = api.get(parent);
      setParent(id, grand, t);
      // Build up shows reasons above what they lead to, so step out upwards.
      api.get(id).ord = orderBetween(siblings, siblings.indexOf(p) + (building() ? 0 : 1));
    }, { id, offset: caretOffset() });
  }

  function move(id, dir) {
    change(t => {
      const n = api.get(id), siblings = t.kids(t.parentOf.get(id) ?? null), i = siblings.indexOf(n), other = siblings[i + dir];
      if (!other) return false;
      [n.ord, other.ord] = [other.ord, n.ord];
    }, { id, offset: caretOffset() });
  }

  function removeLine(id, focusAfter) {
    change(t => {
      if (t.kids(id).length) { api.notify('Move or delete the lines underneath first.'); return false; }
      const b = api.board;
      b.nodes = b.nodes.filter(n => n.id !== id);
      b.links = b.links.filter(l => l.from !== id && l.to !== id);
      b.steps = b.steps.filter(s => s !== id);
    }, focusAfter ? { id: focusAfter, offset: Infinity } : null);
  }

  function reparent(id, targetId) {
    change(t => {
      if (id === targetId || (targetId && isDescendant(targetId, id, t))) return false;
      setParent(id, targetId, t);
      const kids = t.kids(targetId ?? null).filter(n => n.id !== id);
      api.get(id).ord = kids.length ? kids.at(-1).ord + 1 : 0;
    }, null);
  }

  // Leading shortcut characters set the type, then disappear.
  function readPrefix(text) {
    const m = text.match(/^([?>!~-])\s/);
    return m ? { kind: PREFIX[m[1]], rest: text.slice(2) } : null;
  }

  // ---------- Automatic layout for cards nobody has placed by hand ----------

  function estimate(n) {
    const lines = (s, per) => Math.max(1, Math.ceil(String(s || '').length / per));
    if (n.type === 'evidence') return 125 + lines(textOf(n), 30) * 27 + (n.note ? lines(n.note, 45) * 20 : 0) + (n.image ? 220 : 0);
    if (n.type === 'fact' || n.type === 'note') return 75 + lines(n.text, 30) * 21;
    return 85 + lines(n.text, 24) * 29 + (n.note ? 20 : 0);
  }
  function height(n) {
    const el = document.querySelector(`#canvas [data-node="${CSS.escape(n.id)}"]`);
    return el?.offsetHeight || estimate(n);
  }

  // Trees made only of automatic cards get a tidy left-to-right layout
  // (reasons to the left of what they support). Automatic cards inside a
  // hand-arranged tree are placed once beside their parent, then left alone.
  function layout(measured) {
    const t = tree(), b = api.board;
    // A tree is laid out tidily when its top card was never placed by hand;
    // cards inside it that you did place keep their spot.
    const managed = new Set();
    const collect = n => { managed.add(n.id); t.kids(n.id).forEach(collect); };
    t.kids(null).filter(r => r.auto).forEach(collect);
    const manual = b.nodes.filter(n => !n.auto && !managed.has(n.id));
    let top = manual.length ? Math.max(...manual.map(n => n.y + (measured ? height(n) : estimate(n)))) + TREE_GAP : 100;
    let changed = false;
    const put = (n, x, y) => { x = Math.round(x); y = Math.round(y); if (n.x !== x || n.y !== y) { n.x = x; n.y = y; changed = true; } };
    const h = n => measured ? height(n) : estimate(n);
    const depthOf = n => 1 + Math.max(0, ...t.kids(n.id).map(depthOf));
    const placed = new Set();
    for (const root of t.kids(null)) {
      if (!root.auto) continue;
      const depth = depthOf(root) - 1;
      const place = (n, d, y) => {
        placed.add(n.id);
        let cursor = y;
        for (const k of t.kids(n.id)) cursor = place(k, d + 1, cursor) + GAP_Y;
        if (n.auto) put(n, 30 + (b.framing === 'build' ? depth - d : d) * COL, y);
        return Math.max(y + h(n), t.kids(n.id).length ? cursor - GAP_Y : 0);
      };
      top = place(root, 0, top) + TREE_GAP;
    }
    for (const n of b.nodes) {
      if (!n.auto || placed.has(n.id)) continue;
      const parent = api.get(t.parentOf.get(n.id));
      let x = parent ? Math.max(0, parent.x + (b.framing === 'build' ? -COL : COL)) : 30, y = parent ? parent.y : top;
      const hit = yy => b.nodes.some(o => o !== n && !o.auto && x < o.x + 330 && x + 330 > o.x && yy < o.y + h(o) + 30 && yy + h(n) + 30 > o.y);
      for (let i = 0; i < 200 && hit(y); i++) y += 40;
      put(n, x, y);
      delete n.auto;
    }
    return changed;
  }

  // Cards placed from elsewhere (e.g. dropped from the inbox) ask to be laid out.
  api.requestLayout = () => { needsLayout = true; };

  // After the spatial board renders, re-run the layout with real card sizes.
  api.onRender(() => {
    if (laying) return;
    if (api.tab === 'map' && needsLayout) {
      needsLayout = false;
      laying = true;
      try { if (layout(true)) { api.commit(false); api.render(); } } finally { laying = false; }
    }
    if (api.tab === 'outline') renderOutline();
  });

  // ---------- Rendering ----------

  function renderOutline() {
    const t = tree(), b = api.board;
    const incomingExtra = new Map();
    for (const l of b.links) {
      if (t.primary.get(l.from) === l) continue;
      if (!incomingExtra.has(l.to)) incomingExtra.set(l.to, []);
      incomingExtra.get(l.to).push(l);
    }
    const hasSource = id => b.links.some(l => l.to === id && l.kind === 'supports' && api.get(l.from)?.type === 'evidence');
    const build = b.framing === 'build';
    const row = n => {
      const parent = t.parentOf.get(n.id), rel = t.primary.get(n.id)?.kind;
      const siblings = parent ? t.kids(parent) : [];
      const again = siblings.slice(0, siblings.indexOf(n)).some(o => stanceOf(t.primary.get(o.id)?.kind) === stanceOf(rel));
      const kids = t.kids(n.id), locked = lockedQuote(n);
      const hint = n.type === 'claim' && !hasSource(n.id) && !kids.some(k => k.type === 'evidence') ? 'no source yet'
        : n.type === 'conclusion' && !kids.length && !b.links.some(l => l.to === n.id) ? 'no reasons yet'
        : n.type === 'evidence' && !n.url ? 'add where this is from' : '';
      const extras = [
        ...b.links.filter(l => l.from === n.id && t.primary.get(n.id) !== l).map(l => [l.to, ALSO_OUT[l.kind], l.id]),
        ...(incomingExtra.get(n.id) || []).map(l => [l.from, ALSO_IN[l.kind], l.id]),
      ].filter(([id]) => api.get(id));
      const childBlock = kids.length ? `<ul class="ol-children">${kids.map(row).join('')}</ul>` : '';
      return `<li class="ol-item" data-id="${esc(n.id)}">
        ${build ? childBlock : ''}
        <div class="ol-row" data-row="${esc(n.id)}">
          <span class="ol-grip" draggable="true" data-grip="${esc(n.id)}" title="Drag onto another line to put it underneath">⠿</span>
          <select class="ol-type type-${esc(n.type)}" data-type="${esc(n.id)}" aria-label="Kind of line">${TYPES.map(([v, l]) => `<option value="${v}" ${v === n.type ? 'selected' : ''}>${l}</option>`).join('')}</select>
          ${parent && !(build && kids.length) ? (n.type === 'gap'
            ? `<span class="ol-rel is-fixed">${(build ? api.buildWord : api.answerWord)(n.type, rel, again)}</span>`
            : `<button type="button" class="ol-rel rel-${esc(rel)}" data-stance="${esc(n.id)}" title="${rel === 'challenges' ? `An objection to the line ${build ? 'it leads to' : 'above'}. Click to make it support it instead.` : `Supports the line ${build ? 'it leads to' : 'above'}. Click to make it an objection instead.`}">${(build ? api.buildWord : api.answerWord)(n.type, rel, again)}</button>`) : ''}
          ${build && kids.length ? `<span class="ol-rel is-fixed is-lead ${rel === 'challenges' ? 'rel-challenges' : ''}" ${rel === 'challenges' ? 'title="This conclusion is an objection to the one it leads to"' : ''}>${kids.some(k => stanceOf(t.primary.get(k.id)?.kind) === 'for') ? 'and so' : kids.some(k => t.primary.get(k.id)?.kind === 'challenges') ? 'still,' : ''}</span>` : ''}
          <div class="ol-text ${n.type === 'evidence' ? 'is-quote' : ''}" data-text="${esc(n.id)}" ${locked ? 'tabindex="0" title="Captured wording. Open the editor (✎) to change it."' : 'contenteditable="plaintext-only"'} spellcheck="true" data-placeholder="${n.type === 'evidence' ? 'Paste the exact words…' : kids.length ? (build ? 'and so… what follows?' : 'What do the lines below add up to?') : 'Type a thought…'}">${esc(textOf(n))}</div>
          ${n.type === 'evidence' && (n.url || n.text) ? `<span class="ol-source">${esc(n.text || '')}${n.url ? ` · ${esc(hostname(n.url))}` : ''}</span>` : ''}
          ${hint ? `<span class="ol-hint">${hint}</span>` : ''}
          ${n.type === 'conclusion' ? (api.mainConclusion()?.id === n.id ? '<span class="ol-answer">answers the question</span>' : api.isInterim(n) ? '<span class="ol-source">interim</span>' : '') : ''}
          <button class="ol-open" data-open="${esc(n.id)}" title="Open the full editor (notes, source link, screenshot)" aria-label="Edit details">✎</button>
        </div>
        ${extras.length ? `<div class="ol-extras">${extras.map(([id, label, linkId]) => `<button data-goto="${esc(id)}" data-link="${esc(linkId)}">${esc(label)} ${(o => o.type === 'evidence' ? '“' + esc(clip(textOf(o) || o.text, 60)) + '”' : esc(clip(o.text, 60)))(api.get(id))}</button>`).join('')}</div>` : ''}
        ${build ? '' : childBlock}
      </li>`;
    };
    const title = b.title === DEFAULT_TITLE ? '' : b.title;
    const roots = t.kids(null);
    const unplaced = inboxThoughts.filter(c => !b.nodes.some(n => n.sourceCaptureId === c.id));
    view.innerHTML = `
      <div class="ol-shell">
        <label class="ol-label" for="ol-title">Question</label>
        <input id="ol-title" class="ol-title" value="${esc(title)}" placeholder="What are you trying to figure out? (optional, add it later)">
        ${unplaced.length ? `<div class="ol-inbox"><span>${unplaced.length} thought${unplaced.length === 1 ? '' : 's'} jotted from the side panel</span><button data-add-jots>Add to outline</button></div>` : ''}
        <div class="ol-tree-wrap"><ul class="ol-tree ${build ? 'is-build' : ''}" aria-label="Outline">${roots.map(row).join('')}</ul><svg class="ol-arrows" aria-hidden="true"></svg></div>
        ${roots.length ? '' : '<p class="ol-empty">Nothing here yet. Write whatever you already know or suspect, one thought per line. Sort it out afterwards.</p>'}
        <div class="ol-drop-root" data-drop-root>Drop here to move a line to the top level</div>
        <form class="ol-jot" id="ol-jot-form"><input id="ol-jot" placeholder="Jot a thought and press Enter" autocomplete="off" aria-label="Jot a thought"><button class="dark">Add</button></form>
        <p class="ol-keys">${build ? '<kbd>Tab</kbd> make it a reason for the line below · start a line with <kbd>so</kbd> to draw a conclusion from the lines above ·' : '<kbd>Tab</kbd> put under the line above · <kbd>⇧ Tab</kbd> move out ·'} <kbd>Alt ↑↓</kbd> reorder · start a line with <kbd>?</kbd> question <kbd>&gt;</kbd> quote <kbd>!</kbd> conclusion <kbd>-</kbd> fact about you <kbd>~</kbd> objection · <kbd>but</kbd> joins two lines as reasons for a new one</p>
        ${roots.length > 1 || roots.some(r => t.kids(r.id).length) ? '<div class="ol-actions"><button data-order-from-outline title="Reasons first, then what they lead to">Use this order for the walkthrough</button><button data-tidy>Re-arrange the board from this outline</button></div>' : ''}
      </div>`;
    restoreFocus();
    drawArrows();
  }

  // Extra connections (beyond the outline's nesting) drawn as arrows in the
  // right margin, from the supporting line to the line it supports.
  function drawArrows() {
    const wrap = view.querySelector('.ol-tree-wrap'), svg = wrap?.querySelector('.ol-arrows');
    if (!svg) return;
    const t = tree(), box = wrap.getBoundingClientRect();
    const links = api.board.links.filter(l => t.primary.get(l.from) !== l);
    let lane = 0;
    const paths = links.map(l => {
      const a = wrap.querySelector(`[data-row="${CSS.escape(l.from)}"]`), c = wrap.querySelector(`[data-row="${CSS.escape(l.to)}"]`);
      if (!a || !c) return '';
      const ra = a.getBoundingClientRect(), rc = c.getBoundingClientRect();
      const y1 = ra.top - box.top + Math.min(16, ra.height / 2), y2 = rc.top - box.top + Math.min(16, rc.height / 2);
      const edge = box.width + 4, out = edge + 16 + (lane++ % 3) * 9;
      return `<path class="k-${esc(l.kind)}" data-arrow="${esc(l.id)}" d="M${edge},${y1} C${out},${y1} ${out},${y2} ${edge + 3},${y2}" marker-end="url(#ol-head)"/>`;
    }).join('');
    svg.innerHTML = `<defs><marker id="ol-head" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M1 1 L9 5 L1 9" fill="none" stroke="context-stroke" stroke-width="1.5"/></marker></defs>${paths}`;
  }
  new ResizeObserver(() => { if (api.tab === 'outline') drawArrows(); }).observe(view);
  view.addEventListener('mouseover', e => {
    const ref = e.target.closest('[data-link]');
    view.querySelectorAll('.is-hot').forEach(el => el.classList.remove('is-hot'));
    if (!ref) return;
    view.querySelector(`[data-arrow="${CSS.escape(ref.dataset.link)}"]`)?.classList.add('is-hot');
    view.querySelector(`[data-row="${CSS.escape(ref.dataset.goto)}"]`)?.classList.add('is-hot');
  });

  const clip = (s, n) => { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
  const hostname = u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };

  function restoreFocus() {
    if (!focus) return;
    const el = focus.id === 'jot' ? view.querySelector('#ol-jot') : view.querySelector(`[data-text="${CSS.escape(focus.id)}"]`);
    const offset = focus.offset; focus = null;
    if (!el) return;
    el.focus();
    if (el.isContentEditable) setCaret(el, offset);
    el.scrollIntoView({ block: 'nearest' });
  }
  function setCaret(el, offset) {
    const text = el.firstChild, len = text?.textContent.length || 0, range = document.createRange();
    if (text) range.setStart(text, Math.min(len, offset ?? len)); else range.setStart(el, 0);
    range.collapse(true);
    const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);
  }
  function caretOffset() {
    const sel = getSelection(), el = document.activeElement;
    if (!sel.rangeCount || !el?.isContentEditable) return 0;
    const r = sel.getRangeAt(0).cloneRange(); r.selectNodeContents(el); r.setEnd(sel.anchorNode, sel.anchorOffset);
    return r.toString().length;
  }
  const visibleRows = () => [...view.querySelectorAll('[data-text]')];

  // ---------- Events ----------

  view.addEventListener('input', e => {
    const el = e.target.closest('[data-text]');
    if (!el) return;
    const id = el.dataset.text, n = api.get(id);
    let value = el.textContent;
    if (BUT.test(value) && joinTarget(id)) {
      pending = { id, value: value.replace(BUT, '') };
      flushText();
      return joinWithAbove(id);
    }
    if (building() && SO.test(value) && reasonsAbove(id).length) {
      pending = { id, value: value.replace(SO, '') };
      flushText();
      return gather(id, 0);
    }
    requestAnimationFrame(drawArrows);
    const prefix = readPrefix(value);
    if (prefix && (n.type === 'note' || prefix.kind === 'challenge')) {
      pending = { id, value: prefix.rest };
      return change(t => {
        if (prefix.kind === 'challenge') {
          if (n.type === 'note') applyType(n, 'claim');
          const parent = t.parentOf.get(id);
          if (parent) t.primary.get(id).kind = 'challenges';
        } else {
          applyType(n, prefix.kind);
          const link = t.primary.get(id);
          if (link) link.kind = api.fitKind(n.type, link.kind);
        }
      }, { id, offset: 0 });
    }
    pending = { id, value };
    clearTimeout(timer);
    timer = setTimeout(flushText, 700);
  });

  view.addEventListener('keydown', e => {
    const el = e.target.closest('[data-text]');
    if (!el) return;
    const id = el.dataset.text, t = tree(), rows = visibleRows(), i = rows.indexOf(el);
    const empty = el.isContentEditable && !el.textContent.trim(), offset = caretOffset();
    const atStart = !el.isContentEditable || offset === 0, atEnd = !el.isContentEditable || offset === el.textContent.length;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (empty && t.parentOf.get(id) && !t.kids(id).length) return outdent(id);
      addLine(id);
    } else if (e.key === 'Tab') {
      e.preventDefault();
      e.shiftKey ? outdent(id) : indent(id);
    } else if (e.key === 'Backspace' && empty && offset === 0) {
      e.preventDefault();
      removeLine(id, rows[i - 1]?.dataset.text);
    } else if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      move(id, e.key === 'ArrowUp' ? -1 : 1);
    } else if (e.key === 'ArrowUp' && atStart && rows[i - 1]) {
      e.preventDefault(); flushText(); rows[i - 1].focus(); setCaret(rows[i - 1], Infinity);
    } else if (e.key === 'ArrowDown' && atEnd && rows[i + 1]) {
      e.preventDefault(); flushText(); rows[i + 1].focus(); setCaret(rows[i + 1], 0);
    }
  });
  view.addEventListener('focusout', e => { if (e.target.closest('[data-text]')) flushText(); });

  view.addEventListener('change', e => {
    const typeSel = e.target.closest('[data-type]');
    if (typeSel) {
      const id = typeSel.dataset.type;
      change(t => {
        const n = api.get(id);
        applyType(n, typeSel.value);
        const link = t.primary.get(id);
        if (link) link.kind = api.fitKind(n.type, link.kind);
      }, { id, offset: Infinity });
    } else if (e.target.id === 'ol-title') {
      api.board.title = e.target.value.trim() || DEFAULT_TITLE;
      api.persist(); api.render();
    }
  });

  view.addEventListener('submit', e => {
    if (e.target.id !== 'ol-jot-form') return;
    e.preventDefault();
    const input = view.querySelector('#ol-jot'), raw = input.value.trim();
    if (!raw) return;
    const prefix = readPrefix(raw + ' ');
    const type = prefix && prefix.kind !== 'challenge' ? prefix.kind : 'note';
    const text = prefix ? prefix.rest.trim() : raw;
    if (BUT.test(raw) && tree().kids(null).length) {
      addLine(null, raw.replace(BUT, '').trim(), type);
      const last = tree().kids(null).at(-1);
      if (last) joinWithAbove(last.id);
      return;
    } else if (building() && SO.test(raw)) {
      addLine(null, raw.replace(SO, '').trim(), type);
      const last = tree().kids(null).at(-1);
      if (last) gather(last.id);
    } else addLine(null, text, type);
    focus = { id: 'jot' };
    renderOutline();
  });

  view.addEventListener('click', e => {
    const open = e.target.closest('[data-open]'), go = e.target.closest('[data-goto]'), stance = e.target.closest('[data-stance]');
    if (stance) {
      const id = stance.dataset.stance;
      change(t => { const l = t.primary.get(id); l.kind = l.kind === 'challenges' ? kindFor(api.get(id)) : 'challenges'; }, null);
    } else if (open) { flushText(); const n = api.get(open.dataset.open); api.openCard(n.type, n.id); }
    else if (go) { focus = { id: go.dataset.goto, offset: Infinity }; restoreFocus(); }
    else if (e.target.closest('[data-order-from-outline]')) orderFromOutline();
    else if (e.target.closest('[data-tidy]')) tidy();
    else if (e.target.closest('[data-add-jots]')) addJots();
  });

  // Drag a line by its grip onto another line to put it underneath.
  view.addEventListener('dragstart', e => {
    const grip = e.target.closest('[data-grip]');
    if (!grip) return;
    dragId = grip.dataset.grip;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragId);
    e.dataTransfer.setDragImage(grip.closest('.ol-row'), 10, 10);
    view.classList.add('is-dragging');
  });
  view.addEventListener('dragover', e => {
    const target = e.target.closest('[data-row],[data-drop-root]');
    if (!dragId || !target) return;
    e.preventDefault();
    view.querySelectorAll('.drop-target').forEach(el => el !== target && el.classList.remove('drop-target'));
    target.classList.add('drop-target');
  });
  view.addEventListener('dragend', () => { dragId = null; view.classList.remove('is-dragging'); view.querySelectorAll('.drop-target').forEach(el => el.classList.remove('drop-target')); });
  view.addEventListener('drop', e => {
    const target = e.target.closest('[data-row],[data-drop-root]');
    if (!dragId || !target) return;
    e.preventDefault();
    const id = dragId; dragId = null;
    reparent(id, target.dataset.row || null);
  });

  // Reasons before what they lead to: a depth-first, children-first reading.
  function orderFromOutline() {
    change(t => {
      const out = [];
      const walk = n => { t.kids(n.id).forEach(walk); if (!['note', 'evidence'].includes(n.type)) out.push(n.id); };
      t.kids(null).forEach(walk);
      api.board.steps = [...out, ...api.board.steps.filter(id => !out.includes(id) && api.get(id))];
    }, null);
    api.notify('Walkthrough now follows the outline. Undo restores the previous order.');
  }

  function tidy() {
    change(() => { api.board.nodes.forEach(n => { n.auto = true; }); }, null);
    api.notify('Cards re-arranged from the outline. Undo restores your layout.');
  }

  async function refreshInbox() {
    try {
      inboxThoughts = (await api.workspace.inbox(api.session.journey.id)).filter(c => c.kind === 'note');
    } catch { inboxThoughts = []; }
    if (api.tab === 'outline') renderOutline();
  }

  function addJots() {
    const placed = new Set(api.board.nodes.map(n => n.sourceCaptureId).filter(Boolean));
    const fresh = inboxThoughts.filter(c => !placed.has(c.id)).sort((a, b) => a.capturedAt - b.capturedAt);
    change(t => {
      let ord = Math.max(0, ...t.kids(null).map(n => n.ord + 1));
      for (const c of fresh) {
        const n = api.workspace.noteCard(c, { x: 30, y: 100 });
        Object.assign(n, { auto: true, ord: ord++ });
        api.board.nodes.push(n);
      }
    }, null);
  }

  // Reading direction, shared by the outline and the spatial board.
  document.querySelector('.board-bar .tabs')?.insertAdjacentHTML('afterend', `<div class="ol-framing" role="group" aria-label="Read the argument">
    <button type="button" data-framing="answer" title="The point first, then what backs it up: “Y because X”">Answer first</button>
    <button type="button" data-framing="build" title="Reasons first, leading to the point: “X, and so Y”">Build up</button></div>`);
  const syncFraming = () => document.querySelectorAll('[data-framing]').forEach(b => b.setAttribute('aria-pressed', String((api.board.framing === 'build') === (b.dataset.framing === 'build'))));
  api.onRender(syncFraming);
  document.addEventListener('click', e => {
    const f = e.target.closest('[data-framing]');
    if (!f || api.board.framing === f.dataset.framing || (!api.board.framing && f.dataset.framing === 'answer')) return;
    flushText();
    api.board.framing = f.dataset.framing;
    needsLayout = true; layout(false);
    api.persist(); api.render();
  });

  // Empty-board shortcut and cross-tab jot notifications.
  document.addEventListener('click', e => { if (e.target.closest('[data-open-outline]')) { focus = { id: 'jot' }; api.setTab('outline'); } });
  globalThis.chrome?.runtime?.onMessage?.addListener(msg => { if (msg.type === 'trail-updated' && msg.journeyId === api.session.journey.id) refreshInbox(); });
  refreshInbox();
  if (needsLayout && api.tab === 'map') api.render();
  if (api.tab === 'outline') { focus = focus || { id: 'jot' }; renderOutline(); }
}
