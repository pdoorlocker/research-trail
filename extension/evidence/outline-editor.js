// Outline: the low-friction way into a board. Jot thoughts as lines, then
// connect them with the words you would say out loud. The outline and the
// spatial board are two views of the same cards and connections.
//
// Connections are stored in reading order ("[from] word [to]"). A line sits
// under the card its first incoming connection comes from. How it is shown:
//  - because / one objection / which raises the question / answer: indented
//    under the line (details about that line);
//  - so / and / but: the story continues. A single continuation flows straight
//    down at the same level; several continuations from one line branch.
// Further connections to a line appear as "also …" links, joined to it by a
// line in the left margin, so nothing on the board is hidden here.

const DEFAULT_TITLE = 'What am I trying to establish?';
const TYPES = [['note', 'Thought'], ['fact', 'Fact'], ['claim', 'Claim'], ['conclusion', 'Conclusion'], ['gap', 'Question'], ['evidence', 'Quote']];
const CONTINUES = new Set(['so', 'and', 'but']);
const PREFIX = { '?': 'gap', '>': 'evidence', '!': 'conclusion', '-': 'fact' };
// Words typed at the start of a line connect it to the line above; synonyms
// normalise to one word per circumstance.
const WORD_PREFIX = /^(and so|because|and|but|so|ergo|therefore|thus|answer|~)[,:]?\s+/i;
const WORD_OF = { 'and so': 'so', ergo: 'so', therefore: 'so', thus: 'so', '~': 'objection' };
const COL = 410, GAP_Y = 36, CHAIN_GAP = 64, TREE_GAP = 90, INDENT = 30;

