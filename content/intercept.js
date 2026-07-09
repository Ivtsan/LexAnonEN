/**
 * intercept.js — upload-intercept content script.
 *
 * Runs ONLY on the AI-chat sites allowlisted in manifest.json. When the user
 * attaches a supported document to the page, it pauses the upload and asks
 * whether to anonymize it on the firm's LexAnon server first; the anonymized
 * file is then injected back into the same <input>.
 *
 * All server traffic goes through the background service worker: content
 * scripts are subject to the page's CORS policy (and chatgpt.com/claude.ai
 * block chrome-extension:// workers via CSP), the worker is not.
 *
 * Design rule inherited from the server: NO SILENT FALLBACK. The original
 * file is only ever uploaded after an explicit "Attach original" click —
 * closing the panel attaches nothing.
 */
'use strict';

const PANEL_ID = '__lexanon_intercept_panel__';
const SUPPORTED = ['.docx', '.txt', '.pdf', '.doc'];
const MAX_SIZE = 50 * 1024 * 1024;
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

// ─── State ────────────────────────────────────────────────────────────────
let interceptEnabled = true;
let panelRoot = null;
let shadow = null;
let activeInput = null;  // set when the file arrived via <input type=file>
let dropPath = null;     // drag & drop: element path at drop time, deepest first
let dropPoint = null;    // drag & drop: { x, y } client coords of the drop
let currentFile = null;
let port = null;
let jobState = null; // { jobId, entities }
let injecting = false;

// ─── Init / settings ──────────────────────────────────────────────────────
// paired: only intercept once the extension is actually connected to a
// server. Before pairing the feature cannot work, and nagging on every
// upload with no way to act would just teach users to hate the panel.
let paired = false;

function syncState() {
  const active = interceptEnabled && paired;
  active ? boot() : teardown();
}

chrome.storage.local.get(['interceptEnabled', 'serverUrl', 'token'], (d) => {
  interceptEnabled = d.interceptEnabled !== false; // default on
  paired = !!(d.serverUrl && d.token);
  syncState();
});

chrome.storage.onChanged.addListener((changes) => {
  if ('interceptEnabled' in changes) {
    interceptEnabled = changes.interceptEnabled.newValue !== false;
  }
  if ('serverUrl' in changes || 'token' in changes) {
    chrome.storage.local.get(['serverUrl', 'token'], (d) => {
      paired = !!(d.serverUrl && d.token);
      syncState();
    });
    return;
  }
  syncState();
});

// ─── Observer ─────────────────────────────────────────────────────────────
let booted = false;
let observer = null;

function boot() {
  if (booted) return;
  booted = true;
  // Drag & drop: a capture-phase listener on window fires before the
  // site's own handlers (React attaches at its root container). We add NO
  // dragover handler of our own — only drops the site already accepts are
  // intercepted, so its drop zones behave exactly as designed.
  window.addEventListener('drop', onDrop, { capture: true });
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
  window.removeEventListener('drop', onDrop, { capture: true });
  observer?.disconnect();
  observer = null;
  closePanel();
}

function attachOne(input) {
  if (input.__lexanonHooked) return;
  input.__lexanonHooked = true;
  input.addEventListener('change', onFileChange, { capture: true });
}

function isContextAlive() {
  try { return !!(chrome?.runtime?.id); } catch { return false; }
}

