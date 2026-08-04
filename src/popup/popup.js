import { LANGUAGES } from "../lib/settings.js";

const $ = (id) => document.getElementById(id);

// chrome.runtime.sendMessage sets lastError instead of rejecting; read it or
// Chrome logs "Unchecked runtime.lastError" and the caller sees undefined.
function send(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(response || { ok: false, error: "no response from background" });
    });
  });
}

function status(text, kind = "info") {
  const el = $("status");
  if (!el) return;
  el.textContent = text;
  el.className = `status ${kind}`;
}

// One broken control must never stop the rest of the popup from working.
function on(id, event, handler) {
  const el = $(id);
  if (!el) {
    console.warn(`[dzmt] popup: #${id} is missing from popup.html`);
    return;
  }
  el.addEventListener(event, (e) => {
    try {
      const result = handler(e, el);
      if (result && typeof result.catch === "function") {
        result.catch((error) => status(String(error?.message || error), "error"));
      }
    } catch (error) {
      status(String(error?.message || error), "error");
    }
  });
}

const TOGGLES = ["protectMath", "dehyphenate", "showOriginal", "pdfTakeover"];
const RANGES = ["prefetchPages", "concurrency"];
const TEXTS = ["googleApiKey", "deeplApiKey", "libreEndpoint"];

function showProviderFields(provider) {
  document.querySelectorAll(".field[data-for]").forEach((el) => {
    el.classList.toggle("hidden", el.dataset.for !== provider);
  });
}

const patch = (key, value) => send({ type: "setSettings", patch: { [key]: value } });

async function refreshCache() {
  const res = await send({ type: "cacheStats" });
  const info = $("cacheInfo");
  if (!info) return;
  if (!res.ok) {
    info.textContent = "cache: unavailable";
    return;
  }
  const kb = Math.round((res.data?.bytes || 0) / 1024);
  info.textContent = `cache: ${res.data?.entries || 0} items, ${kb} KB`;
}

// A page loaded before the extension was installed or reloaded has no content
// script, so the first sendMessage fails. Inject it, then retry once.
async function toggleTab(tab) {
  const first = await new Promise((resolve) => {
    chrome.tabs.sendMessage(tab.id, { type: "toggle-page" }, (response) => {
      resolve(chrome.runtime.lastError ? null : response);
    });
  });
  if (first) return true;

  await chrome.scripting.insertCSS({
    target: { tabId: tab.id },
    files: ["src/content/inject.css"],
  });
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ["src/content/inject.js"],
  });

  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tab.id, { type: "toggle-page" }, (response) => {
      resolve(chrome.runtime.lastError ? null : response);
    });
  });
}

async function fillSettings() {
  const res = await send({ type: "getSettings" });
  if (!res.ok) {
    status(
      `Background worker unreachable: ${res.error}. Open chrome://extensions and check the service worker for errors.`,
      "error"
    );
    return;
  }
  const settings = res.data;

  const select = $("targetLang");
  if (select) select.value = settings.targetLang;

  const provider = $("provider");
  if (provider) provider.value = settings.provider;
  showProviderFields(settings.provider);

  for (const id of TOGGLES) {
    const el = $(id);
    if (el) el.checked = !!settings[id];
  }
  for (const id of RANGES) {
    const el = $(id);
    const label = $(`${id}Value`);
    if (el) el.value = settings[id];
    if (label) label.textContent = settings[id];
  }
  for (const id of TEXTS) {
    const el = $(id);
    if (el) el.value = settings[id] || "";
  }
}

function wire() {
  on("targetLang", "change", (_e, el) => patch("targetLang", el.value));
  on("provider", "change", (_e, el) => {
    showProviderFields(el.value);
    return patch("provider", el.value);
  });
  for (const id of TOGGLES) on(id, "change", (e) => patch(id, e.target.checked));
  for (const id of RANGES) {
    on(id, "input", (e) => {
      const label = $(`${id}Value`);
      if (label) label.textContent = e.target.value;
      return patch(id, Number(e.target.value));
    });
  }
  for (const id of TEXTS) on(id, "change", (e) => patch(id, e.target.value.trim()));

  on("openReader", "click", async () => {
    const res = await send({ type: "openReader" });
    if (!res.ok) {
      status(`Could not open the reader: ${res.error}`, "error");
      return;
    }
    window.close();
  });

  on("translatePage", "click", async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const url = tab?.url || "";

    if (!tab?.id) {
      status("No active tab.", "error");
      return;
    }
    if (/^(chrome|edge|about|chrome-extension|devtools|view-source):/i.test(url)) {
      status("Chrome blocks extensions on this kind of page.", "error");
      return;
    }
    if (url.startsWith("file:")) {
      status(
        "Local files need file access: chrome://extensions -> Details -> Allow access to file URLs. For a local PDF, use the PDF reader button instead.",
        "error"
      );
      return;
    }
    if (/\.pdf(\?|#|$)/i.test(url)) {
      status("This is a PDF. Use the PDF reader button.", "error");
      return;
    }

    status("Translating...");
    try {
      const done = await toggleTab(tab);
      if (!done) {
        status("The page did not respond. Reload it and try again.", "error");
        return;
      }
      window.close();
    } catch (error) {
      status(`Cannot run on this page: ${String(error?.message || error)}`, "error");
    }
  });

  on("clearCache", "click", async () => {
    await send({ type: "clearCache" });
    return refreshCache();
  });
}

(async function main() {
  const select = $("targetLang");
  if (select) {
    for (const { code, name } of LANGUAGES) {
      const option = document.createElement("option");
      option.value = code;
      option.textContent = name;
      select.append(option);
    }
  }

  // Wire the buttons first: they must work even if loading settings fails.
  wire();

  try {
    await fillSettings();
  } catch (error) {
    status(String(error?.message || error), "error");
  }
  try {
    await refreshCache();
  } catch {
    /* cache display is cosmetic */
  }
})();
