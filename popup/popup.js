/**
 * popup.js — Extension UI logic (English version).
 * Manages state, drag-and-drop, settings, preview and download.
 * All heavy processing is delegated to a Web Worker (worker/processor.js).
 */
'use strict';

// ---------------------------------------------------------------------------
// Category metadata (mirrors CATEGORIES from entity-finder.js for UI)
// ---------------------------------------------------------------------------
const CATEGORIES = {
  PERSON:   { label: 'Full Name',        placeholder: 'NAME',     color: '#4CAF50', defaultOn: true  },
  COMPANY:  { label: 'Company / Entity', placeholder: 'COMPANY',  color: '#2196F3', defaultOn: true  },
  SSN:      { label: 'SSN',              placeholder: 'SSN',      color: '#E91E63', defaultOn: true  },
  TAXID:    { label: 'Tax ID / EIN',     placeholder: 'TAXID',    color: '#FF5722', defaultOn: true  },
  SWIFT:    { label: 'SWIFT',            placeholder: 'SWIFT',    color: '#FF8F00', defaultOn: true  },
  IBAN:     { label: 'IBAN',             placeholder: 'IBAN',     color: '#FFA000', defaultOn: true  },
  EMAIL:    { label: 'Email',            placeholder: 'EMAIL',    color: '#D32F2F', defaultOn: true  },
  PHONE:    { label: 'Phone',            placeholder: 'PHONE',    color: '#C62828', defaultOn: true  },
  URL:      { label: 'URL / Website',    placeholder: 'URL',      color: '#B71C1C', defaultOn: true  },
  ADDRESS:  { label: 'Address',          placeholder: 'ADDRESS',  color: '#5D4037', defaultOn: true  },
  CONTRACT: { label: 'Contract No.',     placeholder: 'CONTRACT', color: '#455A64', defaultOn: false },
  AMOUNT:   { label: 'Amounts',          placeholder: 'AMOUNT',   color: '#546E7A', defaultOn: false },
};

// ---------------------------------------------------------------------------
// App state
// ---------------------------------------------------------------------------
let state       = 'idle';   // idle | processing | preview | applying | done | error
let currentFile = null;     // { name: string, buffer: ArrayBuffer }
let entities    = [];       // array of entities after PARSE
let worker      = null;
let markupMode  = false;    // true when "Download with markup" was clicked

const DICT_KEY = 'docxAnonymizerDictionaryEN';
let dictWords  = [];

const CUSTOM_CAT_KEY = 'docxAnonymizerCustomCategoriesEN';
let customCategories = [];

const STORAGE_KEY = 'docxAnonymizerSettingsEN';

/** Merges built-in and custom categories */
function getAllCategories() {
  const result = { ...CATEGORIES };
  for (const cat of customCategories) {
    result[cat.key] = {
      label:       cat.label,
      placeholder: cat.placeholder || cat.label.toUpperCase().slice(0, 10),
      color:       cat.color || '#8B5CF6',
      defaultOn:   true,
    };
  }
  return result;
}

// ---------------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
  initWorker();
  initDropZone();
  initCategoryGrid();
  initModeSelector();
  initPreviewControls();
  initButtons();
  initDictionary();
  initCustomCategories();
  initLlmSettings();
  loadSettings();
});

// ---------------------------------------------------------------------------
// Settings: save / load from chrome.storage.local
// ---------------------------------------------------------------------------
function loadSettings() {
  chrome.storage.local.get(STORAGE_KEY, (data) => {
    const s = data[STORAGE_KEY];
    if (!s) return;

    if (s.enabledCategories) {
      document.querySelectorAll('#category-grid input[type="checkbox"]').forEach(cb => {
        cb.checked = s.enabledCategories.includes(cb.dataset.cat);
        cb.closest('label').classList.toggle('off', !cb.checked);
      });
    }

    if (s.mode) {
      document.querySelectorAll('.mode-btn').forEach(btn => {
        const isActive = btn.dataset.mode === s.mode;
        btn.classList.toggle('active', isActive);
        btn.querySelector('input').checked = isActive;
      });
    }

    if (s.autoIntercept !== undefined) {
      $('auto-intercept').checked = s.autoIntercept;
    }

    // LLM settings
    if (s.llmEnabled !== undefined) {
      $('llm-enabled').checked = s.llmEnabled;
      $s('llm-fields', s.llmEnabled);
    }
    if (s.llmServerUrl) $('llm-url').value = s.llmServerUrl;
    if (s.llmModel)     $('llm-model').value = s.llmModel;
  });
}

