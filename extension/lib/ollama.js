// Minimal Ollama client. Everything runs against the user's local instance;
// nothing ever leaves the machine.

import { getSettings, truncate } from './util.js';

export async function ollamaAvailable() {
  const { ollamaUrl } = await getSettings();
  try {
    const res = await fetch(`${ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(2500) });
    return res.ok;
  } catch {
    return false;
  }
}

export async function listModels() {
  const { ollamaUrl } = await getSettings();
  const res = await fetch(`${ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(4000) });
  if (!res.ok) throw new Error(`Ollama responded ${res.status}`);
  const data = await res.json();
  return (data.models || []).map((m) => m.name);
}

// The configured models may not be installed. Rather than fail, resolve to
// what actually is: exact/base-name match first, otherwise any installed chat
// model, and for embeddings fall back to the chat model (any model can embed
// via /api/embed — a dedicated embed model is just better/faster).
export const looksLikeEmbedModel = (name) => /embed|bge|minilm|e5-|arctic/i.test(name);

// Some Ollama model runners (e.g. gemma) can't produce embeddings at all and
// return 501 "this server does not support embeddings".
export function isEmbedUnsupportedError(err) {
  return /not support embeddings|--embeddings/i.test(String(err?.message || err));
}
let modelCache = { at: 0, models: [] };

export async function resolveModels() {
  const { chatModel, embedModel } = await getSettings();
  if (Date.now() - modelCache.at > 60000) {
    modelCache = { at: Date.now(), models: await listModels().catch(() => []) };
  }
  const models = modelCache.models;
  if (!models.length) return { chat: chatModel, embed: embedModel };
  const match = (want) =>
    models.find((m) => m === want || m.split(':')[0] === (want || '').split(':')[0]);
  const chat = match(chatModel) || models.find((m) => !looksLikeEmbedModel(m)) || models[0];
  const embed = match(embedModel) || models.find(looksLikeEmbedModel) || chat;
  return { chat, embed };
}

export async function generate(prompt, { system = '', timeoutMs = 120000, numPredict } = {}) {
  const { ollamaUrl } = await getSettings();
  const { chat } = await resolveModels();
  // think:false — our jobs are simple extraction/summarization tasks, and on
  // thinking-capable models the deliberation otherwise eats the entire
  // num_predict budget, returning an EMPTY response with done_reason
  // "length" (thinking tokens are separated from `response` by Ollama).
  const body = { model: chat, prompt, system, stream: false, think: false };
  // Ollama's default output cap is small (often ~128 tokens) — batch jobs
  // that return one entry per page need much more room or the response
  // truncates mid-JSON with no visible error.
  if (numPredict) body.options = { num_predict: numPredict };

  const attempt = () => fetch(`${ollamaUrl}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });

  let res = await attempt();
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    // Older Ollama builds / some models reject the think flag outright —
    // drop it and retry once rather than failing the job.
    if ('think' in body && /think/i.test(errText)) {
      delete body.think;
      res = await attempt();
    }
    if (!res.ok) {
      const finalErr = (await res.text().catch(() => '')) || errText;
      throw new Error(`Ollama generate failed (${res.status}): ${truncate(finalErr, 200)}`);
    }
  }
  const data = await res.json();
  const out = (data.response || '').trim();
  if (!out && data.done_reason === 'length') {
    throw new Error('model spent the whole output budget thinking and returned no answer');
  }
  return out;
}

export async function embed(text) {
  const { ollamaUrl } = await getSettings();
  const { embed: embedModel } = await resolveModels();
  // Newer Ollama versions use /api/embed; older ones use /api/embeddings.
  let res = await fetch(`${ollamaUrl}/api/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: embedModel, input: text }),
    signal: AbortSignal.timeout(120000),
  });
  if (res.status === 404) {
    res = await fetch(`${ollamaUrl}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: embedModel, prompt: text }),
      signal: AbortSignal.timeout(120000),
    });
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Ollama embed failed (${res.status}): ${truncate(body, 200)}`);
  }
  const data = await res.json();
  if (data.embeddings?.[0]) return data.embeddings[0];
  if (data.embedding) return data.embedding;
  throw new Error('Ollama embed returned no embedding');
}

// Embed several texts in one request — one model load instead of N.
export async function embedBatch(texts) {
  const { ollamaUrl } = await getSettings();
  const { embed: embedModel } = await resolveModels();
  const res = await fetch(`${ollamaUrl}/api/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: embedModel, input: texts }),
    signal: AbortSignal.timeout(300000),
  });
  if (res.status === 404) {
    // Legacy Ollama without /api/embed: fall back to one-at-a-time.
    const out = [];
    for (const t of texts) out.push(await embed(t));
    return out;
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Ollama embed failed (${res.status}): ${truncate(body, 200)}`);
  }
  const data = await res.json();
  if (Array.isArray(data.embeddings)) return data.embeddings;
  throw new Error('Ollama embed returned no embeddings');
}

