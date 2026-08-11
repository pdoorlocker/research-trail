// Injected into pages (after vendor/Readability.js) once they finish loading,
// only while a journey is actively recording. Extracts the readable text and
// sends it to the background worker. Runs in an isolated world; never touches
// page JavaScript.
(() => {
  // Guard against double-injection (SPA navigations can re-fire onCompleted).
  // Time-limited, not one-shot: several schedulers may capture the same href
  // on purpose at different moments — the SPA settle pass at +2.5s, then the
  // streaming-aware recapture at +6s reading the full answer — and a
  // permanent per-href stamp made whichever fired first block the better-
  // timed one. Burst re-fires land within milliseconds; anything a second
  // apart is a deliberate re-read. (Old versions stored a bare string here;
  // `last.href` is then undefined and we just capture, which is fine.)
  const last = window.__researchTrailCaptured;
  if (last && last.href === location.href && Date.now() - last.at < 1500) return;
  window.__researchTrailCaptured = { href: location.href, at: Date.now() };

  let article = null;
  try {
    // Readability mutates its input, so parse a clone.
    const docClone = document.cloneNode(true);
    article = new Readability(docClone, { charThreshold: 250 }).parse();
  } catch (e) {
    // Some pages defeat Readability; fall back to bare metadata below.
  }

  const metaDescription =
    document.querySelector('meta[name="description"]')?.content ||
    document.querySelector('meta[property="og:description"]')?.content ||
    '';

  chrome.runtime.sendMessage({
    type: 'page-captured',
    payload: {
      url: location.href,
      title: article?.title || document.title || '',
      excerpt: (article?.excerpt || metaDescription || '').slice(0, 500),
      text: (article?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 24000),
    },
  });
})();