function saveSettings() {
  const s = {
    enabledCategories: getEnabledCategories(),
    mode:              getSelectedMode(),
    autoIntercept:     $('auto-intercept').checked,
    llmEnabled:        $('llm-enabled').checked,
    llmServerUrl:      $('llm-url').value.trim(),
    llmModel:          $('llm-model').value.trim(),
  };
  chrome.storage.local.set({ [STORAGE_KEY]: s });
}

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------
function initWorker() {
  worker = new Worker(chrome.runtime.getURL('worker/processor.js'));
  worker.onmessage = onWorkerMessage;
  worker.onerror   = (e) => showError(e.message || 'Worker error');
}

function onWorkerMessage(e) {
  const { type } = e.data;

  if (type === 'PROGRESS') {
    setProgress(e.data.percent, e.data.message);

  } else if (type === 'ENTITIES') {
    entities = e.data.entities;
    renderPreview(entities, e.data.stats);
    setState('preview');

  } else if (type === 'RESULT') {
    triggerDownload(e.data.buffer, e.data.filename);
    if (e.data.mapping) {
      const json = JSON.stringify(e.data.mapping, null, 2);
      triggerDownload(
        new TextEncoder().encode(json).buffer,
        e.data.filename.replace('.docx', '_mapping.json'),
        'application/json'
      );
    }
    const count = entities.filter(en => en.enabled !== false).length;
    if (markupMode) {
      markupMode = false;
      $('done-sub').textContent = `${count} entities marked. File saved to Downloads.`;
    } else {
      $('done-sub').textContent = `${count} entities replaced. File saved to Downloads.`;
    }
    setState('done');

  } else if (type === 'ERROR') {
    showError(e.data.message);
  }
}

// ---------------------------------------------------------------------------
// Drag-and-drop / file selection
// ---------------------------------------------------------------------------
function initDropZone() {
  const zone  = $('drop-zone');
  const input = $('file-input');

  zone.addEventListener('dragover',  (e) => { e.preventDefault(); zone.classList.add('drag-over'); });
  zone.addEventListener('dragleave', ()  => zone.classList.remove('drag-over'));
  zone.addEventListener('dragend',   ()  => zone.classList.remove('drag-over'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  });

  zone.addEventListener('click', () => input.click());
  zone.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') input.click(); });

  input.addEventListener('change', (e) => {
    if (e.target.files[0]) handleFile(e.target.files[0]);
    input.value = '';
  });
}

async function handleFile(file) {
  if (!file.name.toLowerCase().endsWith('.docx')) {
    showError('Only .docx files are supported');
    return;
  }
  if (file.size > 50 * 1024 * 1024) {
    showError('File too large (maximum 50 MB)');
    return;
  }

  setState('processing');
  setProgress(0, 'Reading file…');

  let buffer;
  try {
    buffer = await file.arrayBuffer();
  } catch (e) {
    showError('Could not read file: ' + e.message);
    return;
  }

  currentFile = { name: file.name, buffer };

  worker.postMessage({
    type:    'PARSE',
    buffer,
    filename: file.name,
    options:  {
      enabledCategories: getEnabledCategories(),
      language:          'en',
      exclusionWords:    dictWords,
      customCategories:  customCategories,
      llmEnabled:        $('llm-enabled').checked,
      llmServerUrl:      $('llm-url').value.trim(),
      llmModel:          $('llm-model').value.trim(),
    },
  });
}

