// ---------------------------------------------------------------------------
//  Terminology control.
//
//  A machine translator cannot be ordered to use a specific word, and asking it
//  politely with placeholders does not work (the engine rewrites them). So the
//  glossary is applied the same way formulas are protected: the source term is
//  cut out of the prose and replaced by a run holding the *target* term, which
//  is then marked non-translatable. The engine never sees it, so it cannot
//  change it.
//
//  Consequence worth knowing: the surrounding sentence is translated without
//  that word in view, so grammar around a glossary term can be slightly stiffer.
//  That is the price of exact terminology, and for mathematics it is worth it.
// ---------------------------------------------------------------------------

const CACHE = new Map();

/** Parse "english = arabic" lines. Also accepts tab, | or =>. # starts a comment. */
export function parseGlossary(text) {
  const entries = [];
  const seen = new Set();

  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith("//")) continue;

    const match = line.match(/^(.*?)\s*(?:=>|=|\t|\|)\s*(.*)$/);
    if (!match) continue;

    const from = match[1].trim();
    const to = match[2].trim();
    if (!from || !to) continue;

    const key = from.toLowerCase();
    if (seen.has(key)) continue; // first definition wins
    seen.add(key);
    entries.push({ from, to });
  }
  return entries;
}

export function serialiseGlossary(entries) {
  return (entries || []).map((e) => `${e.from} = ${e.to}`).join("\n");
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Build one regular expression for the whole glossary.
 * Longest terms first, so "vector space" wins over "vector".
 */
export function compileGlossary(entries) {
  const list = (entries || []).filter((e) => e && e.from && e.to);
  if (!list.length) return null;

  const signature = list.map((e) => `${e.from}\u0000${e.to}`).join("\u0001");
  if (CACHE.has(signature)) return CACHE.get(signature);

  const sorted = [...list].sort((a, b) => b.from.length - a.from.length);

  const parts = sorted.map((entry) => {
    // Tolerate any run of whitespace between the words of a term.
    const body = escapeRe(entry.from).replace(/\s+/g, "\\s+");
    const lead = /^[\p{L}\p{N}]/u.test(entry.from) ? "\\b" : "";
    const tail = /[\p{L}\p{N}]$/u.test(entry.from) ? "\\b" : "";
    return `${lead}${body}${tail}`;
  });

  const compiled = {
    re: new RegExp(`(${parts.join("|")})`, "giu"),
    map: new Map(sorted.map((e) => [normKey(e.from), e.to])),
    size: sorted.length,
    // Cheap fingerprint so cached translations are invalidated when the
    // glossary changes.
    signature: `g${signature.length.toString(36)}${sorted.length.toString(36)}`,
  };

  if (CACHE.size > 8) CACHE.clear();
  CACHE.set(signature, compiled);
  return compiled;
}

const normKey = (s) => s.toLowerCase().replace(/\s+/g, " ").trim();

function mergeText(runs) {
  const out = [];
  for (const run of runs) {
    const last = out[out.length - 1];
    if (last && last.type === "text" && run.type === "text") {
      last.value += run.ws + run.value;
    } else {
      out.push({ ...run });
    }
  }
  return out;
}

/**
 * Replace glossary hits inside prose runs with protected "term" runs holding
 * the target-language wording.
 *
 * @param runs     runs from segment.splitRuns
 * @param compiled result of compileGlossary
 */
export function applyGlossary(runs, compiled) {
  if (!compiled) return runs;

  const out = [];
  for (const run of runs) {
    if (run.type !== "text" || !compiled.re.test(run.value)) {
      compiled.re.lastIndex = 0;
      out.push(run);
      continue;
    }
    compiled.re.lastIndex = 0;

    const pieces = run.value.split(compiled.re);
    let first = true;

    for (let i = 0; i < pieces.length; i += 1) {
      const piece = pieces[i];
      if (!piece) continue;

      const ws = first ? run.ws : "";
      first = false;

      const isHit = i % 2 === 1;
      const target = isHit ? compiled.map.get(normKey(piece)) : null;

      if (target) out.push({ type: "term", value: target, ws });
      else out.push({ type: "text", value: piece, ws });
    }
  }
  return mergeText(out);
}

// ---------------------------------------------------------------------------
//  Built-in Arabic mathematics glossary.
//
//  Chosen to match the vocabulary used in Algerian university teaching. It is a
//  starting point, not gospel: open the options page and edit freely. Terms are
//  matched case-insensitively on whole words.
// ---------------------------------------------------------------------------

export const MATH_GLOSSARY_AR = [
  // structures
  ["vector space", "فضاء شعاعي"],
  ["vector subspace", "فضاء شعاعي جزئي"],
  ["subspace", "فضاء جزئي"],
  ["field", "حقل"],
  ["ring", "حلقة"],
  ["group", "زمرة"],
  ["subgroup", "زمرة جزئية"],
  ["ideal", "مثالي"],
  ["module", "مقاس"],
  ["algebra", "جبر"],
  ["scalar", "سلّم"],
  ["vector", "شعاع"],
  ["matrix", "مصفوفة"],
  ["matrices", "مصفوفات"],
  ["determinant", "محدّد"],
  ["trace", "أثر"],
  ["transpose", "منقول"],
  ["inverse", "مقلوب"],
  ["identity matrix", "مصفوفة الوحدة"],

  // linear algebra
  ["linear map", "تطبيق خطي"],
  ["linear transformation", "تحويل خطي"],
  ["linear combination", "تشكيلة خطية"],
  ["linearly independent", "مستقلة خطيا"],
  ["linearly dependent", "مرتبطة خطيا"],
  ["basis", "أساس"],
  ["span", "مولّد"],
  ["dimension", "بعد"],
  ["rank", "رتبة"],
  ["kernel", "نواة"],
  ["image", "صورة"],
  ["eigenvalue", "قيمة ذاتية"],
  ["eigenvector", "شعاع ذاتي"],
  ["eigenvalues", "قيم ذاتية"],
  ["eigenvectors", "أشعة ذاتية"],
  ["characteristic polynomial", "كثير الحدود المميز"],
  ["diagonalisable", "قابلة للتقطير"],
  ["diagonalizable", "قابلة للتقطير"],
  ["orthogonal", "متعامد"],
  ["orthonormal", "متعامد ومتجانس"],
  ["inner product", "جداء سلّمي"],
  ["dot product", "جداء سلّمي"],
  ["projection", "إسقاط"],
  ["direct sum", "مجموع مباشر"],

  // analysis
  ["sequence", "متتالية"],
  ["series", "سلسلة"],
  ["limit", "نهاية"],
  ["convergent", "متقاربة"],
  ["divergent", "متباعدة"],
  ["convergence", "تقارب"],
  ["continuous", "مستمر"],
  ["continuity", "استمرارية"],
  ["uniformly continuous", "مستمر بانتظام"],
  ["differentiable", "قابل للاشتقاق"],
  ["derivative", "مشتقة"],
  ["integral", "تكامل"],
  ["bounded", "محدود"],
  ["supremum", "الحد الأعلى"],
  ["infimum", "الحد الأدنى"],
  ["norm", "معيار"],
  ["metric", "مسافة"],
  ["metric space", "فضاء متري"],
  ["complete", "تام"],
  ["Cauchy sequence", "متتالية كوشي"],
  ["Banach space", "فضاء باناخ"],
  ["Hilbert space", "فضاء هيلبرت"],

  // topology and measure
  ["open set", "مجموعة مفتوحة"],
  ["closed set", "مجموعة مغلقة"],
  ["neighbourhood", "جوار"],
  ["neighborhood", "جوار"],
  ["compact", "متراص"],
  ["connected", "مترابط"],
  ["dense", "كثيف"],
  ["closure", "مرافقة"],
  ["interior", "داخل"],
  ["boundary", "حدّ"],
  ["topology", "طوبولوجيا"],
  ["measure", "قياس"],
  ["measurable", "قابل للقياس"],
  ["almost everywhere", "في كل مكان تقريبا"],
  ["sigma-algebra", "جبر سيغما"],

  // logic and proof
  ["theorem", "مبرهنة"],
  ["lemma", "لمّة"],
  ["corollary", "نتيجة"],
  ["proposition", "قضية"],
  ["proof", "إثبات"],
  ["definition", "تعريف"],
  ["remark", "ملاحظة"],
  ["example", "مثال"],
  ["counterexample", "مثال مضاد"],
  ["exercise", "تمرين"],
  ["if and only if", "إذا وفقط إذا"],
  ["necessary and sufficient", "لازم وكاف"],
  ["by induction", "بالتراجع"],
  ["by contradiction", "بالخلف"],
  ["without loss of generality", "دون فقدان العمومية"],
  ["suppose", "لنفترض"],
  ["conversely", "بالعكس"],

  // sets and maps
  ["set", "مجموعة"],
  ["subset", "مجموعة جزئية"],
  ["union", "اتحاد"],
  ["intersection", "تقاطع"],
  ["empty set", "المجموعة الخالية"],
  ["mapping", "تطبيق"],
  ["function", "دالة"],
  ["injective", "متباين"],
  ["surjective", "غامر"],
  ["bijective", "تقابلي"],
  ["isomorphism", "تماثل"],
  ["homomorphism", "تشاكل"],
  ["equivalence relation", "علاقة تكافؤ"],

  // probability
  ["probability", "احتمال"],
  ["random variable", "متغير عشوائي"],
  ["expectation", "أمل رياضي"],
  ["variance", "تباين"],
  ["independent", "مستقل"],
  ["distribution", "توزيع"],
].map(([from, to]) => ({ from, to }));
