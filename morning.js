// THE MORNING BRIEF. One post a day, the first run at or after 09:00 Yerevan.
//
// WHY 09:00
//
//   It is the moment the quiet hours end (QUIET_UNTIL in calendar.js). Every
//   post that arrived between 23:00 and 09:00 came in without a sound, so a
//   reader waking up has missed them by design. The brief is the catch-up for
//   exactly that window — which is what makes it worth a notification rather
//   than being a greeting with numbers attached.
//
//   GitHub's scheduler runs late (5–30 minutes), so in practice this lands
//   somewhere between 09:05 and 09:40. The post never claims a time.
//
// WHAT IT IS MADE OF — AND WHAT IT IS NOT
//
//   Prices (CoinGecko), the Fear & Greed index (alternative.me), the Central
//   Bank of Armenia's official dram rates (api.cba.am), the channel's
//   own posts from the night, and today's calendar. All of it is data.
//
//   NO AI. The Gemini free quota resets at 11:00 Yerevan, so at 09:00 it is at
//   its most likely to be spent — and an AI line would also be the channel's
//   opinion on the market, which is the one thing it never publishes. Like the
//   calendar, the brief goes out whatever state the summariser is in.
//
//   Every part is optional. A price source that is down removes its line, not
//   the post. The only thing that stops the post is Telegram refusing it.
//
// WHY THE WINDOW CLOSES AT 12:00
//
//   A "good morning" posted at 15:00 after an outage is worse than none. Past
//   noon the day is recorded as handled and the brief is skipped, out loud.

import { esc, fit, noOrphan, band } from "./telegram.js";
import {
  partsInTz, ymdInTz, zonedToUtc, parseYmd, addDaysYmd,
  yerevanClock, yerevanDate, yerevanWeekday, impactMark, allOccurrences,
  QUIET_FROM, QUIET_UNTIL, CHANNEL_TZ,
} from "./calendar.js";
import { COINS, formatUsd, formatMove } from "./price.js";

export const MORNING_HOUR = QUIET_UNTIL; // 09:00 — one source of truth
export const MORNING_LAST_HOUR = 12;     // from 12:00 on, the day is skipped

/** false = it rings. The one post a day that is meant to. Flip to silence it. */
export const MORNING_SILENT = false;

export const NET_TIMEOUT_MS = 8_000;

/** Forced to colour presentation (U+FE0F) — see the emoji notes in telegram.js. */
const SUN = "\u2600\uFE0F";

// ── when ────────────────────────────────────────────────────────────────────

/**
 * Is the brief due now, and for which night?
 *
 * Returns null when it is not the morning window or today's brief is already
 * recorded; otherwise { day, stale, from, to } where `from` is 23:00 the
 * evening before (the start of the quiet hours) and `to` is now.
 */
export function morningDue(now, lastDay = null) {
  const day = ymdInTz(now, CHANNEL_TZ);
  if (day === lastDay) return null;
  const hh = partsInTz(now, CHANNEL_TZ).hh;
  if (hh < MORNING_HOUR) return null;
  const y = parseYmd(addDaysYmd(day, -1));
  const from = zonedToUtc(y.y, y.m, y.d, QUIET_FROM, 0, CHANNEL_TZ);
  return { day, stale: hh >= MORNING_LAST_HOUR, from, to: now };
}

// ── data (network) ──────────────────────────────────────────────────────────