// ---------------------------------------------------------------------------
// Category checkboxes
// ---------------------------------------------------------------------------
function initCategoryGrid() {
  const grid = $('category-grid');

  for (const [key, cat] of Object.entries(CATEGORIES)) {
    const label = document.createElement('label');
    label.className = 'cat-item' + (cat.defaultOn ? '' : ' off');
    label.innerHTML = `
      <input type="checkbox" ${cat.defaultOn ? 'checked' : ''} data-cat="${key}">
      <span class="cat-dot" style="background:${cat.color}"></span>
      <span class="cat-label">${cat.label}</span>
    `;
    label.querySelector('input').addEventListener('change', (e) => {
      label.classList.toggle('off', !e.target.checked);
      saveSettings();
    });
    grid.appendChild(label);
  }
}

function getEnabledCategories() {
  return Array.from(
    document.querySelectorAll('#category-grid input[type="checkbox"]:checked')
  ).map(el => el.dataset.cat);
}

// ---------------------------------------------------------------------------
// Replacement mode
// ---------------------------------------------------------------------------
function initModeSelector() {
  document.querySelectorAll('.mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      saveSettings();
    });
  });
}

function getSelectedMode() {
  const active = document.querySelector('.mode-btn.active');
  return active ? active.dataset.mode : 'placeholder';
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------
let currentFilter = 'ALL';

function initPreviewControls() {
  $('check-all-header').addEventListener('change', (e) => {
    getVisibleRows().forEach(row => {
      const cb = row.querySelector('input[type="checkbox"]');
      if (cb) { cb.checked = e.target.checked; syncEntityEnabled(cb); }
    });
  });

  $('btn-select-all').addEventListener('click', () => {
    getVisibleRows().forEach(row => {
      const cb = row.querySelector('input[type="checkbox"]');
      if (cb) { cb.checked = true; syncEntityEnabled(cb); }
    });
    $('check-all-header').checked = true;
  });

  $('btn-deselect-all').addEventListener('click', () => {
    getVisibleRows().forEach(row => {
      const cb = row.querySelector('input[type="checkbox"]');
      if (cb) { cb.checked = false; syncEntityEnabled(cb); }
    });
    $('check-all-header').checked = false;
  });

  $('btn-another').addEventListener('click', resetToIdle);

  const allBtn = $('filter-row').querySelector('[data-filter="ALL"]');
  if (allBtn) {
    allBtn.addEventListener('click', () => {
      currentFilter = 'ALL';
      applyFilter('ALL');
    });
  }
}

function getVisibleRows() {
  return Array.from($('preview-tbody').querySelectorAll('tr:not(.filter-hidden)'));
}

function syncEntityEnabled(checkbox) {
  const id = checkbox.dataset.id;
  const entity = entities.find(e => e.id === id);
  if (entity) {
    entity.enabled = checkbox.checked;
    checkbox.closest('tr').classList.toggle('disabled', !checkbox.checked);
    recalculatePlaceholders();
  }
}

function renderPreview(ents, stats) {
  const allCats = getAllCategories();
  const parts   = [`Found: <strong>${stats.total}</strong>`];
  for (const [cat, cnt] of Object.entries(stats.byCategory)) {
    const meta = allCats[cat];
    if (meta) {
      parts.push(`<span class="badge" style="background:${meta.color}">${meta.label}: ${cnt}</span>`);
    }
  }
  $('preview-stats').innerHTML = parts.join(' &nbsp;');

  renderFilterButtons(stats.byCategory);

  const tbody = $('preview-tbody');
  tbody.innerHTML = '';

  for (const entity of ents) {
    const tr = document.createElement('tr');
    tr.dataset.id  = entity.id;
    tr.dataset.cat = entity.category;

    const tdCheck = document.createElement('td');
    tdCheck.className = 'col-check';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = true;
    cb.dataset.id = entity.id;
    cb.addEventListener('change', (e) => { syncEntityEnabled(e.target); });
    tdCheck.appendChild(cb);

    const tdValue = document.createElement('td');
    tdValue.className = 'col-value';
    buildValueCell(tdValue, entity);

    const tdCat = document.createElement('td');
    tdCat.className = 'col-cat';
    const sel = document.createElement('select');
    sel.className = 'cat-select';
    sel.dataset.id = entity.id;
    for (const [key, cat] of Object.entries(getAllCategories())) {
      const opt = document.createElement('option');
      opt.value = key;
      opt.textContent = cat.label;
      opt.selected = key === entity.category;
      sel.appendChild(opt);
    }
    sel.addEventListener('change', (e) => {
      const ent = entities.find(en => en.id === e.target.dataset.id);
      if (ent) {
        ent.category = e.target.value;
        tr.dataset.cat = e.target.value;
        recalculatePlaceholders();
        const inp = tr.querySelector('.replacement-input');
        if (inp) inp.value = ent.replacementText;
      }
    });
    tdCat.appendChild(sel);

    const tdRepl = document.createElement('td');
    tdRepl.className = 'col-repl';
    const replInput = document.createElement('input');
    replInput.type = 'text';
    replInput.className = 'replacement-input';
    replInput.value = entity.replacementText;
    replInput.dataset.id = entity.id;
    replInput.spellcheck = false;
    replInput.addEventListener('input', (e) => {
      const ent = entities.find(en => en.id === e.target.dataset.id);
      if (ent) ent.replacementText = e.target.value;
    });
    tdRepl.appendChild(replInput);

    tr.appendChild(tdCheck);
    tr.appendChild(tdValue);
    tr.appendChild(tdCat);
    tr.appendChild(tdRepl);
    tbody.appendChild(tr);
  }

  applyFilter(currentFilter);
}

function renderFilterButtons(byCategory) {
  const filterRow = $('filter-row');
  const allCats   = getAllCategories();

  filterRow.querySelectorAll('.filter-btn:not([data-filter="ALL"])').forEach(b => b.remove());

  for (const [cat, cnt] of Object.entries(byCategory)) {
    const meta = allCats[cat];
    if (!meta) continue;
    const btn = document.createElement('button');
    btn.className = 'filter-btn';
    btn.dataset.filter = cat;
    btn.innerHTML = `<span style="color:${meta.color}">●</span> ${meta.label} (${cnt})`;
    btn.addEventListener('click', () => {
      currentFilter = cat;
      applyFilter(cat);
    });
    filterRow.appendChild(btn);
  }

  currentFilter = 'ALL';
  applyFilter('ALL');
}

function applyFilter(filter) {
  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.filter === filter);
  });

  const rows = $('preview-tbody').querySelectorAll('tr');
  rows.forEach(row => {
    const show = filter === 'ALL' || row.dataset.cat === filter;
    row.classList.toggle('filter-hidden', !show);
    row.style.display = show ? '' : 'none';
  });
}

