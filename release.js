// THE NUMBER ITSELF. CPI and the jobs report, straight from the BLS, posted as
// a reply to the channel's own warning about them.
//
// WHY
//
//   Until now the channel learned the CPI the way a reader of the news does:
//   outlets write it up, the ranking notices, the model summarises a summary.
//   A professional wants the print first and the commentary second. The BLS
//   publishes the print as data at 08:30 New York; this file reads it there.
//
// NO AI, NO OPINION, NO FORECAST
//
//   Numbers and the previous month's numbers. The market moves on the SURPRISE
//   against economists' consensus, and no free, licensable source for that
//   consensus exists — so the post does not pretend to have one. It compares
//   with last month and says so.
//
// HOW THE NUMBERS ARE MADE — THE SAME WAY THE BLS MAKES THEM
//
//   Monthly change: from the SEASONALLY ADJUSTED index (CUSR…).
//   Yearly change:  from the NOT seasonally adjusted index (CUUR…).
//   That split is the BLS's own convention in the CPI release. Computing both
//   from one series gives numbers that differ from every headline in the world
//   by a tenth now and then — the one thing a data post cannot afford.
//   Percent changes are computed from the index as published (three decimals)
//   and rounded to one decimal, which is how the BLS derives its own.
//
//   Payrolls: the monthly change in the SA total-nonfarm LEVEL (thousands).
//   The previous month's change is taken from the SAME response, so it is
//   the REVISED figure — which is what the BLS headline compares against too.
//
// WHEN, AND WHEN IT GIVES UP
//
//   From the release moment for POLL_WINDOW_MS. A run that finds the API still
//   showing last month's period waits for the next run — the number is never
//   guessed. Past the window the occurrence is recorded and dropped, out loud:
//   the keyless API allows 25 requests a day, and a release that never came
//   (a government shutdown cancelled several in 2025) must not eat them all.

import { esc, band } from "./telegram.js";
import { allOccurrences, partsInTz, CHANNEL_TZ } from "./calendar.js";

export const RELEASE_EVENTS = ["cpi", "nfp"];
export const POLL_WINDOW_MS = 6 * 3_600_000;
export const BLS_TIMEOUT_MS = 15_000;

export const SERIES = {
  cpi: {
    headSA: "CUSR0000SA0",
    headNSA: "CUUR0000SA0",
    coreSA: "CUSR0000SA0L1E",
    coreNSA: "CUUR0000SA0L1E",
  },
  nfp: {
    payrolls: "CES0000000001",
    unemployment: "LNS14000000",
    wages: "CES0500000003",
  },
};

const LINKS = {
  cpi: "https://www.bls.gov/news.release/cpi.nr0.htm",
  nfp: "https://www.bls.gov/news.release/empsit.nr0.htm",
};

/** Nominative — «օգոստոս», not the «օգոստոսի» calendar.js uses for dates. */
const MONTH_NOM = [
  "հունվար", "փետրվար", "մարտ", "ապրիլ", "մայիս", "հունիս",
  "հուլիս", "օգոստոս", "սեպտեմբեր", "հոկտեմբեր", "նոյեմբեր", "դեկտեմբեր",
];

// ── which month the release is about ───────────────────────────────────────

/**
 * Both releases report the month BEFORE the one they come out in (CPI on
 * October 14 is September; payrolls on October 2 is September).
 * Returns { y, m } with m 1–12.
 */
export function referenceMonth(occTs, tz = "America/New_York") {
  const p = partsInTz(occTs, tz);
  return p.m === 1 ? { y: p.y - 1, m: 12 } : { y: p.y, m: p.m - 1 };
}

// ── parsing the BLS response (pure) ────────────────────────────────────────

/**
 * BLS JSON → Map(seriesId → Map("YYYY-MM" → number)). Monthly periods only
 * ("M01".."M12"; "M13" is an annual average and is skipped). A value the BLS
 * marks missing ("-") is simply absent, never zero.
 */
