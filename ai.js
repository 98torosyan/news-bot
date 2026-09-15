// THE ARMENIAN WRITING — and nothing else.
//
// This module is never asked what to post. src/rank.js has already decided
// that, by counting, before anything here runs. All this does is turn a story
// the arithmetic chose into Armenian prose.
//
// EVERY NUMBER HERE WAS MEASURED, NOT LOOKED UP
//
//   Google stopped publishing free-tier limits on its rate-limit page; they
//   depend on the account. Karen's key answered the question directly:
//
//     Quota exceeded for metric: generate_content_free_tier_requests,
//     limit: 5, model: gemini-3.8-flash. Please retry in 27.8s
//
//   Five requests a minute. So calls are spaced, and a run is capped at a
//   handful of stories. At 30-minute runs and at most three stories each, the
//   bot uses about a tenth of what it is allowed.
//
//   The second measured fact: "currently experiencing high demand" is common
//   and TRANSIENT. In one run gemini-flash-latest served the first request and
//   refused the next two, then a different model served them. So the fallback
//   has to happen per call. An earlier draft picked one working model at
//   startup and reused it, which would have turned a thirty-second blip into a
//   silent half hour.

const GEM_BASE = "https://generativelanguage.googleapis.com/v1beta";

/** Tried in order, per call. The first that answers wins that call only. */
export const MODELS = ["gemini-flash-latest", "gemini-3.8-flash", "gemini-2.5-flash", "gemini-2.0-flash"];

/** Measured: 5 requests/minute. 13s leaves headroom without being slow. */
export const MIN_GAP_MS = 13_000;

/** A transient overload is worth waiting out; a quota wall is not. */
const RETRY_DELAYS_MS = [2_000, 8_000, 20_000];

/** The model's way of saying the material does not support a summary. */
export const INSUFFICIENT = "ԱՆԲԱՎԱՐԱՐ";

let lastCallAt = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pace() {
  const wait = MIN_GAP_MS - (Date.now() - lastCallAt);
  if (wait > 0) await sleep(wait);
  lastCallAt = Date.now();
}

async function callInteractions(key, model, prompt) {
  const res = await fetch(`${GEM_BASE}/interactions`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({ model, input: prompt }),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) return { ok: false, status: res.status, why: json?.error?.message ?? `HTTP ${res.status}` };
  const text = (json?.steps ?? [])
    .flatMap((s) => s?.content ?? [])
    .filter((c) => c?.type === "text")
    .map((c) => c.text)
    .join("")
    .trim();
  return text ? { ok: true, text } : { ok: false, status: res.status, why: "դատարկ պատասխան" };
}

