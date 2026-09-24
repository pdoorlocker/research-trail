import * as db from '../lib/db.js';
import * as opener from './open.js';

export const emptyBoard = (title = 'What am I trying to establish?') => ({
  version: 1, title, subtitle: '', sample: false, nodes: [], links: [], steps: [],
});

export async function createBoard(journeyId, content = emptyBoard()) {
  if (!await db.get('journeys', journeyId)) throw new Error('This workspace no longer exists.');
  return db.put('evidenceBoards', {
    id: crypto.randomUUID(), journeyId, content, revision: 0,
    createdAt: Date.now(), updatedAt: Date.now(),
  });
}

export async function openWorkspace(params) {
  const state = params.get('j') ? null : await chrome.runtime.sendMessage({ type: 'get-state' });
  const journeyId = params.get('j') || state?.activeJourneyId;
  const journey = journeyId && await db.get('journeys', journeyId);
  if (!journey) throw new Error('Open an existing workspace before creating an evidence board.');
  let boards = await db.getByIndex('evidenceBoards', 'byJourney', journeyId);
  // Without a specific board, open the one last used in this workspace, else
  // the most recently edited, rather than whichever was created first.
  const remembered = await globalThis.chrome?.storage?.local.get('lastBoardByJourney').then(r => r.lastBoardByJourney?.[journeyId]).catch(() => null);
  let record = boards.find(b => b.id === (params.get('b') || remembered))
    || [...boards].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
  if (!record) { record = await createBoard(journeyId, emptyBoard(journey.name)); boards = [record]; }
  return { journey, boards, record };
}

export async function saveBoard(id, revision, content) {
  let conflict = false;
  const record = await db.update('evidenceBoards', id, existing => {
    if (existing.revision !== revision) { conflict = true; return existing; }
    return { ...existing, content, revision: revision + 1, updatedAt: Date.now() };
  });
  if (!record) throw new Error('This board was removed. Save a board file to keep your changes.');
  if (conflict) throw new Error('This board changed in another tab. Save your board file, then reload to reconcile the versions.');
  return record;
}

export async function inbox(journeyId) {
  const [captures, pages] = await Promise.all([
    db.getByIndex('evidenceCaptures', 'byJourney', journeyId),
    db.getByIndex('nodes', 'byJourney', journeyId),
  ]);
  // Existing highlights remain available without destructively migrating them.
  const legacy = pages.flatMap(page => (page.highlights || []).map((h, index) => ({
    id: `highlight:${page.id}:${index}:${h.at}`, journeyId, pageId: page.id,
    title: page.title || page.url, url: page.url, quote: h.text,
    capturedAt: h.at, legacy: true, view: 'legacy-unverified',
    note: 'Existing highlight: original/translated view and exact page anchor were not recorded. Verify against the source.',
  })));
  return [...captures, ...legacy].sort((a, b) => b.capturedAt - a.capturedAt);
}

export function evidenceCard(capture, position) {
  const original = capture.view !== 'translated' && capture.view !== 'legacy-unverified';
  return {
    id: crypto.randomUUID(), type: 'evidence', text: capture.title || 'Captured evidence',
    x: position.x, y: position.y, sourceCaptureId: capture.id, sourcePageId: capture.pageId || '',
    url: capture.url, quote: original ? capture.quote || '' : '',
    displayedQuote: capture.quote || capture.displayedQuote || '',
    note: [capture.note, !original && capture.quote ? `Displayed text (original not verified): ${capture.quote}` : ''].filter(Boolean).join('\n'),
    image: capture.image || '', originalImage: capture.image || '', highlights: [],
    tier: 'Unreviewed', checked: '', capturedAt: capture.capturedAt,
    provenance: { view: capture.view || 'original', anchor: capture.anchor || null, frameUrl: capture.frameUrl || capture.url },
  };
}

// A thought jotted from the side panel. It keeps the page it was written on
// as context, but it is the author's own words, never a source quotation.
export function noteCard(capture, position) {
  return {
    id: crypto.randomUUID(), type: 'note', text: capture.title || '',
    x: position.x, y: position.y, sourceCaptureId: capture.id, capturedAt: capture.capturedAt,
    note: capture.note || '',
  };
}

export async function saveJot(journeyId, text, page = {}) {
  if (!await db.get('journeys', journeyId)) throw new Error('Choose a workspace first.');
  const url = /^https?:/.test(page.url || '') ? page.url : '';
  return db.put('evidenceCaptures', {
    id: crypto.randomUUID(), journeyId, kind: 'note', view: 'jot', title: text.trim().slice(0, 2000), quote: '',
    url, note: url && page.title ? `Jotted while reading “${page.title}”` : '', capturedAt: Date.now(),
  });
}

// Best effort: outside the extension (tests, exported reader) there is no
// chrome.storage, and losing "resume" must never break the board.
export async function rememberView(url, info) {
  try { if (globalThis.chrome?.storage) await opener.rememberView(url, info); } catch { /* not critical */ }
}