export function parseBls(json) {
  const out = new Map();
  for (const s of json?.Results?.series ?? []) {
    const byMonth = new Map();
    for (const d of s?.data ?? []) {
      const mm = /^M(0[1-9]|1[0-2])$/.exec(String(d?.period ?? ""));
      const v = Number(String(d?.value ?? "").replace(/,/g, ""));
      if (!mm || !d?.year || !Number.isFinite(v) || String(d.value).trim() === "-") continue;
      byMonth.set(`${d.year}-${mm[1]}`, v);
    }
    if (s?.seriesID) out.set(String(s.seriesID), byMonth);
  }
  return out;
}

const key = (y, m) => `${y}-${String(m).padStart(2, "0")}`;
const back = ({ y, m }, n) => {
  const t = y * 12 + (m - 1) - n;
  return { y: Math.floor(t / 12), m: (t % 12) + 1 };
};
const r1 = (x) => Math.round(x * 10) / 10;
const pctChange = (a, b) => (a != null && b != null && b !== 0 ? r1((a / b - 1) * 100) : null);

/**
 * The numbers for one release, or null if the reference month is not in the
 * data yet (the API still shows last month — try again next run).
 */
export function computeRelease(eventId, series, ref) {
  const at = (id, when) => series.get(id)?.get(key(when.y, when.m)) ?? null;
  const prev = back(ref, 1);

  if (eventId === "cpi") {
    const S = SERIES.cpi;
    if (at(S.headSA, ref) == null || at(S.headNSA, ref) == null) return null;
    return {
      kind: "cpi",
      ref,
      headYoY: pctChange(at(S.headNSA, ref), at(S.headNSA, back(ref, 12))),
      headYoYPrev: pctChange(at(S.headNSA, prev), at(S.headNSA, back(ref, 13))),
      headMoM: pctChange(at(S.headSA, ref), at(S.headSA, prev)),
      headMoMPrev: pctChange(at(S.headSA, prev), at(S.headSA, back(ref, 2))),
      coreYoY: pctChange(at(S.coreNSA, ref), at(S.coreNSA, back(ref, 12))),
      coreYoYPrev: pctChange(at(S.coreNSA, prev), at(S.coreNSA, back(ref, 13))),
      coreMoM: pctChange(at(S.coreSA, ref), at(S.coreSA, prev)),
      coreMoMPrev: pctChange(at(S.coreSA, prev), at(S.coreSA, back(ref, 2))),
    };
  }

  if (eventId === "nfp") {
    const S = SERIES.nfp;
    const lvl = (w) => at(S.payrolls, w);
    if (lvl(ref) == null || at(S.unemployment, ref) == null) return null;
    const diff = (a, b) => (a != null && b != null ? Math.round(a - b) : null);
    return {
      kind: "nfp",
      ref,
      payrolls: diff(lvl(ref), lvl(prev)),
      payrollsPrev: diff(lvl(prev), lvl(back(ref, 2))),
      unemployment: at(S.unemployment, ref),
      unemploymentPrev: at(S.unemployment, prev),
      wagesMoM: pctChange(at(S.wages, ref), at(S.wages, prev)),
      wagesYoY: pctChange(at(S.wages, ref), at(S.wages, back(ref, 12))),
    };
  }

  return null;
}

// ── the post (pure) ────────────────────────────────────────────────────────

const signed = (x) => (x == null ? "—" : `${x > 0 ? "+" : x < 0 ? "−" : ""}${Math.abs(x).toFixed(1)}%`);
const plain = (x) => (x == null ? "—" : `${x.toFixed(1)}%`);
const jobs = (k) => (k == null ? "—" : `${k > 0 ? "+" : k < 0 ? "−" : ""}${Math.abs(k).toLocaleString("en-US")}K`);
const was = (s) => ` <i>(նախորդ՝ ${s})</i>`;

