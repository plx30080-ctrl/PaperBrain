/* ============================================================
   app.js – PaperBrain main application
   ============================================================ */

import * as DB  from './db.js';
import * as API from './api.js';

/* ── state ──────────────────────────────────────────────────── */

const state = {
  notes:        [],
  currentNoteId: null,
  searchQuery:  '',
  settings: {
    apiKey: '',
    model:  'claude-sonnet-4-6',
    theme:  'light',
  },
  processing: [],  // [{ id, name, status, progress, done, error }]
};

/* ── DOM refs ───────────────────────────────────────────────── */

const $ = (sel, root = document) => root.querySelector(sel);

const el = {
  // Sidebar
  notesList:          $('#notes-list'),
  notesCount:         $('#notes-count'),
  searchInput:        $('#search-input'),
  searchClear:        $('#search-clear'),
  newUploadBtn:       $('#new-upload-btn'),

  // Main
  uploadZone:         $('#upload-zone'),
  dropTarget:         $('#drop-target'),
  uploadBtn:          $('#upload-btn'),
  cameraBtn:          $('#camera-btn'),
  fileInput:          $('#file-input'),
  cameraInput:        $('#camera-input'),
  processingQueue:    $('#processing-queue'),
  processingStatus:   $('#processing-status'),
  queueItems:         $('#queue-items'),
  emptyState:         $('#empty-state'),
  emptyUploadBtn:     $('#empty-upload-btn'),

  // Settings modal
  settingsModal:      $('#settings-modal'),
  settingsBtn:        $('#settings-btn'),
  closeSettings:      $('#close-settings'),
  apiKeyInput:        $('#api-key-input'),
  toggleKeyBtn:       $('#toggle-key-btn'),
  testKeyBtn:         $('#test-key-btn'),
  modelSelect:        $('#model-select'),
  saveSettingsBtn:    $('#save-settings-btn'),
  exportBtn:          $('#export-btn'),
  importFile:         $('#import-file'),
  clearAllBtn:        $('#clear-all-btn'),

  // Note modal
  noteModal:              $('#note-modal'),
  closeNoteModal:         $('#close-note-modal'),
  noteModalTitle:         $('#note-modal-title'),
  noteModalDate:          $('#note-modal-date'),
  noteModalSource:        $('#note-modal-source'),
  noteProcessBadge:       $('#note-processing-badge'),
  noteReprocessBtn:       $('#note-reprocess-btn'),
  noteExportMdBtn:        $('#note-export-md-btn'),
  noteDeleteBtn:          $('#note-delete-btn'),
  noteImagesContainer:    $('#note-images-container'),
  tabOrganized:           $('#tab-organized'),
  tabTranscription:       $('#tab-transcription'),
  tabSummary:             $('#tab-summary'),
  noteTagsList:           $('#note-tags-list'),
  noteTagInput:           $('#note-tag-input'),
  relatedRow:             $('#related-row'),
  relatedNotesList:       $('#related-notes-list'),

  // Confirm dialog
  confirmOverlay:  $('#confirm-overlay'),
  confirmTitle:    $('#confirm-title'),
  confirmMessage:  $('#confirm-message'),
  confirmOk:       $('#confirm-ok'),
  confirmCancel:   $('#confirm-cancel'),

  // Toast
  toastContainer:  $('#toast-container'),
};

/* ── utils ──────────────────────────────────────────────────── */

function uuid() {
  return (crypto.randomUUID?.() ?? (Date.now().toString(36) + Math.random().toString(36).slice(2)));
}

function escHtml(str) {
  if (str == null) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function fmtDate(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleDateString(undefined, { month:'short', day:'numeric', year:'numeric' });
}

function fmtDateShort(ts) {
  if (!ts) return '';
  const d   = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString())
    return d.toLocaleTimeString(undefined, { hour:'numeric', minute:'2-digit' });
  return d.toLocaleDateString(undefined, { month:'short', day:'numeric' });
}

/* ── toast ──────────────────────────────────────────────────── */

function toast(msg, type = 'info', duration = 3500) {
  const icons = { success:'✅', error:'❌', warning:'⚠️', info:'ℹ️' };
  const t = document.createElement('div');
  t.className = `toast toast--${type}`;
  t.innerHTML = `<span class="toast-icon">${icons[type] ?? 'ℹ️'}</span><span class="toast-msg">${escHtml(msg)}</span>`;
  el.toastContainer.appendChild(t);
  setTimeout(() => { t.classList.add('fade-out'); setTimeout(() => t.remove(), 220); }, duration);
}

