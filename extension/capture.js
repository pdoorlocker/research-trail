// Injected into pages (after vendor/Readability.js) once they finish loading,
// only while a journey is actively recording. Extracts the readable text and
// sends it to the background worker. Runs in an isolated world; never touches
// page JavaScript.
(() => {
  // Guard against double-injection (SPA navigations can re-fire onCompleted).
  if (window.__researchTrailCaptured === location.href) return;
  window.__researchTrailCaptured = location.href;

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