async function getJson(url, timeoutMs = NET_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { accept: "application/json" } });
    if (!res.ok) return { ok: false, why: `HTTP ${res.status}` };
    const json = await res.json().catch(() => null);
    return json ? { ok: true, json } : { ok: false, why: "անհայտ պատասխան" };
  } catch (e) {
    return { ok: false, why: e?.name === "AbortError" ? "ժամանակը լրացավ" : String(e?.message ?? e) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Every coin on the allowlist in ONE call — /simple/price takes a list, so the
 * biggest mover costs nothing extra. Returns [{symbol, usd, change24h}] for the
 * coins that came back, in allowlist order.
 */
export async function fetchMarket(coins = COINS) {
  const ids = coins.map((c) => c.id).join(",");
  const r = await getJson(
    `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(ids)}&vs_currencies=usd&include_24hr_change=true`
  );
  if (!r.ok) return { ok: false, why: r.why, rows: [] };
  const rows = [];
  for (const c of coins) {
    const row = r.json?.[c.id];
    if (!row || typeof row.usd !== "number") continue;
    rows.push({
      symbol: c.symbol,
      usd: row.usd,
      change24h: typeof row.usd_24h_change === "number" ? row.usd_24h_change : null,
    });
  }
  return rows.length ? { ok: true, rows } : { ok: false, why: "գին չկա", rows: [] };
}

/** alternative.me — free, keyless, one number a day. */
export async function fetchFearGreed() {
  const r = await getJson("https://api.alternative.me/fng/?limit=1");
  const d = r.ok ? r.json?.data?.[0] : null;
  const value = Number(d?.value);
  if (!d || !Number.isFinite(value)) return { ok: false, why: r.why ?? "անհայտ պատասխան" };
  return { ok: true, value, label: String(d.value_classification ?? "") };
}

// ── the Central Bank of Armenia's official rates ─────────────────────────────
//
// The CBA's own web service (api.cba.am), not a market quote: this is the
// official rate banks and the tax office reference, which is what an Armenian
// reader actually means by "the rate". SOAP, because that is the only protocol
// the service accepts from outside — a plain POST with an XML body, parsed with
// the same regex approach feeds.js uses, so still nothing to install.
//
// USD, EUR and RUB: the dollar and the euro for obvious reasons, the rouble
// because remittances and trade with Russia make it matter here more than
// almost anywhere else.

export const CBA_ISOS = ["USD", "EUR", "RUB"];

const CBA_URL = "https://api.cba.am/exchangerates.asmx";

function cbaEnvelope() {
  return `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body><ExchangeRatesLatest xmlns="http://www.cba.am/" /></soap:Body>
</soap:Envelope>`;
}

const num = (s) => {
  const n = Number(String(s ?? "").trim().replace(",", "."));
  return Number.isFinite(n) && String(s ?? "").trim() !== "" ? n : null;
};

/**
 * Pure: the ExchangeRatesLatest response → [{iso, amount, rate, diff}] for the
 * ISOs asked for, in that order. Anything unparseable is skipped, never guessed.
 */
export function parseCbaRates(xml, isos = CBA_ISOS) {
  const blocks = String(xml).match(/<ExchangeRate>[\s\S]*?<\/ExchangeRate>/g) ?? [];
  const byIso = new Map();
  for (const b of blocks) {
    const get = (t) => (b.match(new RegExp(`<${t}>([^<]*)</${t}>`)) ?? [])[1];
    const iso = String(get("ISO") ?? "").trim().toUpperCase();
    const rate = num(get("Rate"));
    if (!iso || rate === null || rate <= 0) continue;
    byIso.set(iso, { iso, amount: num(get("Amount")) ?? 1, rate, diff: num(get("Difference")) });
  }
  return isos.map((i) => byIso.get(i)).filter(Boolean);
}

export async function fetchCbaRates({ timeoutMs = NET_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(CBA_URL, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "text/xml; charset=utf-8",
        SOAPAction: '"http://www.cba.am/ExchangeRatesLatest"',
      },
      body: cbaEnvelope(),
    });
    if (!res.ok) return { ok: false, why: `HTTP ${res.status}`, rows: [] };
    const rows = parseCbaRates(await res.text());
    return rows.length ? { ok: true, rows } : { ok: false, why: "փոխարժեք չգտնվեց պատասխանում", rows: [] };
  } catch (e) {
    return { ok: false, why: e?.name === "AbortError" ? "ժամանակը լրացավ" : String(e?.message ?? e), rows: [] };
  } finally {
    clearTimeout(timer);
  }
}

/** "USD 386.40 −0.35" — two decimals, the CBA's own precision. */
function cbaBit(r) {
  const unit = r.amount && r.amount !== 1 ? `${r.amount} ` : "";
  const move = formatMove(r.diff, { digits: 2, suffix: "" });
  const diff = move ? ` ${move}` : "";
  return `${unit}${esc(r.iso)} ${r.rate.toFixed(2)}${diff}`;
}

// ── the US market close, from FRED ──────────────────────────────────────────
//
// What a professional looks at before crypto in the morning: the S&P 500, the
// VIX and the 10-year Treasury yield. FRED (the St. Louis Fed) publishes all
// three as official daily series, free — but only with a key, so this whole
// section exists only when the FRED_API_KEY secret is set.
//
// FRED posts a trading day's close during the following US morning, which can
// be after 09:00 in Yerevan. So the line always prints the DATE of the close it
// shows: yesterday's close labelled as yesterday's, or the day before labelled
// as that — never an old number passed off as fresh.
//
// Gold is deliberately absent: FRED no longer carries a gold price, and a
// token standing in for it would be a proxy dressed as the thing.

export const FRED_SERIES = [
  { id: "SP500", label: "S&P 500", kind: "pct" },
  { id: "VIXCLS", label: "VIX", kind: "level" },
  { id: "DGS10", label: "10Y", kind: "bp" },
];