// Errors that mean "Ollama isn't reachable right now" — jobs should stay
// queued rather than count as failed attempts.
export function isOfflineError(err) {
  const msg = String(err?.message || err);
  return (
    err?.name === 'TimeoutError' ||
    err?.name === 'AbortError' ||
    msg.includes('Failed to fetch') ||
    msg.includes('NetworkError') ||
    msg.includes('403') // Ollama rejects unknown origins until OLLAMA_ORIGINS is set
  );
}

// ---- Prompt builders ----

export function summarizePrompt(node) {
  return {
    system:
      'You summarize web pages for a personal research notebook. Be concrete and specific. Never invent facts not in the text. Always write in English, even when the page is in another language.',
    prompt: `Page title: ${node.title || '(untitled)'}
URL: ${node.url}

Page text:
${truncate(node.text || node.excerpt || '', 16000)}

Summarize this page as 3-5 short bullet points capturing what matters for research (key claims, data, arguments). Then on a final line write: TAGS: followed by 3-6 comma-separated topic tags.

Format exactly:
- bullet one
- bullet two
TAGS: tag1, tag2, tag3`,
  };
}

export function parseSummary(response) {
  const lines = response.split('\n').map((l) => l.trim()).filter(Boolean);
  const bullets = [];
  let tags = [];
  for (const line of lines) {
    const tagMatch = line.match(/^\**TAGS:?\**\s*(.+)$/i);
    if (tagMatch) {
      tags = tagMatch[1].split(',').map((t) => t.trim().toLowerCase().replace(/\.$/, '')).filter(Boolean).slice(0, 6);
    } else if (/^[-*•]\s+/.test(line)) {
      bullets.push(line.replace(/^[-*•]\s+/, ''));
    }
  }
  // If the model ignored the bullet format, fall back to using the whole response.
  if (bullets.length === 0 && response.trim()) bullets.push(truncate(response.trim(), 400));
  return { bullets: bullets.slice(0, 6), tags };
}

export function connectionLabelPrompt(nodeA, nodeB) {
  const describe = (n) =>
    `"${n.title || n.url}" (${n.host})${n.summary?.length ? ' — ' + truncate(n.summary.join('; '), 400) : ''}`;
  return {
    system: 'You label connections between research sources. Respond with a single short phrase, under 12 words, no quotes, no preamble, in English.',
    prompt: `Two pages from a research session appear to be related:

Page A: ${describe(nodeA)}
Page B: ${describe(nodeB)}

In one short phrase, what connects them? (e.g. "both analyze parking minimum reform outcomes")`,
  };
}

export function connectionDescriptionPrompt(nodeA, nodeB, label) {
  const describe = (n) =>
    `"${n.title || n.url}" (${n.host})${n.summary?.length ? '\nSummary: ' + truncate(n.summary.join('; '), 600) : ''}`;
  return {
    system:
      'You explain how two research sources relate. Respond with 2-3 plain, concrete sentences in English. No preamble, no headings.',
    prompt: `Two pages from a research session are connected${label ? ` (short label: "${label}")` : ''}.

Page A: ${describe(nodeA)}

Page B: ${describe(nodeB)}

In 2-3 sentences: how do these pages relate, and what does reading both give the researcher that either alone doesn't?`,
  };
}

// Tiny recognition handles ("the one about…"), written for all pages at
// once so they come out mutually distinct.
export function hooksPrompt(nodes) {
  const list = nodes
    .map((n, i) => {
      const gist = n.summary?.length ? n.summary.join('; ') : (n.excerpt || '');
      return `${i + 1}. "${n.title || n.url}" (${n.host}) — ${truncate(gist, 220)}`;
    })
    .join('\n');
  return {
    system:
      'You write tiny recognition handles for pages on a research map. Respond with ONLY a JSON array, no prose, no code fences. English.',
    prompt: `Pages from a research session:

${list}

For EACH page, write a short handle (4-9 words) capturing what makes THIS page different from all the others — what you'd say when telling a friend "it's the one about…". No two handles may be alike. Don't repeat the site name.

Respond ONLY with JSON like:
[{"n":1,"handle":"fee table for every residence permit type"}]`,
  };
}

