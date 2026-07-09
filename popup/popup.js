// popup.js — connection status only. Pairing lives in the full-tab app:
// Chrome closes this popup the moment it loses focus (which the
// chrome.permissions.request prompt forces), so forms here lose state.

import { getSettings, clearPairing, ping, llmHealth } from "../lib/api.js";

const $ = (id) => document.getElementById(id);

function show(viewId) {
  $("view-connected").hidden = viewId !== "view-connected";
  $("view-pair").hidden = viewId !== "view-pair";
}

function setDot(id, state) {
  $(id).className = "dot " + state;
}

function openApp(hash) {
  chrome.tabs.create({ url: chrome.runtime.getURL("app/app.html" + (hash || "")) });
  window.close();
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
  const { serverUrl, token } = await getSettings();
  if (serverUrl && token) {
    show("view-connected");
    refreshConnected();
  } else {
    show("view-pair");
  }
}

// Upload-intercept toggle: content scripts on the allowlisted AI chat
// sites watch this key and enable/disable themselves live.
chrome.storage.local.get(["interceptEnabled"], (d) => {
  $("intercept-toggle").checked = d.interceptEnabled !== false; // default on
});
$("intercept-toggle").addEventListener("change", (e) => {
  chrome.storage.local.set({ interceptEnabled: e.target.checked });
});

$("open-setup").addEventListener("click", () => openApp("#pair"));
$("open-app").addEventListener("click", () => openApp(""));

$("unpair").addEventListener("click", async () => {
  await clearPairing();
  show("view-pair");
});

init();
