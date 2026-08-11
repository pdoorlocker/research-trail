// Shared helpers used by the background worker and the journey page.

const TRACKING_PARAMS = [
  /^utm_/i, /^fbclid$/i, /^gclid$/i, /^dclid$/i, /^msclkid$/i,
  /^mc_[ce]id$/i, /^igshid$/i, /^ref_src$/i, /^_hs/i, /^vero_/i,
];

// Two-part public suffixes we care about for domain grouping. Not exhaustive,
// just enough that docs.example.co.uk and blog.example.co.uk group together.
const TWO_PART_TLDS = new Set([
  'co.uk', 'org.uk', 'gov.uk', 'ac.uk', 'me.uk', 'nhs.uk', 'sch.uk', 'police.uk',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au',
  'co.jp', 'or.jp', 'ne.jp', 'ac.jp', 'go.jp', 'lg.jp',
  'gv.at', 'ac.at', 'co.at', 'or.at', 'priv.at',
  'com.br', 'org.br', 'net.br', 'edu.br', 'gov.br',
  'com.mx', 'gob.mx', 'com.ar', 'org.ar', 'gob.ar',
  'co.nz', 'govt.nz', 'org.nz', 'ac.nz',
  'co.in', 'org.in', 'gov.in', 'ac.in', 'net.in',
  'co.za', 'org.za', 'gov.za', 'ac.za',
  'com.sg', 'gov.sg', 'edu.sg', 'com.cn', 'org.cn', 'gov.cn', 'edu.cn',
  'co.kr', 'or.kr', 'go.kr', 'ac.kr',
  'com.tw', 'org.tw', 'gov.tw', 'edu.tw', 'com.hk', 'org.hk', 'gov.hk', 'edu.hk',
  'co.id', 'go.id', 'ac.id', 'or.id', 'com.my', 'gov.my', 'edu.my',
  'co.th', 'go.th', 'ac.th', 'or.th', 'com.ph', 'gov.ph', 'com.vn', 'gov.vn',
  'com.tr', 'org.tr', 'gov.tr', 'edu.tr', 'co.il', 'org.il', 'gov.il', 'ac.il',
  'com.pl', 'org.pl', 'net.pl', 'edu.pl', 'gov.pl',
  'com.ua', 'org.ua', 'gov.ua', 'edu.ua', 'in.ua',
]);

// Search engines keep the meaningful part of a URL in one or two params and
// pad the rest with session and telemetry noise. Google's AI Mode is the
// extreme case: every turn of a chat rewrites `mstk`, `aioh`, `cs`, `mtid`,
// `csuir`… while `q` stays put, so a single conversation would otherwise land
// on the map as thirty near-identical pages. For known search endpoints we keep
// the query and the surface it was asked on (`udm=50` is AI Mode, `tbm` picks
// images/news) and drop everything else — different queries stay different
// pages, one conversation stays one page.
const SEARCH_ENDPOINTS = [
  { host: /(^|\.)google\.[a-z]{2,3}(\.[a-z]{2})?$/, path: /^\/search$/, keep: ['q', 'udm', 'tbm'] },
  { host: /(^|\.)bing\.com$/, path: /^\/search$/, keep: ['q'] },
  { host: /(^|\.)duckduckgo\.com$/, path: /^\/$/, keep: ['q', 'ia'] },
  { host: /(^|\.)search\.brave\.com$/, path: /^\/search$/, keep: ['q'] },
  { host: /(^|\.)ecosia\.org$/, path: /^\/search$/, keep: ['q'] },
  { host: /(^|\.)startpage\.com$/, path: /^\/(sp\/)?search$/, keep: ['query', 'q'] },
  { host: /(^|\.)youtube\.com$/, path: /^\/results$/, keep: ['search_query'] },
];

function searchParamsToKeep(u) {
  return SEARCH_ENDPOINTS.find((e) => e.host.test(u.hostname) && e.path.test(u.pathname))?.keep;
}

export function canonicalUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    u.hash = '';

    const keep = searchParamsToKeep(u);
    if (keep) {
      const kept = keep
        .map((k) => [k, u.searchParams.get(k)])
        .filter(([, v]) => v !== null && v !== '');
      u.search = '';
      for (const [k, v] of kept) u.searchParams.set(k, v);
      return u.toString();
    }

    const toDelete = [];
    for (const key of u.searchParams.keys()) {
      if (TRACKING_PARAMS.some((re) => re.test(key))) toDelete.push(key);
    }
    for (const key of toDelete) u.searchParams.delete(key);
    // Normalize trailing slash on bare paths so example.com and example.com/ merge.
    if (u.pathname === '/' && !u.search) return u.origin;
    return u.toString();
  } catch {
    return rawUrl;
  }
}

// Registrable domain, approximately eTLD+1: "docs.example.com" -> "example.com".
export function baseDomain(hostname) {
  const parts = hostname.toLowerCase().split('.').filter(Boolean);
  if (parts.length <= 2) return parts.join('.');
  const lastTwo = parts.slice(-2).join('.');
  const take = TWO_PART_TLDS.has(lastTwo) ? 3 : 2;
  return parts.slice(-take).join('.');
}

export function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

const DEFAULT_BLOCKLIST = [
  'mail.google.com',
  'accounts.google.com',
  'outlook.live.com',
  'outlook.office.com',
  'web.whatsapp.com',
  'messenger.com',
  'web.telegram.org',
  'login.microsoftonline.com',
];

