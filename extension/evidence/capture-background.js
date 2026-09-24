import * as db from '../lib/db.js';
import { canonicalUrl, getSettings, isCapturable } from '../lib/util.js';
import { collectSelection } from './selection.js';

export async function captureEvidence(tab, info, journeyId, screenshot = false) {
  if (!tab?.id || tab.incognito) throw new Error('Evidence capture is unavailable for this tab.');
  const settings = await getSettings();
  if (!isCapturable(tab.url, settings.blocklist)) throw new Error('This page is excluded from capture.');
  if (!await db.get('journeys', journeyId)) throw new Error('Choose a workspace before saving evidence.');
  let source;
  try {
    const result = await chrome.scripting.executeScript({
      target: { tabId: tab.id, frameIds: [info.frameId || 0] }, func: collectSelection,
    });
    source = result[0]?.result;
  } catch { /* Restricted pages/PDFs can still use explicit screenshot capture. */ }
  const exact = info.selectionText?.trim() || source?.quote || '';
  if (!screenshot && !exact) throw new Error('Select a passage on the page first.');
  const url = source?.url || info.frameUrl || tab.url;
  if (!isCapturable(url, settings.blocklist)) throw new Error('This frame is excluded from capture.');
  const page = await db.getOneByIndex('nodes', 'byJourneyUrl', [journeyId, canonicalUrl(tab.url)]);
  const capture = {
    id: crypto.randomUUID(), journeyId, pageId: page?.id || '',
    url, frameUrl: url, title: source?.title || tab.title || url,
    quote: exact, capturedAt: Date.now(), view: source && (!exact || source.quote === exact) ? source.view : 'legacy-unverified',
    anchor: source?.quote === exact ? source.anchor : { exact, prefix: '', suffix: '' },
    note: source?.view === 'translated'
      ? 'Captured from a translated page view. Switch to the original wording before creating a source-language passage link.'
      : !source || (exact && source.quote !== exact) ? 'The original selection could not be revalidated; original wording and page anchor were not verified.' : '',
  };
  if (screenshot) {
    const [active] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
    if (active?.id !== tab.id || active.url !== tab.url) throw new Error('Return to the source tab before capturing its screenshot.');
    const image = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    const [after] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
    if (after?.id !== tab.id || after.url !== tab.url) throw new Error('The active page changed during capture. Try again.');
    capture.image = image;
  }
  await db.put('evidenceCaptures', capture);
  return capture;
}