// ---------------------------------------------------------------------------
// Entity value editor
// ---------------------------------------------------------------------------
function buildValueCell(td, entity) {
  td.innerHTML = '';
  const span = document.createElement('span');
  span.className = 'entity-value';
  span.title = entity.value;
  span.textContent = entity.value.length > 55 ? entity.value.slice(0, 55) + '…' : entity.value;

  const editBtn = document.createElement('button');
  editBtn.className = 'btn-edit-val';
  editBtn.title = 'Edit found text';
  editBtn.innerHTML = '✎';
  editBtn.addEventListener('click', () => startValueEdit(td, entity));

  td.appendChild(span);
  td.appendChild(editBtn);
}

function startValueEdit(td, entity) {
  td.innerHTML = '';
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'entity-value-edit';
  input.value = entity.value;
  td.appendChild(input);
  input.focus();
  input.select();

  const commit = () => {
    const newVal = input.value.trim();
    if (newVal && newVal !== entity.value) {
      const pt = entity.paraText || '';
      let idx = pt.indexOf(newVal, Math.max(0, entity.start - 10));
      if (idx === -1) idx = pt.indexOf(newVal);
      if (idx !== -1) {
        entity.start = idx;
        entity.end   = idx + newVal.length;
        entity.value = newVal;
      } else {
        alert(`Text "${newVal}" not found in paragraph. Change cancelled.`);
      }
    }
    buildValueCell(td, entity);
  };

  input.addEventListener('blur', commit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter')  { input.blur(); }
    if (e.key === 'Escape') { input.removeEventListener('blur', commit); buildValueCell(td, entity); }
  });
}