export const DEFAULT_SETTINGS = {
  ollamaUrl: 'http://localhost:11434',
  chatModel: 'llama3.1',
  embedModel: 'nomic-embed-text',
  simThreshold: 0.72,
  captureText: true,
  aiPaused: false,
  tabGroupSync: true,
  autoReturnMinutes: 30, // fresh entry after this long a gap reverts to Scratch (0 = never)
  scratchLite: true, // Scratch skips per-page summaries; pages get the full treatment when promoted
  blocklist: DEFAULT_BLOCKLIST,
};

export async function getSettings() {
  const stored = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
}

export async function saveSettings(patch) {
  const current = await getSettings();
  const next = { ...current, ...patch };
  await chrome.storage.local.set({ settings: next });
  return next;
}

// A URL is capturable if it's a normal web page and not blocklisted.
export function isCapturable(url, blocklist) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') return false;
  if (u.hostname === 'chrome.google.com' || u.hostname === 'chromewebstore.google.com') return false;
  const host = u.hostname.toLowerCase();
  return !(blocklist || []).some((entry) => {
    const e = entry.trim().toLowerCase();
    if (!e) return false;
    return host === e || host.endsWith('.' + e);
  });
}

export function uid() {
  return crypto.randomUUID();
}

export function isScratchJourney(j) {
  return j?.kind === 'scratch' || j?.name === 'Scratch';
}

// Workspace lists everywhere put Scratch first — "back to everyday browsing"
// is the most common switch, so it's always the top option.
export function workspaceSort(a, b) {
  return (isScratchJourney(b) ? 1 : 0) - (isScratchJourney(a) ? 1 : 0)
    || b.createdAt - a.createdAt;
}

export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom ? dot / denom : 0;
}

export function truncate(text, max) {
  if (!text) return '';
  return text.length <= max ? text : text.slice(0, max) + '…';
}

// ---------- Scratch organization classification ----------
// Shared by the background organizer and the journey page so both apply the
// exact same rules: the organizer to decide what may cluster, the UI to
// explain WHY a page sits in "Not yet organized".

// Utility/hub pages — carts, checkouts, sign-ins, search results, captchas,
// account pages — sit in the middle of click-chains and BRIDGE unrelated
// threads: buying a bag and buying straws both pass through the same Amazon
// basket, and edge transitivity would weld them (and the bank login used to
// pay) into one mega-topic. Such pages never bind components; they get
// labeled from a neighbor after the real clusters form. The search patterns
// here must cover everything the organizer's SEARCH_HUB_RE matches: its hub
// pass only fires for connectors, and a search page that ISN'T a connector
// is worse than useless — its plain edges weld every result it links.
export const CONNECTOR_RE = /(checkout|\/cart|basket|add-to-cart|sign[-_]?in|log[-_]?in|login|signin|auth|payment|captcha|verified\.|\/search\?|[?&]q=|[?&]query=|[?&]search_query=|thankyou|\/buy\/|orders?[/.-]|order-|\/track|tracking|\/help|customer|contact|returns?\b|support|account)/i;

// No real captured text (title-only) is the same "nothing to say about this
// page" state that already denies it a hook and a summary — an account
// dashboard's URL scheme varies by site and a keyword list will always miss
// one, but "Readability found no body copy" generalizes: such pages are app
// shells / interstitials, never a topic in their own right, and their
// (title-only or absent) embedding is too generic to trust for similarity.
export const thinPage = (n) => !n.text && (!n.excerpt || n.excerpt.trim().length < 25);

// The exact text an embed job reads; anything under 20 trimmed chars is
// skipped by the embedder, so backfills and UIs must use the same bar.
export function embedInput(node) {
  return truncate(`${node.title}\n${node.text || node.excerpt || ''}`, 8000);
}

export function isEmbeddable(node) {
  return embedInput(node).trim().length >= 20;
}

// Behavioral hub signals beyond URL patterns: a page clicked to/from many
// others, or revisited across separate days, is a waypoint ("Your Orders",
// a site's homepage) — not a topic. Such pages are what welded yesterday's
// shopping to today's package-tracking.
export function makeConnectorClassifier(edges) {
  const degree = new Map();
  for (const e of edges) {
    if (e.type === 'similar') continue;
    degree.set(e.from, (degree.get(e.from) || 0) + 1);
    degree.set(e.to, (degree.get(e.to) || 0) + 1);
  }
  const visitDaySpan = (n) => new Set(n.visits.map((v) => new Date(v.at).toDateString())).size;
  return (n) =>
    CONNECTOR_RE.test(n.url)
    || /^(just a moment|sign in|log ?in)/i.test(n.title || '')
    || thinPage(n)
    || (degree.get(n.id) || 0) >= 6
    || (n.visits.length >= 4 && visitDaySpan(n) >= 2);
}

export function formatDuration(seconds) {
  if (!seconds || seconds < 1) return '0s';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const mins = Math.floor(seconds / 60);
  if (mins < 60) return `${mins}m ${Math.round(seconds % 60)}s`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

export function faviconUrl(pageUrl, size = 32) {
  const u = new URL(chrome.runtime.getURL('/_favicon/'));
  u.searchParams.set('pageUrl', pageUrl);
  u.searchParams.set('size', String(size));
  return u.toString();
}
