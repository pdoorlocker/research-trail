// Runs in the selected frame. Keep self-contained for scripting.executeScript.
export function collectSelection() {
  const selection = window.getSelection();
  const quote = selection?.toString().trim() || '';
  const element = selection?.anchorNode?.nodeType === Node.ELEMENT_NODE
    ? selection.anchorNode : selection?.anchorNode?.parentElement;
  const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
  const container = range?.commonAncestorContainer;
  const block = element?.closest('[data-ah-hash],p,li,td,blockquote,article') || element;
  // A selection may cross several translated blocks. Never manufacture a
  // source-language deep link from machine-translated page content.
  const root = container?.nodeType === Node.ELEMENT_NODE ? container : container?.parentElement;
  const translated = (!quote && !!document.querySelector('.ah-showing-en')) || !!element?.closest('.ah-showing-en') || [...(root?.querySelectorAll('.ah-showing-en') || [])].some(el => {
    try { return range.intersectsNode(el); } catch { return false; }
  });
  // Saved from a block Amtshelfer translated: quote the original German of
  // the block(s) instead (the translation isn't aligned word by word, so the
  // whole paragraph), and keep the English selection as its translation.
  if (translated && quote && range && typeof globalThis.__amtshelferOriginalText === 'function') {
    const blocks = [...document.querySelectorAll('.ah-showing-en')].filter(el => { try { return range.intersectsNode(el); } catch { return false; } });
    const inside = n => blocks.some(b => b.contains(n));
    if (blocks.length && inside(range.startContainer) && inside(range.endContainer)) {
      const originals = blocks.map(b => globalThis.__amtshelferOriginalText(b));
      if (originals.every(Boolean)) {
        const german = originals.join(' ');
        return { quote: german, translation: quote, fromTranslation: true, url: location.href, title: document.title, view: 'original', anchor: { exact: german, prefix: '', suffix: '' } };
      }
    }
  }
  let prefix = '', suffix = '';
  if (range && block?.contains(range.startContainer) && block.contains(range.endContainer)) {
    try {
      const before = range.cloneRange(); before.selectNodeContents(block); before.setEnd(range.startContainer, range.startOffset);
      const after = range.cloneRange(); after.selectNodeContents(block); after.setStart(range.endContainer, range.endOffset);
      prefix = before.toString().slice(-100); suffix = after.toString().slice(0, 100);
    } catch { /* Cross-node selections still retain their exact quotation. */ }
  }
  return {
    quote, url: location.href, title: document.title,
    view: translated ? 'translated' : 'original',
    anchor: { exact: quote, prefix, suffix },
  };
}