/* ── confirm dialog ─────────────────────────────────────────── */

function confirm(title, message) {
  return new Promise(resolve => {
    el.confirmTitle.textContent   = title;
    el.confirmMessage.textContent = message;
    el.confirmOverlay.classList.remove('hidden');

    function cleanup(result) {
      el.confirmOverlay.classList.add('hidden');
      el.confirmOk.removeEventListener('click', onOk);
      el.confirmCancel.removeEventListener('click', onCancel);
      resolve(result);
    }
    const onOk     = () => cleanup(true);
    const onCancel = () => cleanup(false);
    el.confirmOk.addEventListener('click', onOk);
    el.confirmCancel.addEventListener('click', onCancel);
  });
}

/* ── settings ───────────────────────────────────────────────── */

async function loadSettings() {
  state.settings.apiKey = (await DB.getSetting('apiKey')) ?? '';
  state.settings.model  = (await DB.getSetting('model'))  ?? 'claude-sonnet-4-6';
  state.settings.theme  = (await DB.getSetting('theme'))  ?? 'light';
  applyTheme(state.settings.theme);
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  document.querySelectorAll('[data-theme-btn]').forEach(b =>
    b.classList.toggle('active', b.dataset.themeBtn === theme)
  );
}

function openSettingsModal() {
  el.apiKeyInput.value = state.settings.apiKey;
  el.modelSelect.value = state.settings.model;
  applyTheme(state.settings.theme);
  el.settingsModal.classList.remove('hidden');
  setTimeout(() => el.apiKeyInput.focus(), 60);
}

function closeSettingsModal() {
  el.settingsModal.classList.add('hidden');
}

async function saveSettings() {
  const apiKey = el.apiKeyInput.value.trim();
  const model  = el.modelSelect.value;
  const theme  = document.documentElement.getAttribute('data-theme') ?? 'light';

  state.settings.apiKey = apiKey;
  state.settings.model  = model;
  state.settings.theme  = theme;

  await Promise.all([
    DB.setSetting('apiKey', apiKey),
    DB.setSetting('model',  model),
    DB.setSetting('theme',  theme),
  ]);

  closeSettingsModal();
  toast('Settings saved', 'success');
}

/* ── notes list ─────────────────────────────────────────────── */

async function loadNotes() {
  state.notes = state.searchQuery
    ? await DB.searchNotes(state.searchQuery)
    : await DB.getAllNotes();
  renderNotesList();
}

function renderNotesList() {
  const { notes } = state;
  el.notesCount.textContent = `${notes.length} note${notes.length !== 1 ? 's' : ''}`;

  if (!notes.length) {
    el.notesList.innerHTML = `<p style="padding:20px 14px;font-size:13px;color:var(--sb-text-2);text-align:center">
      ${state.searchQuery ? 'No matching notes' : 'No notes yet'}
    </p>`;
    return;
  }

  el.notesList.innerHTML = '';
  notes.forEach(note => el.notesList.appendChild(buildNoteCard(note)));
}

function buildNoteCard(note) {
  const isProc = note.processingState && note.processingState !== 'done' && note.processingState !== 'error';
  const div    = document.createElement('div');
  div.className  = `note-card${note.id === state.currentNoteId ? ' active' : ''}`;
  div.dataset.id = note.id;
  div.setAttribute('role', 'listitem');

  const tagsHtml = (note.tags ?? []).slice(0, 3)
    .map(t => `<span class="note-card-tag">${escHtml(t)}</span>`).join('');

  div.innerHTML = `
    <div class="note-card-title">${escHtml(note.title ?? 'Untitled')}</div>
    <div class="note-card-summary">${escHtml(note.summary ?? (isProc ? 'Processing…' : ''))}</div>
    <div class="note-card-footer">
      <div class="note-card-tags">${tagsHtml}</div>
      <span class="note-card-date">${fmtDateShort(note.createdAt)}</span>
    </div>
    ${isProc ? `<div class="note-card-processing"><div class="spinner"></div>${escHtml(note.processingState)}</div>` : ''}
  `;
  div.addEventListener('click', () => openNote(note.id));
  return div;
}

/* ── note detail ────────────────────────────────────────────── */

