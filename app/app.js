// app.js — the LexAnon workflow page (opened in a full tab).
//
// Anonymize: pick .docx → server analyzes → review entities → apply → download.
// Restore:   pick returned .docx → server identifies the job → review every
//            substitution → apply only what the reviewer accepted → download.

import {
  getSettings, ping, pair, normalizeServerUrl, analyze, applyAndDownload,
  listJobs, identify, restorePlan, restoreApplyAndDownload,
} from "../lib/api.js";

const $ = (id) => document.getElementById(id);

const CATEGORY_LABELS = {
  PERSON: "Person", COMPANY: "Company", ADDRESS: "Address", EMAIL: "Email",
  PHONE: "Phone", SSN: "SSN", TAXID: "Tax ID", IBAN: "IBAN", SWIFT: "SWIFT",
  URL: "URL", CONTRACT: "Contract no.", AMOUNT: "Amount",
};

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function showError(boxId, err) {
  const box = $(boxId);
  box.textContent = err.message || String(err);
  box.hidden = false;
}

// ── Tabs ──────────────────────────────────────────────────────────────────

function switchTab(name) {
  $("view-setup").hidden = name !== "setup";
  $("view-anon").hidden = name !== "anon";
  $("view-restore").hidden = name !== "restore";
  $("tab-anon").classList.toggle("active", name === "anon");
  $("tab-restore").classList.toggle("active", name === "restore");
}
$("tab-anon").addEventListener("click", () => switchTab("anon"));
$("tab-restore").addEventListener("click", () => switchTab("restore"));

// ── Connection banner ─────────────────────────────────────────────────────

async function checkConnection() {
  const el = $("conn-status");
  const { serverUrl, token } = await getSettings();
  if (!serverUrl || !token) {
    el.textContent = "Not connected — open the LexAnon toolbar popup to pair with your server.";
    return false;
  }
  try {
    const h = await ping(serverUrl);
    el.textContent = `Connected to ${serverUrl} (v${h.version})`;
    return true;
  } catch (e) {
    el.textContent = e.message;
    return false;
  }
}

// ── Drag & drop plumbing ──────────────────────────────────────────────────

function wireDropZone(zoneId, inputId, onFile) {
  const zone = $(zoneId);
  const input = $(inputId);
  input.addEventListener("change", () => {
    if (input.files.length) onFile(input.files[0]);
  });
  zone.addEventListener("dragover", (e) => { e.preventDefault(); zone.classList.add("dragover"); });
  zone.addEventListener("dragleave", () => zone.classList.remove("dragover"));
  zone.addEventListener("drop", (e) => {
    e.preventDefault();
    zone.classList.remove("dragover");
    if (e.dataTransfer.files.length) onFile(e.dataTransfer.files[0]);
  });
}

function requireDocx(file, errBoxId) {
  if (!file.name.toLowerCase().endsWith(".docx")) {
    showError(errBoxId, new Error("Only .docx files are supported (got: " + file.name + ")"));
    return false;
  }
  return true;
}

// ══ Anonymize flow ════════════════════════════════════════════════════════

let anonState = null; // { file, jobId, entities }

function anonShow(step) {
  $("anon-pick").hidden = step !== "pick";
  $("anon-busy").hidden = step !== "busy";
  $("anon-review").hidden = step !== "review";
}

function renderLLMBanner(llm) {
  const b = $("llm-banner");
  if (!llm.enabled) {
    b.className = "banner warn";
    b.textContent = "AI detection is disabled on the server — results below are from pattern rules only. Names without context cues may be missed. Review carefully.";
    b.hidden = false;
  } else if (llm.error) {
    b.className = "banner error";
    b.textContent = "AI detection FAILED — results below are from pattern rules only and are likely incomplete. Server said: " + llm.error;
    b.hidden = false;
  } else if (llm.failedChunks > 0) {
    b.className = "banner warn";
    b.textContent = `AI detection partially failed (${llm.failedChunks} section(s) not analyzed by the AI). Review those results carefully.`;
    b.hidden = false;
  } else if (llm.ran) {
    b.className = "banner ok";
    b.textContent = "Pattern rules + AI detection both completed.";
    b.hidden = false;
  }
}

