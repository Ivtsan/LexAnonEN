/**
 * content.js — Content script.
 * Intercepts .docx file selections on any website,
 * sends them to the background service worker via chrome.runtime.connect,
 * shows a floating panel, and injects the anonymized file back into the <input>.
 *
 * Why not a Web Worker directly:
 * Sites like ChatGPT, Claude.ai block chrome-extension:// as worker-src
 * via CSP headers. The background service worker runs in the extension context
 * and is not subject to the page's CSP.
 */
'use strict';

const STORAGE_KEY = 'docxAnonymizerSettingsEN';
const PANEL_ID    = '__docx_anon_panel_en__';
const DOCX_MIME   = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const DEFAULT_SETTINGS = {
  autoIntercept:     true,
  mode:              'placeholder',
  enabledCategories: [
    'PERSON', 'COMPANY', 'SSN', 'TAXID',
    'SWIFT', 'IBAN', 'EMAIL', 'PHONE', 'URL', 'ADDRESS',
  ],
  llmEnabled:   false,
  llmServerUrl: '',
  llmModel:     '',
};

// ─── State ────────────────────────────────────────────────────────────────────
let settings     = { ...DEFAULT_SETTINGS };
let panelRoot    = null;
let shadow       = null;
let activeInput  = null;
let currentFile  = null;
let port         = null;
let lastEntities = [];
let injecting    = false;

// ─── Initialisation ───────────────────────────────────────────────────────────
chrome.storage.local.get(STORAGE_KEY, (data) => {
  settings = Object.assign({}, DEFAULT_SETTINGS, data[STORAGE_KEY] || {});
  if (settings.autoIntercept) boot();
});

chrome.storage.onChanged.addListener((changes) => {
  if (!changes[STORAGE_KEY]) return;
  settings = Object.assign({}, DEFAULT_SETTINGS, changes[STORAGE_KEY].newValue || {});
  settings.autoIntercept ? boot() : teardown();
});

// ─── Observer ─────────────────────────────────────────────────────────────────
let booted   = false;
let observer = null;