async function openNote(id) {
  const note = await DB.getNote(id);
  if (!note) return;

  state.currentNoteId = id;

  // Highlight card in sidebar
  document.querySelectorAll('.note-card').forEach(c =>
    c.classList.toggle('active', c.dataset.id === id)
  );

  // Populate header
  el.noteModalTitle.textContent  = note.title ?? 'Untitled';
  el.noteModalDate.textContent   = fmtDate(note.createdAt);
  el.noteModalSource.textContent = note.sourceType === 'pdf' ? 'PDF' : 'Image';

  const isProc = note.processingState && note.processingState !== 'done' && note.processingState !== 'error';
  el.noteProcessBadge.classList.toggle('hidden', !isProc);
  if (isProc)
    el.noteProcessBadge.innerHTML = `<div class="spinner" style="width:10px;height:10px;border-width:1.5px"></div>&nbsp;${escHtml(note.processingState)}`;

  // Images
  el.noteImagesContainer.innerHTML = '';
  (note.images ?? []).forEach((src, i) => {
    const wrap = document.createElement('div');
    wrap.className = 'note-image-item';
    wrap.innerHTML = `
      <img src="${escHtml(src)}" alt="Page ${i + 1}" loading="lazy" />
      ${(note.images?.length ?? 0) > 1 ? `<div class="note-image-page">Page ${i + 1} / ${note.images.length}</div>` : ''}
    `;
    wrap.querySelector('img').addEventListener('click', () => openLightbox(src));
    el.noteImagesContainer.appendChild(wrap);
  });

  // Tab content
  el.tabOrganized.innerHTML       = note.organized
    ? marked.parse(note.organized)
    : '<p style="color:var(--text-3);font-style:italic">No organized content yet.</p>';
  el.tabTranscription.textContent = note.transcription ?? '';
  renderSummaryTab(note);
  switchTab('organized');

  // Tags & related
  renderTags(note.tags ?? []);
  await renderRelatedNotes(note.id);

  el.noteModal.classList.remove('hidden');
  el.noteModal.querySelector('.modal-box').scrollTop = 0;
  showMainView('note');
}

function renderSummaryTab(note) {
  const kp = note.keyPoints ?? [];
  el.tabSummary.innerHTML = `
    <div class="summary-text">${escHtml(note.summary ?? 'No summary yet.')}</div>
    ${kp.length ? `
      <div class="key-points">
        <div class="key-points-label">Key Points</div>
        <ul>${kp.map(p => `<li>${escHtml(p)}</li>`).join('')}</ul>
      </div>` : ''}
  `;
}

function renderTags(tags) {
  el.noteTagsList.innerHTML = tags.map(tag => `
    <span class="tag-chip">
      ${escHtml(tag)}
      <button class="tag-chip-remove" data-tag="${escHtml(tag)}" aria-label="Remove tag">×</button>
    </span>
  `).join('');
}

async function renderRelatedNotes(noteId) {
  const relations = await DB.getRelations(noteId);
  el.relatedRow.classList.toggle('hidden', !relations.length);
  if (!relations.length) return;

  const chips = await Promise.all(relations.map(async rel => {
    const otherId = rel.fromId === noteId ? rel.toId : rel.fromId;
    const other   = await DB.getNote(otherId);
    if (!other) return '';
    const pct = Math.round((rel.score ?? 0) * 100);
    return `<button class="related-chip" data-id="${escHtml(otherId)}" title="${escHtml(rel.reason ?? '')}">
      ${escHtml(other.title ?? 'Untitled')}<span class="related-score">${pct}%</span>
    </button>`;
  }));

  el.relatedNotesList.innerHTML = chips.join('');
}

function closeNoteModal() {
  el.noteModal.classList.add('hidden');
  state.currentNoteId = null;
  document.querySelectorAll('.note-card').forEach(c => c.classList.remove('active'));
  showMainView(state.notes.length ? 'empty' : 'upload');
}

function switchTab(name) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  [
    ['organized',    el.tabOrganized],
    ['transcription',el.tabTranscription],
    ['summary',      el.tabSummary],
  ].forEach(([n, p]) => p.classList.toggle('hidden', n !== name));
}

/* ── main view ───────────────────────────────────────────────── */

