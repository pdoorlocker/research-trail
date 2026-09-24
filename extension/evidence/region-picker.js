// "Save screenshot as evidence": let the reader drag a box around what to
// save instead of capturing the whole screen. Runs via
// scripting.executeScript, so it must be self-contained. Resolves with the
// box in CSS pixels (plus the viewport size, for scaling the screenshot),
// { full: true } for a plain click (the whole visible page), or null on Esc.
export function pickRegion() {
  return new Promise(resolve => {
    document.getElementById('ttwl-region-picker')?.remove();
    const host = document.createElement('div');
    host.id = 'ttwl-region-picker';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>
      .o{position:fixed;inset:0;z-index:2147483647;cursor:crosshair;background:rgba(20,22,18,.35)}
      .o.drawing{background:transparent}
      .b{position:fixed;display:none;border:2px solid #a0cfac;border-radius:2px;box-shadow:0 0 0 9999px rgba(20,22,18,.45)}
      .h{position:fixed;top:16px;left:50%;transform:translateX(-50%);padding:8px 14px;border-radius:8px;background:#20231f;color:#f5f2ea;border:1px solid #ffffff33;
        font:13px/1.4 system-ui,-apple-system,sans-serif;box-shadow:0 8px 24px #0006;pointer-events:none;white-space:nowrap}
      .s{position:fixed;padding:2px 6px;border-radius:4px;background:#20231f;color:#f5f2ea;font:11px ui-monospace,monospace;pointer-events:none;display:none}</style>
      <div class="o"></div><div class="b"></div><div class="s"></div>
      <div class="h">Drag to select what to save · click for the whole visible page · Esc to cancel</div>`;
    document.documentElement.append(host);
    const overlay = root.querySelector('.o'), box = root.querySelector('.b'), size = root.querySelector('.s');
    let start = null, rect = null;
    const finish = result => {
      removeEventListener('keydown', onKey, true);
      host.remove();
      // Let the page repaint without the overlay before the screenshot is taken.
      // (Animation frames pause on background pages, so a timer backs them up.)
      let done = false;
      const go = () => { if (!done) { done = true; resolve(result); } };
      requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(go, 30)));
      setTimeout(go, 200);
    };
    const onKey = e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(null); } };
    addEventListener('keydown', onKey, true);
    overlay.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      e.preventDefault();
      overlay.setPointerCapture(e.pointerId);
      start = { x: e.clientX, y: e.clientY };
    });
    overlay.addEventListener('pointermove', e => {
      if (!start) return;
      rect = { x: Math.min(start.x, e.clientX), y: Math.min(start.y, e.clientY), w: Math.abs(e.clientX - start.x), h: Math.abs(e.clientY - start.y) };
      overlay.classList.add('drawing');
      Object.assign(box.style, { display: 'block', left: rect.x + 'px', top: rect.y + 'px', width: rect.w + 'px', height: rect.h + 'px' });
      Object.assign(size.style, { display: 'block', left: rect.x + 'px', top: Math.max(0, rect.y - 22) + 'px' });
      size.textContent = `${Math.round(rect.w)} × ${Math.round(rect.h)}`;
    });
    overlay.addEventListener('pointerup', () => {
      if (!start) return;
      const big = rect && rect.w > 8 && rect.h > 8;
      finish(big ? { ...rect, vw: innerWidth, vh: innerHeight } : { full: true });
    });
  });
}
