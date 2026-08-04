// Translation engine: providers, concurrency, retry, cache, terminology.
// Protection is never done with placeholders (engines rewrite them):
//   runs - send prose only, formulas never leave the browser (google-free)
//   tags - whole sentence with protected text inside ignored tags (deepl,
//          google-cloud). Better grammar, documented guarantee.

import { getSettings, isRtl } from "./settings.js";
import { normalise, splitRuns, isolate } from "./segment.js";
import { compileGlossary, applyGlossary } from "./glossary.js";

class RateLimited extends Error {}

const TAG_PROVIDERS = new Set(["google-cloud", "deepl"]);

// ---------- cache ----------

const memory = new Map();
const MEMORY_MAX = 4000;
const PREFIX = "tc:";

function hash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h) ^ s.charCodeAt(i);
  return (h >>> 0).toString(36) + s.length.toString(36);
}

const cacheKey = (p, sl, tl, text) => `${PREFIX}${p}|${sl}|${tl}|${hash(text)}`;

async function cacheGet(key) {
  if (memory.has(key)) return memory.get(key);
  const got = await chrome.storage.local.get(key);
  const value = got[key];
  if (value !== undefined) memory.set(key, value);
  return value;
}

const pendingWrites = {};
let flushTimer = null;

function cacheSet(key, value) {
  if (memory.size > MEMORY_MAX) memory.clear();
  memory.set(key, value);
  pendingWrites[key] = value;
  if (flushTimer) return;
  flushTimer = setTimeout(async () => {
    const batch = { ...pendingWrites };
    for (const k of Object.keys(pendingWrites)) delete pendingWrites[k];
    flushTimer = null;
    try {
      await chrome.storage.local.set(batch);
    } catch {
      await clearCache(); // quota exceeded: keep working from memory
    }
  }, 1500);
}

export async function cacheStats() {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter((k) => k.startsWith(PREFIX));
  const bytes = keys.reduce((n, k) => n + k.length + String(all[k]).length, 0);
  return { entries: keys.length, bytes };
}

export async function clearCache() {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter((k) => k.startsWith(PREFIX));
  if (keys.length) await chrome.storage.local.remove(keys);
  memory.clear();
  return keys.length;
}

// ---------- concurrency ----------

class Limiter {
  constructor(limit) {
    this.limit = limit;
    this.active = 0;
    this.queue = [];
  }
  setLimit(n) {
    this.limit = Math.max(1, Math.min(8, (n | 0) || 1));
  }
  run(task) {
    return new Promise((resolve, reject) => {
      this.queue.push({ task, resolve, reject });
      this.pump();
    });
  }
  pump() {
    while (this.active < this.limit && this.queue.length) {
      const { task, resolve, reject } = this.queue.shift();
      this.active++;
      task()
        .then(resolve, reject)
        .finally(() => {
          this.active--;
          this.pump();
        });
    }
  }
}

const limiter = new Limiter(4);
let cooldownUntil = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- providers ----------

const GOOGLE_FREE_URL = "https://translate.googleapis.com/translate_a/single";
const GOOGLE_CLOUD_URL = "https://translation.googleapis.com/language/translate/v2";

async function googleFree({ text, sl, tl }) {
  const url = new URL(GOOGLE_FREE_URL);
  url.searchParams.set("client", "gtx");
  url.searchParams.set("sl", sl || "auto");
  url.searchParams.set("tl", tl);
  url.searchParams.set("dt", "t");
  url.searchParams.set("dj", "1");
  url.searchParams.set("q", text);

  const res = await fetch(url, { credentials: "omit", cache: "no-store" });
  if (res.status === 429 || res.status === 403) throw new RateLimited("rate limited");
  if (!res.ok) throw new Error(`google-free ${res.status}`);
  const data = await res.json();
  return (data?.sentences || []).map((s) => s.trans || "").join("");
}

async function googleCloud({ text, sl, tl, settings, tagged }) {
  const key = settings.googleApiKey;
  if (!key) throw new Error("Google Cloud API key missing");
  const url = new URL(GOOGLE_CLOUD_URL);
  url.searchParams.set("key", key);
  const body = { q: text, target: tl, format: tagged ? "html" : "text" };
  if (sl && sl !== "auto") body.source = sl;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status === 429) throw new RateLimited("rate limited");
  if (!res.ok) throw new Error(`google-cloud ${res.status}`);
  const data = await res.json();
  return data?.data?.translations?.[0]?.translatedText || "";
}