export function parseHooks(response, count) {
  const objects = parseJsonObjectsLoose(response);
  return objects
    .filter(
      (p) => Number.isInteger(p?.n) && p.n >= 1 && p.n <= count
        && typeof p.handle === 'string' && p.handle.trim(),
    )
    .map((p) => ({ n: p.n, handle: p.handle }));
}

// Extract every complete {...} object from a possibly-truncated response —
// output caps or context limits can cut a JSON array off mid-entry, and a
// batch job should keep whatever finished rather than discard all of it.
function parseJsonObjectsLoose(text) {
  const out = [];
  let depth = 0;
  let objStart = -1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{') {
      if (depth === 0) objStart = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && objStart !== -1) {
        try {
          out.push(JSON.parse(text.slice(objStart, i + 1)));
        } catch { /* malformed entry — skip just this one */ }
        objStart = -1;
      } else if (depth < 0) {
        depth = 0; // stray closing brace; keep scanning
      }
    }
  }
  return out;
}

// Short plain-words names for research threads (Scratch topics, split
// suggestions). One batch call names them all.
export function clusterNamesPrompt(clusters) {
  const blocks = clusters
    .map((c) => `${c.n}. ${c.pages.slice(0, 10).join(' | ')}`)
    .join('\n');
  return {
    system:
      'You name research threads. Respond with ONLY a JSON array, no prose, no code fences. English.',
    prompt: `Each numbered line lists pages from one research thread:

${blocks}

Name each thread in 2-5 plain words that say what it's about (e.g. "Osprey messenger bag shopping").

Respond ONLY with JSON like:
[{"n":1,"name":"Osprey messenger bag shopping"}]`,
  };
}

export function parseClusterNames(response, count) {
  return parseJsonObjectsLoose(response).filter(
    (p) => Number.isInteger(p?.n) && p.n >= 1 && p.n <= count
      && typeof p.name === 'string' && p.name.trim(),
  );
}

// Embedding-free connection finding: one batch call where the chat model
// reads all page summaries and proposes related pairs directly.
export function connectionsBatchPrompt(nodes) {
  const list = nodes
    .map((n, i) => {
      const gist = n.summary?.length ? n.summary.join('; ') : (n.excerpt || '');
      return `${i + 1}. "${n.title || n.url}" (${n.host}) — ${truncate(gist, 300)}`;
    })
    .join('\n');
  return {
    system:
      'You map connections between pages from a research session. You respond with ONLY a JSON array, no prose, no code fences. "why" values are in English.',
    prompt: `Pages from a research session, numbered:

${list}

Identify pairs of pages from DIFFERENT websites that are meaningfully related for this research: same specific topic, one answers a question the other raises, contradicting claims, or the same entity/process. Ignore weak "both are about the general theme" links.

Respond with ONLY a JSON array like:
[{"a":1,"b":4,"why":"reason under 12 words"}]

At most 12 pairs. If none, respond with [].`,
  };
}

export function parseConnections(response, count) {
  const objects = parseJsonObjectsLoose(response);
  return objects
    .filter(
      (p) =>
        Number.isInteger(p?.a) && Number.isInteger(p?.b) &&
        p.a >= 1 && p.a <= count && p.b >= 1 && p.b <= count && p.a !== p.b,
    )
    .slice(0, 12);
}

export function synthesisPrompt(journey, nodes) {
  const pageBlocks = nodes
    .map((n) => {
      const parts = [`### ${n.title || n.url} (${n.host})`];
      if (n.summary?.length) parts.push(n.summary.map((b) => `- ${b}`).join('\n'));
      else if (n.excerpt) parts.push(truncate(n.excerpt, 300));
      if (n.notes) parts.push(`My notes: ${truncate(n.notes, 500)}`);
      if (n.highlights?.length) {
        parts.push('Highlights I saved: ' + n.highlights.map((h) => `"${truncate(h.text, 200)}"`).join(' / '));
      }
      return parts.join('\n');
    })
    .join('\n\n');

  return {
    system:
      'You are a research assistant synthesizing a browsing session into an overview. Ground everything in the provided material; never invent sources. Always write in English, even when the source pages are in another language.',
    prompt: `Research journey: "${journey.name}"

Pages visited (with summaries, my notes, and highlights):

${truncate(pageBlocks, 24000)}

Write a synthesis in markdown with exactly these sections:
## What this research is about
(2-3 sentences)
## Key threads
(bulleted, group related pages together, mention sources by name)
## Tensions & open questions
(where sources disagree or things remain unanswered)
## Possible gaps
(angles or source types not yet covered)`,
  };
}
