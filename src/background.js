// Service worker: message router, PDF interception, context menu, shortcuts.

import { getSettings, setSettings, DEFAULTS } from "./lib/settings.js";
import { translateMany, cacheStats, clearCache } from "./lib/translator.js";

const PDF_RULE_ID = 1;

// Online PDFs are opened in our bilingual reader instead of Chrome's built-in
// viewer, which is a plugin whose text no extension can reach.
async function syncPdfRule() {
  const { pdfTakeover } = await getSettings();
  const target = chrome.runtime.getURL("src/viewer/viewer.html");

  const rule = {
    id: PDF_RULE_ID,
    priority: 1,
    action: {
      type: "redirect",
      redirect: { regexSubstitution: `${target}?file=\\0` },
    },
    condition: {
      regexFilter: "^https?://[^?#]+\\.pdf(?:[?#].*)?$",
      resourceTypes: ["main_frame"],
    },
  };

  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [PDF_RULE_ID],
    addRules: pdfTakeover ? [rule] : [],
  });
}

chrome.runtime.onInstalled.addListener(async () => {
  await setSettings(await getSettings()); // materialise defaults
  await syncPdfRule();

  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "translate-selection",
      title: "Translate selection",
      contexts: ["selection"],
    });
    chrome.contextMenus.create({
      id: "open-reader",
      title: "Open bilingual PDF reader",
      contexts: ["action"],
    });
  });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.settings) syncPdfRule();
});

function openReader(file) {
  const base = chrome.runtime.getURL("src/viewer/viewer.html");
  chrome.tabs.create({ url: file ? `${base}?file=${encodeURIComponent(file)}` : base });
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === "open-reader") return openReader();
  if (info.menuItemId === "translate-selection" && info.selectionText && tab?.id) {
    const [result] = await translateMany([info.selectionText]);
    chrome.tabs.sendMessage(tab.id, {
      type: "show-bubble",
      original: info.selectionText,
      translation: result.text || `[${result.error}]`,
    });
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command === "open-reader") return openReader();
  if (command === "toggle-page") {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: "toggle-page" });
  }
});

const HANDLERS = {
  translate: ({ items }) => translateMany(items),
  getSettings: () => getSettings(),
  setSettings: ({ patch }) => setSettings(patch),
  cacheStats: () => cacheStats(),
  clearCache: () => clearCache(),
  openReader: ({ file }) => openReader(file),
  defaults: () => DEFAULTS,
};

chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  const handler = HANDLERS[message?.type];
  if (!handler) return false;
  Promise.resolve(handler(message))
    .then((data) => respond({ ok: true, data }))
    .catch((error) => respond({ ok: false, error: String(error?.message || error) }));
  return true; // async response
});
