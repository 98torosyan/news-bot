// LIQUIDITY. Two posts built from the same idea: how many dollars are in reach
// of the market this week, and did a large block of them just arrive or leave.
//
// 1. THE PULSE — Sunday, 12:00 Yerevan, once a week.
//
//      Stablecoins: USDT and USDC market value now and seven days ago
//      (CoinGecko). A stablecoin is a dollar that has already crossed into
//      crypto, so their total is the market's ready cash.
//
//      Fed net liquidity: the Fed's balance sheet minus the Treasury's account
//      at the Fed (TGA) minus overnight reverse repos — the standard
//      WALCL − WTREGEN − RRPONTSYD, from FRED. The dollars the Fed has created
//      that are actually loose in the financial system.
//
//    THE UNITS ARE READ, NEVER ASSUMED. Public write-ups disagree about them —
//    at least one widely copied dashboard says the TGA series is in billions,
//    while FRED itself says millions — and a wrong guess is an error of a
//    thousand times. So the units come from FRED's own series metadata on
//    every run, and a result outside a plausible range is not published at
//    all. Without a FRED key the post carries the stablecoins only.
//
//    Sunday noon, not 20:00: the weekly overview and the weekly results recap
//    own Sunday evening, and a third post in that minute is noise.
//
// 2. THE ALERT — when USDT or USDC grows or shrinks by a large amount in a day.
//
//    This is the NET 24-hour change in supply (CoinGecko's market-cap change;
//    a stablecoin's price is a dollar, so the change is the supply change).
//    The post says so. It is deliberately not "Tether minted $1B": telling a
//    mint from a treasury transfer on-chain takes knowledge of each issuer's
//    addresses that this file cannot verify, and a wrong mint alert is worse
//    than none. The net change carries the same signal and cannot be misread.
//
// Neither post says what the numbers mean for prices. They are the numbers.

import { esc, band } from "./telegram.js";
import { formatMove } from "./price.js";
import { partsInTz, ymdInTz, addDaysYmd, yerevanDate, CHANNEL_TZ } from "./calendar.js";

export const NET_TIMEOUT_MS = 10_000;

export const STABLES = [
  { id: "tether", symbol: "USDT", threshold: 1e9 },
  { id: "usd-coin", symbol: "USDC", threshold: 5e8 },
];
// Longer than CoinGecko's 24-hour window, on purpose: a mint stays inside the
// rolling 24h change for a full day, so any shorter cooldown would announce
// the SAME mint twice (a 20-hour cooldown did exactly that in simulation).
export const ALERT_COOLDOWN_MS = 26 * 3_600_000;

export const PULSE_HOUR = 12;
export const PULSE_LAST_HOUR = 19;
export const PULSE_SILENT = false;

// ── money formatting ────────────────────────────────────────────────────────

/** $172.4 մլրդ · $5.86 տրլն · $420 մլն — Armenian scale words, like the posts. */
export function money(usd, { sign = false } = {}) {
  const a = Math.abs(usd);
  const [scaled, digits, unit] =
    a >= 1e12 ? [a / 1e12, 2, " տրլն"] : a >= 1e9 ? [a / 1e9, 1, " մլրդ"] : a >= 1e6 ? [a / 1e6, 0, " մլն"] : [a, 0, ""];
  // A CHANGE is written the channel's one way (price.js formatMove):
  // «▲ +$42.0 մլրդ». A level carries no arrow; a negative level a real minus.
  if (sign) return formatMove(Math.sign(usd) * scaled, { digits, prefix: "$", suffix: unit, zero: `$0${unit}` });
  const body = digits || unit ? scaled.toFixed(digits) : Math.round(scaled).toLocaleString("en-US");
  return `${usd < 0 ? "−" : ""}$${body}${unit}`;
}

const pctText = (p) => formatMove(p, { zero: "0.0%" });

// ── network helpers ─────────────────────────────────────────────────────────

async function getJson(url, fetchImpl = fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NET_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { signal: controller.signal, headers: { accept: "application/json" } });
    if (!res.ok) return { ok: false, why: `HTTP ${res.status}` };
    const json = await res.json().catch(() => null);
    return json ? { ok: true, json } : { ok: false, why: "անհայտ պատասխան" };
  } catch (e) {
    return { ok: false, why: e?.name === "AbortError" ? "ժամանակը լրացավ" : String(e?.message ?? e) };
  } finally {
    clearTimeout(timer);
  }
}

// ── stablecoins (CoinGecko) ─────────────────────────────────────────────────

