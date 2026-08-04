// ---------------------------------------------------------------------------
//  Read aloud.
//
//  Uses the browser's own speech synthesis, so it costs nothing and works
//  offline with the voices installed on the system. Windows ships an Arabic
//  voice (Hoda / Naayf) once the Arabic language pack is installed; without it
//  listVoices() simply returns no Arabic entry and we say so instead of
//  producing gibberish.
//
//  Chrome silently truncates long utterances, so text is spoken in sentence
//  sized chunks queued one after another.
// ---------------------------------------------------------------------------

const synth = typeof speechSynthesis === "undefined" ? null : speechSynthesis;

const MAX_CHUNK = 200;

let queue = [];
let speaking = false;
let onState = () => {};

export const available = () => !!synth;

export function onSpeechState(callback) {
  onState = typeof callback === "function" ? callback : () => {};
}

/** Voices are populated asynchronously on first call in Chrome. */
export function listVoices() {
  if (!synth) return Promise.resolve([]);
  const now = synth.getVoices();
  if (now.length) return Promise.resolve(now);

  return new Promise((resolve) => {
    const done = () => resolve(synth.getVoices());
    synth.addEventListener("voiceschanged", done, { once: true });
    setTimeout(done, 1000); // some platforms never fire the event
  });
}

export async function voicesForLang(lang) {
  const code = String(lang || "").slice(0, 2).toLowerCase();
  const all = await listVoices();
  const matching = all.filter((v) => v.lang.slice(0, 2).toLowerCase() === code);
  return { matching, all };
}

function chunk(text) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (!clean) return [];

  // Split on sentence enders, Arabic full stop and comma included.
  const sentences = clean.match(/[^.!?؟।\u06D4]+[.!?؟\u06D4]*\s*/g) || [clean];
  const out = [];

  for (const sentence of sentences) {
    if (sentence.length <= MAX_CHUNK) {
      out.push(sentence.trim());
      continue;
    }
    let rest = sentence;
    while (rest.length > MAX_CHUNK) {
      const cut = rest.lastIndexOf(" ", MAX_CHUNK);
      const at = cut > MAX_CHUNK * 0.5 ? cut : MAX_CHUNK;
      out.push(rest.slice(0, at).trim());
      rest = rest.slice(at);
    }
    if (rest.trim()) out.push(rest.trim());
  }
  return out.filter(Boolean);
}

function next(options) {
  if (!synth || !queue.length) {
    speaking = false;
    onState({ speaking: false });
    return;
  }

  const text = queue.shift();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = options.lang || "ar";
  utterance.rate = clampNumber(options.rate, 0.5, 2, 1);
  utterance.pitch = clampNumber(options.pitch, 0, 2, 1);
  if (options.voice) {
    const voice = synth.getVoices().find((v) => v.name === options.voice);
    if (voice) {
      utterance.voice = voice;
      utterance.lang = voice.lang;
    }
  }

  utterance.onend = () => next(options);
  utterance.onerror = () => next(options);
  synth.speak(utterance);
}

const clampNumber = (value, min, max, fallback) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

/** Speak text, replacing anything currently being spoken. */
export function speak(text, options = {}) {
  if (!synth) return false;
  stop();
  queue = chunk(text);
  if (!queue.length) return false;
  speaking = true;
  onState({ speaking: true });
  next(options);
  return true;
}

export function stop() {
  queue = [];
  speaking = false;
  synth?.cancel();
  onState({ speaking: false });
}

export function toggle(text, options = {}) {
  if (speaking) {
    stop();
    return false;
  }
  return speak(text, options);
}

export const isSpeaking = () => speaking;