// ---------------------------------------------------------------------------
// Placeholder recalculation
// ---------------------------------------------------------------------------
function recalculatePlaceholders() {
  if (getSelectedMode() !== 'placeholder') return;
  const allCats  = getAllCategories();
  const counters = {};
  const seen     = {};
  for (const entity of entities) {
    if (entity.enabled === false) continue;
    const key = `${entity.category}::${entity.value.trim().toLowerCase()}`;
    if (seen[key]) {
      entity.replacementText = seen[key];
    } else {
      const n = (counters[entity.category] = (counters[entity.category] || 0) + 1);
      const prefix = (allCats[entity.category] || {}).placeholder || entity.category;
      entity.replacementText = `[${prefix}_${n}]`;
      seen[key] = entity.replacementText;
    }
    const inp = document.querySelector(`.replacement-input[data-id="${entity.id}"]`);
    if (inp) inp.value = entity.replacementText;
  }
}

// ---------------------------------------------------------------------------
// Custom categories
// ---------------------------------------------------------------------------
function initCustomCategories() {
  chrome.storage.local.get(CUSTOM_CAT_KEY, (data) => {
    customCategories = data[CUSTOM_CAT_KEY] || [];
    renderCustomCatList();
    renderCustomCatInGrid();
  });

  $('ccat-add').addEventListener('click', addCustomCategory);
  $('ccat-pattern').addEventListener('keydown', (e) => { if (e.key === 'Enter') addCustomCategory(); });
}

function addCustomCategory() {
  const label   = $('ccat-label').value.trim();
  const ph      = $('ccat-placeholder').value.trim().toUpperCase().replace(/\s+/g, '_') || 'CUSTOM';
  const pattern = $('ccat-pattern').value.trim();
  const color   = $('ccat-color').value;

  if (!label)   { $('ccat-label').focus();   return; }
  if (!pattern) { $('ccat-pattern').focus(); return; }

  try { new RegExp(pattern); } catch (_) {
    alert('Invalid regular expression: ' + pattern);
    return;
  }

  const key = 'CUST_' + Date.now();
  customCategories.push({ key, label, placeholder: ph, pattern, flags: 'gi', color });
  $('ccat-label').value       = '';
  $('ccat-placeholder').value = '';
  $('ccat-pattern').value     = '';
  $('ccat-color').value       = '#8B5CF6';

  saveCustomCategories();
  renderCustomCatList();
  renderCustomCatInGrid();
}

function saveCustomCategories() {
  chrome.storage.local.set({ [CUSTOM_CAT_KEY]: customCategories });
}

function renderCustomCatList() {
  const container = $('custom-cat-list');
  container.innerHTML = '';
  if (customCategories.length === 0) {
    container.innerHTML = '<span class="dict-empty">No custom categories</span>';
    return;
  }
  for (const cat of customCategories) {
    const item = document.createElement('div');
    item.className = 'custom-cat-item';

    const dot = document.createElement('span');
    dot.className = 'custom-cat-dot';
    dot.style.background = cat.color;

    const info = document.createElement('div');
    info.className = 'custom-cat-info';
    const name = document.createElement('div');
    name.className = 'custom-cat-name';
    name.textContent = `${cat.label}  →  [${cat.placeholder}_N]`;
    const pat = document.createElement('div');
    pat.className = 'custom-cat-pattern';
    pat.textContent = cat.pattern;
    info.appendChild(name);
    info.appendChild(pat);

    const del = document.createElement('button');
    del.className = 'custom-cat-del';
    del.title = 'Delete category';
    del.textContent = '×';
    del.addEventListener('click', () => {
      customCategories = customCategories.filter(c => c.key !== cat.key);
      saveCustomCategories();
      renderCustomCatList();
      renderCustomCatInGrid();
    });

    item.appendChild(dot);
    item.appendChild(info);
    item.appendChild(del);
    container.appendChild(item);
  }
}

function renderCustomCatInGrid() {
  const grid = $('category-grid');
  grid.querySelectorAll('.cat-item[data-custom]').forEach(el => el.remove());
  for (const cat of customCategories) {
    const label = document.createElement('label');
    label.className = 'cat-item';
    label.dataset.custom = cat.key;
    label.innerHTML = `
      <input type="checkbox" checked data-cat="${cat.key}">
      <span class="cat-dot" style="background:${cat.color}"></span>
      <span class="cat-label">${cat.label}</span>
    `;
    label.querySelector('input').addEventListener('change', (e) => {
      label.classList.toggle('off', !e.target.checked);
      saveSettings();
    });
    grid.appendChild(label);
  }
}