/** Pure: [[ms, cap], …] → { now, weekAgo } — the cap closest to 7 days before the last point. */
export function weekChange(caps) {
  const pts = (caps ?? []).filter((p) => Array.isArray(p) && Number.isFinite(p[1]) && p[1] > 0);
  if (pts.length < 2) return null;
  const last = pts[pts.length - 1];
  const target = last[0] - 7 * 86_400_000;
  let best = pts[0];
  for (const p of pts) if (Math.abs(p[0] - target) < Math.abs(best[0] - target)) best = p;
  if (Math.abs(best[0] - target) > 36 * 3_600_000) return null; // no point near a week ago
  return { now: last[1], weekAgo: best[1] };
}

export async function fetchStableWeek({ fetchImpl = fetch } = {}) {
  const rows = [];
  for (const s of STABLES) {
    const r = await getJson(
      `https://api.coingecko.com/api/v3/coins/${s.id}/market_chart?vs_currency=usd&days=8&interval=daily`, fetchImpl
    );
    const w = r.ok ? weekChange(r.json?.market_caps) : null;
    if (w) rows.push({ symbol: s.symbol, ...w });
  }
  return rows.length ? { ok: true, rows } : { ok: false, rows: [] };
}

// ── Fed net liquidity (FRED) ────────────────────────────────────────────────

export const NET_LIQ_SERIES = { balance: "WALCL", tga: "WTREGEN", rrp: "RRPONTSYD" };

/** Pure: FRED's `units` text → multiplier to dollars, or null if not understood. */
export function unitsToDollars(units) {
  const u = String(units ?? "").toLowerCase();
  if (!u.includes("dollar")) return null;
  if (u.includes("trillion")) return 1e12;
  if (u.includes("billion")) return 1e9;
  if (u.includes("million")) return 1e6;
  if (u.includes("thousand")) return 1e3;
  return null;
}

