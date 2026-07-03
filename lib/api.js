// api.js — the LexAnon server client. All document processing happens on
// the firm's on-premises server; this extension is a thin client.
//
// Design rule inherited from the server: NO SILENT FALLBACK. Every error is
// surfaced to the user with the server's own message.

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ── Settings (chrome.storage.local) ───────────────────────────────────────

export async function getSettings() {
  const { serverUrl = "", token = "", clientName = "" } =
    await chrome.storage.local.get(["serverUrl", "token", "clientName"]);
  return { serverUrl, token, clientName };
}

export async function saveSettings(settings) {
  await chrome.storage.local.set(settings);
}

export async function clearPairing() {
  await chrome.storage.local.remove(["token"]);
}

// normalizeServerUrl validates and canonicalizes what the user typed.
export function normalizeServerUrl(input) {
  let raw = input.trim();
  if (raw === "") throw new Error("Enter the server address");
  if (!/^https?:\/\//i.test(raw)) raw = "http://" + raw;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Not a valid address: " + input);
  }
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Use just the server address, e.g. https://192.168.1.10:8090");
  }
  return url.origin;
}

// ── Low-level request helpers ─────────────────────────────────────────────

// connectError explains a network-level fetch failure. For HTTPS servers
// the overwhelmingly common cause on a fresh setup is an untrusted
// self-signed certificate, so say so instead of a bare "failed to fetch".
function connectError(serverUrl, e) {
  let msg = "Cannot reach " + serverUrl + " — is the server running? (" + e.message + ")";
  if (/^https:/i.test(serverUrl)) {
    msg += " If this server uses a self-signed certificate, open " + serverUrl +
      " in a regular browser tab once and trust the certificate (verify the fingerprint with your administrator).";
  }
  return new ApiError(0, msg);
}

async function parseError(resp) {
  let msg = "server returned HTTP " + resp.status;
  try {
    const body = await resp.json();
    if (body && body.error) msg = body.error;
  } catch { /* non-JSON error body */ }
  return new ApiError(resp.status, msg);
}

async function request(path, opts = {}) {
  const { serverUrl, token } = await getSettings();
  if (!serverUrl) throw new ApiError(0, "No server configured — open the LexAnon popup and pair first");
  if (!token) throw new ApiError(0, "Not paired with the server — open the LexAnon popup and pair first");
  const headers = { Authorization: "Bearer " + token, ...(opts.headers || {}) };
  let resp;
  try {
    resp = await fetch(serverUrl + path, { ...opts, headers });
  } catch (e) {
    throw connectError(serverUrl, e);
  }
  if (resp.status === 401) {
    throw new ApiError(401, "The server rejected this client's token. Re-pair from the LexAnon popup.");
  }
  if (!resp.ok) throw await parseError(resp);
  return resp;
}

async function requestJSON(path, opts) {
  return (await request(path, opts)).json();
}

function multipartBody(file, fields = {}) {
  const fd = new FormData();
  fd.append("file", file, file.name);
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return fd;
}

// downloadResponse turns a docx response into a browser download.
async function downloadResponse(resp, fallbackName) {
  const blob = await resp.blob();
  let name = fallbackName;
  const cd = resp.headers.get("Content-Disposition") || "";
  const m = cd.match(/filename="([^"]+)"/);
  if (m) name = m[1];
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return name;
}

// ── Public API ────────────────────────────────────────────────────────────

// ping checks reachability WITHOUT auth. Used for the popup status light
// and during pairing.
export async function ping(serverUrl) {
  let resp;
  try {
    resp = await fetch(serverUrl + "/api/health");
  } catch (e) {
    throw connectError(serverUrl, e);
  }
  if (!resp.ok) throw await parseError(resp);
  const body = await resp.json();
  if (body.service !== "lexanon-server") {
    throw new ApiError(0, "That address responds, but it is not a LexAnon server");
  }
  return body; // { service, version, time }
}

// pair exchanges a one-time code for a bearer token and saves everything.
export async function pair(serverUrl, code, clientName) {
  await ping(serverUrl);
  let resp;
  try {
    resp = await fetch(serverUrl + "/api/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: code.trim(), clientName }),
    });
  } catch (e) {
    throw connectError(serverUrl, e);
  }
  if (!resp.ok) throw await parseError(resp);
  const { token } = await resp.json();
  await saveSettings({ serverUrl, token, clientName });
  return token;
}