function showMainView(view) {
  // view: 'upload' | 'empty' | 'note'  (note = modal is open, show empty bg)
  el.uploadZone.classList.toggle('hidden',  view !== 'upload');
  el.emptyState.classList.toggle('hidden',  view !== 'empty' && view !== 'note');
}

/* ── lightbox ────────────────────────────────────────────────── */

function openLightbox(src) {
  const lb = document.createElement('div');
  lb.className = 'lightbox';
  lb.innerHTML = `<img src="${escHtml(src)}" alt="Full size" />`;
  lb.addEventListener('click', () => lb.remove());
  document.addEventListener('keydown', function esc(e) { if (e.key === 'Escape') { lb.remove(); document.removeEventListener('keydown', esc); } });
  document.body.appendChild(lb);
}

/* ── file processing ─────────────────────────────────────────── */

async function handleFiles(files) {
  if (!state.settings.apiKey) {
    toast('Add your Anthropic API key in Settings first', 'warning');
    openSettingsModal();
    return;
  }

  const valid = [...files].filter(f => {
    const ok = f.type.startsWith('image/') || f.type === 'application/pdf';
    if (!ok) toast(`Skipped "${f.name}" — unsupported type`, 'warning');
    return ok;
  });
  if (!valid.length) return;

  const jobs = valid.map(f => ({ id: uuid(), file: f, name: f.name, status: 'Waiting…', progress: 0, done: false, error: false }));
  state.processing.push(...jobs);
  renderQueue();

  for (const job of jobs) await processJob(job);

  setTimeout(() => {
    state.processing = state.processing.filter(j => j.error);
    renderQueue();
    if (!state.processing.length) el.processingQueue.classList.add('hidden');
  }, 2500);
}

async function processJob(job) {
  try {
    updateJob(job, 'Reading file…', 10);

    let dataUrls;
    if (job.file.type === 'application/pdf') {
      updateJob(job, 'Rendering PDF…', 20);
      dataUrls = await renderPDF(job.file);
    } else {
      const raw = await API.fileToDataUrl(job.file);
      dataUrls  = [await API.resizeImage(raw)];
    }

    updateJob(job, 'Transcribing with AI…', 45);
    const result = await API.processNote(dataUrls, state.settings.apiKey, state.settings.model);

    updateJob(job, 'Saving…', 88);
    const note = {
      id:              uuid(),
      createdAt:       Date.now(),
      updatedAt:       Date.now(),
      title:           result.title,
      transcription:   result.transcription,
      organized:       result.organized,
      summary:         result.summary,
      tags:            result.tags,
      keyPoints:       result.keyPoints,
      images:          dataUrls,
      sourceType:      job.file.type === 'application/pdf' ? 'pdf' : 'image',
      processingState: 'done',
    };

    await DB.saveNote(note);
    updateJob(job, 'Done ✓', 100, true, false);
    toast(`"${note.title}" ready`, 'success');

    await loadNotes();
    showMainView('empty');

    // Find relations in background — never block the UI
    findAndSaveRelations(note).catch(() => {});

  } catch (err) {
    console.error('[processJob]', err);
    updateJob(job, err.message, 0, false, true);
    toast(`Failed: "${job.name}" — ${err.message}`, 'error', 6000);
  }
}

async function findAndSaveRelations(newNote) {
  const all     = await DB.getAllNotes();
  const others  = all.filter(n => n.id !== newNote.id && n.processingState === 'done');
  if (!others.length) return;

  const related = await API.findRelatedNotes(newNote, others, state.settings.apiKey, state.settings.model);
  if (!related.length) return;

  await DB.saveRelations(related.map(r => ({
    id:        uuid(),
    fromId:    newNote.id,
    toId:      r.id,
    score:     r.score,
    reason:    r.reason,
    createdAt: Date.now(),
  })));

  if (state.currentNoteId === newNote.id) await renderRelatedNotes(newNote.id);
}

/* ── PDF rendering ───────────────────────────────────────────── */

async function renderPDF(file) {
  if (typeof pdfjsLib === 'undefined')
    throw new Error('PDF.js did not load. Please refresh the page.');

  pdfjsLib.GlobalWorkerOptions.workerSrc =
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

  const pdf      = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
  const dataUrls = [];

  for (let i = 1; i <= pdf.numPages; i++) {
    const page   = await pdf.getPage(i);
    const vp     = page.getViewport({ scale: 1.8 });
    const canvas = document.createElement('canvas');
    canvas.width  = vp.width;
    canvas.height = vp.height;
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
    dataUrls.push(await API.resizeImage(canvas.toDataURL('image/jpeg', 0.85)));
  }
  return dataUrls;
}

