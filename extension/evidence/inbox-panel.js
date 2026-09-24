// Evidence inbox as a side panel. Captured passages and jotted thoughts are
// dragged straight onto the board or the outline:
//  - onto empty board space: placed there;
//  - onto a card or an outline line: placed beside it and connected to it
//    (a passage already on the board just gains the connection);
//  - "Add" places it without dragging (keyboard, touch).

const TYPE = 'application/x-evidence-capture';

export function init(api) {
  const panel = document.getElementById('inbox-panel');
  if (!panel) return;
  const esc = api.esc;
  let captures = [], filter = '', showPlaced = false, loading = false;

  const domain = u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
  const clip = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
  const onBoard = c => api.board.nodes.find(n => n.sourceCaptureId === c.id);

  async function refresh() {
    if (loading) return;
    loading = true;
    try { captures = await api.workspace.inbox(api.session.journey.id); } catch { captures = []; }
    loading = false;
    draw();
  }

  function draw() {
    if (panel.hidden) return;
    const q = filter.toLowerCase();
    const list = captures.filter(c => (showPlaced || !onBoard(c)) && (!q || `${c.title} ${c.quote} ${c.url}`.toLowerCase().includes(q)));
    const placed = captures.filter(onBoard).length;
    panel.innerHTML = `
      <div class="detail-heading"><p class="panel-label" role="heading" aria-level="2">Evidence inbox</p><button data-inbox-close aria-label="Close the inbox">✕</button></div>
      <p class="ui-hint">Drag onto a card or an outline line to back it up, or onto empty space to place it.</p>
      <input type="search" id="inbox-filter" placeholder="Filter" value="${esc(filter)}" aria-label="Filter the inbox">
      ${placed ? `<label class="inbox-toggle"><input type="checkbox" id="inbox-show-placed" ${showPlaced ? 'checked' : ''}> Show ${placed} already on this board</label>` : ''}
      <ul class="inbox-list">${list.map(c => {
        const note = c.kind === 'note', used = !!onBoard(c);
        const kind = note ? 'Jotted thought' : c.view === 'translated' ? 'From a translated page' : c.view === 'legacy-unverified' ? 'Wording not verified' : '';
        return `<li class="inbox-card ${used ? 'is-used' : ''}" draggable="true" data-capture="${esc(c.id)}">
          <p class="inbox-meta">${esc([domain(c.url), kind, used ? 'on board' : ''].filter(Boolean).join(' · '))}</p>
          ${note ? `<p class="inbox-thought">${esc(clip(c.title, 220))}</p>` : `<p class="inbox-title">${esc(clip(c.title, 90))}</p>${c.quote ? `<blockquote>${esc(clip(c.quote, 220))}</blockquote>` : ''}`}
          ${c.image ? '<p class="inbox-meta">Screenshot included</p>' : ''}
          <button data-place="${esc(c.id)}">${used ? 'Select on board' : 'Add'}</button>
        </li>`;
      }).join('') || `<li class="empty">${captures.length ? 'Nothing matches.' : 'Nothing captured yet. On any page, select text → right-click → Add passage to evidence board.'}</li>`}</ul>`;
    const input = panel.querySelector('#inbox-filter');
    input.oninput = () => { filter = input.value; draw(); const again = panel.querySelector('#inbox-filter'); again.focus(); again.setSelectionRange(filter.length, filter.length); };
  }

  // Put a capture on the board (or reuse its card) and optionally connect it.
  function place(id, { at, attachTo, fromOutline } = {}) {
    const capture = captures.find(c => c.id === id);
    if (!capture) return;
    const b = api.board;
    let card = onBoard(capture), added = false;
    if (!card) {
      if (b.nodes.length >= 500) { api.notify('This board has reached the 500-card limit.'); return; }
      const target = attachTo && api.get(attachTo);
      const spot = at || (target ? besideCard(target) : api.freePosition());
      card = capture.kind === 'note' ? api.workspace.noteCard(capture, spot) : api.workspace.evidenceCard(capture, spot);
      card.ord = Date.now();
      // Dropped onto a card (not a chosen spot): join that card's automatic layout.
      if (fromOutline || (!at && target?.auto)) { card.auto = true; api.requestLayout?.(); }
      b.nodes.push(card);
      added = true;
    }
    let linked = false;
    if (attachTo && attachTo !== card.id && !b.links.some(l => l.from === card.id && l.to === attachTo)) {
      b.links.push({ id: api.uid(), from: card.id, to: attachTo, kind: api.allowedKinds(card.type)[0], label: '' });
      linked = true;
    }
    if (!added && !linked) { api.select(card.id, true); return; }
    api.persist();
    api.select(card.id, api.tab === 'map' && !at);
    api.notify(added ? (linked ? 'Added and connected. Undo to remove.' : 'Added to the board. Undo to remove.') : 'Connected the passage already on the board.');
  }

  // Left of the card it backs (reasons sit left of what they support), then
  // down until it clears other cards.
  function besideCard(target) {
    const el = document.querySelector(`#canvas [data-node="${CSS.escape(target.id)}"]`);
    // Reasons sit on the side the board reads from: right of the point when
    // it reads answer first, left of it when it builds up.
    const right = target.x + (el?.offsetWidth || 300) + 40;
    let x = api.board.framing === 'build' ? target.x - 340 : right, y = target.y;
    if (x < 0) x = right;
    const clash = yy => api.board.nodes.some(n => {
      const e = document.querySelector(`#canvas [data-node="${CSS.escape(n.id)}"]`), w = e?.offsetWidth || 300, h = e?.offsetHeight || 220;
      return x < n.x + w + 20 && x + 300 > n.x && yy < n.y + h + 20 && yy + 220 > n.y;
    });
    for (let i = 0; i < 200 && clash(y); i++) y += 30;
    return { x: Math.round(x), y: Math.round(y) };
  }

  panel.addEventListener('click', e => {
    if (e.target.closest('[data-inbox-close]')) return api.setInbox(false);
    const btn = e.target.closest('[data-place]');
    if (btn) place(btn.dataset.place, { fromOutline: api.tab === 'outline' });
  });
  panel.addEventListener('change', e => { if (e.target.id === 'inbox-show-placed') { showPlaced = e.target.checked; draw(); } });
  panel.addEventListener('dragstart', e => {
    const item = e.target.closest('[data-capture]');
    if (!item) return;
    e.dataTransfer.setData(TYPE, item.dataset.capture);
    e.dataTransfer.setData('text/plain', captures.find(c => c.id === item.dataset.capture)?.quote || '');
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
    draw();
  });
  globalThis.chrome?.runtime?.onMessage?.addListener(msg => { if (msg.type === 'trail-updated' && msg.journeyId === api.session.journey.id) refresh(); });
  if (api.inboxOpen) refresh();
}