export function renderRelease(r, event) {
  const month = MONTH_NOM[r.ref.m - 1];
  const lines = [`${band("HIGH")} <b>${esc(event.name)} · ${month}</b>`, ""];

  if (r.kind === "cpi") {
    lines.push(
      `Տարեկան՝ <b>${plain(r.headYoY)}</b>${was(plain(r.headYoYPrev))}`,
      `Ամսական՝ <b>${signed(r.headMoM)}</b>${was(signed(r.headMoMPrev))}`,
      "",
      `Core տարեկան՝ <b>${plain(r.coreYoY)}</b>${was(plain(r.coreYoYPrev))}`,
      `Core ամսական՝ <b>${signed(r.coreMoM)}</b>${was(signed(r.coreMoMPrev))}`,
      "",
      `<i>Core-ը առանց սննդի և էներգիայի։</i>`
    );
  } else {
    lines.push(
      `Նոր աշխատատեղեր՝ <b>${jobs(r.payrolls)}</b>${was(`${jobs(r.payrollsPrev)}, վերանայված`)}`,
      `Գործազրկություն՝ <b>${plain(r.unemployment)}</b>${was(plain(r.unemploymentPrev))}`,
      `Միջին ժամավճար՝ <b>${signed(r.wagesMoM)}</b> ամսական · ${plain(r.wagesYoY)} տարեկան`
    );
  }

  lines.push("", `<a href="${LINKS[r.kind]}">BLS</a> · <i>պաշտոնական տվյալ, համեմատությունը՝ նախորդ ամսվա հետ</i>`);
  return lines.join("\n");
}

// ── what is due (pure) ─────────────────────────────────────────────────────

/**
 * Release occurrences that have happened, are inside the polling window, and
 * are not yet recorded. Each carries `expired` once the window has passed.
 */
export function dueReleases(now, done = {}, events) {
  const out = [];
  const lookback = POLL_WINDOW_MS + 36 * 3_600_000;
  for (const o of allOccurrences(now - lookback, now, events)) {
    if (!RELEASE_EVENTS.includes(o.event.id)) continue;
    if (o.ts > now || done[o.key]) continue;
    out.push({ ...o, expired: now - o.ts > POLL_WINDOW_MS });
  }
  return out;
}

// ── the network ────────────────────────────────────────────────────────────

/**
 * One request for every series a release needs. Keyless v1 by default (25
 * requests a day, plenty); if BLS_API_KEY is set in the repository secrets,
 * the registered v2 endpoint is used instead.
 */
export async function fetchBls(seriesIds, ref, { key = process.env.BLS_API_KEY } = {}) {
  const url = key
    ? "https://api.bls.gov/publicAPI/v2/timeseries/data/"
    : "https://api.bls.gov/publicAPI/v1/timeseries/data/";
  const body = { seriesid: seriesIds, startyear: String(ref.y - 2), endyear: String(ref.y) };
  if (key) body.registrationkey = key;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BLS_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: { "content-type": "application/json", "user-agent": "Mozilla/5.0 (compatible; NewsBot/1.0; personal channel)" },
      body: JSON.stringify(body),
    });
    if (!res.ok) return { ok: false, why: `HTTP ${res.status}` };
    const json = await res.json().catch(() => null);
    if (json?.status !== "REQUEST_SUCCEEDED") {
      return { ok: false, why: String(json?.message?.[0] ?? json?.status ?? "անհայտ պատասխան").slice(0, 160) };
    }
    return { ok: true, series: parseBls(json) };
  } catch (e) {
    return { ok: false, why: e?.name === "AbortError" ? "ժամանակը լրացավ" : String(e?.message ?? e) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Has the channel already posted the official numbers this story restates?
 *
 * On a CPI morning the BLS's own feed item ("Consumer Price Index – August
 * 2026") is a lone primary source, so the news half would post it as a second
 * 🟪🟪🟪, with a sound, minutes after the data post already gave the numbers.
 * Only the BLS's OWN item is suppressed: CoinDesk's "bitcoin jumps after CPI"
 * is reaction, not restatement, and still posts.
 */
export function coveredByRelease(lead, words, now, done = {}, events) {
  if (lead?.source !== "BLS") return null;
  for (const o of allOccurrences(now - 36 * 3_600_000, now, events)) {
    if (!RELEASE_EVENTS.includes(o.event.id) || !done[o.key]) continue;
    const hits = (o.event.keywords ?? []).filter((k) => words.has(k)).length;
    if (hits >= 2) return o;
  }
  return null;
}

export function seriesFor(eventId) {
  return Object.values(SERIES[eventId] ?? {});
}