/** FRED observations (newest first) → the latest two numeric values. */
export function lastTwo(observations) {
  const vals = [];
  for (const o of observations ?? []) {
    const v = Number(o?.value);
    if (o?.value === "." || !Number.isFinite(v)) continue; // "." = market holiday
    vals.push({ date: String(o.date), value: v });
    if (vals.length === 2) break;
  }
  return vals.length === 2 ? { date: vals[0].date, value: vals[0].value, prev: vals[1].value } : null;
}

export async function fetchMacro(key = process.env.FRED_API_KEY) {
  if (!key) return { ok: false, why: "FRED_API_KEY չկա", rows: [] };
  const rows = [];
  let why = null;
  for (const s of FRED_SERIES) {
    const r = await getJson(
      `https://api.stlouisfed.org/fred/series/observations?series_id=${s.id}&api_key=${encodeURIComponent(key)}` +
        "&file_type=json&sort_order=desc&limit=10"
    );
    const two = r.ok ? lastTwo(r.json?.observations) : null;
    if (two) rows.push({ ...s, ...two });
    else why = r.why ?? "տվյալ չկա";
  }
  return rows.length ? { ok: true, rows } : { ok: false, why, rows: [] };
}

function macroBit(r) {
  const d = r.value - r.prev;
  if (r.kind === "pct") {
    const move = pct((d / r.prev) * 100);
    return `${esc(r.label)} ${r.value.toLocaleString("en-US", { maximumFractionDigits: 0 })}${move ? ` ${move}` : ""}`;
  }
  if (r.kind === "bp") {
    const bp = Math.round(d * 100);
    const move = formatMove(bp, { digits: 0, suffix: " բ.կ." });
    return `${esc(r.label)} ${r.value.toFixed(2)}%${move ? ` ${move}` : ""}`;
  }
  const move = formatMove(d, { suffix: "" });
  return `${esc(r.label)} ${r.value.toFixed(1)}${move ? ` ${move}` : ""}`;
}

/** "2026-09-24" → "24 սեպտ." — the date of the close, short. */
const MON_SHORT = ["հունվ.", "փետր.", "մարտ", "ապր.", "մայիս", "հունիս", "հուլիս", "օգոստ.", "սեպտ.", "հոկտ.", "նոյ.", "դեկտ."];
function closeDate(ymd) {
  const [, m, d] = String(ymd).split("-").map(Number);
  return m && d ? `${d} ${MON_SHORT[m - 1]}` : "";
}

/**
 * The channel's CURRENT public @username, asked for on every brief rather than
 * written into the code — the channel has been renamed before, and a stored
 * t.me link is exactly the thing a rename breaks. No username → no links, and
 * the headlines are listed as plain text.
 */
export async function fetchChannelUsername(token, chatId) {
  if (!token || !chatId) return null;
  const r = await getJson(`https://api.telegram.org/bot${token}/getChat?chat_id=${encodeURIComponent(chatId)}`);
  const u = r.ok && r.json?.ok ? r.json.result?.username : null;
  return u ? String(u) : null;
}

// ── render (pure) ───────────────────────────────────────────────────────────

const FNG_HY = {
  "extreme fear": "ծայրահեղ վախ",
  fear: "վախ",
  neutral: "չեզոք",
  greed: "ագահություն",
  "extreme greed": "ծայրահեղ ագահություն",
};

/**
 * A move as the reader sees it, or null when it rounds to nothing: «▼0.0%»
 * appeared on 2026-09-25 for a −0.04% day, an arrow pointing at no move.
 * Rounded FIRST, so the arrow can never disagree with the number.
 */
export function pct(n) {
  const text = formatMove(n);
  if (!text) return null;
  const r = Math.round(n * 10) / 10;
  // A BIG MOVE IS BOLD. Telegram cannot colour text, and the channel keeps one
  // hue (🟪) so that colour never has to carry meaning. So instead of a green
  // or red arrow, a move of BIG_MOVE_PCT or more is set in bold: small moves
  // stay quiet, the one that matters stands out, and it reads the same in any
  // theme and for a reader who cannot tell red from green.
  return Math.abs(r) >= BIG_MOVE_PCT ? `<b>${text}</b>` : text;
}

/** From this size a 24-hour move is set in bold (see pct). */
export const BIG_MOVE_PCT = 2;

export function priceBit(row) {
  const move = typeof row.change24h === "number" ? pct(row.change24h) : null;
  const change = move ? ` ${move}` : "";
  return `${esc(row.symbol)} ${esc(formatUsd(row.usd))}${change}`;
}

/** The biggest 24h move among the coins NOT already on the BTC/ETH line. */
export function biggestMover(rows) {
  const others = rows.filter((r) => r.symbol !== "BTC" && r.symbol !== "ETH" && typeof r.change24h === "number");
  if (others.length === 0) return null;
  return others.reduce((a, b) => (Math.abs(b.change24h) > Math.abs(a.change24h) ? b : a));
}

