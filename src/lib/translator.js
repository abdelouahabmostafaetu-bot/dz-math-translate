// ---------------------------------------------------------------------------
//  Translation engine: providers, concurrency, retry, cache.
//
//  Runs in the service worker only, so the whole browser shares one cache and
//  one rate limit.
//
//  Formulas are protected in one of two ways, never with placeholders:
//
//   * runs  - split the paragraph, send only the prose, reassemble. Used for
//             the free Google endpoint, which has no markup support.
//   * tags  - send the paragraph as markup with formulas inside tags the API
//             is documented to ignore (DeepL tag_handling=xml + ignore_tags,
//             Google format=html with translate="no"). Better grammar, since
//             the engine still sees the whole sentence.
// ---------------------------------------------------------------------------

import { getSettings, isRtl } from "./settings.js";
import { normalise, splitRuns, isolate } from "./segment.js";

class RateLimited extends Error {}

const TAG_PROVIDERS = new Set(["google-cloud", "deepl"]);

// ---------- cache -----------------------------------------------------------

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

// ---------- concurrency -----------------------------------------------------

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

// ---------- providers -------------------------------------------------------

const GOOGLE_FREE_URL = "https://translate.googleapis.com/translate_a/single";
const GOOGLE_CLOUD_URL = "https://translation.googleapis.com/language/translate/v2";

// Unofficial endpoint used by the Google Translate web page: no key, no cost,
// rate limited, no contract. See the README.
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
  const endpoint = "https://" + host + "/v2/translate";

  const params = new URLSearchParams({ text, target_lang: tl.toUpperCase() });
  if (sl && sl !== "auto") params.set("source_lang", sl.toUpperCase());
  if (tagged) {
    // Documented DeepL feature: content inside ignored tags is passed through.
    params.set("tag_handling", "xml");
    params.set("ignore_tags", "x");
  }

  const res = await fetch(endpoint, {
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

const PROVIDERS = {
  "google-free": googleFree,
  "google-cloud": googleCloud,
  deepl,
  libre,
};

// One network call, rate limited, retried, with a browser-wide cooldown.
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

// ---------- markup helpers --------------------------------------------------

const escapeXml = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function unescapeXml(s) {
  return String(s)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

function buildMarkup(runs, useX) {
  return runs
    .map(({ type, value, ws }) => {
      const body = escapeXml(value);
      if (type !== "math") return ws + body;
      return ws + (useX ? `<x>${body}</x>` : `<span translate="no">${body}</span>`);
    })
    .join("");
}

function parseMarkup(raw, rtl) {
  let out = String(raw || "");
  out = out.replace(/<x>([\s\S]*?)<\/x>/g, (_m, inner) => isolate(unescapeXml(inner), rtl));
  out = out.replace(
    /<span[^>]*translate="?no"?[^>]*>([\s\S]*?)<\/span>/gi,
    (_m, inner) => isolate(unescapeXml(inner), rtl)
  );
  out = out.replace(/<[^>]+>/g, ""); // any tag the engine invented
  return unescapeXml(out).replace(/\s+/g, " ").trim();
}

// ---------- strategies ------------------------------------------------------

// Send prose only; mathematics never leaves the browser.
async function translateByRuns(runs, settings, rtl) {
  const pieces = await Promise.all(
    runs.map(async (run) => {
      if (run.type === "math") return isolate(run.value, rtl);
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

async function translateByTags(runs, settings, rtl) {
  const markup = buildMarkup(runs, settings.provider === "deepl");
  return parseMarkup(await call(markup, settings, true), rtl);
}

async function translateOne(rawText, settings) {
  const source = normalise(rawText);
  if (!source) return "";

  const rtl = isRtl(settings.targetLang);
  const mode = !settings.protectMath
    ? "plain"
    : TAG_PROVIDERS.has(settings.provider)
      ? "tags"
      : "runs";

  const key = cacheKey(settings.provider, settings.sourceLang, settings.targetLang, `${mode}|${source}`);
  const hit = await cacheGet(key);
  if (hit !== undefined) return hit;

  const runs = mode === "plain" ? [] : splitRuns(source);
  const hasMath = runs.some((r) => r.type === "math");

  let out;
  if (!hasMath) {
    // No formula to protect: the engine sees the whole paragraph, best quality.
    out = await call(source, settings);
  } else if (mode === "tags") {
    out = await translateByTags(runs, settings, rtl);
  } else {
    out = await translateByRuns(runs, settings, rtl);
  }

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

  return Promise.all(
    (items || []).map(async (text) => {
      try {
        return { text: await translateOne(text, settings) };
      } catch (error) {
        return { error: String(error?.message || error) };
      }
    })
  );
}
