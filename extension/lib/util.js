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

export function canonicalUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    u.hash = '';
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
