// Amtshelfer content script.
// Activates only on German-language pages. Adds a hover toolbar to text blocks
// (Translate / Explain / Read / +Glossary), swaps German↔English in place with
// the built-in on-device Translator API, and persists per-paragraph state
// keyed by a hash of the German text so it survives revisits.

(() => {
  'use strict';

  // Takeover handshake: when the extension reloads/updates, the background
  // re-injects this script into open tabs. The fresh copy announces itself
  // on the shared DOM; the orphaned old copy (whose chrome.* APIs are dead,
  // but whose DOM listeners still fire) hears it, restores the page, and
  // unhooks — so the new copy takes over without a page refresh.
  // Namespaced by extension id: while both the standalone Amtshelfer and the
  // Research Trail build are installed, they must never retire each other —
  // a retired copy refuses to activate, which read as "buttons do nothing".
  // The legacy un-namespaced event is still DISPATCHED (never listened to) so
  // pre-namespace copies lingering in open tabs retire instead of doubling up.
  const TAKEOVER = 'amtshelfer-takeover:' + chrome.runtime.id;
  document.dispatchEvent(new CustomEvent('amtshelfer-takeover'));
  document.dispatchEvent(new CustomEvent(TAKEOVER));
  let retired = false;
  document.addEventListener(TAKEOVER, function onTakeover() {
    document.removeEventListener(TAKEOVER, onTakeover);
    retired = true;
    try { deactivate(); } catch { /* best effort — page refresh still works */ }
  });

  const BLOCK_SELECTOR = 'p, li, h1, h2, h3, h4, h5, h6, dd, dt, td, blockquote';
  // Clickable/short elements (nav links, buttons, accordion headers, form
  // labels) are registered individually when they aren't already inside a
  // registered block.
  const INLINE_SELECTOR = 'a, button, summary, caption, figcaption, legend, th, label';
  // Elements that must survive translation untouched (no text of their own
  // worth translating) vs. ones we keep but translate the text inside.
  const SKIP_KEEP_SELECTOR = 'svg, img, picture, video, audio, iframe, canvas, input, select, textarea, script, style, noscript';
  const KEEP_SELECTOR = 'a, button, label, summary, [role="button"], [onclick]';
  // Formatting-only tags (bold sub-headings like "Schritt 1: …", <em> notes)
  // that sometimes stand in for a real heading/paragraph tag in hand-rolled
  // markup — registerExtra treats a bare one of these as orphaned content,
  // same as a bare text node.
  const ORPHAN_SELECTOR = 'strong, b, em, i, u, mark';
  // Every piece of UI this extension injects — registration must never adopt
  // our own panels/labels (the section-preview label once registered itself
  // as a translatable block).
  const OWN_UI_SELECTOR = '.ah-explain, .ah-gist, .ah-chip, #ah-banner, #ah-toast, ' +
    '#ah-agent-panel, #ah-toolbar-host, #ah-section-box, #ah-select-panel';
  const MIN_LEN = 25;
  const MIN_LEN_HEADING = 4;
  const MIN_LEN_INLINE = 3;
  const MIN_LEN_WORDED = 8;

  const pageKey = location.origin + location.pathname;

  let pageStore = {};   // hash -> { de, en, read, ts }
  let glossary = {};    // term -> { translation, sourceUrl, ts }
  let settings = { translateBackend: 'chrome' };
  let translator = null;
  let currentBlock = null;
  let hideTimer = null;
  let saveChain = Promise.resolve();
  const originalHtml = new Map(); // element -> original innerHTML (for DE view)

  // ---------- utils ----------

  const norm = t => t.replace(/\s+/g, ' ').trim();

  function fnv1a(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(36);
  }

  function blockText(el) {
    return norm(el.textContent || '');
  }

  // Text that would actually be translated if this element registered:
  // leaves out form-control internals (a td wrapping only a <select> has
  // nothing of its own to translate — options get their own cheat sheet)
  // and our own injected UI (a DE chip's "DE" once pushed a short parent
  // over the length floor on rescan, double-registering it).
  function candidateText(el) {
    if (!el.querySelector('select, textarea, .ah-chip, .ah-gist, .ah-explain')) return blockText(el);
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
      acceptNode: n =>
        n.parentElement.closest('select, textarea, .ah-chip, .ah-gist, .ah-explain')
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_ACCEPT
    });
    let s = '';
    while (walker.nextNode()) s += walker.currentNode.data;
    return norm(s);
  }

  // Minimum length for an element to register on its own. Short blocks are
  // often exactly what an American needs translated — a bare list entry
  // ("Heiratsurkunde"), a status line ("Voraussichtlich: morgen"), a tiny
  // heading ("Maße") — so any block holding at least one real word (3+
  // letters; skips bare prices/times like "€ 218" or "13:39") gets a low
  // floor. The tall 25-char floor only remains for wordless leftovers.
  function minLenFor(el, text) {
    if (/^H[1-6]$/.test(el.tagName)) return MIN_LEN_HEADING;
    if (/[a-zA-ZäöüÄÖÜß]{3}/.test(text)) return MIN_LEN_WORDED;
    return MIN_LEN;
  }

  function isCandidate(el) {
    const text = candidateText(el);
    if (text.length < minLenFor(el, text)) return false;
    // Prefer innermost blocks: skip if a descendant is also a candidate (by
    // the descendant's own floor), so an <li> wrapping a long <p> — or a
    // list of short items — doesn't double-register.
    for (const child of el.querySelectorAll(BLOCK_SELECTOR)) {
      const ct = candidateText(child);
      if (ct.length >= minLenFor(child, ct)) return false;
    }
    return true;
  }

  // ---------- language gate ----------

  // A non-German lang attribute is only a hint, not a verdict — apps
  // routinely mislabel (ikea.com's German order pages declare lang="se"), so
  // anything except an explicit "de" is verified against the actual text.
  // Returns true / false / 'retry' ('retry' = not enough text yet to judge,
  // common on client-rendered apps at document_idle — worth another look).
  async function pageIsGerman() {
    const lang = (document.documentElement.lang || '').toLowerCase();
    if (lang.startsWith('de')) return true;
    if (!('LanguageDetector' in self)) return false;
    try {
      if (await LanguageDetector.availability() === 'unavailable') return false;
      const sample = norm(document.body?.innerText || '').slice(0, 800);
      if (sample.length < 80) return 'retry';
      const det = await LanguageDetector.create();
      const res = await det.detect(sample);
      det.destroy();
      return res[0]?.detectedLanguage === 'de' && res[0].confidence > 0.5;
    } catch {
      return false;
    }
  }

  // ---------- storage ----------

  async function loadState() {
    const data = await chrome.storage.local.get(['pages', 'glossary', 'settings']);
    pageStore = data.pages?.[pageKey] || {};
    glossary = data.glossary || {};
    settings = { ...settings, ...(data.settings || {}) };
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes.settings) settings = { ...settings, ...(changes.settings.newValue || {}) };
      if (changes.glossary) glossary = changes.glossary.newValue || {};
    });
  }

  // Serialize writes so rapid actions don't clobber each other.
  function persist(fn) {
    saveChain = saveChain.then(async () => {
      const data = await chrome.storage.local.get(['pages', 'glossary']);
      const pages = data.pages || {};
      fn(pages, data.glossary || {});
      await chrome.storage.local.set({ pages, glossary });
    }).catch(e => console.warn('[Amtshelfer] save failed', e));
    return saveChain;
  }

  function saveEntry(hash, patch) {
    pageStore[hash] = { ...(pageStore[hash] || {}), ...patch, ts: Date.now() };
    return persist(pages => {
      pages[pageKey] = pageStore;
    });
  }

  function saveGlossary() {
    return persist(() => {});
  }

  function ctxOn() {
    return settings.explainPageContext !== false;
  }

  async function toggleCtx() {
    settings.explainPageContext = !ctxOn();
    const { settings: existing } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({
      settings: { ...(existing || {}), explainPageContext: settings.explainPageContext }
    });
  }

  function pageContext(includeText) {
    const context = { title: document.title, url: location.href };
    if (includeText) {
      context.pageText = norm(document.body?.innerText || '').slice(0, 6000);
    }
    return context;
  }

  // ---------- translator ----------

  // The availability/create promises can hang indefinitely in browsers whose
  // translation component is missing (observed in embedded Chromium shells),
  // so every await is raced against a timeout.
  function withTimeout(promise, ms, what) {
    return Promise.race([
      promise,
      new Promise((_, rej) =>
        setTimeout(() => rej(new Error(what + ' timed out — on-device translation may not be available in this browser.')), ms))
    ]);
  }

  async function ensureTranslator() {
    if (translator) return translator;
    if (!('Translator' in self)) {
      throw new Error('Built-in Translator API not available — Amtshelfer needs Chrome 138+.');
    }
    const avail = await withTimeout(
      Translator.availability({ sourceLanguage: 'de', targetLanguage: 'en' }),
      15000, 'Translator availability check');
    if (avail === 'unavailable') {
      throw new Error('German→English on-device translation is not supported on this device.');
    }
    if (avail !== 'available') toast('Downloading translation model (one-time)…');
    translator = await withTimeout(Translator.create({
      sourceLanguage: 'de',
      targetLanguage: 'en',
      monitor(m) {
        m.addEventListener('downloadprogress', e => {
          toast(`Downloading translation model… ${Math.round((e.loaded || 0) * 100)}%`);
        });
      }
    }), 180000, 'Translation model setup');
    return translator;
  }

  // Routes through the backend chosen in settings: Chrome's on-device
  // translator (default) or the local Ollama model via the service worker.
  // onDelta (optional) receives the accumulated partial translation as it
  // streams — only the Ollama backend produces deltas.
  async function translateText(text, onDelta) {
    if (settings.translateBackend === 'ollama') {
      const stop = startSpinner('Translating with Ollama…');
      try {
        const res = await streamRequest({
          type: 'translate',
          text,
          context: ctxOn() ? pageContext(true) : null
        }, { onDelta: (_d, full) => onDelta?.(full) });
        if (!res?.ok) {
          throw new Error((res?.error || 'Ollama translation failed.') + (res?.hint ? ' ' + res.hint : ''));
        }
        return res.text.trim();
      } finally {
        stop();
      }
    }
    const t = await ensureTranslator();
    return (await t.translate(text)).trim();
  }

  // ---------- block state ----------

  function registerBlock(el) {
    if (el.dataset.ahHash) return;
    if (el.closest(OWN_UI_SELECTOR)) return;
    if (!isCandidate(el)) return;
    adopt(el);
    underlineGlossaryTerms(el);
  }

  function registerInline(el) {
    if (el.dataset.ahHash) return;
    if (el.closest(OWN_UI_SELECTOR)) return;
    if (el.parentElement?.closest('[data-ah-hash]')) return;
    if (el.querySelector('[data-ah-hash]')) return;
    // A link/button wrapping block-level content (e.g. a whole card) is a
    // container, not an inline label — leave its inner blocks to register.
    if (el.querySelector('p, div, li, ul, ol, table, section, article, h1, h2, h3, h4, h5, h6')) return;
    const text = candidateText(el);
    if (text.length < MIN_LEN_INLINE || !/[a-zA-ZäöüÄÖÜß]/.test(text)) return;
    adopt(el);
  }

  // Generic containers (divs/spans like Bootstrap card headers) whose own
  // direct text is substantial, plus orphan text nodes sitting directly in a
  // container next to registered elements (common in hand-rolled FAQ markup).
  function directText(el) {
    let s = '';
    for (const n of el.childNodes) if (n.nodeType === 3) s += n.data;
    return norm(s);
  }

  function registerExtra(el) {
    if (el.closest(OWN_UI_SELECTOR)) return;
    if (el.dataset.ahHash) return;
    if (el.parentElement?.closest('[data-ah-hash]')) return;
    if (el.querySelector('[data-ah-hash]')) {
      // A container that already holds registered content (a heading, a
      // previously-wrapped span, …) can still have orphaned siblings sitting
      // directly in it: a bare text node (an FAQ answer dumped straight into
      // the div) or a bare bold/italic "label" like "Schritt 1: …" that uses
      // formatting instead of a real heading/paragraph tag. wrapOrphanText
      // no-ops if there's nothing like that to pick up, so it's always safe
      // to call once a registered descendant exists.
      wrapOrphanText(el);
      return;
    }
    // A div/section still wrapping other structural containers is usually a
    // page section, not a single block of prose. But blocks register before
    // extras, so reaching here means none of those children qualified on
    // their own (e.g. a card with a list of very short items) — adopt small
    // ones whole like the pre-structural-check behavior did, and only skip
    // large ones, which really are page-level wrappers best left to their
    // children. Long-form text that just uses <br> instead of <p> (e.g. a
    // property description) has no structural children and is fine to adopt
    // however long it runs, short of the truly enormous mis-detected case.
    const dt = directText(el);
    if (dt.length < 15) return;
    const len = blockText(el).length;
    if (el.querySelector('div, section, article, ul, ol, table') && len > 500) return;
    if (len > 6000) return;
    adopt(el);
    underlineGlossaryTerms(el);
  }

  // Wraps long bare text nodes (an answer dumped straight into a <div>) in a
  // span so they become translatable/gistable like any other block, and
  // adopts bare bold/italic "labels" (<strong>Schritt 1: …</strong>) the
  // same way — both are content sitting directly in a container instead of
  // inside a real block tag, just one is raw text and the other an element.
  function wrapOrphanText(el) {
    for (const node of [...el.childNodes]) {
      if (node.nodeType === 3) {
        if (norm(node.data).length < 25) continue;
        const span = document.createElement('span');
        span.dataset.ahWrapped = '1';
        node.after(span);
        span.appendChild(node);
        adopt(span);
        underlineGlossaryTerms(span);
      } else if (node.nodeType === 1 && node.matches(ORPHAN_SELECTOR) &&
                 !node.dataset.ahHash && !node.querySelector('[data-ah-hash], p, div, li, ul, ol, table, section, article, h1, h2, h3, h4, h5, h6')) {
        const text = blockText(node);
        if (text.length < MIN_LEN_WORDED || !/[a-zA-ZäöüÄÖÜß]{3}/.test(text)) continue;
        adopt(node);
        underlineGlossaryTerms(node);
      }
    }
  }

  function adopt(el) {
    const hash = fnv1a(blockText(el));
    el.dataset.ahHash = hash;
    const saved = pageStore[hash];
    if (saved?.read) el.classList.add('ah-read');
    if (saved?.en) applyEnglish(el, saved);
    if (saved?.explain) el.classList.add('ah-explained');
  }

  function scanBlocks(root = document) {
    root.querySelectorAll(BLOCK_SELECTOR).forEach(registerBlock);
    root.querySelectorAll(INLINE_SELECTOR).forEach(registerInline);
    root.querySelectorAll('div, span, section, article').forEach(registerExtra);
    root.querySelectorAll('select').forEach(registerSelect);
    root.querySelectorAll('input[type="submit"], input[type="button"], input[type="reset"]')
      .forEach(registerInputButton);
  }

  // Links, buttons, and other clickable controls: we only swap their visible
  // text, never their attributes or handlers, and the DE/EN chip is placed
  // *outside* the element (as a sibling) so it can't interfere with the
  // control's own click/navigation.
  function isInteractive(el) {
    return el.matches('a[href], button, summary, label, input, select, [role="button"], [onclick]');
  }

  // `saved` is a pageStore entry: enHtml (present when the block had markup
  // worth preserving — links, buttons, icons) wins over the plain-text en.
  function applyEnglish(el, saved) {
    if (!originalHtml.has(el)) originalHtml.set(el, el.innerHTML);
    if (saved.enHtml) el.innerHTML = saved.enHtml;
    else el.textContent = saved.en;
    finalizeEnglish(el);
  }

  // Marks a block whose content ALREADY shows English (translated in place,
  // markup intact) — just the classes and the toggle chip.
  function finalizeEnglish(el) {
    el.classList.add('ah-translated', 'ah-showing-en');
    attachChip(el);
  }

  function showGerman(el) {
    const html = originalHtml.get(el);
    if (html == null) return;
    el.innerHTML = html;
    el.classList.remove('ah-showing-en');
    attachChip(el);
    underlineGlossaryTerms(el);
  }

  function toggleLanguage(el) {
    if (el.classList.contains('ah-showing-en')) {
      showGerman(el);
    } else {
      const saved = pageStore[el.dataset.ahHash];
      if (saved?.en) applyEnglish(el, saved);
    }
  }

  function attachChip(el) {
    el._ahChip?.remove();
    const chip = document.createElement('button');
    chip.className = 'ah-chip';
    chip.type = 'button';
    chip.textContent = el.classList.contains('ah-showing-en') ? 'DE' : 'EN';
    chip.title = el.classList.contains('ah-showing-en')
      ? 'Show original German'
      : 'Show English translation';
    chip.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      toggleLanguage(el);
    });
    el._ahChip = chip;
    if (isInteractive(el)) el.after(chip);
    else el.appendChild(chip);
  }

  // ---------- markup-preserving translation ----------

  // Splits a block into translatable units without breaking its structure.
  // A unit is either a run of plain nodes (text, <strong>, <br>…) that gets
  // replaced wholesale by the translated text, or the text INSIDE an element
  // that must survive (a link keeps its href, a button its handlers, a label
  // its wrapped <input>). Icons/inputs/media are never touched at all — this
  // is what keeps wizard answer buttons and React UIs working after a
  // translation pass. Formatting inside a plain run (bold, <br>) is
  // flattened, same as translation always did.
  function translationUnits(el) {
    const units = [];
    const walk = parent => {
      let run = [];
      const flush = () => {
        if (!run.length) return;
        const nodes = run;
        run = [];
        const raw = nodes.map(n => n.textContent ?? '').join('');
        const text = norm(raw);
        if (!text || !/[a-zA-ZäöüÄÖÜß]/.test(text)) return; // bare prices/pipes: leave as-is
        // Keep the run's edge whitespace so translated text doesn't fuse
        // with an adjacent link ("apply here:⟪a⟫" instead of "apply here: ⟪a⟫").
        const lead = /^\s/.test(raw) ? ' ' : '';
        const trail = /\s$/.test(raw) ? ' ' : '';
        units.push({
          text,
          apply(en) {
            // A run that is exactly one element (a formatting wrapper like
            // <span class="esvlink-linktext">) keeps the element — the
            // translation goes inside it, so its classes/styling survive.
            if (nodes.length === 1 && nodes[0].nodeType === 1) {
              nodes[0].textContent = lead + en + trail;
              return;
            }
            nodes[0].before(document.createTextNode(lead + en + trail));
            nodes.forEach(n => n.remove());
          }
        });
      };
      for (const node of [...parent.childNodes]) {
        // Comments (server-template markers like <!-- Tagtyp eSV_Link -->)
        // are invisible: never translate them, never let them split a run.
        if (node.nodeType !== 1 && node.nodeType !== 3) continue;
        if (node.nodeType === 1 &&
            (node.classList.contains('ah-chip') || node.classList.contains('ah-gist') ||
             node.classList.contains('ah-explain') || node.matches(SKIP_KEEP_SELECTOR))) {
          flush();
          continue; // keep untouched, no text worth translating inside
        }
        if (node.nodeType === 1 &&
            (node.matches(KEEP_SELECTOR) || node.querySelector(KEEP_SELECTOR + ',' + SKIP_KEEP_SELECTOR))) {
          flush();
          walk(node); // translate the text inside, keep the element itself
          continue;
        }
        // Text-less elements are presentational — CSS-drawn icons like the
        // ÖGK accordion's <span class="sv-down">, spacer <i>s, and <br>s.
        // They must survive in place, never be consumed by a run.
        if (node.nodeType === 1 && !norm(node.textContent || '')) {
          flush();
          continue;
        }
        run.push(node);
      }
      flush();
    };
    walk(el);
    return units;
  }

  // Translates several short pieces that belong together. Chrome's on-device
  // translator is a fast local call per piece; Ollama gets them as one
  // batched request so a multi-link paragraph doesn't serialize into N slow
  // round trips.
  async function translateMany(texts) {
    if (settings.translateBackend === 'ollama' && texts.length > 1) {
      const stop = startSpinner('Translating with Ollama…');
      try {
        const res = await streamRequest({
          type: 'translateBatch',
          blocks: texts.map((t, i) => ({ n: i + 1, text: t })),
          context: { title: document.title }
        });
        if (!res?.ok) {
          throw new Error((res?.error || 'Ollama translation failed.') + (res?.hint ? ' ' + res.hint : ''));
        }
        const out = new Array(texts.length).fill('');
        for (const { n, en } of res.items || []) {
          if (n >= 1 && n <= texts.length && en) out[n - 1] = en;
        }
        return out;
      } finally {
        stop();
      }
    }
    const out = [];
    for (const t of texts) out.push(await translateText(t));
    return out;
  }

  // Translates a block in place, unit by unit, and returns the pageStore
  // patch: en (plain text, also the pre-enHtml legacy shape) plus enHtml
  // when structure was preserved. Restores the German on failure.
  async function translateElement(el) {
    if (!originalHtml.has(el)) originalHtml.set(el, el.innerHTML);
    const units = translationUnits(el);
    try {
      if (units.length <= 1 && !el.querySelector(KEEP_SELECTOR + ',' + SKIP_KEEP_SELECTOR)) {
        // Plain block: whole-text translation, streaming straight into it.
        const en = await translateText(blockText(el), partial => {
          if (el.isConnected) el.textContent = partial;
        });
        el.textContent = en;
        return { en, enHtml: null };
      }
      const ens = await translateMany(units.map(u => u.text));
      units.forEach((u, i) => { if (ens[i]) u.apply(ens[i]); });
      return { en: ens.filter(Boolean).join(' '), enHtml: el.children.length ? el.innerHTML : null };
    } catch (e) {
      el.innerHTML = originalHtml.get(el);
      underlineGlossaryTerms(el);
      throw e;
    }
  }

  // ---------- actions ----------

  async function translateBlock(el) {
    if (el.classList.contains('ah-translated')) {
      toggleLanguage(el);
      updateToolbar(el);
      return;
    }
    const hash = el.dataset.ahHash;
    const de = blockText(el);
    try {
      el.classList.add('ah-busy');
      const patch = await translateElement(el);
      await saveEntry(hash, { de, ...patch });
      finalizeEnglish(el);
    } catch (e) {
      toast(friendlyError(e), true);
    } finally {
      el.classList.remove('ah-busy');
      updateToolbar(el);
    }
  }

  // Nearest preceding heading, walking up through ancestors — gives the model
  // the section the passage sits in.
  // Context sent to the model should be the original German even when a
  // block is currently showing its translation (whose text also includes the
  // appended DE/EN chip label).
  function germanText(el) {
    return pageStore[el.dataset?.ahHash]?.de || blockText(el);
  }

  function nearestHeading(el) {
    let node = el;
    while (node && node !== document.body) {
      let sib = node.previousElementSibling;
      while (sib) {
        if (/^H[1-6]$/.test(sib.tagName)) return germanText(sib);
        const hs = sib.querySelectorAll?.('h1,h2,h3,h4,h5,h6');
        if (hs?.length) return germanText(hs[hs.length - 1]);
        sib = sib.previousElementSibling;
      }
      node = node.parentElement;
    }
    return '';
  }

  // Where the block sits on the page and what surrounds it — a passage like
  // "danach gilt Folgendes:" is meaningless without its neighbors, and "item
  // 3 of a requirements list" reads very differently from a standalone note.
  function blockNeighborhood(el) {
    const all = [...document.querySelectorAll('[data-ah-hash]')];
    const idx = all.indexOf(el);
    if (idx < 0) return {};
    const out = { position: `paragraph ${idx + 1} of ${all.length} on the page` };
    const before = all[idx - 1], after = all[idx + 1];
    if (before) out.before = germanText(before).slice(0, 300);
    if (after) out.after = germanText(after).slice(0, 300);
    return out;
  }

  // Explanations (and their follow-up chats) persist in pageStore[hash].explain
  // so X-ing the panel doesn't lose them; reopening replays from cache, and
  // "Re-explain" forces a fresh query.
  async function explainBlock(el) {
    const existing = el.nextElementSibling;
    if (existing?.classList?.contains('ah-explain')) {
      existing.remove();
      return;
    }
    const saved = pageStore[el.dataset.ahHash]?.explain;
    if (saved?.messages?.length >= 2) renderCachedExplain(el, saved);
    else await freshExplain(el);
  }

  function buildExplainPanel(el) {
    const panel = document.createElement('div');
    panel.className = 'ah-explain';
    panel.innerHTML =
      '<div class="ah-explain-head"><span class="ah-explain-title">Explaining…</span>' +
      '<span class="ah-explain-actions">' +
      '<button class="ah-explain-redo" type="button" title="Ask the model again from scratch" hidden>↻ Re-explain</button>' +
      '<button class="ah-explain-close" type="button" title="Close (kept for later)">×</button>' +
      '</span></div>' +
      '<div class="ah-explain-body">Asking the local model…</div>';
    panel.querySelector('.ah-explain-close').addEventListener('click', () => panel.remove());
    panel.querySelector('.ah-explain-redo').addEventListener('click', () => {
      panel.remove();
      freshExplain(el, true);
    });
    el.after(panel);
    return panel;
  }

  function renderCachedExplain(el, saved) {
    const panel = buildExplainPanel(el);
    panel.querySelector('.ah-explain-redo').hidden = false;
    panel.querySelector('.ah-explain-title').textContent =
      'What this means · ' + (saved.backend || '') + ' · saved';
    panel.querySelector('.ah-explain-body').textContent = saved.messages[1].content;
    panel._messages = saved.messages.slice();
    panel._backend = saved.backend;
    const row = addChatRow(panel, el);
    for (let i = 2; i + 1 < panel._messages.length; i += 2) {
      renderChatPair(panel, row, panel._messages[i].content, panel._messages[i + 1].content);
    }
  }

  async function freshExplain(el, force) {
    const de = pageStore[el.dataset.ahHash]?.de || blockText(el);
    const context = pageContext(ctxOn());
    context.heading = nearestHeading(el);
    Object.assign(context, blockNeighborhood(el));
    const panel = buildExplainPanel(el);
    const body = panel.querySelector('.ah-explain-body');
    const title = panel.querySelector('.ah-explain-title');

    // A local model reply can take anywhere from 2s to over a minute with no
    // other signal, so tick a live elapsed counter instead of a static
    // string — and once tokens start streaming in, show those instead.
    const label = force ? 'Re-asking the local model' : 'Asking the local model';
    body.classList.add('ah-explain-loading');
    const start = Date.now();
    const tick = () => { body.textContent = `${label}… ${Math.round((Date.now() - start) / 1000)}s`; };
    tick();
    const timer = setInterval(tick, 1000);
    let streaming = false;

    let res;
    try {
      res = await streamRequest({ type: 'explain', text: de, context }, {
        onDelta: (_d, text) => {
          if (!panel.isConnected) return;
          if (!streaming) {
            streaming = true;
            clearInterval(timer);
            body.classList.remove('ah-explain-loading');
          }
          body.textContent = text;
        }
      });
    } finally {
      clearInterval(timer);
      body.classList.remove('ah-explain-loading');
    }
    if (!panel.isConnected) return;
    // Shown on failure too — "Re-explain" doubles as the retry button (e.g.
    // after starting Ollama), saving a close-and-reopen round trip.
    panel.querySelector('.ah-explain-redo').hidden = false;
    if (res?.ok) {
      title.textContent = 'What this means · ' + (res.backend || '');
      body.textContent = res.text;
      panel._messages = [
        { role: 'user', content: res.userMsg },
        { role: 'assistant', content: res.text }
      ];
      panel._backend = res.backend;
      el.classList.add('ah-explained');
      await persistExplain(el, panel);
      addChatRow(panel, el);
      updateToolbar(el);
    } else {
      title.textContent = 'Explain failed';
      body.textContent = (res?.error || 'Unknown error') + (res?.hint ? '\n\n' + res.hint : '');
    }
  }

  function persistExplain(el, panel) {
    return saveEntry(el.dataset.ahHash, {
      de: pageStore[el.dataset.ahHash]?.de || blockText(el),
      explain: { messages: panel._messages, backend: panel._backend, ts: Date.now() }
    });
  }

  function renderChatPair(panel, row, q, a) {
    const qEl = document.createElement('div');
    qEl.className = 'ah-chat-q';
    qEl.textContent = q;
    panel.insertBefore(qEl, row);
    const aEl = document.createElement('div');
    aEl.className = 'ah-chat-a';
    aEl.textContent = a;
    panel.insertBefore(aEl, row);
    return aEl;
  }

  // Follow-up chat under an explanation: the transcript lives on the panel
  // element, is replayed to the model each turn, and is persisted after every
  // answer. Returns the input row so cached turns can be inserted above it.
  function addChatRow(panel, el) {
    const row = document.createElement('div');
    row.className = 'ah-chat-row';
    const input = document.createElement('input');
    input.className = 'ah-chat-input';
    input.type = 'text';
    input.placeholder = 'Ask a follow-up… (e.g. "which of these applies to me?")';
    const btn = document.createElement('button');
    btn.className = 'ah-chat-send';
    btn.type = 'button';
    btn.textContent = 'Ask';
    row.append(input, btn);
    panel.appendChild(row);

    const send = async () => {
      const q = input.value.trim();
      if (!q || btn.disabled) return;
      input.value = '';
      btn.disabled = true;
      const aEl = renderChatPair(panel, row, q, '…');
      aEl.classList.add('ah-explain-loading');
      const start = Date.now();
      const timer = setInterval(() => {
        aEl.textContent = `Thinking… ${Math.round((Date.now() - start) / 1000)}s`;
      }, 1000);
      aEl.textContent = 'Thinking…';
      let streaming = false;

      panel._messages.push({ role: 'user', content: q });
      let res;
      try {
        res = await streamRequest({ type: 'chat', messages: panel._messages }, {
          onDelta: (_d, text) => {
            if (!aEl.isConnected) return;
            if (!streaming) {
              streaming = true;
              clearInterval(timer);
              aEl.classList.remove('ah-explain-loading');
            }
            aEl.textContent = text;
          }
        });
      } finally {
        clearInterval(timer);
        aEl.classList.remove('ah-explain-loading');
      }
      if (res?.ok) {
        panel._messages.push({ role: 'assistant', content: res.text });
        aEl.textContent = res.text;
        persistExplain(el, panel);
      } else {
        panel._messages.pop();
        aEl.textContent = '⚠ ' + (res?.error || 'Unknown error') + (res?.hint ? ' — ' + res.hint : '');
      }
      btn.disabled = false;
      input.focus();
    };
    btn.addEventListener('click', send);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') send(); });
    return row;
  }

  async function toggleRead(el) {
    const hash = el.dataset.ahHash;
    const read = !el.classList.contains('ah-read');
    el.classList.toggle('ah-read', read);
    await saveEntry(hash, { de: pageStore[hash]?.de || blockText(el), read });
    updateToolbar(el);
  }

  async function addSelectionToGlossary(el) {
    const term = norm(String(getSelection() || ''));
    if (!term || term.length > 60) return;
    try {
      const translation = await translateText(term);
      glossary[term] = { translation, sourceUrl: location.href, ts: Date.now() };
      await saveGlossary();
      toast(`Added to glossary: ${term} → ${translation}`);
      getSelection()?.removeAllRanges();
      underlineGlossaryTerms(el);
      updateToolbar(el);
    } catch (e) {
      toast(friendlyError(e), true);
    }
  }

  // ---------- glossary underlines ----------

  function underlineGlossaryTerms(el) {
    const terms = Object.keys(glossary);
    if (!terms.length || el.classList.contains('ah-showing-en')) return;
    // select/textarea excluded: wrapping a span around option text mutates a
    // live form control (seen on ÖGK's appointment dropdown) — never do that.
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
      acceptNode: n =>
        n.parentElement.closest('.ah-term, .ah-chip, a, script, style, select, textarea')
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_ACCEPT
    });
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const node of nodes) {
      for (const term of terms) {
        const idx = node.data.indexOf(term);
        if (idx === -1) continue;
        const range = document.createRange();
        range.setStart(node, idx);
        range.setEnd(node, idx + term.length);
        const span = document.createElement('span');
        span.className = 'ah-term';
        span.title = glossary[term].translation;
        try { range.surroundContents(span); } catch { /* crosses markup; skip */ }
        break;
      }
    }
  }

  // ---------- select/dropdown cheat sheet ----------

  // Translating <option> text IN PLACE is unsafe: forms without value
  // attributes submit the label text itself (classic on old servlet-era
  // Austrian gov forms), and page JS often reads option text for its own
  // logic. So the dropdown is never modified — an EN chip beside it opens a
  // read-only panel mapping each German option to English; the user still
  // picks in the real (German) dropdown.
  const SELECT_MAX_OPTIONS = 100;

  function optionTexts(sel) {
    return [...sel.options].map(o => norm(o.textContent)).filter(Boolean).slice(0, SELECT_MAX_OPTIONS);
  }

  function attachCheatChip(el, title, onClick) {
    const chip = document.createElement('button');
    chip.className = 'ah-chip ah-select-chip';
    chip.type = 'button';
    chip.textContent = 'EN';
    chip.title = title;
    chip.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      onClick(chip);
    });
    el.after(chip);
  }

  function registerSelect(sel) {
    if (sel.dataset.ahSelect) return;
    if (sel.closest(OWN_UI_SELECTOR)) return;
    const texts = optionTexts(sel);
    if (texts.length < 2) return;
    if (!texts.some(t => /[a-zA-ZäöüÄÖÜß]{3}/.test(t))) return;
    sel.dataset.ahSelect = '1';
    attachCheatChip(sel,
      'Show these options in English (view only — the form itself is never changed)',
      chip => toggleCheatPanel(sel, chip, optionTexts(sel), {
        title: 'Options in English',
        foot: 'View only — pick your answer in the dropdown itself.',
        current: norm(sel.selectedOptions[0]?.textContent || ''),
        capNote: sel.options.length > SELECT_MAX_OPTIONS
      }));
  }

  // Submit/reset/button inputs: the value attribute is the visible label AND
  // what the form submits — old servlet backends sometimes branch on the
  // literal submit value, so it's as untouchable as option text. Same
  // read-only chip treatment ("Freie Termine anzeigen" on ÖGK's booking form
  // was the last untranslatable thing on the page).
  function registerInputButton(inp) {
    if (inp.dataset.ahSelect) return;
    if (inp.closest(OWN_UI_SELECTOR)) return;
    const de = norm(inp.value || '');
    if (de.length < MIN_LEN_INLINE || !/[a-zA-ZäöüÄÖÜß]{3}/.test(de)) return;
    inp.dataset.ahSelect = '1';
    attachCheatChip(inp,
      'Show this button in English (view only — the button itself is never changed)',
      chip => toggleCheatPanel(inp, chip, [de], {
        title: 'Button in English',
        foot: 'View only — the button itself keeps working exactly as before.'
      }));
  }

  let selectPanel = null;
  function closeSelectPanel() {
    selectPanel?.remove();
    selectPanel = null;
    removeEventListener('scroll', closeSelectPanel, true);
  }

  async function toggleCheatPanel(owner, chip, texts, { title, foot, current, capNote }) {
    if (selectPanel?._for === owner) { closeSelectPanel(); return; }
    closeSelectPanel();
    const hash = fnv1a('select:' + texts.join('\u0001'));
    const panel = document.createElement('div');
    panel.id = 'ah-select-panel';
    panel._for = owner;
    panel.innerHTML =
      '<div class="ah-select-head"><span class="ah-select-title"></span>' +
      '<button class="ah-select-close" type="button" title="Close">\u00d7</button></div>' +
      '<div class="ah-select-body">Translating\u2026</div>' +
      '<div class="ah-select-foot"></div>';
    panel.querySelector('.ah-select-title').textContent = title;
    panel.querySelector('.ah-select-foot').textContent = capNote
      ? `First ${SELECT_MAX_OPTIONS} options shown \u00b7 ${foot}`
      : foot;
    panel.querySelector('.ah-select-close').addEventListener('click', closeSelectPanel);
    document.documentElement.appendChild(panel);
    // Anchored under the chip; geometry needs !important to beat the
    // all:initial reset in content.css (see section-preview lesson).
    const r = chip.getBoundingClientRect();
    const set = (p, v) => panel.style.setProperty(p, v, 'important');
    set('top', Math.min(r.bottom + 6, innerHeight - 60) + 'px');
    set('left', Math.max(8, Math.min(r.left, innerWidth - 340)) + 'px');
    selectPanel = panel;
    // The panel doesn't follow the page; fold it away rather than drift.
    addEventListener('scroll', closeSelectPanel, true);
    // Once the user picks an option, the sheet has done its job.
    owner.addEventListener('change', closeSelectPanel, { once: true });

    let ens = pageStore[hash]?.optionsEn;
    if (!ens || ens.length !== texts.length) {
      try {
        ens = await translateMany(texts);
        await saveEntry(hash, { de: texts.join(' | '), optionsEn: ens });
      } catch (e) {
        if (panel.isConnected) panel.querySelector('.ah-select-body').textContent = friendlyError(e);
        return;
      }
    }
    if (!panel.isConnected) return;
    const body = panel.querySelector('.ah-select-body');
    body.textContent = '';
    texts.forEach((de, i) => {
      const row = document.createElement('div');
      row.className = 'ah-select-row' + (current && de === current ? ' ah-select-current' : '');
      const deEl = document.createElement('span');
      deEl.className = 'ah-select-de';
      deEl.textContent = de;
      const enEl = document.createElement('span');
      enEl.className = 'ah-select-en';
      enEl.textContent = ens[i] || '\u2014';
      row.append(deEl, enEl);
      body.appendChild(row);
    });
  }

  // ---------- hover toolbar (shadow DOM) ----------

  let toolbarHost, toolbarShadow, toolbarEl;

  function buildToolbar() {
    toolbarHost = document.createElement('div');
    toolbarHost.id = 'ah-toolbar-host';
    toolbarHost.style.cssText =
      'position:absolute;z-index:2147483646;display:none;top:0;left:0;';
    toolbarShadow = toolbarHost.attachShadow({ mode: 'open' });
    toolbarShadow.innerHTML = `
      <style>
        .bar {
          display: flex; flex-direction: column; gap: 2px; padding: 3px;
          background: #1f2933; border-radius: 8px;
          box-shadow: 0 2px 10px rgba(0,0,0,.35);
          font: 12px/1 -apple-system, system-ui, sans-serif;
        }
        button {
          all: unset; cursor: pointer; color: #e4e7eb;
          padding: 5px 9px; border-radius: 5px; white-space: nowrap;
          text-align: left;
        }
        button:hover { background: #3e4c59; }
        button.hidden { display: none; }
        button.on { color: #7ce0a3; }
        button.ctx {
          font-size: 10.5px; color: #9aa5b1;
          border-top: 1px solid #3e4c59; border-radius: 0 0 5px 5px;
          margin-top: 1px; padding-top: 6px;
        }
        button.ctx.on { color: #7ce0a3; }
      </style>
      <div class="bar">
        <button data-act="translate">Translate</button>
        <button data-act="section" class="hidden" title="Translate the whole surrounding section — hover to see exactly what it grabs">Translate section</button>
        <button data-act="explain">Explain</button>
        <button data-act="read">✓ Read</button>
        <button data-act="glossary" class="hidden">＋ Glossary</button>
        <button data-act="ctx" class="ctx" title="Include the whole page as context for Explain (and Ollama translation) — toggles per request">page ctx ✓</button>
      </div>`;
    toolbarEl = toolbarShadow.querySelector('.bar');
    toolbarEl.addEventListener('mouseenter', () => clearTimeout(hideTimer));
    toolbarEl.addEventListener('mouseleave', scheduleHide);
    toolbarEl.addEventListener('click', e => {
      const act = e.target?.dataset?.act;
      if (!act || !currentBlock) return;
      if (act === 'translate') translateBlock(currentBlock);
      if (act === 'section' && currentSection?.el) {
        hideSectionPreview();
        translateWholePage(currentSection.el)
          .then(() => currentBlock && updateToolbar(currentBlock));
      }
      if (act === 'explain') explainBlock(currentBlock);
      if (act === 'read') toggleRead(currentBlock);
      if (act === 'glossary') addSelectionToGlossary(currentBlock);
      if (act === 'ctx') toggleCtx().then(() => updateToolbar(currentBlock));
    });
    // Dev-tools-style clarity: while the pointer rests on "Translate
    // section", the exact stretch of page it would grab lights up.
    toolbarEl.addEventListener('mouseover', e => {
      if (e.target?.dataset?.act === 'section') showSectionPreview();
    });
    toolbarEl.addEventListener('mouseout', e => {
      if (e.target?.dataset?.act === 'section') hideSectionPreview();
    });
    document.documentElement.appendChild(toolbarHost);
  }

  // The section on offer for the hovered block: the nearest ancestor that
  // would translate MORE than the block itself does — i.e. hovering one
  // paragraph offers its whole card/article, not a chain of wrappers around
  // the same paragraph. Bare list containers (ul/ol/dl) are stepped through:
  // hovering a wizard answer should offer the whole question card, not just
  // the answer list. Never offers <body> (that's "Translate whole page").
  let currentSection = null;
  function sectionFor(el) {
    const base = untranslatedVisibleIn(el, el).blocks.length;
    let node = el.parentElement;
    while (node && node !== document.body) {
      if (!/^(UL|OL|DL)$/.test(node.tagName)) {
        const count = untranslatedVisibleIn(node, node).blocks.length;
        if (count > base) return { el: node, count };
      }
      node = node.parentElement;
    }
    return null;
  }

  let sectionBox = null;
  function showSectionPreview() {
    if (!currentSection?.el?.isConnected) return;
    if (!sectionBox) {
      sectionBox = document.createElement('div');
      sectionBox.id = 'ah-section-box';
      sectionBox.innerHTML = '<div id="ah-section-label"></div>';
      document.documentElement.appendChild(sectionBox);
    }
    const r = currentSection.el.getBoundingClientRect();
    // content.css hardens #ah-section-box with all:initial !important, and
    // stylesheet !important beats plain inline styles — geometry has to be
    // written with priority or the box never actually shows.
    const set = (p, v) => sectionBox.style.setProperty(p, v, 'important');
    set('display', 'block');
    set('top', r.top + 'px');
    set('left', r.left + 'px');
    set('width', r.width + 'px');
    set('height', r.height + 'px');
    sectionBox.querySelector('#ah-section-label').textContent =
      `Translate ${currentSection.count} block${currentSection.count > 1 ? 's' : ''}`;
  }

  function hideSectionPreview() {
    sectionBox?.style.setProperty('display', 'none', 'important');
  }

  function updateToolbar(el) {
    if (!toolbarShadow || el !== currentBlock) return;
    const btn = a => toolbarShadow.querySelector(`[data-act="${a}"]`);
    btn('translate').textContent = !el.classList.contains('ah-translated')
      ? 'Translate'
      : el.classList.contains('ah-showing-en') ? 'Show DE' : 'Show EN';
    currentSection = sectionFor(el);
    btn('section').classList.toggle('hidden', !currentSection);
    if (currentSection) {
      btn('section').textContent = `Translate section (${currentSection.count})`;
    }
    btn('read').classList.toggle('on', el.classList.contains('ah-read'));
    btn('read').textContent = el.classList.contains('ah-read') ? '✓ Read' : 'Mark read';
    const hasExplain = !!pageStore[el.dataset.ahHash]?.explain;
    btn('explain').classList.toggle('on', hasExplain);
    btn('explain').textContent = hasExplain ? 'Explanation ✓' : 'Explain';
    const sel = norm(String(getSelection() || ''));
    const inBlock = sel && el.contains(getSelection()?.anchorNode || null);
    btn('glossary').classList.toggle('hidden', !inBlock || sel.length > 60);
    btn('ctx').textContent = ctxOn() ? 'page ctx ✓' : 'page ctx ✗';
    btn('ctx').classList.toggle('on', ctxOn());
  }

  // Sits beside the block (right if there's room, else left) so it never
  // covers the text above or below; only falls back to "above" when both
  // gutters are too narrow.
  function showToolbarFor(el) {
    clearTimeout(hideTimer);
    currentBlock = el;
    setHover(el);
    updateToolbar(el);
    const r = el.getBoundingClientRect();
    toolbarHost.style.display = 'block';
    const bw = toolbarEl.offsetWidth || 110;
    const bh = toolbarEl.offsetHeight || 110;
    // Some embedded shells report a zero viewport; assume a sane size there.
    const vw = innerWidth || document.documentElement.clientWidth || 1280;
    const vh = innerHeight || document.documentElement.clientHeight || 800;
    const gap = 8;
    let left, top;
    if (r.right + gap + bw <= vw - 4) {
      left = r.right + gap;
      top = r.top;
    } else if (r.left - gap - bw >= 4) {
      left = r.left - gap - bw;
      top = r.top;
    } else {
      left = Math.max(4, Math.min(r.left, vw - bw - 4));
      top = r.top - bh - 6;
    }
    top = Math.max(4, Math.min(top, vh - bh - 4));
    toolbarHost.style.top = top + scrollY + 'px';
    toolbarHost.style.left = left + scrollX + 'px';
  }

  // Gentle highlight on the block currently under the toolbar, so it's clear
  // which element an action will apply to.
  let hoveredEl = null;
  function setHover(el) {
    if (hoveredEl === el) return;
    hoveredEl?.classList.remove('ah-hover');
    hoveredEl = el;
    el?.classList.add('ah-hover');
  }

  function scheduleHide() {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      toolbarHost.style.display = 'none';
      currentBlock = null;
      setHover(null);
      hideSectionPreview();
    }, 350);
  }

  let hoverHandlers = null;
  function wireHover() {
    const over = e => {
      const el = e.target?.closest?.('[data-ah-hash]');
      if (el) showToolbarFor(el);
      else if (currentBlock && !toolbarHost.contains(e.target)) scheduleHide();
    };
    const selch = () => {
      if (currentBlock) updateToolbar(currentBlock);
    };
    // Keep glossary button in sync right after a mouse selection.
    const up = () => {
      if (currentBlock) setTimeout(() => currentBlock && updateToolbar(currentBlock), 0);
    };
    document.addEventListener('mouseover', over);
    document.addEventListener('selectionchange', selch);
    document.addEventListener('mouseup', up);
    hoverHandlers = { over, selch, up };
  }

  function unwireHover() {
    if (!hoverHandlers) return;
    document.removeEventListener('mouseover', hoverHandlers.over);
    document.removeEventListener('selectionchange', hoverHandlers.selch);
    document.removeEventListener('mouseup', hoverHandlers.up);
    hoverHandlers = null;
  }

  // ---------- English-version banner ----------

  // Best English-version link, most specific first:
  //   1. hreflang alternate declared by the page (points at THIS page's EN version)
  //   2. a mirrored same-host path (/en/..., /english/...) that actually resolves
  //   3. the page's own language-switch link (usually the EN homepage)
  //   4. hardcoded homepage fallbacks for known Austrian gov sites
  // Returns { url, pageSpecific } or null.
  async function englishVersionUrl() {
    const here = location.href;
    const alt = document.querySelector('link[rel="alternate"][hreflang^="en"]');
    if (alt?.href && alt.href !== here) return { url: alt.href, pageSpecific: true };

    const path = location.pathname;
    if (!/^\/(en|english)(\/|$)/i.test(path)) {
      const candidates = [...new Set([
        '/en' + path,
        '/english' + path,
        path.replace(/^\/de(?=\/|$)/, '/en')
      ])].filter(c => c !== path);
      for (const c of candidates) {
        try {
          const res = await fetch(location.origin + c, { method: 'HEAD', redirect: 'follow' });
          if (!res.ok) continue;
          // Reject soft-redirects back to a homepage or to the page we're on.
          const final = new URL(res.url);
          const fp = final.pathname.replace(/\/+$/, '');
          if (final.href === here || fp === '' || /^\/(en|english)$/i.test(fp)) continue;
          return { url: res.url, pageSpecific: true };
        } catch { /* offline, CSP, or blocked HEAD — try the next candidate */ }
      }
    }

    const switcher = document.querySelector('a[hreflang^="en"][href]') ||
      [...document.querySelectorAll('a[href]')].find(a => /^english$/i.test(a.textContent.trim()));
    if (switcher?.href && switcher.href !== here) return { url: switcher.href, pageSpecific: false };

    const h = location.hostname;
    if (h.endsWith('wien.gv.at') && !path.startsWith('/english')) {
      return { url: 'https://www.wien.gv.at/english/', pageSpecific: false };
    }
    if (h.endsWith('oesterreich.gv.at') && !path.startsWith('/en')) {
      return { url: 'https://www.oesterreich.gv.at/en.html', pageSpecific: false };
    }
    return null;
  }

  async function maybeShowBanner() {
    if (sessionStorage.getItem('ah-banner-dismissed')) return;
    const found = await englishVersionUrl();
    if (!found) return;
    const banner = document.createElement('div');
    banner.id = 'ah-banner';
    const link = document.createElement('a');
    link.href = found.url;
    link.textContent = found.pageSpecific
      ? 'This page has an official English version →'
      : 'This site has an official English version →';
    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = '×';
    close.title = 'Dismiss';
    close.addEventListener('click', () => {
      sessionStorage.setItem('ah-banner-dismissed', '1');
      banner.remove();
    });
    banner.append(link, close);
    document.body.appendChild(banner);
  }

  // Streaming request over a dedicated port: the background posts {delta,
  // text} (token progress) and {item} ({n,…} objects as they complete in a
  // batched JSON response) messages, then a final {done} with the same shape
  // sendMessage would have returned. Never rejects — errors come back as
  // { ok: false } results so call sites read uniformly.
  // Self-healing: an MV3 service worker that's been idle a long time (laptop
  // slept, tab sat in the background) occasionally fails to wake on connect
  // and drops the port instantly with "Receiving end does not exist" — a
  // short-delay retry almost always succeeds, so only give up after a few.
  // A port that dies MID-stream is not retried (the operation may have
  // side effects half-applied; the caller's error toast is honest there).
  function streamRequest(payload, handlers) {
    return attemptStream(payload, handlers, 2);
  }

  function attemptStream(payload, { onDelta, onItem } = {}, retries) {
    return new Promise(resolve => {
      let port;
      try {
        port = chrome.runtime.connect({ name: 'ah-stream' });
      } catch (e) {
        resolve({ ok: false, error: friendlyError(e) });
        return;
      }
      let settled = false;
      let streamStarted = false;
      const started = Date.now();
      port.onMessage.addListener(m => {
        streamStarted = true;
        if (m.done) {
          settled = true;
          resolve(m.done);
          port.disconnect();
        } else if (m.item) {
          try { onItem?.(m.item); } catch { /* keep streaming */ }
        } else if (m.delta != null) {
          try { onDelta?.(m.delta, m.text); } catch { /* keep streaming */ }
        }
      });
      port.onDisconnect.addListener(() => {
        if (settled) return;
        settled = true;
        if (!streamStarted && retries > 0 && Date.now() - started < 2000) {
          setTimeout(() => resolve(attemptStream(payload, { onDelta, onItem }, retries - 1)), 300);
          return;
        }
        resolve({ ok: false, error: friendlyError(chrome.runtime.lastError?.message || 'Lost connection to the extension.') });
      });
      port.postMessage(payload);
    });
  }

  // chrome.runtime.sendMessage throws this when the tab's content script has
  // outlived the background worker it's talking to (classically: the
  // extension was just reloaded from chrome://extensions) — point the user
  // at the actual fix instead of surfacing the cryptic Chrome message.
  function friendlyError(e) {
    const msg = String(e?.message || e);
    if (/Extension context invalidated|Receiving end does not exist/.test(msg)) {
      return 'Lost connection to the extension, and retrying didn\'t help. Try again in a moment; refresh the page if it keeps happening.';
    }
    return msg;
  }

  // ---------- toast ----------

  let toastEl, toastTimer;
  // `opts.sticky` keeps the toast visible with a spinner until the caller's
  // next toast() call replaces it — a plain toast always auto-hides after 4s,
  // which used to make long Ollama calls look like they'd silently died.
  function toast(msg, opts = false) {
    if (typeof opts === 'boolean') opts = { isError: opts };
    const { isError = false, sticky = false } = opts;
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.id = 'ah-toast';
      toastEl.innerHTML = '<span class="ah-toast-spinner"></span><span class="ah-toast-text"></span>';
      document.documentElement.appendChild(toastEl);
    }
    toastEl.querySelector('.ah-toast-text').textContent = msg;
    toastEl.classList.toggle('ah-toast-error', isError);
    toastEl.classList.toggle('ah-toast-busy', sticky);
    toastEl.classList.add('ah-toast-show');
    clearTimeout(toastTimer);
    if (!sticky) {
      toastTimer = setTimeout(() => toastEl.classList.remove('ah-toast-show'), 4000);
    }
  }

  // Ticks a sticky "label · Ns" toast for the duration of a slow async call.
  // Returns a stop function; call it once the operation settles. Not every
  // call site shows its own follow-up toast (e.g. a successful single-block
  // translate), so stop() itself un-sticks the toast and starts its normal
  // 4s auto-hide — otherwise the spinner would freeze on screen forever. A
  // caller that does show its own toast() right after just overrides it.
  // Spinners share the single toast, so a refcount keeps one operation's
  // stop() from un-sticking the toast out from under another still running.
  // The returned stop() also carries a setLabel(newLabel) for callers whose
  // progress text changes mid-operation (e.g. a streaming x/y counter).
  let activeSpinners = 0;
  function startSpinner(label) {
    const start = Date.now();
    const tick = () => toast(`${label} · ${Math.round((Date.now() - start) / 1000)}s`, { sticky: true });
    tick();
    const timer = setInterval(tick, 1000);
    activeSpinners++;
    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      activeSpinners--;
      if (activeSpinners > 0 || !toastEl) return;
      toastEl.classList.remove('ah-toast-busy');
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => toastEl.classList.remove('ah-toast-show'), 4000);
    };
    stop.setLabel = l => {
      label = l;
      if (!stopped) tick();
    };
    return stop;
  }

  // ---------- page-level actions (from the popup) ----------

  const isVisible = el => el.checkVisibility ? el.checkVisibility() : el.offsetParent !== null;

  function untranslatedVisibleIn(scope, root) {
    const all = [
      ...(root?.matches?.('[data-ah-hash]') ? [root] : []),
      ...scope.querySelectorAll('[data-ah-hash]')
    ].filter(el => !el.classList.contains('ah-translated'));
    const blocks = all.filter(isVisible);
    return { blocks, hidden: all.length - blocks.length };
  }

  // After a full-page pass, keep translating content that renders late —
  // SPAs (post.at tracking) mount whole sidebars seconds after load, which
  // used to leave them German because the one-shot pass had already run.
  let followPageTranslate = false;
  let pageTranslating = false;

  async function translateWholePage(root) {
    // Skip invisible blocks: pages like wien.gv.at keep an entire mega-menu,
    // cookie dialog, and share widgets in hidden containers — often more text
    // than the visible article. Translating those through a local LLM is what
    // made whole-page passes take minutes. Hidden blocks still translate on
    // hover if they're ever revealed.
    if (pageTranslating) return;
    pageTranslating = true;
    try {
      const { blocks, hidden } = untranslatedVisibleIn(root || document, root);
      if (!blocks.length) {
        toast(hidden
          ? `Nothing visible left to translate (${hidden} blocks are in hidden menus/dialogs — they translate on hover when shown).`
          : root ? 'Nothing left to translate in that section.' : 'Nothing left to translate on this page.');
        if (!root) followPageTranslate = true;
        return;
      }
      const hiddenNote = hidden
        ? `\n${hidden} hidden blocks (menus/dialogs) skipped — they translate on hover when shown.`
        : '';
      const ok = settings.translateBackend === 'ollama'
        ? await translateBlocksOllama(blocks, hiddenNote)
        : await translateBlocksChrome(blocks, hiddenNote);
      // Only keep following on success — a dead Ollama shouldn't retrigger
      // an error toast on every DOM mutation.
      if (!root) followPageTranslate = ok !== false;
    } finally {
      pageTranslating = false;
    }
  }

  // Chrome's on-device translator is a fast local call per unit with no
  // network hop, so a simple loop is already quick — no batching needed.
  async function translateBlocksChrome(blocks, hiddenNote = '') {
    let done = 0;
    for (const el of blocks) {
      try {
        const de = blockText(el);
        const patch = await translateElement(el);
        await saveEntry(el.dataset.ahHash, { de, ...patch });
        finalizeEnglish(el);
      } catch (e) {
        toast(friendlyError(e), true);
        return false;
      }
      done++;
      if (done % 5 === 0 || done === blocks.length) {
        toast(`Translating page… ${done}/${blocks.length}`);
      }
    }
    toast(`Page translated (${done} blocks). Each keeps its DE/EN toggle.${hiddenNote}`);
    return true;
  }

  // Ollama translates a whole page's worth of text per request instead of
  // one call per block — each call previously re-sent the full page as
  // context just to translate one snippet, which serialized behind Ollama
  // and made large pages crawl. The batch is built from translation UNITS
  // (a block's plain runs and kept-element texts), so links and buttons
  // survive here exactly like in single-block translation. Chunked by char
  // budget so nothing is dropped on very long pages; a block's units always
  // share one chunk so its terminology stays consistent.
  async function translateBlocksOllama(blocks, hiddenNote = '') {
    const jobs = blocks.map(el => {
      if (!originalHtml.has(el)) originalHtml.set(el, el.innerHTML);
      return { el, de: blockText(el), units: translationUnits(el), ens: [], applied: 0 };
    }).filter(j => j.units.length);

    const chunks = [];
    let cur = [], curLen = 0;
    for (const job of jobs) {
      const len = job.units.reduce((s, u) => s + u.text.length, 0);
      if (curLen + len > 6000 && cur.length) { chunks.push(cur); cur = []; curLen = 0; }
      for (let i = 0; i < job.units.length; i++) cur.push({ job, i });
      curLen += len;
    }
    if (cur.length) chunks.push(cur);

    let done = 0;
    for (let ci = 0; ci < chunks.length; ci++) {
      const chunk = chunks[ci];
      const pass = chunks.length > 1 ? ` (pass ${ci + 1}/${chunks.length})` : '';
      const stop = startSpinner(`Translating with Ollama… ${done}/${jobs.length}${pass}`);
      // Each unit lands the moment its {n, en} object completes in the
      // streamed JSON — the page fills in progressively and the counter
      // ticks up instead of everything appearing at once at the end.
      const applied = new Map();
      const applyItem = ({ n, en }) => {
        if (applied.has(n)) return applied.get(n);
        const p = (async () => {
          const entry = chunk[n - 1];
          if (!entry || !en) return;
          const { job, i } = entry;
          if (!job.el.isConnected) return;
          job.units[i].apply(en);
          job.ens[i] = en;
          if (++job.applied < job.units.length) return;
          // Last unit of this block: persist and finish it.
          const enHtml = job.el.children.length ? job.el.innerHTML : null;
          await saveEntry(job.el.dataset.ahHash, {
            de: job.de,
            en: job.ens.filter(Boolean).join(' '),
            enHtml
          });
          finalizeEnglish(job.el);
          done++;
          stop.setLabel(`Translating with Ollama… ${done}/${jobs.length}${pass}`);
        })();
        applied.set(n, p);
        return p;
      };
      let res;
      try {
        res = await streamRequest({
          type: 'translateBatch',
          blocks: chunk.map((entry, i) => ({ n: i + 1, text: entry.job.units[entry.i].text })),
          context: { title: document.title }
        }, { onItem: applyItem });
      } finally {
        stop();
      }
      if (!res?.ok) {
        toast((res?.error || 'Translation failed.') + (res?.hint ? ' ' + res.hint : ''), true);
        return false;
      }
      // Authoritative final list — applies anything the streaming scan
      // missed and waits out items it already started.
      for (const item of res.items || []) await applyItem(item);
      await Promise.all(applied.values());
    }
    toast(`Page translated (${done}/${jobs.length} blocks). Each keeps its DE/EN toggle.${hiddenNote}`);
    return true;
  }

  // Content blocks worth a gist: skip page chrome (nav/header/breadcrumb) and
  // short standalone links/buttons, but keep short section headings.
  function gistEligible(el) {
    const text = pageStore[el.dataset.ahHash]?.de || blockText(el);
    if (text.length < 15) return false;
    // Hidden containers (mega-menus, cookie dialogs) sit outside <nav> on
    // web-component sites, so the chrome filter below misses them.
    if (!(el.checkVisibility ? el.checkVisibility() : el.offsetParent !== null)) return false;
    if (el.closest('header, nav, [role="navigation"], .navbar, .breadcrumb, #skiplinks')) return false;
    if ((el.tagName === 'A' || el.tagName === 'BUTTON') && text.length < 60) return false;
    return true;
  }

  // A one-line English gist appears under each paragraph while the German stays.
  // Batched by char budget so nothing is dropped on long pages. Toggles off.
  async function toggleGists() {
    const existing = document.querySelectorAll('.ah-gist');
    if (existing.length) { existing.forEach(g => g.remove()); return; }

    const eligible = [...document.querySelectorAll('[data-ah-hash]')].filter(gistEligible);
    if (!eligible.length) { toast('No paragraphs found to summarize.'); return; }

    // Chunk in document order so a long page becomes several passes, not a
    // truncated single request.
    const chunks = [];
    let cur = [], curLen = 0;
    for (const el of eligible) {
      const text = pageStore[el.dataset.ahHash]?.de || blockText(el);
      if (curLen + text.length > 6000 && cur.length) { chunks.push(cur); cur = []; curLen = 0; }
      cur.push({ el, text });
      curLen += text.length;
    }
    if (cur.length) chunks.push(cur);

    let shown = 0;
    for (let ci = 0; ci < chunks.length; ci++) {
      const chunk = chunks[ci];
      const pass = chunks.length > 1 ? ` (pass ${ci + 1}/${chunks.length})` : '';
      const stop = startSpinner(`Summarizing… ${shown}/${eligible.length}${pass}`);
      // Gists appear under their paragraphs as each one completes in the
      // streamed JSON rather than all at once at the end.
      const applied = new Set();
      const applyGist = ({ n, g }) => {
        if (applied.has(n)) return;
        applied.add(n);
        const block = chunk[n - 1];
        if (!block?.el?.isConnected || !g) return;
        if (block.el.nextElementSibling?.classList?.contains('ah-gist')) return;
        const gist = document.createElement('div');
        gist.className = 'ah-gist';
        gist.textContent = '≈ ' + g;
        block.el.after(gist);
        shown++;
        stop.setLabel(`Summarizing… ${shown}/${eligible.length}${pass}`);
      };
      let res;
      try {
        res = await streamRequest({
          type: 'gists',
          blocks: chunk.map((b, i) => ({ n: i + 1, text: b.text })),
          context: { title: document.title }
        }, { onItem: applyGist });
      } finally {
        stop();
      }
      if (!res?.ok) {
        toast((res?.error || 'Gists failed.') + (res?.hint ? ' ' + res.hint : ''), true);
        return;
      }
      // Authoritative final list — applies anything the streaming scan missed.
      for (const item of res.gists || []) applyGist(item);
    }
    toast(`Added ${shown} gists. Click "AI gists" again to clear them.`);
  }

  // ---------- ask-the-page agent ----------

  // The model picks block numbers off the registry we send it; it never sees
  // or produces selectors or code, so a page (untrusted input!) can at worst
  // steer which of its own paragraphs get highlighted.
  async function askPage(q) {
    clearAgentHits();
    const els = [...document.querySelectorAll('[data-ah-hash]')];
    if (!els.length) { toast('No text blocks found on this page.', true); return; }

    // Trim per-block and cap the total so huge pages still fit one request.
    const blocks = [];
    let total = 0;
    for (let i = 0; i < els.length; i++) {
      const text = germanText(els[i]).slice(0, 200);
      if (total + text.length > 15000) break;
      blocks.push({ n: i + 1, text });
      total += text.length;
    }

    const stop = startSpinner('Asking the local model about this page…');
    let res;
    try {
      res = await streamRequest({ type: 'agent', q, blocks, context: { title: document.title } });
    } finally {
      stop();
    }
    if (!res?.ok) {
      toast((res?.error || 'Ask failed.') + (res?.hint ? ' ' + res.hint : ''), true);
      return;
    }

    const hitCount = applyAgentHighlights(res, els);
    showAgentPanel(q, res, hitCount, els, blocks.length);
  }

  // Badge each hit with its block number so inline citations in the
  // answer ("see [30]") point at something the user can actually find.
  // Returns how many hits landed; scrolls to the most relevant one.
  function applyAgentHighlights(res, els) {
    const hits = [];
    for (const n of res.highlight || []) {
      const el = els[n - 1];
      if (!el?.isConnected) continue;
      el.classList.add('ah-agent-hit');
      el.dataset.ahAgentN = n;
      hits.push(el);
    }
    const target = (res.scrollTo && els[res.scrollTo - 1]?.isConnected && els[res.scrollTo - 1]) || hits[0];
    target?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return hits.length;
  }

  function clearAgentHighlights() {
    document.querySelectorAll('.ah-agent-hit').forEach(el => {
      el.classList.remove('ah-agent-hit');
      delete el.dataset.ahAgentN;
    });
  }

  function clearAgentHits() {
    clearAgentHighlights();
    document.getElementById('ah-agent-panel')?.remove();
  }

  function agentFootText(hitCount) {
    return hitCount
      ? `${hitCount} passage${hitCount > 1 ? 's' : ''} highlighted on the page`
      : 'Nothing on the page to point at for this one';
  }

  function showAgentPanel(q, res, hitCount, els, maxN) {
    const panel = document.createElement('div');
    panel.id = 'ah-agent-panel';
    panel.innerHTML =
      '<div class="ah-agent-head"><span class="ah-agent-title"></span>' +
      '<button class="ah-agent-close" type="button" title="Close and clear highlights">×</button></div>' +
      '<div class="ah-agent-scroll"><div class="ah-agent-q"></div><div class="ah-agent-body"></div></div>' +
      '<div class="ah-agent-foot"></div>';
    panel.querySelector('.ah-agent-title').textContent = 'Answer · ' + (res.backend || '');
    panel.querySelector('.ah-agent-q').textContent = q;
    renderAgentAnswer(panel.querySelector('.ah-agent-body'), res.answer, els);
    panel.querySelector('.ah-agent-foot').textContent = agentFootText(hitCount);
    panel.querySelector('.ah-agent-close').addEventListener('click', clearAgentHits);
    // Follow-up chat: the transcript (raw JSON turns, so the model stays in
    // its answer/highlight format) lives on the panel; each new answer
    // re-highlights and re-cites, replacing the previous highlights.
    panel._messages = [
      { role: 'user', content: res.userMsg },
      { role: 'assistant', content: res.raw }
    ];
    addAgentChatRow(panel, els, maxN);
    document.documentElement.appendChild(panel);
  }

  function addAgentChatRow(panel, els, maxN) {
    const row = document.createElement('div');
    row.className = 'ah-chat-row';
    const input = document.createElement('input');
    input.className = 'ah-chat-input';
    input.type = 'text';
    input.placeholder = 'Ask a follow-up about this page…';
    const btn = document.createElement('button');
    btn.className = 'ah-chat-send';
    btn.type = 'button';
    btn.textContent = 'Ask';
    row.append(input, btn);
    panel.insertBefore(row, panel.querySelector('.ah-agent-foot'));

    const scroll = panel.querySelector('.ah-agent-scroll');
    const send = async () => {
      const q = input.value.trim();
      if (!q || btn.disabled) return;
      input.value = '';
      btn.disabled = true;
      const qEl = document.createElement('div');
      qEl.className = 'ah-chat-q';
      qEl.textContent = q;
      const aEl = document.createElement('div');
      aEl.className = 'ah-chat-a ah-explain-loading';
      scroll.append(qEl, aEl);
      scroll.scrollTop = scroll.scrollHeight;
      const start = Date.now();
      const timer = setInterval(() => {
        aEl.textContent = `Thinking… ${Math.round((Date.now() - start) / 1000)}s`;
      }, 1000);
      aEl.textContent = 'Thinking…';

      panel._messages.push({ role: 'user', content: q });
      let res;
      try {
        res = await streamRequest({ type: 'agentChat', messages: panel._messages, maxN });
      } finally {
        clearInterval(timer);
        aEl.classList.remove('ah-explain-loading');
      }
      if (res?.ok) {
        panel._messages.push({ role: 'assistant', content: res.raw });
        aEl.textContent = '';
        renderAgentAnswer(aEl, res.answer, els);
        clearAgentHighlights();
        const hitCount = applyAgentHighlights(res, els);
        panel.querySelector('.ah-agent-foot').textContent = agentFootText(hitCount);
      } else {
        panel._messages.pop();
        aEl.textContent = '⚠ ' + (res?.error || 'Unknown error') + (res?.hint ? ' — ' + res.hint : '');
      }
      scroll.scrollTop = scroll.scrollHeight;
      btn.disabled = false;
      input.focus();
    };
    btn.addEventListener('click', send);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') send(); });
  }

  // Inline [N] citations become buttons that jump to the (already
  // highlighted, badge-numbered) block on the page.
  function renderAgentAnswer(body, answer, els) {
    for (const part of answer.split(/(\[\d+\])/)) {
      const m = part.match(/^\[(\d+)\]$/);
      const el = m && els[Number(m[1]) - 1];
      if (el?.isConnected) {
        const btn = document.createElement('button');
        btn.className = 'ah-agent-ref';
        btn.type = 'button';
        btn.textContent = part;
        btn.title = 'Jump to this passage';
        btn.addEventListener('click', () => el.scrollIntoView({ behavior: 'smooth', block: 'center' }));
        body.appendChild(btn);
      } else if (part) {
        body.appendChild(document.createTextNode(part));
      }
    }
  }

  // ---------- activation & popup control ----------

  let active = false;
  let observer = null;

  async function activate() {
    if (active || retired) return;
    active = true;
    await loadState();
    if (!toolbarHost) buildToolbar();
    scanBlocks();
    wireHover();
    maybeShowBanner();

    // Register blocks added later (accordions, lazy content) — and if a
    // whole-page translate already ran, catch late arrivals up to English.
    let debounce;
    observer = new MutationObserver(() => {
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        scanBlocks();
        if (followPageTranslate && !pageTranslating &&
            untranslatedVisibleIn(document).blocks.length) {
          translateWholePage();
        }
      }, 800);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // Puts the page back the way we found it: German text restored, chips,
  // panels, and underlines removed, listeners gone. The page keeps working
  // without a reload, and saved state stays in storage for re-enabling.
  function deactivate() {
    if (!active) return;
    active = false;
    followPageTranslate = false;
    observer?.disconnect();
    observer = null;
    unwireHover();
    for (const el of document.querySelectorAll('[data-ah-hash]')) {
      if (el.classList.contains('ah-showing-en') && originalHtml.has(el)) {
        el.innerHTML = originalHtml.get(el);
      }
      el._ahChip?.remove();
      el.classList.remove('ah-translated', 'ah-showing-en', 'ah-read', 'ah-hover',
        'ah-explained', 'ah-agent-hit', 'ah-busy');
      delete el.dataset.ahHash;
      delete el.dataset.ahAgentN;
    }
    document.querySelectorAll('.ah-term').forEach(s => s.replaceWith(s.textContent));
    document.querySelectorAll('.ah-gist, .ah-explain, .ah-chip, #ah-agent-panel, #ah-banner, #ah-toast, #ah-toolbar-host, #ah-section-box')
      .forEach(n => n.remove());
    closeSelectPanel();
    document.querySelectorAll('[data-ah-select]').forEach(s => delete s.dataset.ahSelect);
    sectionBox = null;
    currentSection = null;
    toolbarHost = toolbarShadow = toolbarEl = null;
    toastEl = null;
    currentBlock = null;
    hoveredEl = null;
    originalHtml.clear();
  }

  async function setOverride(value) {
    const { overrides = {} } = await chrome.storage.local.get('overrides');
    if (value) overrides[pageKey] = value;
    else delete overrides[pageKey];
    await chrome.storage.local.set({ overrides });
    if (value === 'on') await activate();
    if (value === 'off') deactivate();
    // Back to auto while dormant: give detection one immediate shot so the
    // popup reflects reality without a reload.
    if (!value && !active && await pageIsGerman() === true) await activate();
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === 'status') {
      sendResponse({ ok: true, active });
      return;
    }
    if (msg?.type === 'setOverride') {
      setOverride(msg.value).then(
        () => sendResponse({ ok: true, active }),
        e => sendResponse({ ok: false, error: String(e?.message || e) }));
      return true;
    }
    if (!active) {
      sendResponse({ ok: false, inactive: true });
      return;
    }
    if (msg?.type === 'pageTranslate') { translateWholePage(); sendResponse({ ok: true }); }
    if (msg?.type === 'pageGists') { toggleGists(); sendResponse({ ok: true }); }
    if (msg?.type === 'pageAsk' && msg.q) { askPage(msg.q); sendResponse({ ok: true }); }
  });

  // ---------- init ----------

  async function init() {
    const { overrides = {} } = await chrome.storage.local.get('overrides');
    if (overrides[pageKey] === 'off') return;
    if (overrides[pageKey] === 'on') return activate();
    // Client-rendered apps often have no text yet at document_idle — retry
    // detection a couple of times before giving up on an unlabeled page.
    for (const delay of [0, 2500, 8000]) {
      if (delay) await new Promise(r => setTimeout(r, delay));
      if (retired) return;
      const verdict = await pageIsGerman();
      if (verdict === true) return activate();
      if (verdict === false) return;
    }
  }

  init();
})();