// ─── Base64 helpers ───────────────────────────────────────────────────────
function uint8ToBase64(uint8) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < uint8.length; i += chunk) {
    binary += String.fromCharCode.apply(null, uint8.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToUint8(b64) {
  const binary = atob(b64);
  const uint8 = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) uint8[i] = binary.charCodeAt(i);
  return uint8;
}

// ─── Output naming (mirrors app.js) ──────────────────────────────────────
// PDF jobs come back as .txt (input-only on the server), .doc as .docx.
function outputName(filename, suffix) {
  const m = filename.match(/\.(docx|txt|pdf|doc)$/i);
  if (!m) return filename + suffix;
  let ext = m[0];
  if (m[1].toLowerCase() === 'pdf') ext = '.txt';
  if (m[1].toLowerCase() === 'doc') ext = '.docx';
  return filename.slice(0, -m[0].length) + suffix + ext;
}

function mimeFor(name) {
  return name.toLowerCase().endsWith('.docx') ? DOCX_MIME : 'text/plain';
}

// ─── File intercept ───────────────────────────────────────────────────────
function onFileChange(e) {
  if (injecting) return;
  // Only single-file selections: injecting one file back would silently
  // drop the rest of a multi-select.
  if (!e.target.files || e.target.files.length !== 1) return;
  const file = e.target.files[0];
  const lower = file.name.toLowerCase();
  if (!SUPPORTED.some((ext) => lower.endsWith(ext))) return;
  if (file.size > MAX_SIZE) return;

  e.stopImmediatePropagation();
  activeInput = e.target;
  currentFile = file;
  jobState = null;

  showAskPanel(file.name);
}

// ─── Drag & drop intercept ───────────────────────────────────────────────
function onDrop(e) {
  if (injecting) return;
  const dt = e.dataTransfer;
  if (!dt) return;
  // Only single-file drops (same rule as onFileChange): re-dropping one
  // file would silently lose the rest.
  if (!dt.files || dt.files.length !== 1) return;
  const file = dt.files[0];
  const lower = file.name.toLowerCase();
  if (!SUPPORTED.some((ext) => lower.endsWith(ext))) return;
  if (file.size > MAX_SIZE) return;

  // Swallow the drop before the site's own handlers see it.
  e.preventDefault();
  e.stopImmediatePropagation();

  activeInput = null;
  // Remember the whole path (deepest first), not just the target: React
  // apps re-render freely and the exact node may be gone by the time we
  // deliver — an ancestor along the same path is the next best thing.
  dropPath = e.composedPath().filter((n) => n instanceof Element);
  dropPoint = { x: e.clientX, y: e.clientY };
  currentFile = file;
  jobState = null;

  // Sites show a "drop your file here" overlay on dragenter; since we ate
  // the drop, tell them the drag ended so the overlay goes away. Dispatched
  // at the target so it bubbles through the whole handler chain.
  fireDragEvent(e.target, 'dragleave', new DataTransfer(), dropPoint);

  showAskPanel(file.name);
}

function fireDragEvent(target, type, dt, point) {
  const ev = new DragEvent(type, {
    bubbles: true,
    cancelable: true,
    composed: true,
    dataTransfer: dt,
    clientX: point?.x ?? 0,
    clientY: point?.y ?? 0,
    view: window,
  });
  target.dispatchEvent(ev);
}

// Re-play the drop the site expected, but with `file` in it: synthetic
// dragenter → dragover → drop at the element the user originally dropped
// on, with the original coordinates (some handlers pick the drop zone by
// position). dispatchEvent runs the full capture+bubble path, so every
// listener the real drop would have reached sees this one too.
function dispatchDrop(target, file) {
  const dt = new DataTransfer();
  dt.items.add(file);
  injecting = true;
  try {
    fireDragEvent(target, 'dragenter', dt, dropPoint);
    fireDragEvent(target, 'dragover', dt, dropPoint);
    fireDragEvent(target, 'drop', dt, dropPoint);
  } finally {
    injecting = false;
  }
}

// Best still-valid stand-in for the original drop target.
function findDropTarget() {
  for (const el of dropPath || []) {
    if (el.isConnected) return el;
  }
  // Whatever now sits at the drop coordinates (ignore our own panel).
  if (dropPoint) {
    const el = document.elementFromPoint(dropPoint.x, dropPoint.y);
    if (el && !panelRoot?.contains(el)) return el;
  }
  return null;
}

// ─── Background connection ────────────────────────────────────────────────
function connect() {
  if (!isContextAlive()) { showReloadError(); return null; }
  try {
    if (port) { try { port.disconnect(); } catch { /* already gone */ } }
    port = chrome.runtime.connect({ name: 'lexanon-intercept' });
  } catch (err) {
    if (err.message?.includes('Extension context')) showReloadError();
    else showFailure('Connection to the LexAnon extension failed: ' + err.message, false);
    return null;
  }
  port.onMessage.addListener(onBgMessage);
  port.onDisconnect.addListener(() => {
    const err = chrome.runtime.lastError;
    if (err?.message?.includes('Extension context')) showReloadError();
  });
  return port;
}

function onBgMessage(msg) {
  if (msg.type === 'PROGRESS') {
    setStatus('scanning', 'Analyzing on your LexAnon server…' +
      (msg.percent != null ? ' ' + msg.percent + '%' : '') +
      (msg.message ? ' — ' + msg.message : ''), msg.percent ?? 15);

  } else if (msg.type === 'ENTITIES') {
    jobState = { jobId: msg.jobId, entities: msg.entities || [] };
    for (const w of msg.warnings || []) setNote('warn', w);
    const llm = msg.llm || {};
    if (llm.enabled === false) {
      setNote('warn', 'AI detection is disabled on the server — pattern rules only. Review carefully.');
    } else if (llm.error) {
      setNote('error', 'AI detection FAILED — results are from pattern rules only and likely incomplete. Server said: ' + llm.error);
    } else if (llm.failedChunks > 0) {
      setNote('warn', 'AI detection partially failed (' + llm.failedChunks + ' section(s) not analyzed).');
    }
    if (jobState.entities.length === 0) {
      setStatus('done', 'No personal data found in this document.');
      showButtons([
        ['primary', 'Attach file', () => { passThrough(); closePanel(); }],
        ['ghost', 'Cancel', closePanel],
      ]);
    } else {
      setStatus('ready', summarize(jobState.entities));
      showButtons([
        ['primary', 'Anonymize & attach', startApply],
        ['ghost', 'Attach original', () => { passThrough(); closePanel(); }],
        ['ghost', 'Cancel', closePanel],
      ]);
    }

  } else if (msg.type === 'RESULT') {
    if (injectFile(base64ToUint8(msg.dataB64), msg.filename)) {
      setStatus('done', 'Anonymized file attached: ' + msg.filename +
        ' — verifying with a second AI pass…', undefined);
      showButtons([['ghost', 'Close', closePanel]]);
    }

  } else if (msg.type === 'VERIFICATION') {
    renderVerification(msg.verification || {});

  } else if (msg.type === 'ERROR') {
    if (msg.connect) {
      showFailure('Cannot reach your LexAnon server — this file has NOT been anonymized. ' +
        msg.message, true);
    } else {
      showFailure('Anonymization failed — this file has NOT been anonymized. ' +
        msg.message, true);
    }
  }
}

// ─── Actions ──────────────────────────────────────────────────────────────
async function startAnalyze() {
  const instructions = shadow.getElementById('lx-instructions').value.trim();
  chrome.storage.local.set({ redactInstructions: instructions });
  shadow.getElementById('lx-instr-wrap').style.display = 'none';

  setStatus('scanning', 'Reading file…', 5);
  // Analysis can take minutes on a cold model — never trap the user.
  // Cancel closes the panel; the server-side job continues harmlessly.
  showButtons([['ghost', 'Cancel', closePanel]]);

  let buffer;
  try {
    buffer = await currentFile.arrayBuffer();
  } catch {
    showFailure('Could not read the file from the page.', true);
    return;
  }
  const p = connect();
  if (!p) return;
  p.postMessage({
    type: 'ANALYZE',
    name: currentFile.name,
    dataB64: uint8ToBase64(new Uint8Array(buffer)),
    instructions,
  });
}

function startApply() {
  if (!jobState) return;
  setStatus('scanning', 'Applying placeholders…', 10);
  showButtons([['ghost', 'Cancel', closePanel]]);
  // Reconnect: the service worker may have idled out while the user read
  // the summary; the job lives on the server, so a fresh port is enough.
  const p = connect();
  if (!p) return;
  p.postMessage({
    type: 'APPLY',
    jobId: jobState.jobId,
    entities: jobState.entities,
    fallbackName: outputName(currentFile.name, '_anonymized'),
  });
}

// ─── File injection ───────────────────────────────────────────────────────
function dispatchInto(input, file) {
  const dt = new DataTransfer();
  dt.items.add(file);
  input.files = dt.files;
  injecting = true;
  try {
    input.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
    input.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
  } finally {
    injecting = false;
  }
}

// Hand `file` to the page the same way it originally arrived: via the
// <input> for picker uploads, via a synthetic drop for drag & drop.
function deliver(file) {
  if (activeInput) {
    dispatchInto(activeInput, file);
    return;
  }
  if (dropPath) {
    const target = findDropTarget();
    if (target) { dispatchDrop(target, file); return; }
    // The page changed completely while we were working. A file input is
    // an acceptable stand-in — sites route both upload paths into the
    // same logic.
    const input = document.querySelector('input[type="file"]');
    if (input) { dispatchInto(input, file); return; }
    throw new Error('the page changed while anonymizing and the drop target is gone. Drop the file again.');
  }
  throw new Error('no attach point.');
}

function injectFile(bytes, filename) {
  try {
    const mime = mimeFor(filename);
    const file = new File([new Blob([bytes], { type: mime })], filename,
      { type: mime, lastModified: Date.now() });
    deliver(file);
    return true;
  } catch (err) {
    injecting = false;
    showFailure('Could not attach the anonymized file to the page: ' + err.message, true);
    return false;
  }
}

function passThrough() {
  if (!currentFile) return;
  try { deliver(currentFile); } catch (err) {
    injecting = false;
    showFailure('Could not attach the original file to the page: ' + err.message, false);
  }
}

// ─── Panel states ─────────────────────────────────────────────────────────
function showAskPanel(filename) {
  if (!panelRoot) buildPanel();
  shadow.getElementById('lx-filename').textContent = filename;
  shadow.getElementById('lx-notes').innerHTML = '';
  const wrap = shadow.getElementById('lx-instr-wrap');
  wrap.style.display = 'block';
  chrome.storage.local.get(['redactInstructions'], (d) => {
    shadow.getElementById('lx-instructions').value = d.redactInstructions || '';
  });
  setStatus('ready', 'Anonymize this document before it is uploaded?');
  showButtons([
    ['primary', 'Anonymize', startAnalyze],
    ['ghost', 'Attach original', () => { passThrough(); closePanel(); }],
    ['ghost', 'Cancel', closePanel],
  ]);
  panelRoot.style.display = 'block';
}

// showFailure is the loud path: nothing was attached, and re-attaching the
// original is an explicit, clearly-labeled decision.
function showFailure(message, offerOriginal) {
  if (!shadow) buildPanel();
  panelRoot.style.display = 'block';
  shadow.getElementById('lx-instr-wrap').style.display = 'none';
  setStatus('error', message);
  const buttons = [];
  if (offerOriginal && currentFile) {
    buttons.push(['danger', 'Attach original anyway (NOT anonymized)', () => {
      passThrough();
      closePanel();
    }]);
  }
  buttons.push(['ghost', 'Cancel', closePanel]);
  showButtons(buttons);
}

function showReloadError() {
  if (!shadow) buildPanel();
  panelRoot.style.display = 'block';
  setStatus('error', 'The LexAnon extension was updated. Reload the page and try again.');
  showButtons([
    ['primary', 'Reload page', () => location.reload()],
    ['ghost', 'Cancel', closePanel],
  ]);
}

function renderVerification(v) {
  if (!shadow) return;
  if (v.status === 'clean') {
    setNote('ok', 'Verification passed: a second AI pass found no leftover personal data in the attached file.');
    setStatus('done', 'Anonymized file attached.');
  } else if (v.status === 'findings') {
    const items = (v.findings || []).map((f) => '“' + f.value + '”').join(', ');
    setNote('error', 'Verification found possible leftover personal data in the attached file: ' +
      items + '. Consider removing the attachment and reviewing the document.');
    setStatus('error', 'Anonymized file attached — with verification findings.');
  } else if (v.status === 'skipped') {
    setNote('warn', 'Verification skipped: AI detection is disabled on the server, so the attached file was not double-checked.');
    setStatus('done', 'Anonymized file attached.');
  } else {
    setNote('warn', 'Verification could not complete — the attached file has NOT been double-checked.' +
      (v.error ? ' Server said: ' + v.error : ''));
    setStatus('done', 'Anonymized file attached.');
  }
}

function summarize(entities) {
  const CAT = {
    PERSON: 'Name', COMPANY: 'Company', SSN: 'SSN', TAXID: 'Tax ID',
    SWIFT: 'SWIFT', IBAN: 'IBAN', EMAIL: 'Email', PHONE: 'Phone',
    URL: 'URL', ADDRESS: 'Address', CONTRACT: 'Contract', AMOUNT: 'Amount',
    CUSTOM: 'Custom',
  };
  const by = {};
  for (const e of entities) by[e.category] = (by[e.category] || 0) + 1;
  const parts = Object.entries(by).map(([k, n]) => (CAT[k] || k) + ' (' + n + ')');
  return 'Found ' + entities.length + ': ' + parts.join(', ') +
    '. All will be replaced with placeholders. To review each item first, use the LexAnon toolbar icon instead.';
}

// ─── Panel plumbing ───────────────────────────────────────────────────────
function closePanel() {
  if (panelRoot) panelRoot.style.display = 'none';
  try { port?.disconnect(); } catch { /* already gone */ }
  port = null;
  activeInput = null;
  dropPath = null;
  dropPoint = null;
  currentFile = null;
  jobState = null;
}

function setStatus(type, text, progress) {
  if (!shadow) return;
  const el = shadow.getElementById('lx-status');
  const bar = shadow.getElementById('lx-bar');
  el.textContent = text;
  el.className = 'status ' + type;
  if (progress !== undefined && progress !== null) {
    bar.style.width = Math.min(progress, 100) + '%';
    bar.parentElement.style.display = 'block';
  } else {
    bar.parentElement.style.display = 'none';
  }
}

function setNote(cls, text) {
  const notes = shadow.getElementById('lx-notes');
  const div = document.createElement('div');
  div.className = 'note ' + cls;
  div.textContent = text;
  notes.appendChild(div);
}

function showButtons(defs) {
  const actions = shadow.getElementById('lx-actions');
  actions.innerHTML = '';
  for (const [cls, label, onClick] of defs) {
    const b = document.createElement('button');
    b.className = 'btn ' + cls;
    b.textContent = label;
    b.addEventListener('click', onClick);
    actions.appendChild(b);
  }
  actions.style.display = defs.length ? 'flex' : 'none';
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
  .panel{width:360px;background:#fff;border-radius:12px;
    box-shadow:0 8px 32px rgba(0,0,0,.18),0 2px 8px rgba(0,0,0,.10);overflow:hidden;
    animation:in .24s cubic-bezier(.34,1.56,.64,1) both}
  @keyframes in{from{opacity:0;transform:translateY(16px) scale(.96)}to{opacity:1;transform:none}}
  .hd{display:flex;align-items:center;gap:8px;padding:10px 14px;background:#1f3a5f;color:#fff}
  .hd-title{font-size:13px;font-weight:600;flex:1}
  .close-btn{background:none;border:none;color:rgba(255,255,255,.8);font-size:20px;cursor:pointer;line-height:1;padding:0 2px}
  .close-btn:hover{color:#fff}
  .bd{padding:12px 14px 14px}
  .fname{font-size:12px;color:#3c4043;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
    margin-bottom:10px;padding:6px 8px;background:#f8f9fa;border-radius:6px;border:1px solid #e8eaed}
  .status{font-size:12px;color:#5f6368;min-height:16px;line-height:1.45;margin-bottom:8px;white-space:pre-line}
  .status.ready{color:#1f3a5f;font-weight:500}
  .status.done{color:#1e8e3e;font-weight:500}
  .status.error{color:#d93025;font-weight:500}
  .note{font-size:11px;line-height:1.4;border-radius:6px;padding:6px 8px;margin-bottom:8px}
  .note.ok{background:#e6f4ea;color:#1e8e3e}
  .note.warn{background:#fef7e0;color:#9a6700}
  .note.error{background:#fce8e6;color:#c5221f}
  .pw{height:3px;background:#e8eaed;border-radius:2px;margin-bottom:11px;overflow:hidden}
  #lx-bar{height:100%;background:#1f3a5f;border-radius:2px;transition:width .3s ease;width:0}
  #lx-instr-wrap{margin-bottom:10px}
  #lx-instr-wrap label{display:block;font-size:11px;color:#5f6368;margin-bottom:4px}
  #lx-instructions{width:100%;min-height:44px;resize:vertical;font-size:12px;padding:6px 8px;
    border:1px solid #dadce0;border-radius:6px;font-family:inherit}
  #lx-actions{display:flex;gap:8px;flex-wrap:wrap}
  .btn{flex:1;min-width:90px;padding:8px 10px;border-radius:7px;font-size:12px;font-weight:500;
    cursor:pointer;border:none;transition:background .15s,opacity .15s}
  .btn.primary{background:#1f3a5f;color:#fff;flex:1.5}
  .btn.primary:hover{background:#16293f}
  .btn.ghost{background:#f1f3f4;color:#3c4043;border:1px solid #dadce0}
  .btn.ghost:hover{background:#e8eaed}
  .btn.danger{background:#fce8e6;color:#c5221f;border:1px solid #f6c7c3;flex:2}
  .btn.danger:hover{background:#f9d7d4}
</style>
<div class="panel">
  <div class="hd">
    <span>&#128274;</span>
    <span class="hd-title">LexAnon</span>
    <button class="close-btn" id="lx-close" title="Close (attaches nothing)">&times;</button>
  </div>
  <div class="bd">
    <div class="fname" id="lx-filename"></div>
    <div id="lx-notes"></div>
    <div id="lx-instr-wrap">
      <label for="lx-instructions">Anything specific you want to redact? (optional)</label>
      <textarea id="lx-instructions" placeholder="e.g. the project codename, our hourly rates, the settlement amount"></textarea>
    </div>
    <div class="status" id="lx-status"></div>
    <div class="pw" style="display:none"><div id="lx-bar"></div></div>
    <div id="lx-actions"></div>
  </div>
</div>`;

  // Deliberately NOT a pass-through: closing the panel attaches nothing.
  // Uploading the original must always be an explicit, labeled choice.
  shadow.getElementById('lx-close').addEventListener('click', closePanel);

  document.documentElement.appendChild(panelRoot);
}
