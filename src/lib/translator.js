// ---------------------------------------------------------------------------
//  Translation engine: providers + concurrency limit + retry + cache.
//  Runs in the service worker only, so every page shares one cache and one
//  rate limit.
// ---------------------------------------------------------------------------

import { getSettings } from "./settings.js";
import { protectMath, restoreMath, normalise } from "./segment.js";

class RateLimited extends Error {}

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
  if (!flushTimer) {
    flushTimer = setTimeout(async () => {
      const batch = { ...pendingWrites };
      for (const k of Object.keys(pendingWrites)) delete pendingWrites[k];
      flushTimer = null;
      try {
        await chrome.storage.local.set(batch);
      } catch (e) {
        // Quota exceeded: drop the persistent cache, keep working in memory.
        await clearCache();
      }
    }, 1500);
  }
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
    this.limit = Math.max(1, Math.min(8, n | 0 || 1));
  }
  run(task) {
    return new Promise((resolve, reject) => {
      this.queue.push({ task, resolve, reject });
      this.#pump();
    });
  }
  #pump() {
    while (this.active < this.limit && this.queue.length) {
      const { task, resolve, reject } = this.queue.shift();
      this.active++;
      task()
        .then(resolve, reject)
        .finally(() => {
          this.active--;
          this.#pump();
        });
    }
  }
}

const limiter = new Limiter(4);
let cooldownUntil = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- providers -------------------------------------------------------

// Unofficial endpoint used by the Google Translate web page. No key, no cost,
// but rate limited and not covered by any API contract: see README.
async function googleFree({ text, sl, tl }) {
  const url = new URL("https://translate.googleapis.com/translate_a/single");
  url.searchParams.set("client", "gtx");
  url.searchParams.set("sl", sl || "auto");
  url.searchParams.set("tl", tl);
  url.searchParams.set("dt", "t");
  url.searchParams.set("dj", "1");
  url.searchParams.set("q", text);

  const res = await fetch(url, { credentials: "omit", cache: "no-store" });
  if (res.status === 429 || res.status === 403) throw new RateLimited("429");
  if (!res.ok) throw new Error(`google-free ${res.status}`);

  const data = await res.json();
  const sentences = data?.sentences || [];
  return sentences.map((s) => s.trans || "").join("");
}

async function googleCloud({ text, sl, tl, settings }) {
  const key = settings.googleApiKey;
  if (!key) throw new Error("Google Cloud API key missing");
  const url = `https://translation.googleapis.com/language/translate/v2?key=${encodeURIComponent(key)}`;
  const body = { q: text, target: tl, format: "text" };
  if (sl && sl !== "auto") body.source = sl;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status === 429) throw new RateLimited("429");
  if (!res.ok) throw new Error(`google-cloud ${res.status}`);
  const data = await res.json();
  return data?.data?.translations?.[0]?.translatedText || "";
}

async function deepl({ text, sl, tl, settings }) {
  const key = settings.deeplApiKey;
  if (!key) throw new Error("DeepL API key missing");
  const host = settings.deeplFree ? "api-free.deepl.com" : "api.deepl.com";
  const params = new URLSearchParams({ text, target_lang: tl.toUpperCase() });
  if (sl && sl !== "auto") params.set("source_lang", sl.toUpperCase());

  const res = await fetch(`https://${host}/v2/translate`, {
    method: "POST",
    headers: {
      Authorization: `DeepL-Auth-Key ${key}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params,
  });
  if (res.status === 429 || res.status === 456) throw new RateLimited("429");
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
  if (res.status === 429) throw new RateLimited("429");
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

// ---------- public API ------------------------------------------------------

async function translateOne(rawText, settings) {
  const source = normalise(rawText);
  const tl = settings.targetLang;
  const sl = settings.sourceLang;
  const key = cacheKey(settings.provider, sl, tl, source);

  const hit = await cacheGet(key);
  if (hit !== undefined) return hit;

  const { text, parts } = protectMath(source, settings.protectMath);
  const call = PROVIDERS[settings.provider] || googleFree;

  let lastError;
  for (let attempt = 0; attempt < 4; attempt++) {
    const wait = cooldownUntil - Date.now();
    if (wait > 0) await sleep(wait);
    try {
      const raw = await limiter.run(() => call({ text, sl, tl, settings }));
      const out = restoreMath(raw, parts);
      cacheSet(key, out);
      return out;
    } catch (error) {
      lastError = error;
      if (error instanceof RateLimited) {
        // Back off globally, not just for this request.
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

/**
 * Translate a list of strings. Returns an array of the same length; a failed
 * item comes back as { error } so the UI can show it per paragraph instead of
 * failing the whole page.
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