/* ── queue UI ────────────────────────────────────────────────── */

function updateJob(job, status, progress, done = false, error = false) {
  job.status   = status;
  job.progress = progress;
  job.done     = done;
  job.error    = error;
  renderQueue();
}

function renderQueue() {
  if (!state.processing.length) return;
  el.processingQueue.classList.remove('hidden');

  const done  = state.processing.filter(j => j.done).length;
  el.processingStatus.textContent = `${done} / ${state.processing.length}`;

  el.queueItems.innerHTML = state.processing.map(j => `
    <div class="queue-item">
      ${j.done  ? '<span style="color:var(--success);font-size:15px">✓</span>'
      : j.error ? '<span style="color:var(--danger);font-size:15px">✕</span>'
      :           '<div class="spinner"></div>'}
      <div style="flex:1;min-width:0">
        <div class="queue-item-name">${escHtml(j.name)}</div>
        <div class="queue-progress"><div class="queue-progress-bar" style="width:${j.progress}%"></div></div>
      </div>
      <span class="queue-item-status${j.error?' error':j.done?' done':''}">${escHtml(j.status)}</span>
    </div>
  `).join('');
}

/* ── tags ────────────────────────────────────────────────────── */

async function addTag(raw) {
  const tag  = raw.toLowerCase().trim().replace(/[^a-z0-9-_]/g, '');
  if (!tag || !state.currentNoteId) return;
  const note = await DB.getNote(state.currentNoteId);
  if (!note || (note.tags ?? []).includes(tag)) return;
  note.tags      = [...(note.tags ?? []), tag];
  note.updatedAt = Date.now();
  await DB.saveNote(note);
  renderTags(note.tags);
  await loadNotes();
}

async function removeTag(tag) {
  if (!state.currentNoteId) return;
  const note = await DB.getNote(state.currentNoteId);
  if (!note) return;
  note.tags      = (note.tags ?? []).filter(t => t !== tag);
  note.updatedAt = Date.now();
  await DB.saveNote(note);
  renderTags(note.tags);
  await loadNotes();
}

/* ── note actions ────────────────────────────────────────────── */

async function reprocessCurrentNote() {
  if (!state.currentNoteId) return;
  const note = await DB.getNote(state.currentNoteId);
  if (!note?.images?.length) { toast('No images to reprocess', 'warning'); return; }

  const ok = await confirm('Reprocess note?', 'AI will re-analyse the original images and overwrite the current text.');
  if (!ok) return;

  el.noteReprocessBtn.disabled = true;
  el.noteProcessBadge.classList.remove('hidden');
  el.noteProcessBadge.innerHTML = `<div class="spinner" style="width:10px;height:10px;border-width:1.5px"></div>&nbsp;Transcribing…`;

  try {
    const result = await API.processNote(note.images, state.settings.apiKey, state.settings.model);
    Object.assign(note, { ...result, processingState: 'done', updatedAt: Date.now() });
    await DB.saveNote(note);
    await loadNotes();
    await openNote(note.id);
    toast('Note reprocessed', 'success');
  } catch (err) {
    toast(`Reprocess failed: ${err.message}`, 'error');
    el.noteProcessBadge.classList.add('hidden');
  } finally {
    el.noteReprocessBtn.disabled = false;
  }
}

async function deleteCurrentNote() {
  if (!state.currentNoteId) return;
  const note = await DB.getNote(state.currentNoteId);
  const ok   = await confirm('Delete note?', `"${note?.title ?? 'This note'}" will be permanently deleted.`);
  if (!ok) return;
  await DB.deleteNote(state.currentNoteId);
  closeNoteModal();
  await loadNotes();
  toast('Note deleted', 'info');
}

async function saveTitleEdit() {
  if (!state.currentNoteId) return;
  const newTitle = el.noteModalTitle.textContent.trim();
  if (!newTitle) return;
  const note = await DB.getNote(state.currentNoteId);
  if (!note || note.title === newTitle) return;
  note.title     = newTitle;
  note.updatedAt = Date.now();
  await DB.saveNote(note);
  await loadNotes();
}

