// Central settings store. Everything else reads defaults from here.

export const DEFAULTS = {
  // ---- translation engine ----
  provider: "google-free", // google-free | google-cloud | deepl | libre
  sourceLang: "auto",
  targetLang: "ar",
  googleApiKey: "",
  deeplApiKey: "",
  deeplFree: true,
  libreEndpoint: "https://libretranslate.com/translate",
  libreApiKey: "",

  // ---- behaviour ----
  protectMath: true, // never send formulas to the translator
  dehyphenate: true, // repair words broken across PDF lines
  skipHeaders: true, // ignore running heads, page numbers, short noise
  minChars: 3, // shortest paragraph worth translating
  concurrency: 4, // parallel requests
  prefetchPages: 2, // pages translated ahead of the visible one
  autoTranslate: true, // translate on scroll; off = translate on demand only

  // ---- terminology ----
  glossaryEnabled: true,
  glossary: [], // [{ from: "vector space", to: "فضاء شعاعي" }]

  // ---- presentation ----
  pdfTakeover: true, // open online PDFs in the bilingual reader
  paneSide: "end", // reading pane side: start | end
  paneWidth: 400, // pixels
  fontScale: 1.0,
  lineHeight: 1.75,
  theme: "light", // light | sepia | dark
  showOriginal: false,
  webInline: true, // insert translations under each block on web pages

  // ---- read aloud ----
  ttsVoice: "",
  ttsRate: 1.0,
  ttsPitch: 1.0,
};

const RTL = new Set(["ar", "he", "fa", "ur", "ps", "sd", "ug", "yi", "dv"]);

export function isRtl(lang) {
  return RTL.has(String(lang || "").slice(0, 2).toLowerCase());
}

export async function getSettings() {
  const stored = await chrome.storage.local.get("settings");
  return { ...DEFAULTS, ...(stored.settings || {}) };
}

export async function setSettings(patch) {
  const next = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ settings: next });
  return next;
}

export function onSettingsChanged(callback) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.settings) {
      callback({ ...DEFAULTS, ...(changes.settings.newValue || {}) });
    }
  });
}

// A deliberately short list: the languages an Algerian maths student actually
// needs. Add more freely, any code the provider knows will work.
export const LANGUAGES = [
  { code: "ar", name: "Arabic" },
  { code: "fr", name: "French" },
  { code: "en", name: "English" },
  { code: "es", name: "Spanish" },
  { code: "de", name: "German" },
  { code: "it", name: "Italian" },
  { code: "ru", name: "Russian" },
  { code: "tr", name: "Turkish" },
  { code: "zh-CN", name: "Chinese" },
];

export const PROVIDER_LABELS = {
  "google-free": "Google Translate (free, no key)",
  "google-cloud": "Google Cloud Translation (API key)",
  deepl: "DeepL (API key, best quality)",
  libre: "LibreTranslate (self hosted)",
};