const RANK = { HIGH: 0, MEDIUM: 1, LOW: 2 };

/**
 * The whole post, from plain data — no network, no clock of its own, so every
 * branch is testable.
 *
 *   now       the moment of the run (dates and "today" are taken from it)
 *   market    fetchMarket() result
 *   fng       fetchFearGreed() result
 *   cba       fetchCbaRates() result
 *   macro     fetchMacro() result
 *   night     [{id, headline, importance, at}] posted in the night window
 *   username  channel @username without the @, or null
 *   events    the calendar (EVENTS)
 */
export function renderMorning({ now, market, fng, cba = null, macro = null, night = [], username = null, events }) {
  const lines = [
    `${SUN} <b>ԲԱՐԻ ԼՈՒՅՍ</b> · ${esc(yerevanWeekday(now))}, ${esc(yerevanDate(now))}`,
  ];

  // --- the market -----------------------------------------------------------
  const rows = market?.ok ? market.rows : [];
  const main = rows.filter((r) => r.symbol === "BTC" || r.symbol === "ETH");
  const mover = biggestMover(rows);
  const fngOk = fng?.ok === true;
  if (main.length || mover || fngOk) {
    lines.push("", "<b>Շուկան՝ 24 ժամում</b>");
    if (main.length) lines.push(main.map(priceBit).join(" · "));
    if (mover) lines.push(`Ամենաշատը շարժվեց՝ ${priceBit(mover)}`);
    if (fngOk) {
      const word = FNG_HY[fng.label.toLowerCase()] ?? fng.label;
      lines.push(`Fear &amp; Greed՝ ${fng.value}${word ? ` · ${esc(word)}` : ""}`);
    }
  }

  // --- the US close ---------------------------------------------------------
  if (macro?.ok && macro.rows.length) {
    const when = closeDate(macro.rows[0].date);
    lines.push("", `<b>ԱՄՆ շուկա${when ? ` · փակում ${esc(when)}` : ""}</b>`, macro.rows.map(macroBit).join(" · "));
  }

  // --- the dram -------------------------------------------------------------
  // Its own line and its own label: an official daily rate is a different kind
  // of number from a 24-hour crypto move, and the header above names the latter.
  if (cba?.ok && cba.rows.length) {
    lines.push("", `<b>ՀՀ ԿԲ փոխարժեք</b>`, cba.rows.map(cbaBit).join(" · "));
  }

  // --- the night ------------------------------------------------------------
  //
  // Marked stories are listed, strongest first; ordinary ones are only counted.
  // A brief that lists everything is just the channel scrolled backwards.
  const shown = night
    .filter((p) => p.importance === "HIGH" || p.importance === "MEDIUM")
    .sort((a, b) => RANK[a.importance] - RANK[b.importance] || a.at - b.at);
  const ordinary = night.length - shown.length;

  lines.push("", "<b>Գիշերը ալիքում</b>");
  if (night.length === 0) {
    lines.push("Գիշերը հանգիստ էր։");
  } else {
    for (const p of shown) {
      const title = noOrphan(esc(p.headline));
      const linked = username && p.id ? `<a href="https://t.me/${esc(username)}/${Number(p.id)}">${title}</a>` : title;
      lines.push(`${band(p.importance)} ${linked}`);
    }
    if (ordinary > 0) {
      lines.push(shown.length ? `<i>+ ${ordinary} սովորական</i>` : `${ordinary} սովորական նորություն, կարևոր՝ ոչ մեկը։`);
    }
  }

  // --- today ----------------------------------------------------------------
  const day = ymdInTz(now, CHANNEL_TZ);
  const { y, m, d } = parseYmd(day);
  const dayStart = zonedToUtc(y, m, d, 0, 0, CHANNEL_TZ);
  const next = parseYmd(addDaysYmd(day, 1));
  const dayEnd = zonedToUtc(next.y, next.m, next.d, 0, 0, CHANNEL_TZ) - 1;
  const today = allOccurrences(dayStart, dayEnd, events);

  lines.push("", "<b>Այսօր</b>");
  if (today.length === 0) {
    lines.push("Նախատեսված տնտեսական իրադարձություն չկա։");
  } else {
    for (const o of today) {
      const gone = o.ts < now ? " <i>(արդեն եղավ)</i>" : "";
      lines.push(`${impactMark(o.event.impact)} ${esc(yerevanClock(o.ts))} · ${noOrphan(esc(o.event.name))}${gone}`);
    }
  }

  return fit(lines);
}
