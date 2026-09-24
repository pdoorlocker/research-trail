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
    .x{position:absolute;top:6px;right:8px;border:0;padding:2px 6px;font-size:14px;opacity:.7}</style>
    <div class="t" role="status">
      <button class="x" data-a="close" aria-label="Dismiss">✕</button>
      <div>${info.error ? esc(info.error) : `Saved to <b>${esc(info.journeyName)}</b>`}</div>
      ${info.quote ? `<p class="q">“${esc(clip(info.quote, 140))}”</p>` : info.screenshot ? '<p class="q">Screenshot of this page</p>' : ''}
      ${info.warning ? `<div class="w">${esc(info.warning)}</div>` : ''}
      <div class="a">
        <button class="p" data-a="open">Open board</button>
        ${info.moveTo ? `<button data-a="move">Move to ${esc(clip(info.moveTo.name, 28))}</button>` : ''}
      </div>
    </div>`;
  document.documentElement.append(host);
  let timer = setTimeout(() => host.remove(), 7000);
  const t = root.querySelector('.t');
  t.addEventListener('mouseenter', () => clearTimeout(timer));
  t.addEventListener('mouseleave', () => { timer = setTimeout(() => host.remove(), 3000); });
  root.addEventListener('click', e => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (!a) return;
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
