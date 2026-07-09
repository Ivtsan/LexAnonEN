// background.js — service worker behind the upload-intercept content script.
//
// Content scripts run inside the page and are subject to its CORS policy,
// so they cannot talk to the LexAnon server directly; this worker proxies
// the API calls (chatgpt.com/claude.ai also block chrome-extension:// as
// worker-src via CSP, which is why v1 used the same architecture).
//
// Protocol over a long-lived Port (name "lexanon-intercept"):
//   in:  { type:"ANALYZE", name, dataB64, instructions }
//   in:  { type:"APPLY", jobId, entities, fallbackName }
//   out: { type:"PROGRESS", percent, message }
//   out: { type:"ENTITIES", jobId, entities, stats, llm, warnings }
//   out: { type:"RESULT", dataB64, filename }
//   out: { type:"VERIFICATION", verification }
//   out: { type:"ERROR", message, connect }   connect=true → server unreachable/unpaired

import { ApiError, analyze, applyToBlob, getJob } from "./lib/api.js";

function uint8ToBase64(uint8) {
  let binary = "";
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

function post(port, msg) {
  try { port.postMessage(msg); } catch { /* page navigated away */ }
}

function postError(port, e) {
  post(port, {
    type: "ERROR",
    message: e.message || String(e),
    // status 0 = network-level failure or not paired — the page must offer
    // an explicit "attach the original anyway" decision, never a silent one.
    connect: e instanceof ApiError && e.status === 0,
  });
}

// pollVerification relays the server's post-anonymization audit (second AI
// pass over the anonymized output) once it lands on the job.
async function pollVerification(port, jobId) {
  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    try {
      const job = await getJob(jobId);
      if (job.verification) {
        post(port, { type: "VERIFICATION", verification: job.verification });
        return;
      }
    } catch { /* transient — keep polling until the deadline */ }
    await new Promise((r) => setTimeout(r, 2000));
  }
  post(port, {
    type: "VERIFICATION",
    verification: { status: "unknown", error: "verification did not complete in time" },
  });
}

async function handleAnalyze(port, msg) {
  const bytes = base64ToUint8(msg.dataB64);
  const file = new File([bytes], msg.name, { lastModified: Date.now() });
  const fields = msg.instructions ? { instructions: msg.instructions } : {};
  const res = await analyze(file, (pct, m) => {
    post(port, { type: "PROGRESS", percent: pct, message: m });
  }, fields);
  post(port, {
    type: "ENTITIES",
    jobId: res.jobId,
    entities: res.entities,
    stats: res.stats,
    llm: res.llm,
    warnings: res.warnings,
  });
}

async function handleApply(port, msg) {
  const { blob, name } = await applyToBlob(
    msg.jobId, "placeholder", msg.entities, msg.fallbackName);
  const buf = new Uint8Array(await blob.arrayBuffer());
  post(port, { type: "RESULT", dataB64: uint8ToBase64(buf), filename: name });
  // Not awaited by the content script's main flow: the file is already
  // attached; the audit result updates the panel when it arrives.
  pollVerification(port, msg.jobId);
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "lexanon-intercept") return;
  port.onMessage.addListener(async (msg) => {
    try {
      if (msg.type === "ANALYZE") await handleAnalyze(port, msg);
      else if (msg.type === "APPLY") await handleApply(port, msg);
    } catch (e) {
      postError(port, e);
    }
  });
});
