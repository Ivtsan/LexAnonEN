// popup.js — connection status + pairing. The actual workflow lives in the
// full-page app (app/app.html); the popup is deliberately minimal.

import {
  getSettings, clearPairing, normalizeServerUrl, ping, pair, llmHealth,
} from "../lib/api.js";

const $ = (id) => document.getElementById(id);

function show(viewId) {
  $("view-connected").hidden = viewId !== "view-connected";
  $("view-pair").hidden = viewId !== "view-pair";
}

function setDot(id, state) {
  $(id).className = "dot " + state;
}

async function refreshConnected() {
  const { serverUrl } = await getSettings();
  try {
    const h = await ping(serverUrl);
    setDot("server-dot", "ok");
    $("server-status").textContent = `Server online — ${serverUrl} (v${h.version})`;
  } catch (e) {
    setDot("server-dot", "bad");
    $("server-status").textContent = e.message;
    setDot("llm-dot", "bad");
    $("llm-status").textContent = "LLM status unknown (server unreachable)";
    return;
  }
  try {
    const h = await llmHealth();
    if (h.ok) {
      setDot("llm-dot", "ok");
      $("llm-status").textContent = "AI detection online";
    } else {
      // Not a silent downgrade: the user must know detection is regex-only.
      setDot("llm-dot", "warn");
      $("llm-status").textContent = "AI detection unavailable — rules-only. " + (h.error || "");
    }
  } catch (e) {
    setDot("llm-dot", "bad");
    $("llm-status").textContent = e.message;
  }
}

async function init() {
  const { serverUrl, token, clientName } = await getSettings();
  if (serverUrl && token) {
    show("view-connected");
    refreshConnected();
  } else {
    show("view-pair");
    if (serverUrl) $("server-url").value = serverUrl;
    if (clientName) $("client-name").value = clientName;
  }
}

$("pair-btn").addEventListener("click", async () => {
  const errBox = $("pair-error");
  errBox.hidden = true;
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
    show("view-connected");
    refreshConnected();
  } catch (e) {
    errBox.textContent = e.message;
    errBox.hidden = false;
  } finally {
    btn.disabled = false;
  }
});

$("open-app").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("app/app.html") });
  window.close();
});

$("unpair").addEventListener("click", async () => {
  await clearPairing();
  show("view-pair");
});

init();