function renderEntities(entities) {
  const tbody = $("anon-entities");
  tbody.innerHTML = "";
  for (const e of entities) {
    const tr = document.createElement("tr");
    tr.innerHTML =
      `<td><input type="checkbox" data-id="${esc(e.id)}" ${e.enabled ? "checked" : ""}></td>` +
      `<td>${esc(CATEGORY_LABELS[e.category] || e.category)}</td>` +
      `<td class="mono">${esc(e.value)}</td>` +
      `<td class="mono">${esc(e.replacementText)}</td>` +
      `<td><span class="badge ${esc(e.source)}">${esc(e.source)}</span></td>`;
    tr.classList.toggle("disabled", !e.enabled);
    tr.querySelector("input").addEventListener("change", (ev) => {
      e.enabled = ev.target.checked;
      tr.classList.toggle("disabled", !e.enabled);
    });
    tbody.appendChild(tr);
  }
}

async function startAnalyze(file) {
  $("anon-error").hidden = true;
  if (!requireDocx(file, "anon-error")) return;
  anonShow("busy");
  $("anon-busy-msg").textContent = `Analyzing ${file.name} on the server…`;
  try {
    const res = await analyze(file);
    anonState = { file, jobId: res.jobId, entities: res.entities || [] };
    $("anon-title").textContent = file.name;
    $("anon-summary").textContent =
      `${anonState.entities.length} entities found. Untick anything that should stay. ` +
      `Job ${res.jobId} is stored on the server for later restore.`;
    renderLLMBanner(res.llm || {});
    renderEntities(anonState.entities);
    anonShow("review");
  } catch (e) {
    anonShow("pick");
    showError("anon-error", e);
  }
}

$("anon-apply").addEventListener("click", async () => {
  const btn = $("anon-apply");
  btn.disabled = true;
  $("anon-error").hidden = true;
  try {
    const mode = $("anon-mode").value;
    if (mode !== "placeholder" &&
        !confirm("Mask/Delete modes are NOT restorable — the original values cannot be put back automatically. Continue?")) {
      return;
    }
    const name = await applyAndDownload(
      anonState.jobId, mode, anonState.entities,
      anonState.file.name.replace(/\.docx$/i, "_anonymized.docx"));
    $("anon-summary").textContent = `Downloaded ${name}. To restore later, use the Restore tab with the document that comes back.`;
  } catch (e) {
    showError("anon-error", e);
  } finally {
    btn.disabled = false;
  }
});

$("anon-reset").addEventListener("click", () => {
  anonState = null;
  $("anon-file").value = "";
  $("anon-error").hidden = true;
  $("llm-banner").hidden = true;
  anonShow("pick");
});

wireDropZone("anon-pick", "anon-file", startAnalyze);

// ══ Restore flow ══════════════════════════════════════════════════════════

let restoreState = null; // { file, jobId, plan, jobs, selectedJobId }

function restoreShow(step) {
  $("restore-pick").hidden = step !== "pick";
  $("restore-busy").hidden = step !== "busy";
  $("restore-select").hidden = step !== "select";
  $("restore-review").hidden = step !== "review";
}

function renderContext(occ) {
  // Highlight the matched text inside its context snippet where possible.
  const i = occ.context.indexOf(occ.matched);
  if (i === -1) return esc(occ.context);
  return esc(occ.context.slice(0, i)) + "<mark>" + esc(occ.matched) + "</mark>" +
    esc(occ.context.slice(i + occ.matched.length));
}

