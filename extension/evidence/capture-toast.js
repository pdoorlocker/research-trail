// Shown inside the page after "Save passage as evidence", so saving never
// pulls you off what you're reading. Runs via scripting.executeScript, so it
// must be self-contained. A shadow root keeps the page's styles out.
export function showCaptureToast(info) {
  document.getElementById('ttwl-capture-toast')?.remove();
  const host = document.createElement('div');
  host.id = 'ttwl-capture-toast';
  const root = host.attachShadow({ mode: 'open' });
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const clip = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
  // One high-contrast style: the page's colors are unknown, so the toast
  // carries its own dark surface and a light border.
  root.innerHTML = `<style>
    .t{position:fixed;right:20px;bottom:20px;z-index:2147483647;width:min(360px,calc(100vw - 40px));box-sizing:border-box;padding:14px 16px;border-radius:10px;
      font:14px/1.45 system-ui,-apple-system,sans-serif;background:#20231f;color:#f5f2ea;border:1px solid #ffffff33;box-shadow:0 10px 30px #0007;animation:in .18s ease-out}
    @keyframes in{from{opacity:0;transform:translateY(8px)}}
    b{font-weight:600}.q{margin:6px 0 0;font:italic 14px/1.45 Georgia,serif;opacity:.85}.w{margin-top:4px;font-size:12px;opacity:.75}
    .a{display:flex;gap:8px;margin-top:10px;flex-wrap:wrap}
    button{font:600 13px system-ui,sans-serif;border-radius:6px;padding:5px 10px;cursor:pointer;border:1px solid currentColor;background:transparent;color:inherit}
    button.p{background:#a0cfac;color:#20231f;border-color:transparent}
    .x{position:absolute;top:6px;right:8px;border:0;padding:2px 6px;font-size:14px;opacity:.7}
    .pick{margin-top:10px;border-top:1px solid #ffffff26;padding-top:10px}
    .pick p{margin:0 0 6px;font-size:12.5px;opacity:.85}
    .seg{display:inline-flex;border:1px solid #ffffff40;border-radius:6px;margin-bottom:6px}.seg button{border:0;border-radius:5px;font-weight:500;padding:3px 8px}.seg button[aria-pressed=true]{background:#ffffff26}
    input{width:100%;box-sizing:border-box;padding:6px 8px;border-radius:6px;border:1px solid #ffffff40;background:#ffffff14;color:inherit;font:14px system-ui,sans-serif}
    ul{list-style:none;margin:6px 0 0;padding:0;max-height:190px;overflow:auto}
    li button{display:block;width:100%;text-align:left;border:0;font:14px/1.35 Georgia,serif;padding:5px 6px;border-radius:5px}
    li button:hover,li button.on{background:#ffffff1f}
    .ty{font:10px ui-monospace,monospace;text-transform:uppercase;opacity:.6;margin-right:4px}</style>
    <div class="t" role="status">
      <button class="x" data-a="close" aria-label="Dismiss">✕</button>
      <div>${info.error ? esc(info.error) : `Saved to <b>${esc(info.journeyName)}</b>`}</div>
      ${info.quote ? `<p class="q">“${esc(clip(info.quote, 140))}”</p>` : info.screenshot ? '<p class="q">Screenshot of this page</p>' : ''}
      ${info.warning ? `<div class="w">${esc(info.warning)}</div>` : ''}
      <div class="a">
        ${info.error ? '' : '<button class="p" data-a="attach">Attach…</button>'}
        <button data-a="open">Open board</button>
        ${info.moveTo ? `<button data-a="move">Move to ${esc(clip(info.moveTo.name, 28))}</button>` : ''}
      </div>
    </div>`;
  document.documentElement.append(host);
  let timer = setTimeout(() => host.remove(), 7000);
  const t = root.querySelector('.t');
  t.addEventListener('mouseenter', () => clearTimeout(timer));
  t.addEventListener('mouseleave', () => { if (!root.querySelector('.pick')) timer = setTimeout(() => host.remove(), 3000); });
  // "Attach…": pick the line on your board this passage backs up.
  let word = 'because', lines = [], boardId = null, active = 0;
  const TYPE = { note: 'thought', gap: 'question' };
  const drawLines = () => {
    const q = (root.querySelector('input')?.value || '').toLowerCase();
    const shown = lines.filter(l => !q || l.text.toLowerCase().includes(q)).slice(0, 30);
    active = Math.min(active, Math.max(0, shown.length - 1));
    root.querySelector('ul').innerHTML = shown.map((l, i) => `<li><button data-line="${esc(l.id)}" class="${i === active ? 'on' : ''}"><span class="ty">${esc(TYPE[l.type] || l.type)}</span>${esc(clip(l.text, 90))}</button></li>`).join('') || '<li style="opacity:.7;font-size:13px">No line matches.</li>';
    return shown;
  };
  async function openAttach() {
    clearTimeout(timer);
    const res = await chrome.runtime.sendMessage({ type: 'capture-attach-options', journeyId: info.journeyId });
    if (!res?.lines?.length) { t.querySelector('.a').insertAdjacentHTML('afterend', '<div class="w">This workspace has no board with lines yet. Open the board to add it.</div>'); return; }
    lines = res.lines; boardId = res.boardId;
    t.querySelector('.a').insertAdjacentHTML('afterend', `<div class="pick"><p>Attach to a line on “${esc(clip(res.boardTitle, 40))}”</p>
      <div class="seg"><button data-w="because" aria-pressed="true">backs it up</button><button data-w="objection" aria-pressed="false">objects to it</button></div>
      <input placeholder="Find a line" aria-label="Find a line"><ul></ul></div>`);
    const input = root.querySelector('input');
    input.addEventListener('input', () => { active = 0; drawLines(); });
    input.addEventListener('keydown', e => {
      const shown = drawLines();
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); active = (active + (e.key === 'ArrowDown' ? 1 : -1) + shown.length) % Math.max(1, shown.length); drawLines(); }
      else if (e.key === 'Enter' && shown[active]) { e.preventDefault(); attach(shown[active]); }
      else if (e.key === 'Escape') host.remove();
      e.stopPropagation();
    });
    drawLines(); input.focus();
  }
  async function attach(line) {
    const res = await chrome.runtime.sendMessage({ type: 'capture-attach', captureId: info.captureId, boardId, lineId: line.id, word });
    t.querySelector('.pick')?.remove();
    root.querySelector('.t > div').innerHTML = res?.error ? esc(res.error) : `Attached under <b>${esc(clip(line.text, 60))}</b>`;
    timer = setTimeout(() => host.remove(), 3500);
  }
  root.addEventListener('click', e => {
    const w = e.target.closest('[data-w]');
    if (w) { word = w.dataset.w; root.querySelectorAll('[data-w]').forEach(b => b.setAttribute('aria-pressed', String(b === w))); return; }
    const pick = e.target.closest('[data-line]');
    if (pick) return attach(lines.find(l => l.id === pick.dataset.line));
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (!a) return;
    if (a === 'attach') { e.target.closest('[data-a]').remove(); return openAttach(); }
    if (a === 'open') chrome.runtime.sendMessage({ type: 'capture-toast-open', journeyId: info.journeyId });
    if (a === 'move') {
      chrome.runtime.sendMessage({ type: 'capture-toast-move', captureId: info.captureId, journeyId: info.moveTo.id });
      root.querySelector('.t > div').innerHTML = `Moved to <b>${esc(info.moveTo.name)}</b>`;
      e.target.remove();
      return;
    }
    host.remove();
  });
}
