// Getting back to a board. Every board page keeps its full view (board,
// tab, mode, selection, zoom, scroll) in its URL and reports it here, so:
//  - "Resume" reopens exactly where you were, in any workspace;
//  - opening a board focuses a tab that already shows it instead of
//    stacking duplicates;
//  - tabs closed by an extension reload come back after it.

const PAGE = () => chrome.runtime.getURL('evidence/index.html');

export async function rememberView(url, info) {
  const tab = await (chrome.tabs.getCurrent?.() ?? Promise.resolve(null)).catch(() => null);
  const { openBoards = {}, lastBoardByJourney = {} } = await chrome.storage.local.get(['openBoards', 'lastBoardByJourney']);
  if (tab?.id !== undefined) openBoards[tab.id] = { url, at: Date.now() };
  lastBoardByJourney[info.journeyId] = info.boardId;
  await chrome.storage.local.set({ lastBoard: { ...info, url, at: Date.now() }, openBoards, lastBoardByJourney });
}

export async function lastBoard() {
  return (await chrome.storage.local.get('lastBoard')).lastBoard || null;
}

const paramsOf = url => { try { return new URL(url).searchParams; } catch { return new URLSearchParams(); } };

// Focus a tab already showing this board (or, with only a workspace given,
// any board in it). `extra` adds one-shot flags such as inbox=1 to it.
export async function openBoard(params = {}, extra = {}) {
  const want = new URLSearchParams(params);
  const tabs = (await chrome.tabs.query({})).filter(t => t.url?.startsWith(PAGE()));
  const match = tabs.find(t => {
    const p = paramsOf(t.url);
    return want.get('b') ? p.get('b') === want.get('b') : want.get('j') ? p.get('j') === want.get('j') : false;
  });
  if (match) {
    const update = { active: true };
    if (Object.keys(extra).length) {
      const p = paramsOf(match.url);
      for (const [k, v] of Object.entries(extra)) p.set(k, v);
      update.url = PAGE() + '?' + p;
    }
    await chrome.tabs.update(match.id, update);
    await chrome.windows.update(match.windowId, { focused: true });
    return match;
  }
  for (const [k, v] of Object.entries(extra)) want.set(k, v);
  return chrome.tabs.create({ url: PAGE() + '?' + want });
}

// Reopen the last board exactly as it was left.
export async function resumeBoard() {
  const last = await lastBoard();
  if (!last) return null;
  const tabs = (await chrome.tabs.query({})).filter(t => t.url?.startsWith(PAGE()));
  const open = tabs.find(t => paramsOf(t.url).get('b') === last.boardId);
  if (open) {
    await chrome.tabs.update(open.id, { active: true });
    await chrome.windows.update(open.windowId, { focused: true });
    return open;
  }
  return chrome.tabs.create({ url: last.url });
}

// After an extension reload Chrome has closed our pages; bring back the
// boards that were open, each at its last view. Skips any that survived.
export async function reopenAfterReload() {
  const { openBoards = {} } = await chrome.storage.local.get('openBoards');
  await chrome.storage.local.set({ openBoards: {} });
  const urls = [...new Set(Object.values(openBoards).sort((a, b) => a.at - b.at).map(e => e.url))];
  const still = new Set((await chrome.tabs.query({})).filter(t => t.url?.startsWith(PAGE())).map(t => paramsOf(t.url).get('b')));
  const todo = urls.filter(url => url.startsWith(PAGE()) && !still.has(paramsOf(url).get('b')) && still.add(paramsOf(url).get('b')));
  // The most recently used board comes back in front.
  for (const [i, url] of todo.entries()) await chrome.tabs.create({ url, active: i === todo.length - 1 });
  return urls.length;
}

export async function forgetTab(tabId) {
  const { openBoards = {} } = await chrome.storage.local.get('openBoards');
  if (!(tabId in openBoards)) return;
  delete openBoards[tabId];
  await chrome.storage.local.set({ openBoards });
}