function renderPlan(plan) {
  const warnings = $("restore-warnings");
  warnings.innerHTML = "";
  if (plan.occurrences.length === 0) {
    warnings.innerHTML +=
      `<div class="banner error">No placeholders from this job were found in the document. ` +
      `Either this is the wrong job, or the AI tool removed every placeholder. Nothing can be restored automatically.</div>`;
  }
  if (plan.needsReview > 0) {
    warnings.innerHTML +=
      `<div class="banner warn">${plan.needsReview} match(es) are FUZZY — the AI tool altered those placeholders. ` +
      `They are unticked below; review each one before accepting.</div>`;
  }

  const tbody = $("restore-occurrences");
  tbody.innerHTML = "";
  for (const occ of plan.occurrences) {
    const isExact = occ.status === "exact";
    const tr = document.createElement("tr");
    if (!isExact) tr.classList.add("fuzzy");
    tr.innerHTML =
      `<td><input type="checkbox" data-id="${esc(occ.id)}" ${isExact ? "checked" : ""}></td>` +
      `<td class="mono">${esc(occ.matched)}</td>` +
      `<td class="mono">${esc(occ.original)}</td>` +
      `<td><span class="badge ${esc(occ.status)}">${esc(occ.status)}</span></td>` +
      `<td class="context">…${renderContext(occ)}…</td>`;
    tbody.appendChild(tr);
  }

  const missing = $("restore-missing");
  const list = $("restore-missing-list");
  list.innerHTML = "";
  if (plan.missing && plan.missing.length) {
    for (const m of plan.missing) {
      const li = document.createElement("li");
      li.innerHTML = `<span class="mono">${esc(m.placeholder)}</span> → ${esc(m.original)}`;
      list.appendChild(li);
    }
    missing.hidden = false;
  } else {
    missing.hidden = true;
  }
}

function renderJobList(jobs, filter, preselectedId) {
  const tbody = $("restore-job-list");
  tbody.innerHTML = "";
  const q = filter.trim().toLowerCase();
  const shown = jobs.filter((j) => !q || j.filename.toLowerCase().includes(q));
  if (shown.length === 0) {
    tbody.innerHTML = `<tr><td colspan="4" class="muted">No matching jobs.</td></tr>`;
    return;
  }
  for (const j of shown) {
    const tr = document.createElement("tr");
    const checked = j.id === preselectedId ? "checked" : "";
    tr.innerHTML =
      `<td><input type="radio" name="restore-job" value="${esc(j.id)}" ${checked}></td>` +
      `<td>${esc(j.filename)}</td>` +
      `<td>${new Date(j.createdAt).toLocaleString()}</td>` +
      `<td>${esc(j.status)}</td>`;
    tbody.appendChild(tr);
  }
  syncContinueButton();
}

function selectedJobId() {
  const r = document.querySelector('input[name="restore-job"]:checked');
  return r ? r.value : null;
}

function syncContinueButton() {
  $("restore-select-continue").disabled = !selectedJobId();
}
$("restore-job-list").addEventListener("change", syncContinueButton);

async function startRestore(file) {
  $("restore-error").hidden = true;
  if (!requireDocx(file, "restore-error")) return;
  restoreShow("busy");
  $("restore-busy-msg").textContent = "Loading your anonymization jobs…";
  try {
    // Only jobs that were actually anonymized have a restore mapping.
    const jobs = (await listJobs()).filter(
      (j) => j.status === "anonymized" || j.status === "restored");
    if (jobs.length === 0) {
      throw new Error("No restorable jobs on the server — anonymize a document (in placeholder mode) first.");
    }

    // If the document still carries its tag, pre-select that job; when the
    // content was copy-pasted into a new document the tag is gone and the
    // user simply picks the job themselves.
    const tagged = await identify(file);
    const note = $("restore-select-note");
    if (tagged) {
      note.className = "banner ok";
      note.textContent = `This document identifies itself as "${tagged.filename}" — pre-selected below. Change it only if you are sure.`;
      note.hidden = false;
    } else {
      note.className = "banner warn";
      note.textContent = "This document carries no LexAnon tag (typical when content was copied into a new document). Select the job it came from.";
      note.hidden = false;
    }

    restoreState = { file, jobs, taggedId: tagged ? tagged.jobId : null };
    $("restore-job-filter").value = "";
    renderJobList(jobs, "", restoreState.taggedId);
    restoreShow("select");
  } catch (e) {
    restoreShow("pick");
    showError("restore-error", e);
  }
}