// ---------------------------------------------------------------------------
// Exclusion dictionary
// ---------------------------------------------------------------------------
function initDictionary() {
  chrome.storage.local.get(DICT_KEY, (data) => {
    dictWords = data[DICT_KEY] || [];
    renderDictList();
  });

  $('dict-add').addEventListener('click', addDictWord);
  $('dict-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') addDictWord(); });
}

function addDictWord() {
  const val = $('dict-input').value.trim();
  if (!val || dictWords.includes(val)) { $('dict-input').value = ''; return; }
  dictWords.push(val);
  $('dict-input').value = '';
  saveDictionary();
  renderDictList();
}

function saveDictionary() {
  chrome.storage.local.set({ [DICT_KEY]: dictWords });
}

function renderDictList() {
  const container = $('dict-list');
  container.innerHTML = '';
  if (dictWords.length === 0) {
    container.innerHTML = '<span class="dict-empty">List is empty</span>';
    return;
  }
  for (const word of dictWords) {
    const chip = document.createElement('span');
    chip.className = 'dict-chip';
    chip.textContent = word;
    const del = document.createElement('button');
    del.className = 'dict-del';
    del.textContent = '×';
    del.addEventListener('click', () => {
      dictWords = dictWords.filter(w => w !== word);
      saveDictionary();
      renderDictList();
    });
    chip.appendChild(del);
    container.appendChild(chip);
  }
}

// ---------------------------------------------------------------------------
// Action buttons
// ---------------------------------------------------------------------------
function initButtons() {
  $('btn-download').addEventListener('click', handleDownload);
  $('btn-markup').addEventListener('click', handleMarkup);
  $('btn-restart').addEventListener('click', resetToIdle);
  $('btn-error-restart').addEventListener('click', resetToIdle);
  $('auto-intercept').addEventListener('change', saveSettings);
}

function handleMarkup() {
  const activeEntities = entities.filter(e => e.enabled !== false);
  if (activeEntities.length === 0) {
    alert('No active entities to mark up.');
    return;
  }
  markupMode = true;
  setState('applying');
  worker.postMessage({
    type:     'MARKUP',
    entities: entities,
    buffer:   currentFile.buffer,
    filename: currentFile.name,
  });
}

function handleDownload() {
  const activeEntities = entities.filter(e => e.enabled !== false);
  if (activeEntities.length === 0) {
    alert('No active replacements. Select at least one entity.');
    return;
  }

  setState('applying');

  worker.postMessage({
    type:          'APPLY',
    entities:      entities,
    mode:          getSelectedMode(),
    buffer:        currentFile.buffer,
    filename:      currentFile.name,
    exportMapping: $('export-mapping').checked,
  });
}

// ---------------------------------------------------------------------------
// File download
// ---------------------------------------------------------------------------
function triggerDownload(buffer, filename, mimeType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
  const blob = new Blob([buffer], { type: mimeType });
  const url  = URL.createObjectURL(blob);
  chrome.downloads.download({ url, filename, saveAs: false }, () => {
    URL.revokeObjectURL(url);
  });
}

// ---------------------------------------------------------------------------
// State management
// ---------------------------------------------------------------------------
function setState(newState) {
  state = newState;

  const sections = ['upload-section', 'progress-section', 'preview-section', 'done-section', 'error-section'];
  sections.forEach(id => $s(id, false));

  switch (newState) {
    case 'idle':
      $s('upload-section', true);
      break;
    case 'processing':
      $s('upload-section', true);
      $s('progress-section', true);
      break;
    case 'preview':
      $s('preview-section', true);
      break;
    case 'applying':
      $s('preview-section', true);
      $s('progress-section', true);
      $('btn-download').disabled = true;
      break;
    case 'done':
      $s('done-section', true);
      break;
    case 'error':
      $s('upload-section', true);
      $s('error-section', true);
      break;
  }
}

function setProgress(percent, message) {
  $('progress-bar').style.width = percent + '%';
  $('progress-label').textContent = message || '';
}

