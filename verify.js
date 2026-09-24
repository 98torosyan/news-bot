// EVERY NUMBER IN A SUMMARY MUST COME FROM THE SOURCE.
//
// The most damaging thing a financial channel can publish is a wrong number:
// "50 basis points" where the Fed said 25, "$12 billion" where the article said
// $1.2. The model does this rarely, and nothing downstream would notice. So
// before a post goes out, every figure in the Armenian summary is looked for in
// the reports it was written from. A figure that is not there stops the post.
//
// WHAT COUNTS AS "THERE"
//
//   The same value, allowing the rewordings a translator legitimately makes:
//     - rounding:          source 1.23 → summary 1.2
//     - scale words:       "$1,200 million" or "$1.2bn" → «$1.2 մլրդ»
//     - points ↔ percent:  "25 basis points" → «0.25 տոկոսային կետ»
//     - decimal comma:     «1,2» is 1.2; «1,234» is one thousand two hundred…
//   A SCALE is never waved through: «50 մլրդ» against a source that says
//   "50 million" is exactly the error this file exists to catch.
//
// WHAT IS NOT CHECKED — deliberately, and only these:
//   - years (1900–2100) and quarters (Q1–Q4): dates, not claims;
//   - plain whole numbers up to 10 with no unit: «երկու», «3 երկիր»;
//   - a whole number right before a unit of time («24 ժամում», «7 օր»).
//
// The check reads ALL the reports of the story, not only the one the model
// was given: a figure CoinDesk printed is evidence even if the model read
// The Block.

const SCALE = [
  [/^(?:thousand|k|հազար)$/i, 1e3],
  [/^(?:million|mn|mln|m|մլն|միլիոն)$/i, 1e6],
  [/^(?:billion|bn|b|մլրդ|միլիարդ)$/i, 1e9],
  [/^(?:trillion|tn|trn|t|տրլն|տրիլիոն)$/i, 1e12],
];
const POINTS = /^(?:basis|bps?|բ\.?կ\.?|բազիսային)$/i;
const TIME = /^(?:ժամ|ժամում|ժամվա|օր|օրում|օրվա|օրից|շաբաթ|շաբաթում|շաբաթվա|ամիս|ամսում|ամսվա|տարի|տարում|տարվա|րոպե|րոպեում|hours?|days?|weeks?|months?|years?|minutes?)$/i;

const NUM = /(\$|€|£|֏)?\s?(\d{1,3}(?:[,\u00a0 ]\d{3})+|\d+)(?:[.,](\d+))?\s?(%|٪)?(?:[\s\u00a0-]*([A-Za-z\u0531-\u0587.]+))?/g;

/**
 * Pure: the figures in a text.
 * → [{ raw, value, decimals, scale, points, pct, currency, skip }]
 *   value   the number as written (1.2 for «1.2 մլրդ»)
 *   scale   the multiplier its word implies (1e9), or 1
 *   points  followed by basis points / «բ.կ.»
 */
export function extractNumbers(text) {
  const out = [];
  const s = String(text ?? "");
  for (const m of s.matchAll(NUM)) {
    const [raw, cur, intPart, frac, pct, wordRaw] = m;
    // «1,234» — a comma followed by exactly three digits groups thousands.
    // «1,2» — any other comma is a decimal comma. The regex has already split
    // them: grouped thousands land in intPart, a decimal part lands in frac.
    const int = Number(intPart.replace(/[,\u00a0 ]/g, ""));
    const decimals = frac ? frac.length : 0;
    const value = frac ? Number(`${int}.${frac}`) : int;
    if (!Number.isFinite(value)) continue;
    const word = String(wordRaw ?? "").replace(/\.$/, "").replace(/^(մլրդ|մլն|տրլն).*$/, "$1");
    let scale = 1;
    for (const [re, k] of SCALE) if (re.test(word)) scale = k;
    const points = POINTS.test(word) || /^բ\.կ/.test(String(wordRaw ?? ""));
    const isYear = !frac && !pct && !cur && scale === 1 && int >= 1900 && int <= 2100;
    const isQuarter = /Q[1-4]\b/i.test(s.slice(Math.max(0, m.index - 1), m.index + raw.length + 1));
    const small = !frac && !pct && !cur && scale === 1 && !points && int <= 10;
    const time = !pct && !cur && TIME.test(word);
    out.push({
      raw: raw.trim(), value, decimals, scale, points, pct: Boolean(pct), currency: cur ?? null,
      skip: isYear || isQuarter || small || time,
    });
  }
  return out;
}

/** a, written with d decimals, is b rounded — or within half a percent of it. */
function sameValue(a, d, b) {
  if (!Number.isFinite(b)) return false;
  const half = 0.5 * 10 ** -d;
  if (Math.abs(a - b) <= half + 1e-9) return true;
  return a !== 0 && Math.abs(a - b) / Math.abs(a) <= 0.005;
}

/** Is the summary figure `f` supported by some source figure? */
export function supported(f, sourceFigures) {
  for (const s of sourceFigures) {
    if (f.scale > 1) {
      // «1.2 մլրդ» must equal the source's full value: 1.2bn, 1,200 million,
      // or 1,200,000,000 written out. Compared in f's own unit, rounded as f is.
      const full = s.value * s.scale;
      if (sameValue(f.value, f.decimals, full / f.scale)) return true;
      continue;
    }
    if (s.scale > 1) {
      // the summary spelled out what the source abbreviated: «1,200,000,000»
      if (sameValue(f.value, f.decimals, s.value * s.scale)) return true;
      continue;
    }
    if (sameValue(f.value, f.decimals, s.value)) return true;
    // 25 basis points ↔ 0.25 percentage points, either direction
    if ((s.points || f.pct || f.points) && sameValue(f.value, f.decimals, s.value / 100)) return true;
    if ((f.points || s.pct) && sameValue(f.value, f.decimals, s.value * 100)) return true;
  }
  return false;
}

/**
 * → { ok, unsupported: [raw…], checked: n }
 * `summary` is parseSummary()'s result; `sources` any number of strings.
 */
export function verifyNumbers(summary, sources) {
  const text = [summary?.headline, summary?.what, summary?.why, summary?.glossDef].filter(Boolean).join("\n");
  const figures = extractNumbers(text).filter((f) => !f.skip);
  const pool = sources.flatMap((t) => extractNumbers(t));
  const unsupported = figures.filter((f) => !supported(f, pool)).map((f) => f.raw);
  return { ok: unsupported.length === 0, unsupported, checked: figures.length };
}

/** The one extra sentence a second attempt gets. */
export const NUMBERS_RETRY_NOTE =
  "\n\nԿԱՐԵՎՈՐ՝ նախորդ փորձում կային թվեր, որոնք չկան աղբյուրում։ Օգտագործիր ՄԻԱՅՆ այն թվերը, որոնք բառացի կան վերևի տեքստում, նույն միավորով (մլն/մլրդ, %, բազիսային կետ)։ Եթե վստահ չես թվի մեջ, մի՛ գրիր այն։";
