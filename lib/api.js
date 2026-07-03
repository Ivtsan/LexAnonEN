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
    throw new ApiError(0, "Cannot reach " + serverUrl + " — is the server running? (" + e.message + ")");
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
    throw new ApiError(0, "Cannot reach " + serverUrl + " (" + e.message + ")");
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
    throw new ApiError(0, "Cannot reach " + serverUrl + " (" + e.message + ")");
  }
  if (!resp.ok) throw await parseError(resp);
  const { token } = await resp.json();
  await saveSettings({ serverUrl, token, clientName });
  return token;
}

export async function llmHealth() {
  return requestJSON("/api/llm/health");
}

// analyze uploads a .docx and returns { jobId, entities, stats, llm }.
export async function analyze(file) {
  return requestJSON("/api/jobs", { method: "POST", body: multipartBody(file) });
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

// identify resolves a round-tripped document to its job via the embedded tag.
export async function identify(file) {
  return requestJSON("/api/jobs/identify", { method: "POST", body: multipartBody(file) });
}

// restorePlan returns { occurrences, missing, needsReview } — nothing is
// modified yet.
export async function restorePlan(jobId, file) {
  return requestJSON(`/api/jobs/${jobId}/restore/plan`, {
    method: "POST",
    body: multipartBody(file),
  });
}

// restoreApply substitutes ONLY the reviewer-accepted occurrence IDs and
// downloads the restored docx.
export async function restoreApplyAndDownload(jobId, file, acceptedIds, fallbackName) {
  const resp = await request(`/api/jobs/${jobId}/restore/apply`, {
    method: "POST",
    body: multipartBody(file, { accepted: JSON.stringify(acceptedIds) }),
  });
  return downloadResponse(resp, fallbackName);
}
