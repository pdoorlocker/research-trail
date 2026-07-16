# 🧭 Research Trail

A Chrome extension that replaces tab anxiety with a map. As you browse, it builds a live graph of every page and how they connect — clicked links, new-tab branches, same-site clusters, and (via a local Ollama model) semantic similarity. The **side panel** always shows where you are in that web: your current page ringed, open tabs lit, closed pages dimmed but never lost — click any node to jump to its tab or resurrect it. Closing a tab is *parking*, not losing: the page stays on the map with its summary, your notes, and its connections.

You're always in a **workspace** (like a tab group that remembers everything); switch or create them from the toolbar popup. Add notes and highlights as you go, then export any workspace as a Markdown report.

Everything stays on your machine: page text lives in the browser's IndexedDB, and all AI runs against your local Ollama instance.

## Install

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked** and select the `extension/` folder

## Ollama setup (optional but recommended)

The extension works without Ollama — you still get the graph, timeline, notes, and highlights. With Ollama you also get per-page bullet summaries, topic tags, AI-discovered connections between pages on different sites, and one-click journey synthesis.

1. Install [Ollama](https://ollama.com). Any chat model you already have works — the extension auto-picks an installed model for summaries, synthesis, *and* connection-finding (the chat model reads page summaries in one batch call and proposes related pairs). Optionally add a dedicated embedding model, which makes connection-finding cheaper and scales past ~60 pages per journey:
   ```sh
   ollama pull nomic-embed-text  # optional: embedding model for similarity at scale
   ```
   With it installed, similarity switches to embeddings automatically (cosine pre-filter, then the chat model labels each connection).
2. Allow the extension to talk to Ollama. Ollama rejects requests from unknown origins, so on macOS run:
   ```sh
   launchctl setenv OLLAMA_ORIGINS "chrome-extension://*"
   ```
   then quit and restart the Ollama app. (If you run `ollama serve` manually instead: `OLLAMA_ORIGINS="chrome-extension://*" ollama serve`.)
3. Check the dot in the extension popup — green means connected. Models and the similarity threshold are configurable in the journey page settings (⚙).

If Ollama is offline, AI jobs queue up and run automatically when it comes back.

## How to use it

1. **Just browse.** Capture is always on (pause anytime from the popup or panel — the badge shows `❚❚` while paused). Every page is captured with its readable text, and the extension records *how* you got there: clicked link, opened-in-new-tab branch, or fresh entry point.
2. **Open the side panel** (📍 in the popup, or Alt+R) — the live "you are here" view. Your current page is ringed in green, pages with open tabs are lit, everything else is parked (dimmed). Click a node to switch to its tab or reopen it; **⏏ Park other tabs** closes everything except where you are, safely.
3. **Workspaces**: the popup switches between them or creates new ones — each is its own map ("apartment hunt", "Scratch", …).
4. **Save highlights**: select text on any page → right-click → *Save highlight to Research Trail*.
5. **Open the full map** (🗺 in the popup) for the deep view — notes, timeline, AI synthesis, exports:
   - Nodes are pages, sized by reading time and revisits; pages on the same domain cluster into dashed boxes.
   - Solid gray arrows = clicked links; blue = opened in a new tab; purple dashed = AI-found similarity (with a label explaining the connection); orange = connections you drew yourself.
   - Click a node for the drawer: summary bullets, tags, your notes, highlights, and all its connections.
   - **✨ Synthesize** asks Ollama for a journey-level overview: what you're researching, key threads, tensions between sources, and gaps.
   - **🔗 Find connections** runs the embedding similarity pass across everything captured so far.
   - The **Timeline** tab shows the same trail chronologically, with branch points marked.
6. **Export** as a Markdown report, JSON, or an Obsidian Canvas file (preserves the graph layout).

## Privacy guardrails

- Capture is always on by design (it's a tab surface), but pausing is one click from the popup or panel and the toolbar badge shows `❚❚` the whole time you're paused.
- Incognito tabs are never captured.
- A domain blocklist (editable in settings) excludes mail, messaging, and login pages by default.
- Page text storage can be turned off entirely in settings (you lose summaries/similarity).
- No network requests except to your own Ollama instance. Favicons are served by Chrome's local favicon cache.
- Delete any page, connection, or whole journey from the UI.

## Architecture

```
extension/
  manifest.json          MV3 manifest
  background.js          service worker: navigation tracking, graph building,
                         time accounting, Ollama job queue
  capture.js             injected per-page (only while recording): Readability
                         text extraction
  lib/
    db.js                IndexedDB wrapper (journeys / nodes / edges / jobs)
    ollama.js            Ollama client + prompt builders
    util.js              URL canonicalization, domain grouping, settings
  popup/                 start/pause/finish controls
  journey/               the map: Cytoscape graph, timeline, drawer, settings
  vendor/                cytoscape.min.js, Readability.js (vendored, no build step)
```

There is no build step — edit a file, hit reload on `chrome://extensions`, done.

### How edges are detected

| Edge | Signal |
|---|---|
| navigated | `webNavigation.onCommitted` with a `link`/`form_submit`/redirect transition in the same tab (SPA route changes via `onHistoryStateUpdated` too) |
| branched | `webNavigation.onCreatedNavigationTarget` — a link opened into a new tab, traced back to the source page |
| same-domain cluster | registrable domain (approx. eTLD+1) grouping, drawn as compound nodes rather than edges |
| similar | cosine similarity of Ollama embeddings ≥ threshold, across different domains only; a chat-model call labels *why* they're related |
| manual | you, via *Connect to…* in the node drawer |

URLs are canonicalized before deduping: hash fragments and tracking params (`utm_*`, `fbclid`, `gclid`, …) are stripped, so revisits merge into one node with a visit history.
