import { LANGUAGES } from "../lib/settings.js";

const $ = (id) => document.getElementById(id);
const send = (message) =>
  new Promise((resolve) => chrome.runtime.sendMessage(message, resolve));

const TOGGLES = ["protectMath", "dehyphenate", "showOriginal", "pdfTakeover"];
const RANGES = ["prefetchPages", "concurrency"];
const TEXTS = ["googleApiKey", "deeplApiKey", "libreEndpoint"];

function showProviderFields(provider) {
  document.querySelectorAll(".field[data-for]").forEach((el) => {
    el.classList.toggle("hidden", el.dataset.for !== provider);
  });
}

async function patch(key, value) {
  await send({ type: "setSettings", patch: { [key]: value } });
}

async function refreshCache() {
  const { data } = await send({ type: "cacheStats" });
  const kb = Math.round((data?.bytes || 0) / 1024);
  $("cacheInfo").textContent = `cache: ${data?.entries || 0} items, ${kb} KB`;
}

(async function main() {
  const select = $("targetLang");
  for (const { code, name } of LANGUAGES) {
    const option = document.createElement("option");
    option.value = code;
    option.textContent = name;
    select.append(option);
  }

  const { data: settings } = await send({ type: "getSettings" });

  select.value = settings.targetLang;
  $("provider").value = settings.provider;
  showProviderFields(settings.provider);
  for (const id of TOGGLES) $(id).checked = !!settings[id];
  for (const id of RANGES) {
    $(id).value = settings[id];
    $(`${id}Value`).textContent = settings[id];
  }
  for (const id of TEXTS) $(id).value = settings[id] || "";

  select.addEventListener("change", () => patch("targetLang", select.value));
  $("provider").addEventListener("change", (event) => {
    showProviderFields(event.target.value);
    patch("provider", event.target.value);
  });
  for (const id of TOGGLES) {
    $(id).addEventListener("change", (event) => patch(id, event.target.checked));
  }
  for (const id of RANGES) {
    $(id).addEventListener("input", (event) => {
      $(`${id}Value`).textContent = event.target.value;
      patch(id, Number(event.target.value));
    });
  }
  for (const id of TEXTS) {
    $(id).addEventListener("change", (event) => patch(id, event.target.value.trim()));
  }

  $("openReader").addEventListener("click", async () => {
    await send({ type: "openReader" });
    window.close();
  });

  $("translatePage").addEventListener("click", async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;
    chrome.tabs.sendMessage(tab.id, { type: "toggle-page" }, () => window.close());
  });

  $("clearCache").addEventListener("click", async () => {
    await send({ type: "clearCache" });
    refreshCache();
  });

  refreshCache();
})();
