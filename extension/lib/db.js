// Thin promise wrapper around IndexedDB, shared by the background worker
// and the journey page.
//
// Stores:
//   journeys: { id, name, status: 'active'|'paused'|'done', createdAt, endedAt,
//               synthesis: { text, updatedAt } | null }
//   nodes:    { id, journeyId, url, host, title, excerpt, text,
//               visits: [{ at, from }], timeSpent, summary: [..], tags: [..],
//               embedding: [..] | null, notes, highlights: [{ text, at }],
//               createdAt }
//   edges:    { id, journeyId, from, to, type: 'navigated'|'branched'|'similar'|'manual',
//               label, count, createdAt }
//   jobs:     { id, journeyId, nodeId, type: 'summarize'|'embed'|'similar-label'|'synthesize',
//               payload, status: 'pending'|'error', attempts, lastError, createdAt }

const DB_NAME = 'research-trail';
const DB_VERSION = 2;

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (evt) => {
      const db = req.result;
      if (evt.oldVersion < 1) {
        db.createObjectStore('journeys', { keyPath: 'id' });

        const nodes = db.createObjectStore('nodes', { keyPath: 'id' });
        nodes.createIndex('byJourney', 'journeyId');
        nodes.createIndex('byJourneyUrl', ['journeyId', 'url'], { unique: true });

        const edges = db.createObjectStore('edges', { keyPath: 'id' });
        edges.createIndex('byJourney', 'journeyId');
        edges.createIndex('byJourneyPair', ['journeyId', 'from', 'to', 'type'], { unique: true });

        const jobs = db.createObjectStore('jobs', { keyPath: 'id' });
        jobs.createIndex('byStatus', 'status');
        jobs.createIndex('byJourney', 'journeyId');
      }
      if (evt.oldVersion < 2) {
        // Auto-organized themes within Scratch: { id, journeyId, name,
        // createdAt, updatedAt }. Nodes reference them via node.topicId.
        const topics = db.createObjectStore('topics', { keyPath: 'id' });
        topics.createIndex('byJourney', 'journeyId');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
  });
}

function reqResult(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function put(store, value) {
  const db = await openDb();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).put(value);
  await txDone(tx);
  return value;
}

export async function get(store, key) {
  const db = await openDb();
  return reqResult(db.transaction(store).objectStore(store).get(key));
}

export async function remove(store, key) {
  const db = await openDb();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).delete(key);
  await txDone(tx);
}

export async function getAll(store) {
  const db = await openDb();
  return reqResult(db.transaction(store).objectStore(store).getAll());
}

export async function getByIndex(store, indexName, key) {
  const db = await openDb();
  const index = db.transaction(store).objectStore(store).index(indexName);
  return reqResult(index.getAll(key));
}

export async function getOneByIndex(store, indexName, key) {
  const db = await openDb();
  const index = db.transaction(store).objectStore(store).index(indexName);
  return reqResult(index.get(key));
}

// Atomically read-modify-write a single record.
export async function update(store, key, fn) {
  const db = await openDb();
  const tx = db.transaction(store, 'readwrite');
  const os = tx.objectStore(store);
  const existing = await reqResult(os.get(key));
  if (existing === undefined) {
    tx.abort?.();
    return undefined;
  }
  const next = fn(existing) || existing;
  os.put(next);
  await txDone(tx);
  return next;
}

// Delete many keys in a single transaction.
export async function removeKeys(store, keys) {
  if (!keys.length) return;
  const db = await openDb();
  const tx = db.transaction(store, 'readwrite');
  for (const k of keys) tx.objectStore(store).delete(k);
  await txDone(tx);
}

export async function deleteWhere(store, indexName, key) {
  const db = await openDb();
  const tx = db.transaction(store, 'readwrite');
  const os = tx.objectStore(store);
  const matches = await reqResult(os.index(indexName).getAllKeys(key));
  for (const k of matches) os.delete(k);
  await txDone(tx);
  return matches.length;
}