function boot() {
  if (booted) return;
  booted = true;
  document.querySelectorAll('input[type="file"]').forEach(attachOne);
  observer = new MutationObserver((muts) => {
    for (const mut of muts) {
      for (const node of mut.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        if (node.matches?.('input[type="file"]')) attachOne(node);
        node.querySelectorAll?.('input[type="file"]').forEach(attachOne);
      }
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
}

function teardown() {
  booted = false;
  observer?.disconnect();
  observer = null;
  closePanel();
}

function attachOne(input) {
  if (input.__docxAnonEn) return;
  input.__docxAnonEn = true;
  input.addEventListener('change', onFileChange, { capture: true });
}

// ─── Extension context check ──────────────────────────────────────────────────
function isContextAlive() {
  try { return !!(chrome?.runtime?.id); } catch { return false; }
}

// ─── Base64 helpers ───────────────────────────────────────────────────────────
function uint8ToBase64(uint8) {
  let binary = '';
  const len = uint8.byteLength;
  for (let i = 0; i < len; i++) binary += String.fromCharCode(uint8[i]);
  return btoa(binary);
}

function base64ToUint8(b64) {
  const binary = atob(b64);
  const uint8  = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) uint8[i] = binary.charCodeAt(i);
  return uint8;
}

// ─── File intercept ───────────────────────────────────────────────────────────
async function onFileChange(e) {
  if (injecting) return;

  const file = e.target.files?.[0];
  if (!file || !file.name.toLowerCase().endsWith('.docx')) return;
  if (file.size > 50 * 1024 * 1024) return;

  e.stopImmediatePropagation();

  activeInput  = e.target;
  currentFile  = file;
  lastEntities = [];

  showPanel(file.name);

  if (!isContextAlive()) { showReloadError(); return; }

  setStatus('scanning', 'Reading file…', 5);

  let buffer;
  try {
    buffer = await file.arrayBuffer();
  } catch {
    setStatus('error', 'Could not read file');
    return;
  }

  connectAndSend({
    type:    'PARSE',
    data:    uint8ToBase64(new Uint8Array(buffer)),
    filename: file.name,
    options:  {
      enabledCategories: settings.enabledCategories,
      llmEnabled:        settings.llmEnabled,
      llmServerUrl:      settings.llmServerUrl,
      llmModel:          settings.llmModel,
    },
  });
}

// ─── Background connection ────────────────────────────────────────────────────
function connectAndSend(message) {
  if (!isContextAlive()) { showReloadError(); return; }

  try {
    if (port) { try { port.disconnect(); } catch {} }
    port = chrome.runtime.connect({ name: 'docx-processor' });
  } catch (err) {
    if (err.message?.includes('Extension context')) showReloadError();
    else setStatus('error', 'Connection failed: ' + err.message);
    return;
  }

  port.onMessage.addListener(onBgMessage);
  port.onDisconnect.addListener(() => {
    const err = chrome.runtime.lastError;
    if (err) {
      if (err.message?.includes('Extension context')) showReloadError();
      else setStatus('error', 'Connection lost: ' + err.message);
    }
  });

  port.postMessage(message);
}

// ─── Messages from background ─────────────────────────────────────────────────
function onBgMessage(msg) {
  const { type } = msg;

  if (type === 'PROGRESS') {
    setStatus('scanning', msg.message, msg.percent);

  } else if (type === 'ENTITIES') {
    lastEntities = msg.entities;
    if (msg.stats.total === 0) {
      setStatus('done', 'No personal data found');
      showActions(false);
    } else {
      setStatus('ready', buildSummary(msg.stats));
      showActions(true);
    }

  } else if (type === 'RESULT') {
    setStatus('done', '✓ Anonymized — file ready');
    injectFile(base64ToUint8(msg.data), msg.filename);
    setTimeout(closePanel, 2400);

  } else if (type === 'ERROR') {
    setStatus('error', msg.message);
  }
}

// ─── Inject anonymized file into <input> ─────────────────────────────────────
function injectFile(buffer, filename) {
  if (!activeInput) return;
  try {
    const blob = new Blob([buffer], { type: DOCX_MIME });
    const file = new File([blob], filename, { type: DOCX_MIME, lastModified: Date.now() });
    const dt   = new DataTransfer();
    dt.items.add(file);
    activeInput.files = dt.files;
    injecting = true;
    try {
      activeInput.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
      activeInput.dispatchEvent(new Event('input',  { bubbles: true, cancelable: true }));
    } finally {
      injecting = false;
    }
  } catch (err) {
    injecting = false;
    setStatus('error', 'Could not inject file: ' + err.message);
  }
}

function passThrough() {
  if (!activeInput || !currentFile) return;
  try {
    const dt = new DataTransfer();
    dt.items.add(currentFile);
    activeInput.files = dt.files;
    injecting = true;
    try {
      activeInput.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
      activeInput.dispatchEvent(new Event('input',  { bubbles: true, cancelable: true }));
    } finally {
      injecting = false;
    }
  } catch {
    injecting = false;
  }
}

// ─── Stale context error ──────────────────────────────────────────────────────
function showReloadError() {
  if (!shadow) buildPanel();
  panelRoot.style.display = 'block';
  setStatus('error', 'Extension was updated. Please reload the page and try again.');
  const actions = shadow.getElementById('da-actions');
  actions.innerHTML = '';
  const btnReload = btn('primary', '🔄 Reload page', () => location.reload());
  const btnClose  = btn('ghost',   'Close', () => {
    panelRoot.style.display = 'none';
    passThrough();
  });
  actions.appendChild(btnReload);
  actions.appendChild(btnClose);
  actions.classList.remove('hidden');
}

// ─── Panel action buttons ─────────────────────────────────────────────────────
function showActions(hasEntities) {
  const actions = shadow.getElementById('da-actions');
  actions.innerHTML = '';

  if (hasEntities) {
    const btnAnon = btn('primary', '🔒 Anonymize', async () => {
      disableActions();
      setStatus('scanning', 'Applying replacements…', 10);
      const buffer = await currentFile.arrayBuffer();
      port.postMessage({
        type:          'APPLY',
        entities:      lastEntities,
        mode:          settings.mode,
        data:          uint8ToBase64(new Uint8Array(buffer)),
        filename:      currentFile.name,
        exportMapping: false,
      });
    });
    actions.appendChild(btnAnon);
  }

  actions.appendChild(btn('ghost', 'Upload original', () => {
    passThrough();
    closePanel();
  }));

  actions.classList.remove('hidden');
}

function disableActions() {
  shadow.getElementById('da-actions')
    .querySelectorAll('button')
    .forEach(b => { b.disabled = true; });
}

// ─── UI: Shadow DOM panel ─────────────────────────────────────────────────────
function showPanel(filename) {
  if (!panelRoot) buildPanel();
  shadow.getElementById('da-filename').textContent = '📄 ' + clip(filename, 42);
  shadow.getElementById('da-actions').innerHTML = '';
  shadow.getElementById('da-actions').classList.add('hidden');
  setStatus('scanning', '', 0);
  panelRoot.style.display = 'block';
}

function closePanel() {
  if (panelRoot) panelRoot.style.display = 'none';
  try { port?.disconnect(); } catch {}
  port        = null;
  activeInput = null;
  currentFile = null;
  lastEntities = [];
}

function setStatus(type, text, progress) {
  if (!shadow) return;
  const el  = shadow.getElementById('da-status');
  const bar = shadow.getElementById('da-bar');
  el.textContent = text;
  el.className   = 'status ' + type;
  if (progress !== undefined) {
    bar.style.width = Math.min(progress, 100) + '%';
    bar.parentElement.style.display = 'block';
  } else {
    bar.parentElement.style.display = 'none';
  }
}

function buildSummary(stats) {
  const CAT = {
    PERSON:   'Name',
    COMPANY:  'Company',
    SSN:      'SSN',
    TAXID:    'Tax ID',
    SWIFT:    'SWIFT',
    IBAN:     'IBAN',
    EMAIL:    'Email',
    PHONE:    'Phone',
    URL:      'URL',
    ADDRESS:  'Address',
    CONTRACT: 'Contract',
    AMOUNT:   'Amount',
  };
  const parts = Object.entries(stats.byCategory)
    .map(([k, n]) => `${CAT[k] || k} (${n})`);
  return `Found ${stats.total}: ${parts.join(', ')}`;
}

function buildPanel() {
  panelRoot = document.createElement('div');
  panelRoot.id = PANEL_ID;
  Object.assign(panelRoot.style, {
    position: 'fixed', bottom: '24px', right: '24px',
    zIndex: '2147483647', display: 'none',
  });

  shadow = panelRoot.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
<style>
  *{box-sizing:border-box;margin:0;padding:0;font-family:-apple-system,"Segoe UI",Roboto,sans-serif}
  .panel{
    width:340px;background:#fff;border-radius:12px;
    box-shadow:0 8px 32px rgba(0,0,0,.18),0 2px 8px rgba(0,0,0,.10);
    overflow:hidden;
    animation:in .24s cubic-bezier(.34,1.56,.64,1) both;
  }
  @keyframes in{from{opacity:0;transform:translateY(16px) scale(.96)}to{opacity:1;transform:none}}
  .hd{display:flex;align-items:center;gap:8px;padding:10px 14px;background:#1a73e8;color:#fff}
  .hd-title{font-size:13px;font-weight:600;flex:1}
  .close-btn{background:none;border:none;color:rgba(255,255,255,.8);font-size:20px;cursor:pointer;line-height:1;padding:0 2px}
  .close-btn:hover{color:#fff}
  .bd{padding:12px 14px 14px}
  .fname{font-size:12px;color:#3c4043;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
         margin-bottom:10px;padding:6px 8px;background:#f8f9fa;border-radius:6px;border:1px solid #e8eaed}
  .status{font-size:12px;color:#5f6368;min-height:16px;line-height:1.45;margin-bottom:8px}
  .status.ready{color:#1e8e3e;font-weight:500}
  .status.done {color:#1a73e8;font-weight:500}
  .status.error{color:#d93025}
  .pw{height:3px;background:#e8eaed;border-radius:2px;margin-bottom:11px;overflow:hidden}
  #da-bar{height:100%;background:#1a73e8;border-radius:2px;transition:width .3s ease;width:0}
  #da-actions{display:flex;gap:8px}
  #da-actions.hidden{display:none}
  .btn{flex:1;padding:8px 10px;border-radius:7px;font-size:12px;font-weight:500;
       cursor:pointer;border:none;transition:background .15s,opacity .15s}
  .btn:disabled{opacity:.5;cursor:not-allowed}
  .btn.primary{background:#1a73e8;color:#fff;flex:1.5}
  .btn.primary:hover:not(:disabled){background:#1558b0}
  .btn.ghost{background:#f1f3f4;color:#3c4043;border:1px solid #dadce0}
  .btn.ghost:hover:not(:disabled){background:#e8eaed}
</style>
<div class="panel">
  <div class="hd">
    <span>🔒</span>
    <span class="hd-title">LexAnon EN</span>
    <button class="close-btn" id="da-close">×</button>
  </div>
  <div class="bd">
    <div class="fname" id="da-filename"></div>
    <div class="status scanning" id="da-status">Initialising…</div>
    <div class="pw"><div id="da-bar"></div></div>
    <div id="da-actions" class="hidden"></div>
  </div>
</div>`;

  shadow.getElementById('da-close').addEventListener('click', () => {
    passThrough();
    closePanel();
  });

  document.documentElement.appendChild(panelRoot);
}

function btn(cls, label, onClick) {
  const b = document.createElement('button');
  b.className   = 'btn ' + cls;
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

function clip(s, n) { return s.length > n ? s.slice(0, n - 1) + '…' : s; }
