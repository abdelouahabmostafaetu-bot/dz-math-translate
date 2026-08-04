import { DEFAULTS, LANGUAGES, PROVIDER_LABELS, getSettings, setSettings } from "../lib/settings.js";
import { parseGlossary, serialiseGlossary, MATH_GLOSSARY_AR } from "../lib/glossary.js";
import { voicesForLang, speak, stop, available } from "../lib/tts.js";

const $ = (id) => document.getElementById(id);

const BOOLS = [
  "deeplFree",
  "protectMath",
  "dehyphenate",
  "skipHeaders",
  "glossaryEnabled",
  "showOriginal",
  "pdfTakeover",
  "webInline",
  "autoTranslate",
];
const TEXTS = ["googleApiKey", "deeplApiKey", "libreEndpoint", "libreApiKey"];
const SELECTS = ["provider", "sourceLang", "targetLang", "theme", "paneSide", "ttsVoice"];
const NUMBERS = [
  "minChars",
  "paneWidth",
  "fontScale",
  "lineHeight",
  "concurrency",
  "prefetchPages",
  "ttsRate",
  "ttsPitch",
];

let current = { ...DEFAULTS };
let flash = null;

function saved(message = "Saved") {
  const el = $("saved");
  el.textContent = message;
  clearTimeout(flash);
  flash = setTimeout(() => (el.textContent = ""), 1400);
}

async function save(patch) {
  current = await setSettings(patch);
  saved();
}

function fillSelect(id, options, selected) {
  const el = $(id);
  el.textContent = "";
  for (const { value, label } of options) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    el.append(option);
  }
  el.value = selected;
}

function syncOutputs() {
  for (const id of NUMBERS) {
    const out = $(`${id}Out`);
    if (out) out.value = $(id).value;
  }
}

function glossaryInfo(entries) {
  $("glossaryCount").textContent = entries.length
    ? `${entries.length} term${entries.length > 1 ? "s" : ""}`
    : "empty";
}

async function refreshCache() {
  chrome.runtime.sendMessage({ type: "cacheStats" }, (response) => {
    if (chrome.runtime.lastError || !response?.ok) return;
    const { entries, bytes } = response.data;
    $("cacheInfo").textContent = `${entries} paragraphs cached (${Math.round(bytes / 1024)} KB)`;
  });
}

async function fillVoices() {
  const note = $("ttsNote");
  if (!available()) {
    note.textContent = "This browser has no speech synthesis.";
    return;
  }

  const { matching, all } = await voicesForLang(current.targetLang);
  const list = [{ value: "", label: "Browser default" }].concat(
    (matching.length ? matching : all).map((v) => ({
      value: v.name,
      label: `${v.name} (${v.lang})`,
    }))
  );
  fillSelect("ttsVoice", list, current.ttsVoice || "");

  note.textContent = matching.length
    ? ""
    : "No voice installed for this language. On Windows: Settings, Time and language, Language, add a speech pack.";
}

function download(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function wire() {
  for (const id of BOOLS) {
    $(id).addEventListener("change", (event) => save({ [id]: event.target.checked }));
  }
  for (const id of TEXTS) {
    $(id).addEventListener("change", (event) => save({ [id]: event.target.value.trim() }));
  }
  for (const id of SELECTS) {
    $(id).addEventListener("change", async (event) => {
      await save({ [id]: event.target.value });
      if (id === "targetLang") await fillVoices();
    });
  }
  for (const id of NUMBERS) {
    const el = $(id);
    el.addEventListener("input", syncOutputs);
    el.addEventListener("change", () => save({ [id]: Number(el.value) }));
  }

  // ---- glossary ----
  let typing = null;
  $("glossaryText").addEventListener("input", (event) => {
    clearTimeout(typing);
    typing = setTimeout(async () => {
      const entries = parseGlossary(event.target.value);
      glossaryInfo(entries);
      await save({ glossary: entries });
    }, 600);
  });

  $("loadMath").addEventListener("click", async () => {
    // Merge, do not overwrite: the reader's own additions come first.
    const mine = parseGlossary($("glossaryText").value);
    const seen = new Set(mine.map((e) => e.from.toLowerCase()));
    const merged = mine.concat(MATH_GLOSSARY_AR.filter((e) => !seen.has(e.from.toLowerCase())));
    $("glossaryText").value = serialiseGlossary(merged);
    glossaryInfo(merged);
    await save({ glossary: merged });
  });

  $("clearGlossary").addEventListener("click", async () => {
    $("glossaryText").value = "";
    glossaryInfo([]);
    await save({ glossary: [] });
  });

  $("exportGlossary").addEventListener("click", () => {
    download("dz-math-glossary.txt", $("glossaryText").value);
  });

  $("importGlossary").addEventListener("click", () => $("glossaryFile").click());
  $("glossaryFile").addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const entries = parseGlossary(await file.text());
    $("glossaryText").value = serialiseGlossary(entries);
    glossaryInfo(entries);
    await save({ glossary: entries });
  });

  // ---- read aloud ----
  $("ttsTest").addEventListener("click", () => {
    const sample =
      current.targetLang === "ar"
        ? "\u0644\u064a\u0643\u0646 \u0641\u0636\u0627\u0621 \u0634\u0639\u0627\u0639\u064a \u0639\u0644\u0649 \u062d\u0642\u0644\u060c \u0648\u0644\u062a\u0643\u0646 \u0639\u0627\u0626\u0644\u0629 \u0645\u0633\u062a\u0642\u0644\u0629 \u062e\u0637\u064a\u0627."
        : "Let V be a vector space over a field.";
    speak(sample, {
      lang: current.targetLang,
      voice: $("ttsVoice").value,
      rate: Number($("ttsRate").value),
      pitch: Number($("ttsPitch").value),
    });
  });
  $("ttsStop").addEventListener("click", stop);

  // ---- maintenance ----
  $("clearCache").addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "clearCache" }, () => {
      saved("Cache cleared");
      refreshCache();
    });
  });

  $("shortcuts").addEventListener("click", () => {
    chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
  });

  $("reset").addEventListener("click", async () => {
    if (!confirm("Reset every setting, including the glossary?")) return;
    await chrome.storage.local.set({ settings: { ...DEFAULTS } });
    location.reload();
  });
}

(async function main() {
  current = await getSettings();

  fillSelect(
    "provider",
    Object.entries(PROVIDER_LABELS).map(([value, label]) => ({ value, label })),
    current.provider
  );
  fillSelect(
    "sourceLang",
    [{ value: "auto", label: "Detect automatically" }].concat(
      LANGUAGES.map((l) => ({ value: l.code, label: l.name }))
    ),
    current.sourceLang
  );
  fillSelect(
    "targetLang",
    LANGUAGES.map((l) => ({ value: l.code, label: l.name })),
    current.targetLang
  );

  for (const id of BOOLS) $(id).checked = !!current[id];
  for (const id of TEXTS) $(id).value = current[id] ?? "";
  for (const id of NUMBERS) $(id).value = current[id] ?? DEFAULTS[id];
  for (const id of ["theme", "paneSide"]) $(id).value = current[id] ?? DEFAULTS[id];

  $("glossaryText").value = serialiseGlossary(current.glossary || []);
  glossaryInfo(current.glossary || []);
  syncOutputs();

  wire();
  await fillVoices();
  await refreshCache();
})();
