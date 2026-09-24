// Optional local-AI drafting (Ollama tool calling). The model never edits the
// board: its tool calls only build a list of proposals that the author
// reviews, and accepted proposals are applied through the same path as manual
// edits (one undo step). It can place inbox passages word for word but has no
// tool that writes or edits a quotation.

import { chatTools, resolveModels } from '../lib/ollama.js';

const MAX_ROUNDS = 16, MAX_PROPOSALS = 40;

const SYSTEM = `You help a person organise an evidence board that answers one question.
Card types: fact (the person's own situation; only the person adds these), claim (what a rule or source says, in plain words), conclusion (the answer the argument reaches), gap (an open question the sources do not settle), evidence (an exact quotation from a source).
Rules:
- You cannot add facts or write evidence. Anything a source or rule says is a claim.
- Leave out inbox passages that do not bear on the question.
- You cannot write evidence. To use a passage, call place_evidence with its inbox ref (S1, S2...).
- Refer to cards only by ref: K1 for cards already on the board, S1 for inbox passages (the ref stays the same after placing), N1 for cards you proposed. add_card returns the new ref.
- When a claim rests on a passage, pass the passage's ref as supported_by. You may make several tool calls at once.
- Keep each card to one idea, under 25 words. Do not invent rules, numbers or dates that are not in the quoted evidence.
- Only connect evidence to a claim when the quoted words actually say it.
- Your calls are proposals the person will review. When finished, reply in 2-3 sentences summarising what you proposed and anything you were unsure about. Do not call tools in that final reply.`;

const TOOLS = [
  { type: 'function', function: { name: 'add_card', description: 'Propose a new card. Returns its ref.', parameters: { type: 'object', properties: {
    type: { type: 'string', enum: ['claim', 'gap', 'conclusion'] },
    text: { type: 'string', description: 'One idea, under 25 words' },
    note: { type: 'string', description: 'Optional caveat or reasoning' },
    supported_by: { type: 'string', description: 'Optional ref of the evidence passage (S1, K3, N1) that backs this card' } }, required: ['type', 'text'] } } },
  { type: 'function', function: { name: 'place_evidence', description: 'Put an inbox passage on the board, word for word. Returns its ref.', parameters: { type: 'object', properties: {
    source: { type: 'string', description: 'Inbox ref, e.g. S1' } }, required: ['source'] } } },
  { type: 'function', function: { name: 'connect', description: 'Propose a connection. supports: evidence backs a card. challenges: contradicts a card. reasoning: one card leads to the next. questions: an open question limits a card.', parameters: { type: 'object', properties: {
    from: { type: 'string', description: 'Ref such as K2, S1 or N1' },
    to: { type: 'string', description: 'Ref such as K1 or N2' },
    kind: { type: 'string', enum: ['supports', 'challenges', 'reasoning', 'questions'] },
    why: { type: 'string', description: 'Short label, under 6 words' } }, required: ['from', 'to', 'kind'] } } },
  { type: 'function', function: { name: 'set_walkthrough', description: 'Propose the reading order: refs of facts, claims, conclusions and questions (not evidence), first to last.', parameters: { type: 'object', properties: {
    order: { type: 'array', items: { type: 'string' } } }, required: ['order'] } } },
];

const PRESETS = [
  ['Sort my inbox', 'Place the inbox passages that help answer the question, skipping unrelated ones. For each one, add a short claim saying what it establishes and connect the passage to that claim with supports.'],
  ['Find conflicts', 'Look for evidence that contradicts a claim, or claims that contradict each other. Connect them with challenges and say why in a few words.'],
  ['Find open questions', 'Add open questions for anything the evidence does not settle, and connect each to the card it limits with questions.'],
  ['Order the walkthrough', 'Propose a walkthrough order: facts first, then claims in logical order, then the conclusion and open questions.'],
];

const clip = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