function exportNoteMarkdown(note) {
  const md = [
    `# ${note.title}`, `_${fmtDate(note.createdAt)}_`, '',
    `## Summary`, note.summary ?? '', '',
    `## Organized Notes`, note.organized ?? '', '',
    `## Original Transcription`, '```', note.transcription ?? '', '```', '',
    `**Tags:** ${(note.tags ?? []).map(t => `#${t}`).join(' ')}`,
  ].join('\n');

  const a    = Object.assign(document.createElement('a'), {
    href:     URL.createObjectURL(new Blob([md], { type: 'text/markdown' })),
    download: `${(note.title ?? 'note').replace(/[^a-z0-9]/gi,'_').toLowerCase()}.md`,
  });
  a.click();
  URL.revokeObjectURL(a.href);
}

/* ── export / import ─────────────────────────────────────────── */

async function exportAll() {
  const data = await DB.exportAll();
  const a    = Object.assign(document.createElement('a'), {
    href:     URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })),
    download: `paperbrain-${new Date().toISOString().slice(0,10)}.json`,
  });
  a.click();
  URL.revokeObjectURL(a.href);
  toast('Export downloaded', 'success');
}

async function importNotes(file) {
  try {
    const data = JSON.parse(await file.text());
    await DB.importAll(data);
    await loadNotes();
    showMainView(state.notes.length ? 'empty' : 'upload');
    toast(`Imported ${data.notes?.length ?? 0} notes`, 'success');
  } catch (err) {
    toast(`Import failed: ${err.message}`, 'error');
  }
}

/* ── search ──────────────────────────────────────────────────── */

let searchTimer = null;
function handleSearch(q) {
  state.searchQuery = q;
  el.searchClear.classList.toggle('hidden', !q);
  clearTimeout(searchTimer);
  searchTimer = setTimeout(loadNotes, 260);
}

/* ── drag and drop ───────────────────────────────────────────── */