export function init(api) {
  const view = document.getElementById('outline-view');
  if (!view) return;
  const esc = api.esc;
  let focus = null;              // { id, offset } to restore after a re-render
  let pending = null, timer = 0; // debounced text edit { id, value }
  // Cards never placed by hand are laid out the first time the board shows.
  let needsLayout = api.board.nodes.some(n => n.auto), laying = false, dragId = null, inboxThoughts = [];

  // ---------- Model ----------

  function tree() {
    const b = api.board, ids = new Set(b.nodes.map(n => n.id));
    const parentOf = new Map(), primary = new Map();
    for (const l of b.links) {
      if (!ids.has(l.from) || !ids.has(l.to) || parentOf.has(l.to)) continue;
      let p = l.from, cycle = false;
      for (let i = 0; p && i < 600; i++) { if (p === l.to) { cycle = true; break; } p = parentOf.get(p); }
      if (cycle) continue;
      parentOf.set(l.to, l.from); primary.set(l.to, l);
    }
    ensureOrder();
    const children = new Map([[null, []]]);
    for (const n of b.nodes) {
      const p = parentOf.get(n.id) ?? null;
      if (!children.has(p)) children.set(p, []);
      children.get(p).push(n);
    }
    for (const list of children.values()) list.sort((a, c) => a.ord - c.ord);
    const kids = id => children.get(id) || [];
    const wordOf = id => primary.get(id)?.word;
    const details = id => kids(id).filter(k => !CONTINUES.has(wordOf(k.id)));
    const continuations = id => kids(id).filter(k => CONTINUES.has(wordOf(k.id)));
    return { parentOf, primary, kids, wordOf, details, continuations };
  }

  // The outline as it is displayed: rows with an indent level.
  function displayRows(t) {
    const out = [];
    const emit = (n, indent) => {
      out.push({ n, indent });
      t.details(n.id).forEach(k => emit(k, indent + 1));
      const next = t.continuations(n.id);
      if (next.length === 1) emit(next[0], indent);
      else next.forEach(k => emit(k, indent + 1));
    };
    t.kids(null).forEach(r => emit(r, 0));
    return out;
  }

  // Older cards have no outline order: derive it once from board position.
  function ensureOrder() {
    const missing = api.board.nodes.filter(n => !Number.isFinite(n.ord)).sort((a, c) => a.y - c.y || a.x - c.x);
    if (!missing.length) return;
    let next = Math.max(0, ...api.board.nodes.filter(n => Number.isFinite(n.ord)).map(n => n.ord + 1));
    for (const n of missing) n.ord = next++;
  }

  const textOf = n => n.type === 'evidence' ? (n.quote || n.displayedQuote || '') : n.text;
  const lockedQuote = n => n.type === 'evidence' && (n.sourceCaptureId || n.image || (!n.quote && n.displayedQuote));
  const isDescendant = (id, ancestor, t) => { for (let p = id; p; p = t.parentOf.get(p)) if (p === ancestor) return true; return false; };

  // Make `from` the line `id` hangs off, with `word`, replacing its current place.
  function connect(id, fromId, word, t) {
    const b = api.board, old = t.primary.get(id);
    if (old) b.links = b.links.filter(l => l !== old);
    if (!fromId) return;
    const from = api.get(fromId), n = api.get(id), w = api.fitWord(from.type, n.type, word);
    const existing = b.links.find(l => l.from === fromId && l.to === id);
    if (existing) { existing.word = w; b.links = [existing, ...b.links.filter(l => l !== existing)]; return; }
    b.links.unshift({ id: api.uid(), from: fromId, to: id, word: w, label: '' });
  }

  // Change how a line follows from the line above. When it stops continuing
  // the story (and becomes a detail), what followed it goes back to its parent.
  function setWord(id, word, t) {
    const l = t.primary.get(id);
    if (!l) return;
    const parent = t.parentOf.get(id);
    if (CONTINUES.has(l.word) && !CONTINUES.has(word)) for (const k of t.continuations(id)) connect(k.id, parent, t.wordOf(k.id), t);
    l.word = api.fitWord(api.get(l.from).type, api.get(id).type, word);
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
    for (const l of api.board.links) if (l.from === n.id || l.to === n.id) l.word = api.fitWord(api.get(l.from)?.type || n.type, api.get(l.to)?.type || n.type, l.word);
  }

  // ---------- Edits (each one is a single undo step) ----------

  function change(fn, nextFocus, { reorder = false } = {}) {
    flushText();
    const t = tree();
    if (fn(t) === false) return;
    // A thought that something now backs up is being argued: a claim.
    for (const n of api.board.nodes) if (n.type === 'note' && api.supportersOf(n.id).length) applyType(n, 'claim');
    // The walkthrough reads in the outline's order.
    if (reorder) {
      const order = displayRows(tree()).map(r => r.n).filter(n => !['note', 'evidence'].includes(n.type)).map(n => n.id);
      api.board.steps = [...order, ...api.board.steps.filter(id => !order.includes(id) && api.get(id))];
    }
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

  // Enter: a parallel detail repeats the line's word ("and because …");
  // otherwise the story continues ("and …"), or a new separate thought.
  function addLine(afterId, text = '', type = 'note') {
    change(t => {
      const b = api.board;
      if (b.nodes.length >= 500) { api.notify('This board has reached the 500-card limit.'); return false; }
      const n = newCard(type, text);
      b.nodes.push(n);
      const after = afterId && api.get(afterId), parent = after ? t.parentOf.get(after.id) : null, word = after && t.wordOf(after.id);
      if (after && parent && !CONTINUES.has(word)) {
        const siblings = t.kids(parent);
        n.ord = orderBetween(siblings, siblings.indexOf(after) + 1);
        connect(n.id, parent, word, t);
      } else if (after && (parent || t.continuations(after.id).length)) {
        // Insert into the chain: the new line continues this one, and what
        // used to follow now follows the new line.
        n.ord = 0;
        for (const k of t.continuations(after.id)) connect(k.id, n.id, t.wordOf(k.id), t);
        connect(n.id, after.id, 'and', t);
      } else {
        const roots = t.kids(null);
        n.ord = after ? orderBetween(roots, roots.indexOf(after) + 1) : Math.max(0, ...roots.map(r => r.ord + 1));
      }
      focus = { id: n.id, offset: text.length };
    });
  }

  // The line a new connection hangs off: the nearest row above at the same level.
  function lineAbove(id, t = tree()) {
    const rows = displayRows(t), i = rows.findIndex(r => r.n.id === id);
    for (let j = i - 1; j >= 0; j--) {
      if (rows[j].indent === rows[i].indent && !isDescendant(rows[j].n.id, id, t)) return rows[j].n;
      if (rows[j].indent < rows[i].indent) return rows[j].n;
    }
    return null;
  }

  // Tab: this line is a reason for the line above it.
  function indent(id) {
    change(t => {
      const above = lineAbove(id, t);
      if (!above || above.id === t.parentOf.get(id) && !CONTINUES.has(t.wordOf(id))) return false;
      connect(id, above.id, 'because', t);
      const kids = t.details(above.id).filter(k => k.id !== id);
      api.get(id).ord = kids.length ? kids.at(-1).ord + 1 : 0;
    }, { id, offset: caretOffset() });
  }

  // Shift+Tab: step out to the level of the line it hangs off.
  function outdent(id) {
    change(t => {
      const parent = t.parentOf.get(id);
      if (!parent) return false;
      const grand = t.parentOf.get(parent), n = api.get(id);
      if (grand) {
        connect(id, grand, t.wordOf(parent), t);
        const siblings = t.kids(grand);
        n.ord = orderBetween(siblings, siblings.indexOf(api.get(parent)) + 1);
      } else {
        connect(id, null, null, t);
        const roots = t.kids(null);
        n.ord = orderBetween(roots, roots.indexOf(api.get(parent)) + 1);
      }
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
      if (t.kids(id).length) { api.notify('Move or delete the lines that follow from it first.'); return false; }
      const b = api.board;
      b.nodes = b.nodes.filter(n => n.id !== id);
      b.links = b.links.filter(l => l.from !== id && l.to !== id);
      b.steps = b.steps.filter(s => s !== id);
    }, focusAfter ? { id: focusAfter, offset: Infinity } : null);
  }

  // Dropped onto a line: it becomes a reason for that line.
  function reparent(id, targetId) {
    change(t => {
      if (id === targetId || (targetId && isDescendant(targetId, id, t))) return false;
      connect(id, targetId, 'because', t);
      const kids = t.kids(targetId ?? null).filter(n => n.id !== id);
      api.get(id).ord = kids.length ? kids.at(-1).ord + 1 : 0;
    }, null);
  }

  const readPrefix = text => { const m = text.match(/^([?>!-])\s/); return m ? { type: PREFIX[m[1]], rest: text.slice(2) } : null; };
  const readWord = text => {
    const m = text.match(WORD_PREFIX);
    if (!m) return null;
    const w = m[1].toLowerCase();
    return { word: WORD_OF[w] || w, rest: text.slice(m[0].length) };
  };
  const capitalise = s => s.replace(/^\s*(\p{Ll})/u, (_, c) => c.toUpperCase());

  // ---------- Automatic layout, shaped like the outline ----------
  // A chain runs down one column; details sit in the next column to the right.

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

  function layout(measured) {
    const t = tree(), b = api.board;
    const managed = new Set();
    const collect = n => { managed.add(n.id); t.kids(n.id).forEach(collect); };
    t.kids(null).filter(r => r.auto).forEach(collect);
    const h = n => measured ? height(n) : estimate(n);
    const manual = b.nodes.filter(n => !n.auto && !managed.has(n.id));
    let top = manual.length ? Math.max(...manual.map(n => n.y + h(n))) + TREE_GAP : 100;
    let changed = false;
    const put = (n, x, y) => { x = Math.round(x); y = Math.round(y); if (n.x !== x || n.y !== y) { n.x = x; n.y = y; changed = true; } };
    const place = (n, col, y) => {
      if (n.auto) put(n, 30 + col * COL, y);
      let right = y;
      // Folded-away evidence takes no room, so the reasoning closes up.
      const shown = t.details(n.id).filter(k => !api.isHidden?.(k.id));
      for (const k of shown) right = place(k, col + 1, right) + GAP_Y;
      let bottom = Math.max(y + h(n), shown.length ? right - GAP_Y : 0);
      const next = t.continuations(n.id);
      if (next.length === 1) bottom = place(next[0], col, bottom + CHAIN_GAP);
      else for (const k of next) bottom = place(k, col + 1, bottom + GAP_Y);
      return bottom;
    };
    for (const root of t.kids(null)) if (root.auto) top = place(root, 0, top) + TREE_GAP;
    // Automatic cards inside a hand-arranged tree: placed once near the card
    // they follow from, then left where they are.
    for (const n of b.nodes) {
      if (!n.auto || managed.has(n.id)) continue;
      const parent = api.get(t.parentOf.get(n.id)), cont = CONTINUES.has(t.wordOf(n.id));
      let x = parent ? parent.x + (cont ? 0 : COL) : 30, y = parent ? parent.y + (cont ? h(parent) + CHAIN_GAP : 0) : top;
      const hit = yy => b.nodes.some(o => o !== n && !o.auto && x < o.x + 330 && x + 330 > o.x && yy < o.y + h(o) + 30 && yy + h(n) + 30 > o.y);
      for (let i = 0; i < 200 && hit(y); i++) y += 40;
      put(n, x, y);
      delete n.auto;
    }
    return changed;
  }

  api.requestLayout = () => { needsLayout = true; };
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
    const t = tree(), b = api.board, rows = displayRows(t);
    const main = api.mainConclusion?.();
    const row = ({ n, indent }) => {
      const parent = t.parentOf.get(n.id), link = t.primary.get(n.id), word = link?.word;
      const siblings = parent ? t.details(parent) : [];
      const again = parent && !CONTINUES.has(word) && siblings.slice(0, siblings.indexOf(n)).some(o => t.wordOf(o.id) === word);
      const locked = lockedQuote(n), from = parent && api.get(parent);
      const hasSource = api.supportersOf(n.id).some(id => api.get(id)?.type === 'evidence');
      const hint = n.type === 'claim' && !hasSource ? 'no source yet'
        : n.type === 'conclusion' && !api.supportersOf(n.id).length ? 'no reasons yet'
        : n.type === 'evidence' && !n.url ? 'add where this is from' : '';
      const extras = b.links.filter(l => l.from === n.id && t.primary.get(l.to) !== l && api.get(l.to));
      const choices = from ? api.WORD_CHOICES.filter(([v]) => api.allowedWords(from.type, n.type).includes(v)) : [];
      return `<li class="ol-item" data-id="${esc(n.id)}" data-from="${esc(parent || '')}" data-joined-by="${esc(word || '')}" style="--indent:${indent}">
        <div class="ol-row" data-row="${esc(n.id)}">
          <span class="ol-grip" draggable="true" data-grip="${esc(n.id)}" title="Drag onto another line to make it a reason for that line">⠿</span>
          <select class="ol-type type-${esc(n.type)}" data-type="${esc(n.id)}" aria-label="Kind of line">${TYPES.map(([v, l]) => `<option value="${v}" ${v === n.type ? 'selected' : ''}>${l}</option>`).join('')}</select>
          ${from ? `<select class="ol-rel rel-${esc(word)}" data-word="${esc(n.id)}" aria-label="How this line follows from “${esc(clip(textOf(from), 40))}”" title="Reads: “${esc(clip(textOf(from), 40))}” ${esc(api.wordLabel(word, n.type))} this line">${choices.map(([v]) => `<option value="${v}" ${v === word ? 'selected' : ''}>${esc(api.wordLabel(v, n.type, again && v === word))}</option>`).join('')}</select>` : ''}
          <div class="ol-text ${n.type === 'evidence' ? 'is-quote' : ''}" data-text="${esc(n.id)}" ${locked ? 'tabindex="0" title="Captured wording. Open the editor (✎) to change it."' : 'contenteditable="plaintext-only"'} spellcheck="true" data-placeholder="${n.type === 'evidence' ? 'Paste the exact words…' : 'Type a thought…'}">${esc(textOf(n))}</div>
          ${n.type === 'evidence' && (n.url || n.text) ? `<span class="ol-source">${esc(n.text || '')}${n.url ? ` · ${esc(hostname(n.url))}` : ''}</span>` : ''}
          ${hint ? `<span class="ol-hint">${hint}</span>` : ''}
          ${n.type === 'conclusion' ? (main?.id === n.id ? '<span class="ol-answer">answers the question</span>' : `${api.isInterim(n) ? '<span class="ol-source">interim</span>' : ''}<button class="ol-make-answer" data-answer="${esc(n.id)}" title="Make this the conclusion that answers the question">★ make this the answer</button>`) : ''}
          <button class="ol-add-also" data-also="${esc(n.id)}" title="Also connect this line to another line (or type @ in the line)">+ also</button>
          <button class="ol-open" data-open="${esc(n.id)}" title="Open the full editor (notes, source link, screenshot)" aria-label="Edit details">✎</button>
        </div>
        ${extras.map(l => `<button class="ol-also" data-goto="${esc(l.to)}" data-link="${esc(l.id)}">↳ also, ${esc(api.wordLabel(l.word, api.get(l.to).type))}: ${(o => o.type === 'evidence' ? '“' + esc(clip(textOf(o), 60)) + '”' : esc(clip(o.text, 60)))(api.get(l.to))}</button>`).join('')}
      </li>`;
    };
    const title = b.title === DEFAULT_TITLE ? '' : b.title;
    const unplaced = inboxThoughts.filter(c => !b.nodes.some(n => n.sourceCaptureId === c.id));
    view.innerHTML = `
      <div class="ol-shell">
        <label class="ol-label" for="ol-title">Question</label>
        <input id="ol-title" class="ol-title" value="${esc(title)}" placeholder="What are you trying to figure out? (optional, add it later)">
        ${unplaced.length ? `<div class="ol-inbox"><span>${unplaced.length} thought${unplaced.length === 1 ? '' : 's'} jotted from the side panel</span><button data-add-jots>Add to outline</button></div>` : ''}
        <div class="ol-tree-wrap"><ul class="ol-tree" aria-label="Outline">${rows.map(row).join('')}</ul><svg class="ol-arrows" aria-hidden="true"></svg></div>
        ${rows.length ? '' : '<p class="ol-empty">Nothing here yet. Write whatever you already know or suspect, one thought per line, or paste your notes. Sort it out afterwards.</p>'}
        <div class="ol-drop-root" data-drop-root>Drop here to make it a separate thought</div>
        <form class="ol-jot" id="ol-jot-form"><input id="ol-jot" placeholder="Jot a thought and press Enter, or paste your notes" autocomplete="off" aria-label="Jot a thought"><button class="dark">Add</button></form>
        <p class="ol-keys">Start a line with <kbd>because</kbd> <kbd>and</kbd> <kbd>but</kbd> <kbd>so</kbd> <kbd>answer</kbd> or <kbd>~</kbd> (an objection) to connect it to the line above · <kbd>Tab</kbd> a reason for the line above · <kbd>⇧ Tab</kbd> step out · <kbd>Alt ↑↓</kbd> reorder · <kbd>?</kbd> question <kbd>&gt;</kbd> quote <kbd>!</kbd> conclusion <kbd>-</kbd> fact about you</p>
        ${rows.length > 1 ? '<div class="ol-actions"><button data-order-from-outline title="Walk through the argument in the order the outline reads">Use this order for the walkthrough</button><button data-tidy>Re-arrange the board from this outline</button></div>' : ''}
      </div>`;
    restoreFocus();
    drawArrows();
  }

  // "Also" connections drawn in the left margin, from the "↳ also" line to
  // the line it points at.
  function drawArrows() {
    const wrap = view.querySelector('.ol-tree-wrap'), svg = wrap?.querySelector('.ol-arrows');
    if (!svg) return;
    const box = wrap.getBoundingClientRect();
    // The line of reasoning: from each line's chip to the chip of the line
    // that follows from it, straight down for a chain, bending into details.
    const chip = id => wrap.querySelector(`.ol-item[data-id="${CSS.escape(id)}"] > .ol-row .ol-type`)?.getBoundingClientRect();
    const spine = [...wrap.querySelectorAll('.ol-item[data-from]:not([data-from=""])')].map(li => {
      const a = chip(li.dataset.from), c = chip(li.dataset.id);
      if (!a || !c) return '';
      // One spine per level, near the label's left edge, so a turn into an
      // indented line has room; small gaps at both ends.
      const x1 = a.left - box.left + 11, y1 = a.bottom - box.top + 3, cy = c.top - box.top + c.height / 2;
      const d = Math.abs(c.left - a.left) < 4 ? `M${x1},${y1} V${c.top - box.top - 4}` : `M${x1},${y1} V${cy - 4} Q${x1},${cy} ${x1 + 4},${cy} H${c.left - box.left - 5}`;
      return `<path class="ol-spine k-${esc(li.dataset.joinedBy)}" d="${d}" marker-end="url(#ol-head)"/>`;
    }).join('');
    // "Also" links: out into the left margin, down, and into the target
    // row's type label. Links that overlap vertically get separate lanes,
    // shorter ones closest to the text, so they run side by side instead of
    // crossing.
    const segs = [...wrap.querySelectorAll('.ol-also')].map(ref => {
      const target = wrap.querySelector(`.ol-item[data-id="${CSS.escape(ref.dataset.goto)}"] > .ol-row .ol-type`);
      if (!target) return null;
      const ra = ref.getBoundingClientRect(), rt = target.getBoundingClientRect();
      return { ref, x1: ra.left - box.left - 3, y1: ra.top - box.top + ra.height / 2, x2: rt.left - box.left - 3, y2: rt.top - box.top + rt.height / 2 };
    }).filter(Boolean).sort((a, c) => Math.abs(a.y2 - a.y1) - Math.abs(c.y2 - c.y1));
    const lanes = [];
    for (const g of segs) {
      const lo = Math.min(g.y1, g.y2) - 6, hi = Math.max(g.y1, g.y2) + 6;
      let k = 0;
      while ((lanes[k] || []).some(([a, c]) => lo < c && hi > a)) k++;
      (lanes[k] = lanes[k] || []).push([lo, hi]);
      g.lane = k;
    }
    const r = 5;
    const paths = segs.map(g => {
      const lx = -10 - g.lane * 9, down = g.y2 > g.y1 ? 1 : -1;
      const d = `M${g.x1},${g.y1} H${lx + r} Q${lx},${g.y1} ${lx},${g.y1 + down * r} V${g.y2 - down * r} Q${lx},${g.y2} ${lx + r},${g.y2} H${g.x2}`;
      const word = api.board.links.find(l => l.id === g.ref.dataset.link)?.word || '';
      return `<path class="ol-also-line k-${esc(word)}" data-arrow="${esc(g.ref.dataset.link)}" d="${d}" marker-end="url(#ol-head)"/>`;
    }).join('');
    svg.innerHTML = `<defs><marker id="ol-head" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5.5" markerHeight="5.5" orient="auto"><path class="ol-head" d="M1.5 1.5 L8.5 5 L1.5 8.5" fill="none" stroke="context-stroke" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></marker></defs>${spine}${paths}`;
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

  // ---------- Paste: indented notes keep their structure ----------

  // Bulleted or indented lines; a leading because/and/but/so/ergo/answer
  // connects a line, a trailing "?" makes a question.
  function parseNotes(text) {
    const lines = text.replace(/\r/g, '').split('\n').filter(l => l.trim());
    if (lines.length < 2) return null;
    const unit = Math.min(...lines.map(l => (l.match(/^[ \t]*/)[0].replace(/\t/g, '    ').length)).filter(n => n > 0), 4) || 4;
    return lines.map(l => {
      const lead = l.match(/^[ \t]*/)[0].replace(/\t/g, '    ').length;
      let body = l.trim().replace(/^([*\-•–·]|\d+[.)])\s+/, '');
      const w = readWord(body + ' ');
      if (w) body = w.rest.trim();
      body = capitalise(body);
      return { depth: Math.round(lead / unit), word: w?.word || null, text: body, type: /\?\s*$/.test(body) ? 'gap' : 'note' };
    });
  }

  function importNotes(items) {
    change(t => {
      const b = api.board, stack = [];
      let ord = Math.max(0, ...t.kids(null).map(r => r.ord + 1));
      const lastAt = new Map(); // depth -> last line at that depth under the current parent
      for (const it of items) {
        if (b.nodes.length >= 500) break;
        const n = newCard(it.type, it.text);
        b.nodes.push(n);
        while (stack.length > it.depth) stack.pop();
        const parent = stack[it.depth - 1] || null, prev = lastAt.get(it.depth);
        const prevHere = prev && prev.parent === parent ? prev.node : null;
        if (it.word && CONTINUES.has(it.word) && prevHere) connect(n.id, prevHere.id, it.word, t);
        else if (parent) connect(n.id, parent.id, it.word || 'because', t);
        else if (it.word && prevHere) connect(n.id, prevHere.id, it.word, t);
        n.ord = ord++;
        stack[it.depth] = n; stack.length = it.depth + 1;
        lastAt.set(it.depth, { node: n, parent });
        for (const d of [...lastAt.keys()]) if (d > it.depth) lastAt.delete(d);
      }
    }, null, { reorder: true });
    api.notify(`Imported ${items.length} lines. Change any word by clicking it.`);
  }

  view.addEventListener('paste', e => {
    const text = e.clipboardData?.getData('text/plain') || '';
    const items = parseNotes(text);
    if (!items) return;
    e.preventDefault();
    importNotes(items);
  });

  // ---------- "Also" picker: connect a line to one more line ----------
  // Opened from a row's "+ also" button or by typing "@" in the line.

  let picker = null; // { id, el, active }
  function openPicker(id) {
    closePicker();
    const n = api.get(id), row = view.querySelector(`[data-row="${CSS.escape(id)}"]`);
    if (!n || !row) return;
    const el = document.createElement('div');
    el.className = 'ol-picker';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', 'Also connect this line to another line');
    el.innerHTML = `<p class="ol-picker-head">“${esc(clip(textOf(n), 60))}”
        <select data-picker-word aria-label="Word">${api.WORD_CHOICES.map(([v, l]) => `<option value="${v}" ${v === 'so' ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select> …</p>
      <input type="search" data-picker-search placeholder="Find the line it also leads to" autocomplete="off" aria-label="Find a line">
      <ul class="ol-picker-list" role="listbox"></ul>`;
    document.body.append(el);
    const r = row.getBoundingClientRect();
    el.style.left = Math.max(8, Math.min(r.left + 40, innerWidth - 440)) + 'px';
    el.style.top = Math.min(r.bottom + 4, innerHeight - 320) + 'px';
    picker = { id, el, active: 0 };
    const search = el.querySelector('[data-picker-search]');
    search.addEventListener('input', () => { picker.active = 0; drawPicker(); });
    search.addEventListener('keydown', e => {
      const items = el.querySelectorAll('[data-pick]');
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); picker.active = (picker.active + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % Math.max(1, items.length); drawPicker(); }
      else if (e.key === 'Enter') { e.preventDefault(); items[picker.active]?.click(); }
      else if (e.key === 'Escape') { e.preventDefault(); closePicker(true); }
    });
    el.addEventListener('click', e => { const b = e.target.closest('[data-pick]'); if (b) pickAlso(b.dataset.pick); });
    drawPicker();
    search.focus();
  }
  function drawPicker() {
    if (!picker) return;
    const { el, id } = picker, q = el.querySelector('[data-picker-search]').value.trim().toLowerCase();
    const linked = new Set(api.board.links.filter(l => l.from === id).map(l => l.to));
    const matches = displayRows(tree()).map(r => r.n).filter(n => n.id !== id && !linked.has(n.id) && (!q || textOf(n).toLowerCase().includes(q))).slice(0, 8);
    picker.active = Math.min(picker.active, Math.max(0, matches.length - 1));
    el.querySelector('.ol-picker-list').innerHTML = matches.map((n, i) => `<li><button type="button" data-pick="${esc(n.id)}" role="option" aria-selected="${i === picker.active}" class="${i === picker.active ? 'is-active' : ''}"><span class="ol-picker-type">${esc(TYPES.find(t => t[0] === n.type)?.[1] || '')}</span> ${esc(clip(textOf(n), 80))}</button></li>`).join('') || '<li class="ol-picker-empty">No other line matches.</li>';
  }
  function closePicker(refocus) {
    if (!picker) return;
    const id = picker.id;
    picker.el.remove(); picker = null;
    if (refocus) { focus = { id, offset: Infinity }; restoreFocus(); }
  }
  function pickAlso(toId) {
    const { id, el } = picker, word = el.querySelector('[data-picker-word]').value;
    closePicker();
    change(() => {
      const from = api.get(id), to = api.get(toId);
      if (api.board.links.some(l => l.from === id && l.to === toId)) return false;
      api.board.links.push({ id: api.uid(), from: id, to: toId, word: api.fitWord(from.type, to.type, word), label: '' });
    }, { id, offset: Infinity });
  }
  document.addEventListener('mousedown', e => { if (picker && !picker.el.contains(e.target) && !e.target.closest('[data-also]')) closePicker(); });

  // ---------- Events ----------

  view.addEventListener('input', e => {
    const el = e.target.closest('[data-text]');
    if (!el) return;
    const id = el.dataset.text, n = api.get(id);
    if (e.inputType === 'insertText' && e.data === '@') {
      const at = caretOffset(), text = el.textContent, cut = text.slice(0, at - 1) + text.slice(at);
      el.textContent = cut; setCaret(el, at - 1);
      pending = { id, value: cut }; flushText();
      return openPicker(id);
    }
    const value = el.textContent;
    requestAnimationFrame(drawArrows);
    const w = readWord(value);
    if (w) {
      const t = tree(), above = t.parentOf.get(id) ? api.get(t.parentOf.get(id)) : lineAbove(id, t);
      if (above) {
        pending = { id, value: capitalise(w.rest) };
        return change(t2 => { if (t2.parentOf.get(id) === above.id) setWord(id, w.word, t2); else connect(id, above.id, w.word, t2); }, { id, offset: 0 });
      }
    }
    const prefix = readPrefix(value);
    if (prefix && n.type === 'note') {
      pending = { id, value: prefix.rest };
      return change(() => { applyType(n, prefix.type); }, { id, offset: 0 });
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
    const typeSel = e.target.closest('[data-type]'), wordSel = e.target.closest('[data-word]');
    if (typeSel) {
      const id = typeSel.dataset.type;
      change(() => { applyType(api.get(id), typeSel.value); }, { id, offset: Infinity });
    } else if (wordSel) {
      const id = wordSel.dataset.word;
      change(t => { setWord(id, wordSel.value, t); }, null);
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
    const w = readWord(raw + ' ');
    const body = w ? capitalise(w.rest.trim()) : raw;
    const prefix = readPrefix(body + ' ');
    const type = prefix ? prefix.type : /\?\s*$/.test(body) ? 'gap' : 'note';
    const text = prefix ? prefix.rest.trim() : body;
    const rows = displayRows(tree()), lastTop = [...rows].reverse().find(r => r.indent === 0)?.n;
    if (w && lastTop) {
      change(t => {
        const n = newCard(type, text);
        api.board.nodes.push(n);
        n.ord = Math.max(0, ...t.kids(lastTop.id).map(k => k.ord + 1));
        connect(n.id, lastTop.id, w.word, t);
      }, { id: 'jot' });
    } else addLine(null, text, type);
    focus = { id: 'jot' };
    renderOutline();
  });

  view.addEventListener('click', e => {
    const open = e.target.closest('[data-open]'), go = e.target.closest('[data-goto]'), also = e.target.closest('[data-also]');
    if (also) { flushText(); picker?.id === also.dataset.also ? closePicker() : openPicker(also.dataset.also); }
    else if (open) { flushText(); const n = api.get(open.dataset.open); api.openCard(n.type, n.id); }
    else if (go) { focus = { id: go.dataset.goto, offset: Infinity }; restoreFocus(); }
    else if (e.target.closest('[data-order-from-outline]')) orderFromOutline();
    else if (e.target.closest('[data-tidy]')) tidy();
    else if (e.target.closest('[data-add-jots]')) addJots();
  });

  // Drag a line by its grip onto another line to make it a reason for it.
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

  // The walkthrough reads the argument in the outline's order.
  function orderFromOutline() {
    change(() => {}, null, { reorder: true });
    api.notify('Walkthrough now follows the outline. Undo restores the previous order.');
  }

  function tidy() {
    change(() => { api.board.nodes.forEach(n => { n.auto = true; }); }, null);
    api.notify('Cards re-arranged from the outline. Undo restores your layout.');
  }

  async function refreshInbox() {
    try { inboxThoughts = (await api.workspace.inbox(api.session.journey.id)).filter(c => c.kind === 'note' && !c.archived); } catch { inboxThoughts = []; }
    if (api.tab === 'outline') renderOutline();
  }

  function addJots() {
    const placed = new Set(api.board.nodes.map(n => n.sourceCaptureId).filter(Boolean));
    const fresh = inboxThoughts.filter(c => !placed.has(c.id)).sort((a, c) => a.capturedAt - c.capturedAt);
    change(t => {
      let ord = Math.max(0, ...t.kids(null).map(n => n.ord + 1));
      for (const c of fresh) {
        const n = api.workspace.noteCard(c, { x: 30, y: 100 });
        Object.assign(n, { auto: true, ord: ord++ });
        api.board.nodes.push(n);
      }
    }, null);
  }

  document.addEventListener('click', e => { if (e.target.closest('[data-open-outline]')) { focus = { id: 'jot' }; api.setTab('outline'); } });
  globalThis.chrome?.runtime?.onMessage?.addListener(msg => { if (msg.type === 'trail-updated' && msg.journeyId === api.session.journey.id) refreshInbox(); });
  refreshInbox();
  if (needsLayout && api.tab === 'map') api.render();
  if (api.tab === 'outline') { focus = focus || { id: 'jot' }; renderOutline(); }
}