export function init(api) {
  const $ = s => document.querySelector(s), esc = api.esc;
  const bar = $('#authorbar');
  if (!bar) return;
  bar.querySelector(':scope > span:last-of-type')?.insertAdjacentHTML('beforebegin', '<button id="assist-open" title="Optional: let a local model propose cards and connections for you to review">✦ Draft with local AI</button>');
  if (!$('#assist-open')) bar.insertAdjacentHTML('beforeend', '<button id="assist-open">✦ Draft with local AI</button>');

  let run = null; // { controller, refs, proposals, captures, summary }

  function dialog() {
    let d = $('#assist-dialog');
    if (d) return d;
    d = document.createElement('dialog'); d.id = 'assist-dialog'; document.body.append(d);
    d.addEventListener('close', () => run?.controller.abort());
    d.addEventListener('click', e => { if (e.target.closest('[data-close]')) d.close(); });
    return d;
  }

  $('#assist-open').onclick = async () => {
    const d = dialog();
    d.innerHTML = `<div class="dialog-heading"><h2>Draft with local AI</h2><button data-close aria-label="Close">✕</button></div>
      <p class="form-help">Runs on this computer through Ollama (<span id="assist-model">checking…</span>). It can propose claims, open questions, conclusions, connections and a walkthrough order, and it can place passages from your evidence inbox word for word. <b>It cannot write or change quotations.</b> Nothing is added until you approve it below, and one Undo removes the whole batch.</p>
      <label class="form-label" for="assist-task">What should it do?</label>
      <textarea id="assist-task" rows="3">${esc(PRESETS[0][1])}</textarea>
      <div class="assist-presets">${PRESETS.map(([label], i) => `<button type="button" data-preset="${i}">${esc(label)}</button>`).join('')}</div>
      <div id="assist-log" aria-live="polite"></div><div id="assist-results"></div>
      <div class="dialog-actions"><button data-close>Close</button><button id="assist-run" class="dark">Draft proposals</button><button id="assist-apply" class="dark" hidden>Add selected to board</button></div>`;
    d.querySelectorAll('[data-preset]').forEach(b => b.onclick = () => { $('#assist-task').value = PRESETS[b.dataset.preset][1]; });
    $('#assist-run').onclick = () => draft().catch(err => { if (err?.name !== 'AbortError') log('⚠ ' + err.message); $('#assist-run').disabled = false; });
    $('#assist-apply').onclick = apply;
    d.showModal();
    resolveModels().then(m => { $('#assist-model').textContent = m.chat || 'no chat model found'; }).catch(() => { $('#assist-model').textContent = 'not reachable'; });
  };

  const log = line => { const el = $('#assist-log'); if (el) { el.textContent += line + '\n'; el.scrollTop = el.scrollHeight; } };

  async function draft() {
    run?.controller.abort();
    $('#assist-run').disabled = true; $('#assist-apply').hidden = true;
    $('#assist-log').textContent = ''; $('#assist-results').innerHTML = '';
    const board = api.board;
    const captures = await api.workspace.inbox(api.session.journey.id);
    const refs = new Map(), proposals = [];
    run = { controller: new AbortController(), refs, proposals, captures };

    // Refs: K = on the board, S = inbox passages not yet placed.
    board.nodes.slice(0, 120).forEach((n, i) => refs.set('K' + (i + 1), { kind: 'card', id: n.id, type: n.type, text: n.text, quote: n.quote }));
    const placed = new Set(board.nodes.map(n => n.sourceCaptureId).filter(Boolean));
    captures.filter(c => !placed.has(c.id) && c.kind !== 'note' && !c.archived).slice(0, 30).forEach((c, i) => refs.set('S' + (i + 1), { kind: 'capture', capture: c, type: 'evidence', text: c.title, quote: c.quote }));
    const refOf = id => [...refs].find(([, v]) => v.id === id)?.[0];

    const lines = [`QUESTION: ${board.title}`, board.subtitle ? `CONTEXT: ${board.subtitle}` : '', '', 'ON THE BOARD:'];
    for (const [ref, v] of refs) if (v.kind === 'card') {
      const n = api.get(v.id);
      lines.push(n.type === 'evidence'
        ? `${ref} [evidence] ${clip(n.text, 80)} — quote: "${clip(n.quote || n.displayedQuote || n.note, 400)}"`
        : `${ref} [${n.type}] ${clip(n.text, 200)}${n.note ? ` (note: ${clip(n.note, 150)})` : ''}`);
    }
    if (!board.nodes.length) lines.push('(empty)');
    const links = board.links.map(l => `${refOf(l.from)} ${api.wordLabel(l.word, api.get(l.to)?.type)} ${refOf(l.to)}${l.label ? ` (${l.label})` : ''}`).filter(s => !s.includes('undefined'));
    lines.push('', 'CONNECTIONS:', ...(links.length ? links : ['(none)']));
    lines.push('', 'WALKTHROUGH ORDER: ' + (api.sequence().map(refOf).filter(Boolean).join(', ') || '(none)'));
    lines.push('', 'EVIDENCE INBOX (captured passages not yet on the board):');
    const inbox = [...refs].filter(([, v]) => v.kind === 'capture');
    for (const [ref, v] of inbox) lines.push(`${ref} — ${clip(v.capture.title, 80)} — "${clip(v.capture.quote, 500)}"${v.capture.view === 'translated' ? ' [captured from a machine-translated view]' : ''}`);
    if (!inbox.length) lines.push('(empty)');

    const messages = [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: lines.filter(l => l !== undefined).join('\n') + '\n\nTASK: ' + $('#assist-task').value.trim() },
    ];
    log(`Sent ${board.nodes.length} cards and ${inbox.length} inbox passages.`);

    let summary = '';
    for (let round = 0; round < MAX_ROUNDS; round++) {
      log(round ? 'Continuing…' : 'Thinking…');
      const { message } = await chatTools(messages, TOOLS, { signal: run.controller.signal });
      messages.push(message);
      const calls = message.tool_calls || [];
      if (!calls.length) { summary = message.content || ''; break; }
      for (const call of calls) {
        let args = call.function?.arguments || {};
        if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }
        const result = proposals.length >= MAX_PROPOSALS ? { error: 'Proposal limit reached. Stop and summarise.' } : execute(call.function?.name, args);
        log(`${call.function?.name}(${clip(JSON.stringify(args), 90)}) → ${result.error ? '⚠ ' + result.error : result.ref || 'ok'}`);
        messages.push({ role: 'tool', tool_name: call.function?.name, content: JSON.stringify(result) });
      }
      if (round === MAX_ROUNDS - 1) summary = 'Stopped after the maximum number of rounds.';
    }
    run.summary = summary;
    log('Done.');
    renderProposals();
    $('#assist-run').disabled = false; $('#assist-run').textContent = 'Draft again';
  }

  // ---- Tool execution: only ever appends to run.proposals ----

  function resolve(raw) {
    const key = String(raw ?? '').trim().replace(/^[#[(]+|[\])]+$/g, '').toUpperCase();
    if (run.refs.has(key)) return { ref: key, ...run.refs.get(key) };
    // Small models sometimes pass a card's text instead of its ref.
    const t = String(raw ?? '').trim().toLowerCase();
    if (!t) return null;
    const seen = new Set(), entries = [...run.refs].filter(([, v]) => !seen.has(v.proposal || v.id || v.capture) && seen.add(v.proposal || v.id || v.capture));
    const hit = entries.find(([, v]) => (v.text || '').toLowerCase() === t)
      || entries.filter(([, v]) => (v.text || '').toLowerCase().includes(t) || (t.length > 12 && (v.quote || '').toLowerCase().includes(t)))
        .reduce((only, e, i, all) => all.length === 1 ? e : only, null);
    return hit ? { ref: hit[0], ...hit[1] } : null;
  }

  function propose(p, text, type, ref = 'N' + (proposals().filter(x => x.ref?.startsWith('N')).length + 1)) {
    p.ref = ref; p.checked = true; proposals().push(p);
    run.refs.set(ref, { kind: 'proposal', proposal: p, type, text });
    return ref;
  }
  const proposals = () => run.proposals;

  function placeCapture(target) {
    const existing = proposals().find(p => p.type === 'evidence' && p.capture.id === target.capture.id);
    if (existing) return existing.ref;
    // The passage keeps its S ref; it now points at the placement proposal.
    return propose({ type: 'evidence', capture: target.capture }, target.capture.title, 'evidence', target.ref);
  }

  function execute(name, a) {
    if (name === 'add_card') {
      // Small models often omit the type; infer it rather than lose the card.
      if (!a.type) a = { ...a, type: /\?\s*$/.test(a.text || '') ? 'gap' : 'claim' };
      if (!['claim', 'gap', 'conclusion'].includes(a.type)) return { error: a.type === 'fact' ? 'Only the person adds facts. If a source says it, add it as a claim.' : 'type must be claim, gap or conclusion' };
      const text = clip(a.text, 400);
      if (!text) return { error: 'text is required' };
      const dup = [...run.refs].find(([, v]) => v.type === a.type && (v.text || '').toLowerCase() === text.toLowerCase());
      if (dup) return { ref: dup[0], note: 'This card already exists; reuse its ref.' };
      const ref = propose({ type: 'card', cardType: a.type, text, note: clip(a.note, 600) }, text, a.type);
      if (!a.supported_by) return { ref };
      const linked = execute('connect', { from: a.supported_by, to: ref, kind: 'supports' });
      return linked.error ? { ref, warning: 'Card added, but not connected: ' + linked.error } : { ref, connected: true };
    }
    if (name === 'place_evidence') {
      const t = resolve(a.source);
      if (!t) return { error: `Unknown inbox ref "${a.source}". Use S1, S2...` };
      if (t.kind === 'card') return { ref: t.ref, note: 'Already on the board.' };
      if (t.kind === 'proposal') return { ref: t.ref, note: 'Already placed.' };
      return { ref: placeCapture(t) };
    }
    if (name === 'connect') {
      let from = resolve(a.from), to = resolve(a.to);
      if (!from) return { error: `Unknown card "${a.from}". Use a ref like K2, S1 or N1.` };
      if (!to) return { error: `Unknown card "${a.to}". Use a ref like K1 or N2.` };
      if (!['supports', 'challenges', 'reasoning', 'questions'].includes(a.kind)) return { error: 'kind must be supports, challenges, reasoning or questions' };
      if (from.kind === 'capture') from = resolve(placeCapture(from));
      if (to.kind === 'capture') to = resolve(placeCapture(to));
      if (from.ref === to.ref || (from.proposal && from.proposal === to.proposal) || (from.id && from.id === to.id)) return { error: 'A card cannot connect to itself.' };
      const key = p => p.id || p.proposal;
      const same = l => l.kind === a.kind && l.fromKey === key(from) && l.toKey === key(to);
      if (proposals().some(p => p.type === 'link' && same(p)) || api.board.links.some(l => (l.from === from.id && l.to === to.id) || (l.from === to.id && l.to === from.id))) return { ok: true, note: 'Connection already exists.' };
      proposals().push({ type: 'link', kind: a.kind, why: clip(a.why, 80), fromKey: key(from), toKey: key(to), fromText: from.text, toText: to.text, checked: true });
      return { ok: true };
    }
    if (name === 'set_walkthrough') {
      const order = (Array.isArray(a.order) ? a.order : []).map(resolve).filter(r => r && r.type !== 'evidence' && r.kind !== 'capture');
      if (!order.length) return { error: 'No valid refs. List refs of facts, claims, conclusions and questions.' };
      const i = proposals().findIndex(p => p.type === 'order');
      const p = { type: 'order', keys: order.map(r => r.id || r.proposal), texts: order.map(r => r.text), checked: true };
      if (i >= 0) proposals()[i] = p; else proposals().push(p);
      return { ok: true, steps: order.length };
    }
    return { error: `Unknown tool ${name}` };
  }

  // ---- Review and apply ----

  function describe(p) {
    if (p.type === 'card') return [`NEW ${p.cardType === 'gap' ? 'OPEN QUESTION' : p.cardType.toUpperCase()}`, `${esc(p.text)}${p.note ? `<br><small>${esc(p.note)}</small>` : ''}`];
    if (p.type === 'evidence') return ['PLACE PASSAGE FROM INBOX', `${esc(p.capture.title)}<br><mark>${esc(clip(p.capture.quote, 240))}</mark>`];
    if (p.type === 'link') return [`CONNECT · ${p.kind.toUpperCase()}`, `${esc(clip(p.fromText, 90))} <b>→</b> ${esc(clip(p.toText, 90))}${p.why ? ` <small>(${esc(p.why)})</small>` : ''}`];
    return ['WALKTHROUGH ORDER', p.texts.map((t, i) => `${i + 1}. ${esc(clip(t, 80))}`).join('<br>')];
  }

  function renderProposals() {
    const list = proposals();
    const used = new Set(list.filter(p => p.type === 'evidence').map(p => p.capture.id));
    const unused = [...run.refs.values()].filter(v => v.kind === 'capture' && !used.has(v.capture.id)).map(v => v.capture);
    $('#assist-results').innerHTML = (run.summary ? `<p class="assist-summary">${esc(run.summary)}</p>` : '')
      + (unused.length ? `<p class="form-help">Not used from your inbox: ${unused.map(c => esc(clip(c.title, 60))).join(' · ')}</p>` : '')
      + (list.length ? `<p class="eyebrow">${list.length} PROPOSALS · UNTICK ANY YOU DON'T WANT</p><div class="proposals">${list.map((p, i) => {
        const [kind, body] = describe(p);
        return `<label class="proposal"><input type="checkbox" data-proposal="${i}" ${p.checked ? 'checked' : ''}><span class="kind">${kind}</span><p>${body}</p><p class="warn" data-warn="${i}"></p></label>`;
      }).join('')}</div>` : '<p class="empty">No proposals. Try rephrasing the task, or add passages to the inbox first.</p>');
    $('#assist-results').querySelectorAll('[data-proposal]').forEach(box => box.onchange = () => { list[box.dataset.proposal].checked = box.checked; checkDeps(); });
    checkDeps();
    $('#assist-apply').hidden = !list.length;
  }

  // A connection or order entry that points at an unticked proposal can't be applied.
  const unchecked = key => typeof key === 'object' && !key.checked;
  function checkDeps() {
    proposals().forEach((p, i) => {
      const warn = $(`[data-warn="${i}"]`);
      const blocked = p.checked && ((p.type === 'link' && (unchecked(p.fromKey) || unchecked(p.toKey))) || (p.type === 'order' && p.keys.some(unchecked)));
      if (warn) warn.textContent = blocked ? (p.type === 'order' ? 'Unticked cards will be left out of the order.' : 'Skipped: it connects to a card you unticked.') : '';
    });
  }

  function apply() {
    const board = api.board, chosen = proposals().filter(p => p.checked), made = new Map();
    const order = chosen.find(p => p.type === 'order');
    let count = 0;
    const placeEvidence = (p, at) => {
      if (made.has(p)) return;
      const card = api.workspace.evidenceCard(p.capture, at || api.freePosition());
      board.nodes.push(card); made.set(p, card.id); count++;
    };
    // Lay each new card out as a column with the new passages that back it
    // directly underneath, so a claim sits next to its evidence.
    for (const p of chosen.filter(p => p.type === 'card')) {
      const id = api.uid(), at = api.freePosition();
      board.nodes.push({ id, type: p.cardType, text: p.text, x: at.x, y: at.y, ...(p.note ? { note: p.note } : {}) });
      if (!order) board.steps.push(id);
      made.set(p, id); count++;
      chosen.filter(l => l.type === 'link' && l.toKey === p && l.fromKey?.type === 'evidence' && l.fromKey.checked)
        .forEach((l, i) => placeEvidence(l.fromKey, { x: at.x + i * 330, y: at.y + 230 }));
    }
    chosen.filter(p => p.type === 'evidence').forEach(p => placeEvidence(p));
    const idOf = key => typeof key === 'string' ? (api.get(key) ? key : null) : made.get(key) || null;
    for (const p of chosen.filter(p => p.type === 'link')) {
      const from = idOf(p.fromKey), to = idOf(p.toKey);
      if (!from || !to) continue;
      // The model proposes "from supports/objects to/questions to"; the board
      // stores reading order: "[to] because / one objection / which raises the question [from]".
      const word = { challenges: 'objection', questions: 'question' }[p.kind] || 'because';
      board.links.push({ id: api.uid(), from: to, to: from, word: api.fitWord(api.get(to).type, api.get(from).type, word), label: p.why || '' }); count++;
    }
    if (order) {
      const ids = [...new Set(order.keys.map(idOf).filter(Boolean))];
      board.steps = [...ids, ...board.steps.filter(id => !ids.includes(id))];
      count++;
    }
    if (!count) { api.notify('Nothing selected.'); return; }
    api.persist(); api.render();
    $('#assist-dialog').close();
    api.notify(`Added ${count} change${count === 1 ? '' : 's'} · Undo reverts them`);
  }
}