function setupDragDrop() {
  const dz = el.dropTarget;
  dz.addEventListener('dragenter', e => { e.preventDefault(); dz.classList.add('drag-over'); });
  dz.addEventListener('dragover',  e => { e.preventDefault(); dz.classList.add('drag-over'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('drag-over'));
  dz.addEventListener('drop', e => {
    e.preventDefault();
    dz.classList.remove('drag-over');
    if (e.dataTransfer?.files?.length) handleFiles(e.dataTransfer.files);
  });

  // Global drop (e.g. onto sidebar)
  document.addEventListener('dragover', e => e.preventDefault());
  document.addEventListener('drop', e => {
    e.preventDefault();
    if (e.dataTransfer?.files?.length) handleFiles(e.dataTransfer.files);
  });
}

/* ── events ──────────────────────────────────────────────────── */

function setupEvents() {
  // Settings
  el.settingsBtn.addEventListener('click',     openSettingsModal);
  el.closeSettings.addEventListener('click',   closeSettingsModal);
  el.settingsModal.addEventListener('click', e => { if (e.target === el.settingsModal) closeSettingsModal(); });
  el.saveSettingsBtn.addEventListener('click', saveSettings);

  el.toggleKeyBtn.addEventListener('click', () => {
    const hide = el.apiKeyInput.type === 'password';
    el.apiKeyInput.type       = hide ? 'text'    : 'password';
    el.toggleKeyBtn.textContent = hide ? 'Hide' : 'Show';
  });

  el.testKeyBtn.addEventListener('click', async () => {
    const key = el.apiKeyInput.value.trim();
    if (!key) { toast('Enter a key first', 'warning'); return; }

    // API calls require a served origin (https:// or localhost), not file://
    if (location.protocol === 'file:') {
      toast('Open the app via a server (not file://) — try a Live Server extension or GitHub Pages', 'error', 8000);
      return;
    }

    el.testKeyBtn.disabled = true;
    el.testKeyBtn.textContent = '…';
    try {
      await API.testApiKey(key);
      toast('API key valid ✓', 'success');
    } catch (err) {
      // Distinguish auth failures from network/CORS errors
      const msg = err.message.toLowerCase();
      if (msg.includes('failed to fetch') || msg.includes('networkerror') || msg.includes('load failed')) {
        toast('Network error — check your internet connection or browser extensions blocking requests', 'error', 7000);
      } else if (msg.includes('401') || msg.includes('authentication') || msg.includes('invalid x-api-key')) {
        toast('Invalid API key — check it at console.anthropic.com', 'error', 6000);
      } else {
        toast(`API error: ${err.message}`, 'error', 6000);
      }
    } finally {
      el.testKeyBtn.disabled   = false;
      el.testKeyBtn.textContent = 'Test';
    }
  });

  document.querySelectorAll('[data-theme-btn]').forEach(b =>
    b.addEventListener('click', () => applyTheme(b.dataset.themeBtn))
  );

  el.exportBtn.addEventListener('click', exportAll);
  el.importFile.addEventListener('change', e => {
    const f = e.target.files?.[0];
    if (f) { importNotes(f); e.target.value = ''; }
  });
  el.clearAllBtn.addEventListener('click', async () => {
    const ok = await confirm('Clear all data?', 'All notes, relations, and settings will be permanently deleted.');
    if (!ok) return;
    await DB.clearAllData();
    state.notes = []; state.currentNoteId = null;
    closeNoteModal(); closeSettingsModal();
    renderNotesList();
    showMainView('upload');
    toast('All data cleared', 'info');
  });

  // Upload
  el.uploadBtn.addEventListener('click',    () => el.fileInput.click());
  el.cameraBtn.addEventListener('click',    () => el.cameraInput.click());
  el.newUploadBtn.addEventListener('click', () => {
    showMainView('upload');
    el.fileInput.click();
  });
  el.emptyUploadBtn.addEventListener('click', () => {
    showMainView('upload');
    el.fileInput.click();
  });
  el.fileInput.addEventListener('change', e => {
    if (e.target.files?.length) { handleFiles(e.target.files); e.target.value = ''; }
  });
  el.cameraInput.addEventListener('change', e => {
    if (e.target.files?.length) { handleFiles(e.target.files); e.target.value = ''; }
  });

  // Note modal
  el.closeNoteModal.addEventListener('click', closeNoteModal);
  el.noteModal.addEventListener('click', e => { if (e.target === el.noteModal) closeNoteModal(); });
  el.noteModalTitle.addEventListener('blur',    saveTitleEdit);
  el.noteModalTitle.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); el.noteModalTitle.blur(); } });
  el.noteReprocessBtn.addEventListener('click', reprocessCurrentNote);
  el.noteDeleteBtn.addEventListener('click',    deleteCurrentNote);
  el.noteExportMdBtn.addEventListener('click',  async () => {
    if (state.currentNoteId) {
      const note = await DB.getNote(state.currentNoteId);
      if (note) exportNoteMarkdown(note);
    }
  });

  // Tabs
  document.querySelectorAll('.tab-btn').forEach(b =>
    b.addEventListener('click', () => switchTab(b.dataset.tab))
  );

  // Tags
  el.noteTagInput.addEventListener('keydown', async e => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      const v = el.noteTagInput.value.replace(/,$/, '').trim();
      if (v) { await addTag(v); el.noteTagInput.value = ''; }
    }
  });
  el.noteTagsList.addEventListener('click', async e => {
    const btn = e.target.closest('.tag-chip-remove');
    if (btn) await removeTag(btn.dataset.tag);
  });

  // Related notes
  el.relatedNotesList.addEventListener('click', e => {
    const chip = e.target.closest('.related-chip');
    if (chip?.dataset.id) openNote(chip.dataset.id);
  });

  // Search
  el.searchInput.addEventListener('input',  e => handleSearch(e.target.value));
  el.searchClear.addEventListener('click',  () => { el.searchInput.value = ''; handleSearch(''); });

  // Keyboard
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      if (!el.noteModal.classList.contains('hidden'))         closeNoteModal();
      else if (!el.settingsModal.classList.contains('hidden')) closeSettingsModal();
    }
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
      e.preventDefault();
      el.searchInput.focus(); el.searchInput.select();
    }
  });

  setupDragDrop();
}

/* ── init ────────────────────────────────────────────────────── */

async function init() {
  try {
    await DB.openDB();
    await loadSettings();
    await loadNotes();
    setupEvents();

    showMainView(state.notes.length ? 'empty' : 'upload');

    if (!state.settings.apiKey) {
      setTimeout(() => {
        toast('Welcome! Add your Anthropic API key in Settings to begin.', 'info', 6000);
        openSettingsModal();
      }, 500);
    }
  } catch (err) {
    console.error('[init]', err);
    toast('Failed to start. Please refresh the page.', 'error', 10000);
  }
}

init();
