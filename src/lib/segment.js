// ---------------------------------------------------------------------------
//  Text preparation. This file is the reason the extension is usable on a
//  mathematics book instead of being a joke.
//
//  Two jobs:
//    1. normalise()    repair text extracted from a PDF (broken words, weird
//                      spacing, ligatures, soft hyphens).
//    2. protectMath()  hide formulas behind placeholders before translation and
//                      restoreMath() put them back afterwards, so that no
//                      machine translator ever gets a chance to "improve"
//                      $f(x) = x^2$ into prose.
// ---------------------------------------------------------------------------

const LIGATURES = [
  [/\ufb00/g, "ff"],
  [/\ufb01/g, "fi"],
  [/\ufb02/g, "fl"],
  [/\ufb03/g, "ffi"],
  [/\ufb04/g, "ffl"],
  [/\u00ad/g, ""], // soft hyphen
  [/\u2019/g, "'"],
  [/[\u201c\u201d]/g, '"'],
  [/\u2013/g, "-"],
  [/\ufeff/g, ""],
];

// Join the physical lines of a PDF paragraph into a single logical string.
export function joinLines(lines, { dehyphenate = true } = {}) {
  let out = "";
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (!out) {
      out = line;
      continue;
    }
    const brokenWord = dehyphenate && /[\p{Ll}]-$/u.test(out) && /^[\p{Ll}]/u.test(line);
    out = brokenWord ? out.slice(0, -1) + line : out + " " + line;
  }
  return out;
}

export function normalise(text) {
  let out = String(text || "");
  for (const [re, to] of LIGATURES) out = out.replace(re, to);
  return out.replace(/\s+/g, " ").trim();
}

// A run of characters that looks like mathematics rather than prose.
// Order matters: the explicit delimiters come first.
const MATH_PATTERNS = [
  /\$[^$\n]{1,300}\$/g, // $ ... $
  /\\\([^\n]{1,300}?\\\)/g, // \( ... \)
  /\\[A-Za-z]+(?:\{[^{}\n]{0,80}\})*/g, // \alpha, \frac{a}{b}
  // an expression containing a relation or a big operator
  /[A-Za-z0-9(){}\[\]|.,'^_+\-*/\\]*[=\u2260\u2264\u2265<>\u2248\u2245\u223c\u2208\u2209\u2282\u2286\u2283\u2287\u222a\u2229\u2200\u2203\u2211\u220f\u222b\u2202\u2207\u221a\u00b1\u00d7\u00f7\u21d2\u21d4\u2192\u21a6][A-Za-z0-9(){}\[\]|.,'^_+\-*/\\\s]{0,80}/gu,
  /\b[A-Za-z]\s*[\^_]\s*\{?[A-Za-z0-9+\-]{1,6}\}?/g, // x^2, a_{n}
  /\b[A-Za-z]\s*\([A-Za-z0-9,\s]{1,12}\)/g, // f(x), g(x, y)
  /[\u0391-\u03c9\u2100-\u214f\u2190-\u21ff\u2200-\u22ff]/gu, // lone symbols
];

const PLACEHOLDER = /ZQX(\d+)XQZ/g;
const mark = (i) => `ZQX${i}XQZ`;

/**
 * Replace every formula by an opaque placeholder.
 * The placeholder is uppercase ASCII with no spaces, which every translation
 * engine passes through untouched.
 */
export function protectMath(text, enabled = true) {
  if (!enabled) return { text, parts: [] };

  const parts = [];
  const taken = []; // [start, end) ranges already claimed
  let work = String(text);

  const overlaps = (a, b) => taken.some(([s, e]) => a < e && b > s);

  for (const pattern of MATH_PATTERNS) {
    pattern.lastIndex = 0;
    let m;
    while ((m = pattern.exec(work))) {
      const start = m.index;
      const end = start + m[0].length;
      if (!m[0].trim() || overlaps(start, end)) continue;
      taken.push([start, end]);
    }
  }

  taken.sort((a, b) => b[0] - a[0]); // right to left, indices stay valid
  const chunks = [];
  for (const [start, end] of taken) {
    chunks.push(work.slice(start, end));
    work = work.slice(0, start) + "\u0000" + work.slice(end);
  }
  chunks.reverse();

  let i = 0;
  work = work.replace(/\u0000/g, () => {
    parts.push(chunks[i]);
    return ` ${mark(i++)} `;
  });

  return { text: work.replace(/\s+/g, " ").trim(), parts };
}

export function restoreMath(translated, parts) {
  if (!parts.length) return translated;

  const used = new Set();
  let out = String(translated).replace(PLACEHOLDER, (_, n) => {
    const i = Number(n);
    used.add(i);
    return parts[i] ?? "";
  });

  // Some engines drop or duplicate placeholders. Never lose a formula:
  // append whatever came back missing, clearly separated.
  const lost = parts.filter((_, i) => !used.has(i));
  if (lost.length) out += " " + lost.join(" ");

  return out.replace(/\s+/g, " ").trim();
}

// Worth translating at all? Skips page numbers, running heads, lone formulas.
export function isTranslatable(text) {
  const t = String(text || "").trim();
  if (t.length < 3) return false;
  const letters = t.match(/\p{L}/gu);
  if (!letters || letters.length < 3) return false;
  if (!/\p{L}{3,}/u.test(t)) return false; // no real word
  const { text: stripped } = protectMath(t, true);
  return /\p{L}{3,}/u.test(stripped.replace(PLACEHOLDER, ""));
}
