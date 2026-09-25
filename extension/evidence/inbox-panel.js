// Evidence inbox side panel. Two sources:
//  - Captured: passages, screenshots and jotted thoughts saved while browsing
//    (archive what you don't need; archived items can be restored or deleted);
//  - From your trail: pages you already visited in this workspace. Drag one
//    onto the board as a source, or open its saved text and pick a passage
//    without going back to the page.
// Drop onto a card or an outline line to back it up, or onto empty board
// space to place it. "Add" does the same without dragging.

const TYPE = 'application/x-evidence-capture';

export function init(api) {
  const panel = document.getElementById('inbox-panel');
  if (!panel) return;
  const esc = api.esc;
  let captures = [], pages = [], loading = false;
  let view = 'captured', filter = '', trailFilter = '', showPlaced = false, showArchived = false, reading = null;

  const domain = u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
  const clip = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
  const onBoard = c => api.board.nodes.find(n => n.sourceCaptureId === c.id);
  const visited = p => api.workspace.lastVisit(p);

  async function refresh() {
    if (loading) return;
    loading = true;
    try {
      [captures, pages] = await Promise.all([api.workspace.inbox(api.session.journey.id), api.workspace.trailPages(api.session.journey.id)]);
      pages.sort((a, b) => visited(b) - visited(a));
    } catch { captures = []; pages = []; }
    loading = false;
    draw();
  }

  // A trail page as something that can be placed: a source card with its
  // link, to which you add the exact words later.
  const pageSource = p => ({ id: 'page:' + p.id, kind: 'page', pageId: p.id, title: p.title || p.url, url: p.url, quote: '', capturedAt: visited(p), view: 'original',
    note: 'From your browsing trail. Add the exact words when you have them.' });
  const findItem = id => captures.find(c => c.id === id) || (id.startsWith('page:') ? (p => p && pageSource(p))(pages.find(p => p.id === id.slice(5))) : null);

  function itemHTML(c) {
    const note = c.kind === 'note', used = !!onBoard(c);
    const kind = note ? 'Jotted thought' : c.view === 'translated' ? 'From a translated page' : c.view === 'legacy-unverified' ? 'Wording not verified' : c.view === 'saved-text' ? 'From saved page text' : c.translation ? 'Original German · English kept' : '';
    return `<li class="inbox-card ${used ? 'is-used' : ''} ${c.archived ? 'is-archived' : ''}" draggable="${!c.archived}" data-capture="${esc(c.id)}">
      <p class="inbox-meta">${esc([domain(c.url), kind, used ? 'on board' : '', c.archived ? 'archived' : ''].filter(Boolean).join(' · '))}</p>
      ${note ? `<p class="inbox-thought">${esc(clip(c.title, 220))}</p>` : `<p class="inbox-title">${esc(clip(c.title, 90))}</p>${c.quote ? `<blockquote>${esc(clip(c.quote, 220))}</blockquote>` : ''}`}
      ${c.image ? '<p class="inbox-meta">Screenshot included</p>' : ''}
      <div class="inbox-actions">${c.archived
        ? `<button data-restore="${esc(c.id)}">Restore</button><button class="danger" data-delete-capture="${esc(c.id)}">Delete</button>`
        : `<button data-place="${esc(c.id)}">${used ? 'Select on board' : 'Add'}</button><button class="inbox-quiet" data-archive="${esc(c.id)}" title="Hide from the inbox. Anything already on a board stays.">Archive</button>`}</div>
    </li>`;
  }

  function draw() {
    if (panel.hidden) return;
    const keep = document.activeElement?.id;
    const tabs = `<div class="inbox-tabs" role="tablist"><button role="tab" data-view="captured" aria-selected="${view === 'captured'}">Captured</button><button role="tab" data-view="trail" aria-selected="${view === 'trail'}">From your trail</button></div>`;
    const head = `<div class="detail-heading"><p class="panel-label" role="heading" aria-level="2">Evidence inbox</p><button data-inbox-close aria-label="Close the inbox">✕</button></div>${tabs}`;
    panel.innerHTML = head + (view === 'captured' ? capturedHTML() : reading ? readerHTML() : trailHTML());
    if (keep) { const el = panel.querySelector('#' + keep); if (el) { el.focus(); if (el.setSelectionRange) el.setSelectionRange(el.value.length, el.value.length); } }
  }

  function capturedHTML() {
    const q = filter.toLowerCase();
    const live = captures.filter(c => !c.archived), archived = captures.filter(c => c.archived);
    const list = (showArchived ? archived : live).filter(c => (showArchived || showPlaced || !onBoard(c)) && (!q || `${c.title} ${c.quote} ${c.url}`.toLowerCase().includes(q)));
    const placed = live.filter(onBoard).length;
    return `<p class="ui-hint">Drag onto a card or an outline line to back it up, or onto empty space to place it.</p>
      <input type="search" id="inbox-filter" placeholder="Filter" value="${esc(filter)}" aria-label="Filter the inbox">
      <div class="inbox-toggles">${placed && !showArchived ? `<label class="inbox-toggle"><input type="checkbox" id="inbox-show-placed" ${showPlaced ? 'checked' : ''}> Show ${placed} already on this board</label>` : ''}
        ${archived.length || showArchived ? `<button class="inbox-quiet" data-toggle-archived>${showArchived ? '← Back to the inbox' : `Archived (${archived.length})`}</button>` : ''}</div>
      <ul class="inbox-list">${list.map(itemHTML).join('') || `<li class="empty">${showArchived ? 'Nothing archived.' : captures.length ? 'Nothing matches.' : 'Nothing captured yet. On any page, select text → right-click → Save passage as evidence. Or look in “From your trail”.'}</li>`}</ul>`;
  }

  function trailHTML() {
    const q = trailFilter.trim().toLowerCase();
    const snippet = p => {
      const text = p.text || '';
      if (q) { const i = text.toLowerCase().indexOf(q); if (i >= 0) return `…${esc(text.slice(Math.max(0, i - 70), i))}<mark>${esc(text.slice(i, i + q.length))}</mark>${esc(text.slice(i + q.length, i + q.length + 90))}…`; }
      return esc(clip(p.excerpt || text, 160));
    };
    const list = pages.filter(p => !q || `${p.title} ${p.url} ${p.text || ''}`.toLowerCase().includes(q)).slice(0, 60);
    return `<p class="ui-hint">Pages you visited in this workspace. Drag one onto the board as a source, or open its saved text to pick the exact passage.</p>
      <input type="search" id="trail-filter" placeholder="Search titles, addresses and page text" value="${esc(trailFilter)}" aria-label="Search your trail">
      <ul class="inbox-list">${list.map(p => {
        const used = !!onBoard({ id: 'page:' + p.id });
        return `<li class="inbox-card ${used ? 'is-used' : ''}" draggable="true" data-capture="page:${esc(p.id)}">
          <p class="inbox-meta">${esc([domain(p.url), visited(p) ? new Date(visited(p)).toLocaleDateString() : '', used ? 'on board' : ''].filter(Boolean).join(' · '))}</p>
          <p class="inbox-page-title">${esc(clip(p.title || p.url, 100))}</p>
          ${p.text || p.excerpt ? `<p class="inbox-snippet">${snippet(p)}</p>` : ''}
          <div class="inbox-actions"><button data-place="page:${esc(p.id)}">${used ? 'Select on board' : 'Add as source'}</button>${p.text ? `<button data-read="${esc(p.id)}">Pick a passage</button>` : ''}</div>
        </li>`;
      }).join('') || `<li class="empty">${pages.length ? 'No page matches.' : 'No pages in this workspace’s trail yet.'}</li>`}</ul>`;
  }

  // The saved text, broken into readable paragraphs at sentence ends.
  function paragraphs(text) {
    const out = []; let cur = '';
    for (const s of text.split(/(?<=[.!?])\s+/)) { cur += (cur ? ' ' : '') + s; if (cur.length > 500) { out.push(cur); cur = ''; } }
    if (cur) out.push(cur);
    return out;
  }
  function readerHTML() {
    const p = pages.find(x => x.id === reading);
    if (!p) { reading = null; return trailHTML(); }
    const saved = captures.filter(c => c.pageId === p.id && !c.archived && c.quote);
    return `<button class="inbox-quiet" data-back>← All pages</button>
      <p class="inbox-page-title">${esc(p.title || p.url)}</p>
      <p class="inbox-meta">${esc(domain(p.url))}${visited(p) ? ' · text saved ' + esc(new Date(visited(p)).toLocaleDateString()) : ''} · <a href="${esc(p.url)}" target="_blank" rel="noopener noreferrer">open page ↗</a></p>
      <p class="ui-hint">Select the exact words, then save them. The live page may have changed since you visited.</p>
      <div class="reader-text" id="reader-text" tabindex="0">${paragraphs(p.text || '').map(t => `<p>${esc(t)}</p>`).join('')}</div>
      <div class="reader-bar"><button class="dark" data-save-selection disabled>Save selected passage</button></div>
      ${saved.length ? `<p class="panel-label">Saved from this page</p><ul class="inbox-list">${saved.map(itemHTML).join('')}</ul>` : ''}`;
  }

  // Keep "Save selected passage" in step with the selection in the reader.
  document.addEventListener('selectionchange', () => {
    const btn = panel.querySelector('[data-save-selection]'), box = panel.querySelector('#reader-text');
    if (!btn || !box) return;
    const sel = getSelection();
    btn.disabled = !(sel.rangeCount && !sel.isCollapsed && box.contains(sel.anchorNode) && box.contains(sel.focusNode) && sel.toString().trim());
  });

  async function saveSelection() {
    const p = pages.find(x => x.id === reading), quote = getSelection().toString().replace(/\s+/g, ' ').trim();
    if (!p || !quote) return;
    const text = (p.text || '').replace(/\s+/g, ' '), i = text.indexOf(quote);
    await api.workspace.savePickedPassage(api.session.journey.id, p, quote, i >= 0 ? text.slice(Math.max(0, i - 100), i) : '', i >= 0 ? text.slice(i + quote.length, i + quote.length + 100) : '');
    getSelection().removeAllRanges();
    api.notify('Saved. Drag it onto the board from “Saved from this page”.');
    await refresh();
  }

  async function archive(id, value) {
    await api.workspace.setArchived(id, value);
    api.notify(value ? 'Archived. Find it under “Archived” to restore or delete it.' : 'Restored to the inbox.');
    await refresh();
    if (showArchived && !captures.some(c => c.archived)) { showArchived = false; draw(); }
  }

  async function remove(id) {
    const c = captures.find(x => x.id === id);
    if (!confirm(`Delete this from the inbox for good?${c?.quote ? `\n\n“${clip(c.quote, 120)}”` : ''}\n\nCards already on a board keep their copy.`)) return;
    await api.workspace.deleteFromInbox(id);
    await refresh();
    if (showArchived && !captures.some(c => c.archived)) { showArchived = false; draw(); }
  }

  // Put an item on the board (or reuse its card) and optionally connect it.
  function place(id, { at, attachTo, fromOutline, word = 'because' } = {}) {
    const capture = findItem(id);
    if (!capture) return;
    const b = api.board;
    let card = onBoard(capture), added = false;
    if (!card) {
      if (b.nodes.length >= 500) { api.notify('This board has reached the 500-card limit.'); return; }
      const target = attachTo && api.get(attachTo);
      const spot = at || (target ? besideCard(target) : api.freePosition());
      card = capture.kind === 'note' ? api.workspace.noteCard(capture, spot) : api.workspace.evidenceCard(capture, spot);
      if (capture.kind === 'page') card.note = capture.note;
      card.ord = Date.now();
      // Dropped onto a card (not a chosen spot): join that card's automatic layout.
      if (fromOutline || (!at && target?.auto)) { card.auto = true; api.requestLayout?.(); }
      b.nodes.push(card);
      added = true;
    }
    let linked = false;
    if (attachTo && attachTo !== card.id && !b.links.some(l => (l.from === attachTo && l.to === card.id) || (l.from === card.id && l.to === attachTo))) {
      // Reads "[target] because [this]" ("as the source says" for a quote).
      b.links.push({ id: api.uid(), from: attachTo, to: card.id, word: api.fitWord(api.get(attachTo).type, card.type, word), label: '' });
      linked = true;
      // Show what you just attached, even while evidence is folded away.
      api.showEvidenceFor?.(attachTo);
    }
    if (!added && !linked) { api.select(card.id, true); return; }
    api.persist();
    api.select(card.id, api.tab === 'map' && !at);
    api.notify(added ? (linked ? 'Added and connected. Undo to remove.' : 'Added to the board. Undo to remove.') : 'Connected the card already on the board.');
  }

  // Details sit to the right of the line they are about, as in the outline;
  // then down until it clears other cards.
  function besideCard(target) {
    const el = document.querySelector(`#canvas [data-node="${CSS.escape(target.id)}"]`);
    let x = target.x + (el?.offsetWidth || 300) + 40, y = target.y;
    const clash = yy => api.board.nodes.some(n => {
      const e = document.querySelector(`#canvas [data-node="${CSS.escape(n.id)}"]`), w = e?.offsetWidth || 300, h = e?.offsetHeight || 220;
      return x < n.x + w + 20 && x + 300 > n.x && yy < n.y + h + 20 && yy + 220 > n.y;
    });
    for (let i = 0; i < 200 && clash(y); i++) y += 30;
    return { x: Math.round(x), y: Math.round(y) };
  }

  panel.addEventListener('click', e => {
    const t = e.target;
    if (t.closest('[data-inbox-close]')) return api.setInbox(false);
    const v = t.closest('[data-view]'); if (v) { view = v.dataset.view; reading = null; return draw(); }
    if (t.closest('[data-toggle-archived]')) { showArchived = !showArchived; return draw(); }
    if (t.closest('[data-back]')) { reading = null; return draw(); }
    const read = t.closest('[data-read]'); if (read) { reading = read.dataset.read; draw(); panel.scrollTop = 0; return; }
    if (t.closest('[data-save-selection]')) return saveSelection();
    const a = t.closest('[data-archive]'); if (a) return archive(a.dataset.archive, true);
    const r = t.closest('[data-restore]'); if (r) return archive(r.dataset.restore, false);
    const d = t.closest('[data-delete-capture]'); if (d) return remove(d.dataset.deleteCapture);
    const btn = t.closest('[data-place]');
    if (btn) place(btn.dataset.place, { fromOutline: api.tab === 'outline' });
  });
  panel.addEventListener('input', e => {
    if (e.target.id === 'inbox-filter') { filter = e.target.value; draw(); }
    if (e.target.id === 'trail-filter') { trailFilter = e.target.value; draw(); }
  });
  panel.addEventListener('change', e => { if (e.target.id === 'inbox-show-placed') { showPlaced = e.target.checked; draw(); } });
  panel.addEventListener('dragstart', e => {
    const item = e.target.closest('[data-capture]');
    if (!item) return;
    e.dataTransfer.setData(TYPE, item.dataset.capture);
    e.dataTransfer.setData('text/plain', findItem(item.dataset.capture)?.quote || '');
    e.dataTransfer.effectAllowed = 'copy';
    document.body.classList.add('is-dropping-evidence');
  });
  // The panel redraws during a drop, so its own dragend can go missing:
  // clear the drop highlighting on any drop or drag end on the page.
  const clearDrop = () => {
    document.body.classList.remove('is-dropping-evidence');
    document.querySelectorAll('.drop-target,.connect-target').forEach(el => el.classList.remove('drop-target', 'connect-target'));
  };
  document.addEventListener('dragend', clearDrop, true);
  document.addEventListener('drop', () => setTimeout(clearDrop), true);

  // Drop targets: the spatial board and the outline.
  const carrying = e => e.dataTransfer?.types?.includes(TYPE);
  const mark = el => {
    document.querySelectorAll('.drop-target,.connect-target').forEach(o => o !== el && o.classList.remove('drop-target', 'connect-target'));
    el?.classList.add(el.matches('[data-node]') ? 'connect-target' : 'drop-target');
  };
  const viewport = document.getElementById('viewport');
  viewport.addEventListener('dragover', e => {
    if (!carrying(e)) return;
    e.preventDefault(); e.dataTransfer.dropEffect = 'copy';
    mark(e.target.closest('#canvas [data-node]'));
  });
  viewport.addEventListener('drop', e => {
    if (!carrying(e)) return;
    e.preventDefault();
    const card = e.target.closest('#canvas [data-node]');
    const p = api.canvasPoint(e.clientX, e.clientY);
    place(e.dataTransfer.getData(TYPE), card ? { attachTo: card.dataset.node } : { at: { x: Math.max(0, p.x - 40), y: Math.max(0, p.y - 20) } });
  });
  const outline = document.getElementById('outline-view');
  outline?.addEventListener('dragover', e => {
    if (!carrying(e)) return;
    e.preventDefault(); e.dataTransfer.dropEffect = 'copy';
    mark(e.target.closest('[data-row]'));
  });
  outline?.addEventListener('drop', e => {
    if (!carrying(e)) return;
    e.preventDefault();
    const row = e.target.closest('[data-row]');
    place(e.dataTransfer.getData(TYPE), { attachTo: row?.dataset.row, fromOutline: true });
  });

  let wasOpen = false;
  api.onRender(() => {
    if (!panel.hidden && !wasOpen) refresh();
    wasOpen = !panel.hidden;
    // Don't redraw under an open reader: it would drop the text selection.
    if (!reading) draw();
  });
  globalThis.chrome?.runtime?.onMessage?.addListener(msg => { if (msg.type === 'trail-updated' && msg.journeyId === api.session.journey.id) refresh(); });
  // "Attach…" from a page or the side panel: when this board is open, it
  // applies the change itself (keeps undo, no save conflict with this tab).
  globalThis.chrome?.runtime?.onMessage?.addListener((msg, _sender, reply) => {
    if (msg.type !== 'attach-capture' || msg.boardId !== api.session.record.id || !api.get(msg.lineId)) return;
    api.workspace.inbox(api.session.journey.id).then(list => { captures = list; place(msg.captureId, { attachTo: msg.lineId, word: msg.word, fromOutline: true }); reply({ ok: true }); draw(); }).catch(() => reply({ ok: false }));
    return true;
  });
  if (api.inboxOpen) refresh();
}