async function callGenerateContent(key, model, prompt) {
  const res = await fetch(`${GEM_BASE}/models/${model}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) return { ok: false, status: res.status, why: json?.error?.message ?? `HTTP ${res.status}` };
  const text = (json?.candidates?.[0]?.content?.parts ?? [])
    .map((p) => p?.text ?? "")
    .join("")
    .trim();
  return text ? { ok: true, text } : { ok: false, status: res.status, why: "դատարկ պատասխան" };
}

const SHAPES = [
  { label: "interactions", fn: callInteractions },
  { label: "generateContent", fn: callGenerateContent },
];

/** A quota wall does not clear by retrying sooner; an overload does. */
function isQuota(why) {
  return /quota|exceeded your current/i.test(String(why));
}

/**
 * Ask the model once, trying every shape and model before giving up.
 *
 * Returns { ok, text } or { ok: false, why }. It never throws and never invents
 * a fallback string: a caller that gets no text posts nothing, which is the
 * whole point — an empty channel is honest, a made-up post is not.
 */
export async function ask(key, prompt, { log = () => {} } = {}) {
  let lastWhy = "չփորձված";

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    for (const shape of SHAPES) {
      for (const model of MODELS) {
        await pace();
        let r;
        try {
          r = await shape.fn(key, model, prompt);
        } catch (e) {
          r = { ok: false, why: String(e?.message ?? e) };
        }
        if (r.ok) return { ok: true, text: r.text, model, shape: shape.label };
        lastWhy = r.why;
        log(`    ${shape.label}/${model}: ${String(r.why).slice(0, 70)}`);

        // A quota wall applies to the key, not to this model, so walking the
        // rest of the list just burns the remaining allowance faster.
        if (isQuota(r.why)) break;
      }
      if (isQuota(lastWhy)) break;
    }

    const delay = RETRY_DELAYS_MS[attempt];
    if (delay == null) break;
    log(`    բոլորը ձախողվեցին — ${delay / 1000}վ սպասում, նորից`);
    await sleep(delay);
  }

  return { ok: false, why: lastWhy };
}

// PROMPT — each rule is a specific thing an earlier version got wrong on a real
// item, kept here so nobody "simplifies" one away without knowing its cost.
//
//   PADDING          Given only a headline and asked for a paragraph, it
//                    restated its first sentence as its third.
//   TRANSLITERATION  It rendered the CLARITY Act as "Քլարիթի" — unsearchable,
//                    and it reads as amateur.
//   RESTATING        It opened the significance line with "This is important
//                    because…", spending a line to say nothing.
//   MARKDOWN         It emitted ** around headings, which Telegram shows as
//                    literal asterisks.
export function summaryPrompt({ title, body, source }) {
  const material = body
    ? `Վերնագիր՝ "${title}"\n\nՏեքստ՝ "${String(body).slice(0, 1500)}"`
    : `Վերնագիր՝ "${title}"\n\n(Տեքստ չկա — միայն վերնագիրը։)`;

  return `Դու ֆինանսական լրագրող ես և գրում ես հայերեն։ Աղբյուրը՝ ${source}։

${material}

Գրիր ՃԻՇՏ այս ձևով, երեք տող, առանց այլ բանի՝

ՎԵՐՆԱԳԻՐ: <մինչև 10 բառ>
ԻՆՉ: <1-3 նախադասություն՝ ինչ է տեղի ունեցել>
ԻՆՉՈՒ: <մեկ նախադասություն՝ ինչ նշանակություն ունի կրիպտո շուկայի համար>

ԿԱՆՈՆՆԵՐ՝
- Մի՛ հորինիր թիվ, գին, տոկոս, ամսաթիվ կամ անուն, որ վերևի նյութում չկա
- Քիչ գրիր՝ լավ։ Եթե միայն մեկ նախադասության փաստ կա, գրիր մեկ նախադասություն։ ՄԻ՛ կրկնիր նույն բանը այլ բառերով
- Հատուկ անունները, ընկերությունների անունները, օրինագծերի անունները և ticker-ները թո՛ղ լատինատառ՝ CLARITY Act, SEC, BlackRock, BTC։ Մի՛ տառադարձիր
- ԻՆՉՈՒ տողը սկսի՛ր ուղիղ բովանդակությամբ։ Մի՛ գրիր «Սա կարևոր է, որովհետև...»
- Մի՛ օգտագործիր * # կամ այլ նշաններ ձևավորման համար
- Մի՛ տուր ներդրումային խորհուրդ
- Եթե նյութը չափազանց քիչ է, որ բան ասես, գրիր միայն՝ ${INSUFFICIENT}`;
}

/**
 * Read the model's three labelled lines back into fields.
 *
 * Strict on purpose. If the shape is not what was asked for, this returns null
 * and the story is skipped rather than posted half-formed — the channel going
 * quiet is a much smaller failure than the channel publishing a fragment.
 */
export function parseSummary(text) {
  const clean = String(text)
    .replace(/[*#`]/g, "") // belt and braces: the prompt forbids these already
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  if (clean.some((l) => l.toUpperCase().startsWith(INSUFFICIENT))) return { insufficient: true };

  const find = (label) => {
    const line = clean.find((l) => l.toUpperCase().startsWith(`${label}:`));
    return line ? line.slice(label.length + 1).trim() : "";
  };

  const headline = find("ՎԵՐՆԱԳԻՐ");
  const what = find("ԻՆՉ");
  const why = find("ԻՆՉՈՒ");

  // "ԻՆՉՈՒ:" also starts with "ԻՆՉ", so a naive search finds the wrong line.
  // Recover by taking the first line that is ԻՆՉ and is not ԻՆՉՈՒ.
  const whatLine = clean.find((l) => /^ԻՆՉ:/i.test(l));
  const whatFixed = whatLine ? whatLine.slice(4).trim() : what;

  if (!headline || !whatFixed) return null;
  return { headline, what: whatFixed, why, insufficient: false };
}
