/* ============================================================
   db.js – IndexedDB persistence layer
   Stores: notes | relations | settings
   ============================================================ */

const DB_NAME    = 'paperbrain';
const DB_VERSION = 1;

let _db = null;

export async function openDB() {
  if (_db) return _db;
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onerror = () => reject(req.error);
    req.onsuccess = () => { _db = req.result; resolve(_db); };

    req.onupgradeneeded = (e) => {
      const db = e.target.result;

      if (!db.objectStoreNames.contains('notes')) {
        const notes = db.createObjectStore('notes', { keyPath: 'id' });
        notes.createIndex('createdAt',       'createdAt');
        notes.createIndex('processingState', 'processingState');
        notes.createIndex('tags',            'tags', { multiEntry: true });
      }

      if (!db.objectStoreNames.contains('relations')) {
        const rel = db.createObjectStore('relations', { keyPath: 'id' });
        rel.createIndex('fromId', 'fromId');
        rel.createIndex('toId',   'toId');
      }

      if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings', { keyPath: 'key' });
      }
    };
  });
}

/* ── helpers ───────────────────────────────────────────────── */

function txGet(db, store, key) {
  return new Promise((resolve, reject) => {
    const req = db.transaction(store, 'readonly').objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

function txGetAll(db, store) {
  return new Promise((resolve, reject) => {
    const req = db.transaction(store, 'readonly').objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

function txPut(db, store, value) {
  return new Promise((resolve, reject) => {
    const req = db.transaction(store, 'readwrite').objectStore(store).put(value);
    req.onsuccess = () => resolve(value);
    req.onerror   = () => reject(req.error);
  });
}

function txDelete(db, store, key) {
  return new Promise((resolve, reject) => {
    const req = db.transaction(store, 'readwrite').objectStore(store).delete(key);
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(req.error);
  });
}

/* ── notes ─────────────────────────────────────────────────── */

export async function saveNote(note) {
  const db = await openDB();
  return txPut(db, 'notes', note);
}

export async function getNote(id) {
  const db = await openDB();
  return txGet(db, 'notes', id);
}

export async function getAllNotes() {
  const db   = await openDB();
  const rows = await txGetAll(db, 'notes');
  return rows.sort((a, b) => b.createdAt - a.createdAt);
}

export async function deleteNote(id) {
  const db = await openDB();

  // Delete note
  await txDelete(db, 'notes', id);

  // Delete associated relations
  const allRel = await txGetAll(db, 'relations');
  const toRemove = allRel.filter(r => r.fromId === id || r.toId === id);
  await Promise.all(toRemove.map(r => txDelete(db, 'relations', r.id)));
}

export async function searchNotes(query) {
  const notes = await getAllNotes();
  if (!query || !query.trim()) return notes;

  const terms = query.toLowerCase().trim().split(/\s+/);

  const scored = notes
    .map(note => {
      const body = [
        note.title        || '',
        note.transcription || '',
        note.organized    || '',
        note.summary      || '',
        ...(note.tags     || []),
      ].join(' ').toLowerCase();

      let score = 0;
      for (const t of terms) {
        if (!body.includes(t)) return null;              // must match all terms
        if ((note.title || '').toLowerCase().includes(t)) score += 3;
        if ((note.summary || '').toLowerCase().includes(t)) score += 2;
        score += 1;
      }
      return { note, score };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);

  return scored.map(s => s.note);
}

/* ── relations ─────────────────────────────────────────────── */

export async function saveRelations(relations) {
  const db = await openDB();
  await Promise.all(relations.map(r => txPut(db, 'relations', r)));
}

export async function getRelations(noteId) {
  const db  = await openDB();
  const all = await txGetAll(db, 'relations');
  return all.filter(r => r.fromId === noteId || r.toId === noteId);
}

/* ── settings ──────────────────────────────────────────────── */

export async function getSetting(key) {
  const db  = await openDB();
  const row = await txGet(db, 'settings', key);
  return row ? row.value : undefined;
}

export async function setSetting(key, value) {
  const db = await openDB();
  return txPut(db, 'settings', { key, value });
}

/* ── export / import / clear ───────────────────────────────── */

export async function exportAll() {
  const db        = await openDB();
  const notes     = await txGetAll(db, 'notes');
  const relations = await txGetAll(db, 'relations');
  return { version: DB_VERSION, exportedAt: Date.now(), notes, relations };
}

export async function importAll(data) {
  if (!data || !Array.isArray(data.notes)) throw new Error('Invalid export file');
  const db = await openDB();
  await Promise.all(data.notes.map(n => txPut(db, 'notes', n)));
  if (Array.isArray(data.relations)) {
    await Promise.all(data.relations.map(r => txPut(db, 'relations', r)));
  }
}

export async function clearAllData() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['notes', 'relations', 'settings'], 'readwrite');
    tx.objectStore('notes').clear();
    tx.objectStore('relations').clear();
    tx.objectStore('settings').clear();
    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(tx.error);
  });
}