export async function llmHealth() {
  return requestJSON("/api/llm/health");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// pollUntil drives a polling loop for the server's asynchronous tasks.
// fetchState must return { done: true, value } or { done: false, progress }.
// Network-level failures (status 0 — Wi-Fi blip, laptop waking up, server
// restarting) are tolerated a few times with backoff; real HTTP errors
// surface immediately. This tolerance is safe because polling is read-only.
async function pollUntil(fetchState, onProgress) {
  const intervalMs = 1500;
  const maxTransient = 8;
  let transient = 0;
  for (;;) {
    let state;
    try {
      state = await fetchState();
      transient = 0;
    } catch (e) {
      if (e instanceof ApiError && e.status === 0 && ++transient <= maxTransient) {
        if (onProgress) onProgress(null, `Connection lost — retrying (${transient}/${maxTransient})…`);
        await sleep(intervalMs * 2);
        continue;
      }
      throw e;
    }
    if (state.done) return state.value;
    if (onProgress && state.progress) onProgress(state.progress.pct, state.progress.msg);
    await sleep(intervalMs);
  }
}

// getJob fetches job detail: { id, status, entities, llm, warnings, error, progress }.
export async function getJob(jobId) {
  return requestJSON(`/api/jobs/${jobId}`);
}

// analyze uploads a .docx (server answers 202 immediately) and polls the
// job until analysis settles. Returns { jobId, entities, stats, llm,
// warnings }. onProgress(pct|null, msg) receives live progress.
export async function analyze(file, onProgress) {
  const acc = await requestJSON("/api/jobs", { method: "POST", body: multipartBody(file) });
  const job = await pollUntil(async () => {
    const j = await getJob(acc.jobId);
    if (j.status === "failed") {
      throw new ApiError(500, "Analysis failed on the server: " + (j.error || "unknown error"));
    }
    if (j.status === "analyzing") return { done: false, progress: j.progress };
    return { done: true, value: j };
  }, onProgress);
  return {
    jobId: job.id,
    entities: job.entities || [],
    stats: job.stats || {},
    llm: job.llm || {},
    warnings: job.warnings || [],
  };
}

// apply sends the (possibly edited) entity list; downloads the anonymized docx.
export async function applyAndDownload(jobId, mode, entities, fallbackName) {
  const resp = await request(`/api/jobs/${jobId}/apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode, entities }),
  });
  return downloadResponse(resp, fallbackName);
}

// listJobs returns recent jobs: [{ id, filename, status, createdAt }].
export async function listJobs() {
  return requestJSON("/api/jobs");
}

// identify tries to resolve a round-tripped document to its job via the
// embedded tag. Returns null when the document carries no tag (the normal
// case when content was copy-pasted into a new document) — the user then
// selects the job manually.
export async function identify(file) {
  try {
    return await requestJSON("/api/jobs/identify", { method: "POST", body: multipartBody(file) });
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return null;
    throw e;
  }
}

// restorePlan submits the round-tripped document (server answers 202 with a
// task ID) and polls until the plan is ready. Returns { occurrences,
// missing, needsReview, llm } — nothing is modified yet. llm reports the
// recovery pass status (enabled/ran/failedChunks/error); the UI must
// surface failures. onProgress(pct|null, msg) receives live progress.
export async function restorePlan(jobId, file, onProgress) {
  const acc = await requestJSON(`/api/jobs/${jobId}/restore/plan`, {
    method: "POST",
    body: multipartBody(file),
  });
  return pollUntil(async () => {
    const t = await requestJSON(`/api/restore-plans/${acc.taskId}`);
    if (t.status === "failed") {
      throw new ApiError(500, "Restore planning failed on the server: " + (t.error || "unknown error"));
    }
    if (t.status === "done") return { done: true, value: t.plan };
    return { done: false, progress: t.progress };
  }, onProgress);
}

// restoreApply substitutes ONLY the reviewer-accepted occurrences and
// downloads the restored docx. Each accepted item is the full span spec
// ({ partName, paraIdx, start, end, placeholder, matched }) — the server
// verifies every span against the uploaded document before touching it,
// and the inserted value comes from the server-side mapping alone.
export async function restoreApplyAndDownload(jobId, file, accepted, fallbackName) {
  const resp = await request(`/api/jobs/${jobId}/restore/apply`, {
    method: "POST",
    body: multipartBody(file, { accepted: JSON.stringify(accepted) }),
  });
  return downloadResponse(resp, fallbackName);
}