$("restore-job-filter").addEventListener("input", () => {
  renderJobList(restoreState.jobs, $("restore-job-filter").value, selectedJobId() || restoreState.taggedId);
});

$("restore-select-cancel").addEventListener("click", () => {
  restoreState = null;
  $("restore-file").value = "";
  restoreShow("pick");
});

$("restore-select-continue").addEventListener("click", async () => {
  const jobId = selectedJobId();
  if (!jobId) return;
  $("restore-error").hidden = true;
  restoreShow("busy");
  $("restore-busy-msg").textContent = "Building restore plan…";
  try {
    // The server still refuses if the document is tagged with a DIFFERENT
    // job than the one selected — that mistake reverses the wrong parties.
    const plan = await restorePlan(jobId, restoreState.file);
    const job = restoreState.jobs.find((j) => j.id === jobId);
    restoreState.jobId = jobId;
    restoreState.plan = plan;
    $("restore-title").textContent = `${restoreState.file.name} → job "${job ? job.filename : jobId}"`;
    renderPlan(plan);
    restoreShow("review");
  } catch (e) {
    restoreShow("select");
    showError("restore-error", e);
  }
});

$("restore-apply").addEventListener("click", async () => {
  const btn = $("restore-apply");
  btn.disabled = true;
  $("restore-error").hidden = true;
  try {
    const accepted = [...$("restore-occurrences").querySelectorAll("input:checked")]
      .map((cb) => cb.dataset.id);
    if (accepted.length === 0) {
      throw new Error("Nothing selected — tick the substitutions you want to apply.");
    }
    await restoreApplyAndDownload(
      restoreState.jobId, restoreState.file, accepted,
      restoreState.file.name.replace(/\.docx$/i, "_restored.docx"));
  } catch (e) {
    showError("restore-error", e);
  } finally {
    btn.disabled = false;
  }
});

$("restore-reset").addEventListener("click", () => {
  restoreState = null;
  $("restore-file").value = "";
  $("restore-error").hidden = true;
  restoreShow("pick");
});

wireDropZone("restore-pick", "restore-file", startRestore);

// ══ Pairing / setup ═══════════════════════════════════════════════════════

$("pair-btn").addEventListener("click", async () => {
  const errBox = $("pair-error");
  const okBox = $("pair-success");
  errBox.hidden = okBox.hidden = true;
  const btn = $("pair-btn");
  btn.disabled = true;
  try {
    const serverUrl = normalizeServerUrl($("server-url").value);
    const code = $("pair-code").value.trim();
    if (!code) throw new Error("Enter the pairing code from your administrator");
    const clientName = $("client-name").value.trim() || "unnamed client";

    // Ask Chrome for permission to talk to this specific origin only.
    const granted = await chrome.permissions.request({ origins: [serverUrl + "/*"] });
    if (!granted) throw new Error("Chrome permission to contact the server was declined");

    await pair(serverUrl, code, clientName);
    okBox.textContent = `Paired with ${serverUrl}.`;
    okBox.hidden = false;
    setTimeout(() => {
      switchTab("anon");
      checkConnection();
    }, 800);
  } catch (e) {
    errBox.textContent = e.message;
    errBox.hidden = false;
  } finally {
    btn.disabled = false;
  }
});

// ── Init ──────────────────────────────────────────────────────────────────

async function init() {
  const { serverUrl, token } = await getSettings();
  if (!serverUrl || !token || location.hash === "#pair") {
    if (serverUrl) $("server-url").value = serverUrl;
    getSettings().then(({ clientName }) => {
      if (clientName) $("client-name").value = clientName;
    });
    switchTab("setup");
    return;
  }
  checkConnection();
}

init();