/** Pure: observations (any order) → [{date, value}] ascending, holidays (".") dropped. */
export function cleanObs(obs) {
  return (obs ?? [])
    .map((o) => ({ date: String(o?.date ?? ""), value: Number(o?.value) }))
    .filter((o) => /^\d{4}-\d{2}-\d{2}$/.test(o.date) && Number.isFinite(o.value) && String(o.value) !== "")
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** The last observation on or before `ymd`. */
const asOf = (series, ymd) => {
  let hit = null;
  for (const o of series) if (o.date <= ymd) hit = o;
  return hit;
};

/**
 * Pure: three series already in DOLLARS → { now, weekAgo, date } or null.
 * Anchored on the balance sheet's latest weekly date; the other two are taken
 * as of that same date, so the three numbers describe the same moment.
 */
export function netLiquidity({ balance, tga, rrp }) {
  const last = balance[balance.length - 1];
  if (!last) return null;
  const weekAgoDate = addDaysYmd(last.date, -7);
  const at = (ymd) => {
    const b = asOf(balance, ymd);
    const t = asOf(tga, ymd);
    const r = asOf(rrp, ymd);
    if (!b || !t || !r) return null;
    // stale components are a wrong number, not an old one
    const age = (o) => (Date.parse(ymd) - Date.parse(o.date)) / 86_400_000;
    if (age(b) > 8 || age(t) > 8 || age(r) > 8) return null;
    return b.value - t.value - r.value;
  };
  const now = at(last.date);
  const weekAgo = at(weekAgoDate);
  if (now == null || weekAgo == null) return null;
  // Sanity: net liquidity has lived between $2T and $8T for as long as the
  // measure has been watched. Outside that, a unit went wrong somewhere.
  if (now < 2e12 || now > 8e12 || weekAgo < 2e12 || weekAgo > 8e12) return null;
  return { now, weekAgo, date: last.date };
}

export async function fetchNetLiquidity(key = process.env.FRED_API_KEY, { fetchImpl = fetch } = {}) {
  if (!key) return { ok: false, why: "FRED_API_KEY չկա" };
  const out = {};
  for (const [name, id] of Object.entries(NET_LIQ_SERIES)) {
    const meta = await getJson(
      `https://api.stlouisfed.org/fred/series?series_id=${id}&api_key=${encodeURIComponent(key)}&file_type=json`, fetchImpl
    );
    const mult = unitsToDollars(meta.ok ? meta.json?.seriess?.[0]?.units : null);
    if (!mult) return { ok: false, why: `${id}-ի միավորը անհայտ է` };
    const obs = await getJson(
      `https://api.stlouisfed.org/fred/series/observations?series_id=${id}&api_key=${encodeURIComponent(key)}` +
        "&file_type=json&sort_order=desc&limit=40", fetchImpl
    );
    if (!obs.ok) return { ok: false, why: `${id}՝ ${obs.why}` };
    out[name] = cleanObs(obs.json?.observations).map((o) => ({ ...o, value: o.value * mult }));
  }
  const nl = netLiquidity(out);
  return nl ? { ok: true, ...nl } : { ok: false, why: "արդյունքը անհավանական է կամ տվյալները հին են" };
}

// ── the pulse post ──────────────────────────────────────────────────────────

/** Sunday, 12:00–19:00 Yerevan, once per week (keyed by that Sunday's date). */
export function pulseDue(now, lastWeek = null) {
  const p = partsInTz(now, CHANNEL_TZ);
  if (p.weekday !== 0) return null;
  const day = ymdInTz(now, CHANNEL_TZ);
  if (day === lastWeek || p.hh < PULSE_HOUR) return null;
  return { week: day, stale: p.hh >= PULSE_LAST_HOUR };
}

// The same abbreviations as morning.js, and no case ending added after them:
// «23 մարտի-ի դրությամբ» is what the old genitive list plus «-ի» produced.
const MON_SHORT = ["հունվ.", "փետր.", "մարտ", "ապր.", "մայիս", "հունիս", "հուլիս", "օգոստ.", "սեպտ.", "հոկտ.", "նոյ.", "դեկտ."];
const shortDate = (ymd) => {
  const [, m, d] = String(ymd).split("-").map(Number);
  return `${d} ${MON_SHORT[m - 1]}`;
};

export function renderPulse({ now, stables, liquidity }) {
  const lines = [`\u{1F4A7} <b>ԻՐԱՑՎԵԼԻՈՒԹՅԱՆ ԻՄՊՈՒԼՍ</b> · ${esc(yerevanDate(now))}`];

  if (stables?.ok && stables.rows.length) {
    lines.push("", "<b>Stablecoin-ներ՝ շաբաթում</b>");
    lines.push(stables.rows.map((r) => `${r.symbol} ${money(r.now)} ${pctText((r.now / r.weekAgo - 1) * 100)}`).join(" · "));
    if (stables.rows.length > 1) {
      const now2 = stables.rows.reduce((s, r) => s + r.now, 0);
      const ago2 = stables.rows.reduce((s, r) => s + r.weekAgo, 0);
      lines.push(`Միասին՝ ${money(now2)} · ${money(now2 - ago2, { sign: true })}`);
    }
  }

  if (liquidity?.ok) {
    lines.push(
      "",
      "<b>Fed-ի զուտ իրացվելիություն</b>",
      `${money(liquidity.now)} · շաբաթում ${money(liquidity.now - liquidity.weekAgo, { sign: true })}`,
      `<i>Fed-ի հաշվեկշիռ − կառավարության հաշիվ (TGA) − reverse repo · տվյալները՝ ${esc(shortDate(liquidity.date))}</i>`
    );
  }

  lines.push("", "<i>Stablecoin-ը արդեն կրիպտո շուկա մտած դոլար է, իրացվելիությունը՝ ֆինանսական համակարգում ազատ դոլարները։</i>");
  lines.push(`<i>CoinGecko${liquidity?.ok ? " · FRED" : ""}</i>`);
  return lines.join("\n");
}

// ── the alert ───────────────────────────────────────────────────────────────

export async function fetchStableDay({ fetchImpl = fetch } = {}) {
  const r = await getJson(
    `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${STABLES.map((s) => s.id).join(",")}`, fetchImpl
  );
  if (!r.ok || !Array.isArray(r.json)) return { ok: false, why: r.why ?? "անհայտ պատասխան", rows: [] };
  const rows = [];
  for (const s of STABLES) {
    const c = r.json.find((x) => x?.id === s.id);
    if (!c) continue;
    rows.push({ ...s, cap: Number(c.market_cap), change: Number(c.market_cap_change_24h), price: Number(c.current_price) });
  }
  return { ok: true, rows };
}

/**
 * Pure: which coins cross their threshold now and are not in cooldown.
 * Guards against data glitches: the coin must be trading at a dollar (so the
 * cap change IS a supply change) and the move must be under 8% of supply (a
 * real day has never moved USDT or USDC by more; a feed hiccup has).
 */
export function dueAlerts(rows, now, last = {}) {
  return rows.filter((r) =>
    Number.isFinite(r.cap) && r.cap > 0 && Number.isFinite(r.change) &&
    r.price >= 0.98 && r.price <= 1.02 &&
    Math.abs(r.change) >= r.threshold && Math.abs(r.change) <= 0.08 * r.cap &&
    now - (last[r.symbol] ?? 0) >= ALERT_COOLDOWN_MS
  );
}

export function renderStableAlert(r) {
  const up = r.change > 0;
  const verb = up ? "աճեց" : "նվազեց";
  return [
    `${band("MEDIUM")} <b>${esc(r.symbol)}-ի շրջանառությունը 24 ժամում ${verb} ${money(Math.abs(r.change))}-ով</b>`,
    "",
    `Ընդհանուրը՝ ${money(r.cap)}`,
    "",
    `<i>Զուտ փոփոխություն՝ թողարկումներ հանած այրումներ · CoinGecko</i>`,
  ].join("\n");
}