async function deepl({ text, sl, tl, settings, tagged }) {
  const key = settings.deeplApiKey;
  if (!key) throw new Error("DeepL API key missing");
  const host = settings.deeplFree ? "api-free.deepl.com" : "api.deepl.com";

  const params = new URLSearchParams({ text, target_lang: tl.toUpperCase() });
  if (sl && sl !== "auto") params.set("source_lang", sl.toUpperCase());
  if (tagged) {
    params.set("tag_handling", "xml"); // documented: ignored tags pass through
    params.set("ignore_tags", "x");
  }

  const res = await fetch("https://" + host + "/v2/translate", {
    method: "POST",
    headers: {
      Authorization: `DeepL-Auth-Key ${key}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params,
  });
  if (res.status === 429 || res.status === 456) throw new RateLimited("rate limited");
  if (!res.ok) throw new Error(`deepl ${res.status}`);
  const data = await res.json();
  return data?.translations?.[0]?.text || "";
}

async function libre({ text, sl, tl, settings }) {
  const res = await fetch(settings.libreEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      q: text,
      source: sl && sl !== "auto" ? sl : "auto",
      target: tl,
      format: "text",
      api_key: settings.libreApiKey || undefined,
    }),
  });
  if (res.status === 429) throw new RateLimited("rate limited");
  if (!res.ok) throw new Error(`libre ${res.status}`);
  const data = await res.json();
  return data?.translatedText || "";
}

const PROVIDERS = { "google-free": googleFree, "google-cloud": googleCloud, deepl, libre };

async function call(text, settings, tagged = false) {
  const fn = PROVIDERS[settings.provider] || googleFree;
  const sl = settings.sourceLang;
  const tl = settings.targetLang;

  let lastError;
  for (let attempt = 0; attempt < 4; attempt++) {
    const wait = cooldownUntil - Date.now();
    if (wait > 0) await sleep(wait);
    try {
      return await limiter.run(() => fn({ text, sl, tl, settings, tagged }));
    } catch (error) {
      lastError = error;
      if (error instanceof RateLimited) {
        const backoff = 1500 * Math.pow(2, attempt);
        cooldownUntil = Date.now() + backoff;
        await sleep(backoff);
        continue;
      }
      if (attempt < 2) {
        await sleep(400 * (attempt + 1));
        continue;
      }
      break;
    }
  }
  throw lastError || new Error("translation failed");
}

// ---------- markup ----------

const escapeXml = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const unescapeXml = (s) =>
  String(s)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");

// Bidi isolation is applied here, before the request: the isolate characters
// are invisible and travel safely inside an ignored tag.
function buildMarkup(runs, useX, rtl) {
  return runs
    .map(({ type, value, ws }) => {
      if (type === "text") return ws + escapeXml(value);
      const body = escapeXml(type === "math" ? isolate(value, rtl) : value);
      return ws + (useX ? `<x>${body}</x>` : `<span translate="no">${body}</span>`);
    })
    .join("");
}

function parseMarkup(raw) {
  let out = String(raw || "");
  out = out.replace(/<x>([\s\S]*?)<\/x>/g, (_m, inner) => unescapeXml(inner));
  out = out.replace(
    /<span[^>]*translate="?no"?[^>]*>([\s\S]*?)<\/span>/gi,
    (_m, inner) => unescapeXml(inner)
  );
  out = out.replace(/<[^>]+>/g, ""); // any tag the engine invented
  return unescapeXml(out).replace(/[ \t]+/g, " ").trim();
}

// ---------- strategies ----------

async function translateByRuns(runs, settings, rtl) {
  const pieces = await Promise.all(
    runs.map(async (run) => {
      if (run.type === "math") return isolate(run.value, rtl);
      if (run.type === "term") return run.value; // already in the target language
      if (!/[\p{L}]/u.test(run.value)) return run.value; // punctuation only
      try {
        return await call(run.value, settings);
      } catch {
        return run.value; // keep the original rather than lose the sentence
      }
    })
  );
  return runs.map((run, i) => run.ws + pieces[i]).join("").trim();
}

async function translateOne(rawText, settings, glossary) {
  const source = normalise(rawText);
  if (!source) return "";

  const rtl = isRtl(settings.targetLang);
  const useTags = TAG_PROVIDERS.has(settings.provider);

  let runs = settings.protectMath
    ? splitRuns(source)
    : [{ type: "text", value: source, ws: "" }];
  runs = applyGlossary(runs, glossary);

  const protectedRuns = runs.filter((r) => r.type !== "text").length;
  const mode = protectedRuns === 0 ? "plain" : useTags ? "tags" : "runs";
  const signature = protectedRuns && glossary ? glossary.signature : "";

  const key = cacheKey(
    settings.provider,
    settings.sourceLang,
    settings.targetLang,
    `${mode}|${signature}|${source}`
  );
  const hit = await cacheGet(key);
  if (hit !== undefined) return hit;

  let out;
  if (mode === "plain") out = await call(source, settings);
  else if (mode === "tags")
    out = parseMarkup(
      await call(buildMarkup(runs, settings.provider === "deepl", rtl), settings, true)
    );
  else out = await translateByRuns(runs, settings, rtl);

  cacheSet(key, out);
  return out;
}

/**
 * Translate a list of strings. Always returns an array of the same length; a
 * failure comes back as { error } so the reader can show it per paragraph
 * instead of failing the whole page.
 */
export async function translateMany(items) {
  const settings = await getSettings();
  limiter.setLimit(settings.concurrency);

  const glossary =
    settings.glossaryEnabled === false ? null : compileGlossary(settings.glossary);

  return Promise.all(
    (items || []).map(async (text) => {
      try {
        return { text: await translateOne(text, settings, glossary) };
      } catch (error) {
        return { error: String(error?.message || error) };
      }
    })
  );
}
