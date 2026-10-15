// Full backup and restore: the IndexedDB stores (workspaces, pages, edges,
// jobs, topics, evidence), chrome.storage.local (settings, glossary,
// translation cache, open boards…) and the extension pages' localStorage
// (panel and board view preferences, Ask threads).
//
// Chrome derives an unpacked extension's ID from its folder path, and all of
// this storage belongs to that ID — so moving or renaming the folder starts
// from empty. A backup file is how data moves across.

import * as db from './db.js';

export const BACKUP_FORMAT = 'research-trail-backup';

export async function exportAll() {
  const idb = await db.dumpAll();
  const storage = await chrome.storage.local.get(null);
  const local = {};
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    local[key] = localStorage.getItem(key);
  }
  return {
    format: BACKUP_FORMAT,
    formatVersion: 1,
    exportedAt: new Date().toISOString(),
    extensionVersion: chrome.runtime.getManifest().version,
    dbVersion: idb.version,
    indexedDB: idb.stores,
    storage,
    localStorage: local,
  };
}

export function describeBackup(backup) {
  const s = backup.indexedDB || {};
  const n = (name) => (s[name] || []).length;
  return `${n('journeys')} workspaces, ${n('nodes')} pages, ${n('edges')} connections, ` +
    `${n('evidenceBoards')} evidence boards, ${n('evidenceCaptures')} saved passages`;
}

// Throws with a readable message if the file isn't a backup this version can restore.
export function validate(backup) {
  if (!backup || backup.format !== BACKUP_FORMAT) {
    throw new Error('This file isn’t a Research Trail backup. (Single-workspace JSON exports can’t be restored.)');
  }
  if (backup.formatVersion !== 1) throw new Error(`Backup format ${backup.formatVersion} is newer than this extension understands.`);
  if (typeof backup.indexedDB !== 'object' || typeof backup.storage !== 'object') {
    throw new Error('This backup file is incomplete.');
  }
}

// Replace everything with the backup. Returns the store names that were skipped.
export async function importAll(backup) {
  validate(backup);
  const skipped = await db.restoreAll(backup.indexedDB);
  await chrome.storage.local.clear();
  await chrome.storage.local.set(backup.storage);
  localStorage.clear();
  for (const [key, value] of Object.entries(backup.localStorage || {})) {
    try { localStorage.setItem(key, value); } catch { /* quota — view prefs only */ }
  }
  return skipped;
}