function showError(msg) {
  $('error-message').textContent = msg;
  setState('error');
}

function resetToIdle() {
  currentFile   = null;
  entities      = [];
  markupMode    = false;
  currentFilter = 'ALL';
  $('preview-tbody').innerHTML = '';
  $('preview-stats').innerHTML = '';
  $('file-input').value = '';
  $('drop-zone').classList.remove('has-file');
  $('btn-download').disabled = false;
  setProgress(0, '');
  setState('idle');
}

// ---------------------------------------------------------------------------
// LLM settings
// ---------------------------------------------------------------------------
function initLlmSettings() {
  $('llm-enabled').addEventListener('change', (e) => {
    $s('llm-fields', e.target.checked);
    saveSettings();
  });

  $('llm-url').addEventListener('change', saveSettings);
  $('llm-model').addEventListener('change', saveSettings);

  $('llm-test').addEventListener('click', async () => {
    const url = $('llm-url').value.trim();
    if (!url) { setLlmStatus('error', 'Enter a server URL'); return; }

    try { new URL(url); } catch {
      setLlmStatus('error', 'Invalid URL format');
      return;
    }

    setLlmStatus('testing', 'Connecting…');

    try {
      const resp = await fetch(url.replace(/\/+$/, '') + '/api/tags', {
        method: 'GET',
        signal: AbortSignal.timeout(5000),
      });
      if (!resp.ok) {
        setLlmStatus('error', 'Server returned ' + resp.status);
        return;
      }
      const data = await resp.json();
      const models = (data.models || []).map(m => m.name || m.model).filter(Boolean);
      if (models.length === 0) {
        setLlmStatus('warn', 'Connected but no models found. Run: ollama pull <model>');
      } else {
        setLlmStatus('ok', 'Connected — ' + models.length + ' model(s) available');
      }
    } catch (err) {
      setLlmStatus('error', 'Connection failed: ' + (err.message || err));
    }
  });

  $('llm-fetch-models').addEventListener('click', async () => {
    const url = $('llm-url').value.trim();
    if (!url) { setLlmStatus('error', 'Enter a server URL first'); return; }

    try { new URL(url); } catch {
      setLlmStatus('error', 'Invalid URL format');
      return;
    }

    setLlmStatus('testing', 'Fetching models…');

    try {
      const resp = await fetch(url.replace(/\/+$/, '') + '/api/tags', {
        method: 'GET',
        signal: AbortSignal.timeout(5000),
      });
      if (!resp.ok) {
        setLlmStatus('error', 'Server returned ' + resp.status);
        return;
      }
      const data = await resp.json();
      const models = (data.models || []).map(m => m.name || m.model).filter(Boolean);

      if (models.length === 0) {
        setLlmStatus('warn', 'No models installed on server');
        return;
      }

      // Update the model field — replace with select, or update existing select
      const modelEl = $('llm-model');
      const currentVal = modelEl.value.trim();
      let select;

      if (modelEl.tagName === 'SELECT') {
        // Already a select from a previous fetch — clear and repopulate
        select = modelEl;
        select.innerHTML = '';
      } else {
        // First fetch — replace input with select
        select = document.createElement('select');
        select.id = 'llm-model';
        select.className = 'dict-text-input';
        select.addEventListener('change', saveSettings);
        modelEl.removeEventListener('change', saveSettings);
        modelEl.parentNode.replaceChild(select, modelEl);
      }

      for (const m of models) {
        const opt = document.createElement('option');
        opt.value = m;
        opt.textContent = m;
        if (m === currentVal) opt.selected = true;
        select.appendChild(opt);
      }

      if (!currentVal || models.indexOf(currentVal) === -1) {
        select.value = models[0];
      }

      saveSettings();
      setLlmStatus('ok', models.length + ' model(s) found');
    } catch (err) {
      setLlmStatus('error', 'Failed: ' + (err.message || err));
    }
  });
}

function setLlmStatus(type, text) {
  const el = $('llm-status');
  el.textContent = text;
  el.className = 'llm-status llm-status-' + type;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------
function $(id)         { return document.getElementById(id); }
function $s(id, show)  { const el = $(id); if (el) el.classList.toggle('hidden', !show); }
