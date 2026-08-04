// ---------------------------------------------------------------------------
//  Text repair and mathematics detection.
//
//  This is the heart of the extension. Two jobs:
//
//   1. Turn PDF text-layer debris into clean prose (hyphenation, ligatures).
//   2. Split a paragraph into prose runs and mathematics runs, so formulas can
//      be kept out of the translation engine entirely.
//
//  Why splitting instead of placeholders: machine translation engines rewrite,
//  reorder and duplicate placeholder tokens. Google is documented to turn
//  "{1 /} {2 /} {3 /}" into "{1} {2} {3}}". Any sentinel string is a gamble, so
//  we never send one. Prose goes out, mathematics stays here.
// ---------------------------------------------------------------------------

const LIGATURES = [
  [/\uFB00/g, "ff"],
  [/\uFB01/g, "fi"],
  [/\uFB02/g, "fl"],
  [/\uFB03/g, "ffi"],
  [/\uFB04/g, "ffl"],
  [/\uFB05/g, "st"],
  [/\uFB06/g, "st"],
];

/** Clean up a string extracted from a PDF text layer. */
export function normalise(text) {
  let out = String(text || "");
  for (const [pattern, replacement] of LIGATURES) out = out.replace(pattern, replacement);
  out = out.replace(/\u00AD/g, ""); // soft hyphen
  out = out.replace(/[\u200B-\u200D\uFEFF]/g, ""); // zero-width junk
  out = out.replace(/\u00A0/g, " ");
  out = out.replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"');
  out = out.replace(/\s+/g, " ");
  return out.trim();
}

/**
 * Join the lines of one paragraph.
 *
 * PDF lines break mid-word: "vocabu-" + "lary". Rejoin those, but keep real
 * hyphens in "well-defined" and in "Hausdorff-" + "Banach" (capital follows).
 */
export function joinLines(lines, { dehyphenate = true } = {}) {
  const list = (lines || []).map((l) => String(l).replace(/\s+$/g, ""));
  let out = "";

  for (let i = 0; i < list.length; i++) {
    const line = list[i];
    const next = list[i + 1] || "";

    if (
      dehyphenate &&
      /[\p{L}]{2}[-\u2010\u2011]$/u.test(line) &&
      /^[\p{Ll}]/u.test(next.trimStart())
    ) {
      out += line.slice(0, -1); // drop the hyphen, no space
      continue;
    }

    out += line;
    if (i < list.length - 1) out += " ";
  }

  return out;
}

// ---------------------------------------------------------------------------
//  Mathematics detection
// ---------------------------------------------------------------------------

// Relations, operators, arrows, blackboard letters and Greek. Edit freely: this
// is meant to be tuned to your own field.
export const MATH_SYMBOLS =
  "=\u2260\u2264\u2265\u2248\u2243\u2245\u223C\u2261<>\u00B1\u00D7\u00F7\u2213\u22C5\u00B7" +
  "\u2217\u2218\u2295\u2296\u2297\u2298\u2208\u2209\u220B\u2282\u2284\u2286\u2287\u2283" +
  "\u222A\u2229\u2205\u2200\u2203\u2204\u2211\u220F\u2210\u222B\u222C\u222E\u221A\u2202" +
  "\u2207\u221E\u2190\u2192\u2194\u21A6\u21D2\u21D0\u21D4\u22A5\u2225\u2227\u2228\u00AC" +
  "\u22A2\u22A8\u226A\u226B\u230A\u230B\u2308\u2309\u2020\u2016\u2211" +
  "\u211D\u2102\u2115\u2124\u211A\u1D53D\u2119\u1D53C\u210D\u2112\u2110\u2131" +
  "\u0391-\u03C9";

const HAS_MATH_SYMBOL = new RegExp(`[${MATH_SYMBOLS}]`, "u");

// Single letters that are ordinary English words, not variables.
const ENGLISH_LETTERS = /^[aAI]$/;

// Punctuation that may cling to a token without being part of the maths.
const LEAD = /^[(\["'\u00AB]+/;
const TRAIL = /[)\]"'\u00BB.,;:!?]+$/;

/** Does this whitespace-delimited token look like mathematics? */
export function isMathToken(token) {
  const raw = String(token || "");
  if (!raw) return false;

  // A dollar or LaTeX group is unambiguous, judge it before stripping anything.
  if (/^\$[^$]*\$$/.test(raw)) return true;
  if (/^\\[a-zA-Z]+/.test(raw)) return true;
  if (/^\\[()[\]]/.test(raw)) return true;

  if (HAS_MATH_SYMBOL.test(raw)) return true;

  const core = raw.replace(LEAD, "").replace(TRAIL, "");
  if (!core) return false;

  // Sub- and superscripts as flattened by the PDF text layer: R^n, a_i, x2.
  if (/[\^_]/.test(core) && /[A-Za-z0-9]/.test(core)) return true;

  // A lone variable. "a", "A" and "I" are English words, so leave them.
  if (/^[A-Za-z]$/.test(core) && !ENGLISH_LETTERS.test(core)) return true;

  // Indexed variables: a1, xn, Mat, R2. Short letter+digit mixtures only.
  if (/^[A-Za-z]{1,3}\d+$/.test(core)) return true;
  if (/^\d+[A-Za-z]{1,3}$/.test(core)) return true;

  // Tuples and coordinate lists: (a1,...,an), (b1,
  if (/^[({[].*[,;].*[)}\]]$/.test(core) && core.length <= 48 && /[A-Za-z\d]/.test(core)) {
    return true;
  }

  return false;
}

/** A token that glues two maths tokens together, such as an ellipsis. */
function isBridge(token) {
  return /^(?:\.\.\.|\u2026|,|;|:|\+|-|\/|\||\\)$/.test(String(token || ""));
}

/**
 * Split a paragraph into ordered runs.
 *
 * Returns [{ type: "text" | "math", value, ws }] where `ws` is the whitespace
 * that preceded the run, so the paragraph can be rebuilt exactly.
 */
export function splitRuns(text) {
  const source = String(text || "");
  if (!source.trim()) return [];

  const parts = source.split(/(\s+)/).filter((p) => p !== "");
  const runs = [];
  let ws = "";

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (/^\s+$/.test(part)) {
      ws = " ";
      continue;
    }

    const previous = runs[runs.length - 1];
    const next = parts[i + 1] && /^\s+$/.test(parts[i + 1]) ? parts[i + 2] : parts[i + 1];

    let type = isMathToken(part) ? "math" : "text";

    // "a1, ... ,an": keep the connective inside the formula rather than sending
    // a stray comma to the translator.
    if (type === "text" && previous?.type === "math" && isBridge(part) && isMathToken(next || "")) {
      type = "math";
    }

    if (previous && previous.type === type) {
      previous.value += ws + part;
    } else {
      runs.push({ type, value: part, ws });
    }
    ws = "";
  }

  return tidy(runs);
}

// Sentence punctuation belongs to the prose, not to the formula, or the
// translated sentence loses its full stop.
function tidy(runs) {
  const out = [];

  for (const run of runs) {
    if (run.type === "math") {
      const match = run.value.match(/[.,;:!?]+$/);
      if (match && run.value.length > match[0].length) {
        out.push({ type: "math", value: run.value.slice(0, -match[0].length), ws: run.ws });
        out.push({ type: "text", value: match[0], ws: "" });
        continue;
      }
    }
    out.push(run);
  }

  // Merge neighbours of the same type created by the step above.
  const merged = [];
  for (const run of out) {
    const previous = merged[merged.length - 1];
    if (previous && previous.type === run.type) previous.value += run.ws + run.value;
    else merged.push(run);
  }
  return merged;
}

/** Is there enough prose here to be worth translating at all? */
export function isTranslatable(text) {
  const source = String(text || "");
  if (source.length < 3) return false;

  const words = splitRuns(source)
    .filter((r) => r.type === "text")
    .flatMap((r) => r.value.split(/\s+/))
    .filter((w) => /[\p{L}]{3}/u.test(w));

  return words.length >= 2;
}

/** Mostly symbols: a displayed equation, a figure label, a page number. */
export function isMathy(text) {
  return !isTranslatable(text);
}

// ---------------------------------------------------------------------------
//  Bidirectional text
// ---------------------------------------------------------------------------

const LRI = "\u2066"; // left-to-right isolate
const PDI = "\u2069"; // pop directional isolate

/**
 * Keep a formula readable inside a right-to-left sentence.
 *
 * Without isolation, Arabic surroundings reorder "f(x) = 2" into nonsense such
 * as "2 = f(x)" on screen. The characters are invisible and copy out cleanly.
 */
export function isolate(value, rtl) {
  const text = String(value ?? "");
  if (!rtl || !text) return text;
  return LRI + text + PDI;
}

export function stripIsolates(text) {
  return String(text || "").replace(/[\u2066-\u2069]/g, "");
}

// ---------------------------------------------------------------------------
//  Legacy helpers, kept so older callers keep working. Prefer splitRuns.
// ---------------------------------------------------------------------------

export function protectMath(text, enabled = true) {
  if (!enabled) return { text: String(text || ""), parts: [] };
  const runs = splitRuns(text);
  return {
    text: runs.map((r) => r.ws + (r.type === "math" ? "" : r.value)).join("").trim(),
    parts: runs.filter((r) => r.type === "math").map((r) => r.value),
  };
}

export function restoreMath(text, parts) {
  const missing = (parts || []).join(" ");
  return missing ? `${text} ${missing}`.trim() : String(text || "");
}
