// Guards liquidity.js: the Sunday pulse and the stablecoin alert. The part
// that matters most is §3 — a units mistake must produce NO post, never a
// number a thousand times off.
//
//   node test-liquidity.mjs

import {
  money, weekChange, unitsToDollars, cleanObs, netLiquidity, fetchNetLiquidity, fetchStableWeek,
  pulseDue, renderPulse, dueAlerts, renderStableAlert, STABLES, ALERT_COOLDOWN_MS, PULSE_SILENT,
} from "./liquidity.js";
import { zonedToUtc, CHANNEL_TZ } from "./calendar.js";

let failures = 0;
const pass = (m) => console.log(`  ok   ${m}`);
const fail = (m) => {
  console.log(`  FAIL ${m}`);
  failures++;
};
const check = (cond, m) => (cond ? pass(m) : fail(m));
const at = (y, mo, d, hh, mm = 0) => zonedToUtc(y, mo, d, hh, mm, CHANNEL_TZ);
const J = (o) => new Response(JSON.stringify(o), { headers: { "content-type": "application/json" } });

console.log("\n1. Money");
{
  check(money(172.43e9) === "$172.4 մլրդ", "billions");
  check(money(5.864e12) === "$5.86 տրլն", "trillions");
  check(money(420e6) === "$420 մլն", "millions");
  check(money(2.1e9, { sign: true }) === "+$2.1 մլրդ" && money(-69e9, { sign: true }) === "−$69.0 մլրդ", "a change carries the channel's arrow");
  check(money(-69e9) === "−$69.0 մլրդ", "a negative level keeps a real minus");
}

console.log("\n2. Stablecoins over a week");
{
  const d = 86_400_000;
  const caps = Array.from({ length: 9 }, (_, i) => [i * d, 170e9 + i * 0.3e9]);
  const w = weekChange(caps);
  check(w && w.now === caps[8][1] && w.weekAgo === caps[1][1], "now vs the point seven days earlier");
  check(weekChange([[0, 1], [2 * d, 2]]) === null, "no point near a week ago → nothing, not a wrong change");

  const fake = async (url) => J({ market_caps: caps });
  const r = await fetchStableWeek({ fetchImpl: fake });
  check(r.ok && r.rows.map((x) => x.symbol).join() === STABLES.map((s) => s.symbol).join(), "USDT and USDC");
}

console.log("\n3. Fed net liquidity — units are read, never assumed");
{
  check(unitsToDollars("Millions of U.S. Dollars") === 1e6 && unitsToDollars("Billions of U.S. Dollars") === 1e9, "units text → multiplier");
  check(unitsToDollars("Percent") === null && unitsToDollars("") === null, "anything else → refused");
  check(cleanObs([{ date: "2026-09-16", value: "." }, { date: "2026-09-09", value: "5" }]).length === 1, "a holiday (\".\") is dropped");

  // Realistic levels: balance sheet $6.60T, TGA $780B, RRP $20B → net $5.80T
  const weeks = ["2026-09-02", "2026-09-09", "2026-09-16"];
  const obs = {
    WALCL: weeks.map((d, i) => ({ date: d, value: String(6_600_000 - (2 - i) * 5_000) })),   // millions
    WTREGEN: weeks.map((d, i) => ({ date: d, value: String(780_000 + (2 - i) * 10_000) })),  // millions
    RRPONTSYD: ["2026-09-08", "2026-09-09", "2026-09-15", "2026-09-16"].map((d) => ({ date: d, value: "20" })), // billions
  };
  const UNITS = { WALCL: "Millions of U.S. Dollars", WTREGEN: "Millions of U.S. Dollars", RRPONTSYD: "Billions of U.S. Dollars" };
  const fred = (units) => async (url) => {
    const id = /series_id=(\w+)/.exec(url)[1];
    return url.includes("/observations") ? J({ observations: [...obs[id]].reverse() }) : J({ seriess: [{ units: units[id] }] });
  };
  const r = await fetchNetLiquidity("k", { fetchImpl: fred(UNITS) });
  check(r.ok && Math.round(r.now / 1e9) === 5800, `units from FRED's metadata → $5.80T (${r.ok ? money(r.now) : r.why})`);
  check(r.ok && Math.round((r.now - r.weekAgo) / 1e9) === 15, `week-on-week +$15B (${r.ok ? money(r.now - r.weekAgo, { sign: true }) : ""})`);
  check(r.ok && r.date === "2026-09-16", "anchored on the balance sheet's latest week");

  // The trap a popular dashboard documents: TGA "in billions". If FRED ever
  // said so, or the code assumed it, the TGA would be a thousand times too big.
  const wrong = await fetchNetLiquidity("k", { fetchImpl: fred({ ...UNITS, WTREGEN: "Billions of U.S. Dollars" }) });
  check(!wrong.ok, `a units mistake → NO number (${wrong.why ?? "posted!"})`);
  const unknown = await fetchNetLiquidity("k", { fetchImpl: fred({ ...UNITS, RRPONTSYD: "Index 2017=100" }) });
  check(!unknown.ok && /միավոր/.test(unknown.why), "units it does not understand → refused, with a reason");
  check(!(await fetchNetLiquidity("")).ok, "no key → skipped quietly");

  const stale = netLiquidity({
    balance: [{ date: "2026-09-09", value: 6.6e12 }, { date: "2026-09-16", value: 6.6e12 }],
    tga: [{ date: "2026-08-01", value: 0.78e12 }],
    rrp: [{ date: "2026-09-16", value: 0.02e12 }],
  });
  check(stale === null, "a component weeks out of date → no number");
}

console.log("\n4. When the pulse goes out");
{
  // 2026-09-27 is a Sunday.
  check(pulseDue(at(2026, 9, 27, 11, 59)) === null, "Sunday 11:59 — not yet");
  check(pulseDue(at(2026, 9, 27, 12, 5))?.week === "2026-09-27", "Sunday 12:05 — due");
  check(pulseDue(at(2026, 9, 27, 12, 35), "2026-09-27") === null, "once a week");
  check(pulseDue(at(2026, 9, 27, 19, 5))?.stale === true, "19:05 — too close to the evening posts: skipped");
  check(pulseDue(at(2026, 9, 26, 12, 5)) === null, "Saturday — no");
  check(PULSE_SILENT === false, "rings — once a week");
}

console.log("\n5. The pulse post");
{
  const now = at(2026, 9, 27, 12, 5);
  const stables = { ok: true, rows: [{ symbol: "USDT", now: 172.4e9, weekAgo: 170.5e9 }, { symbol: "USDC", now: 61.2e9, weekAgo: 61.4e9 }] };
  const liquidity = { ok: true, now: 5.864e12, weekAgo: 5.822e12, date: "2026-09-23" };
  const t = renderPulse({ now, stables, liquidity });
  console.log(t.split("\n").map((l) => "       │ " + l).join("\n"));
  check(t.includes("USDT $172.4 մլրդ +1.1% · USDC $61.2 մլրդ −0.3%"), "each coin with its weekly change");
  check(t.includes("Միասին՝ $233.6 մլրդ · +$1.7 մլրդ"), "the total and its change");
  check(t.includes("$5.86 տրլն · շաբաթում +$42.0 մլրդ"), "net liquidity and its change");
  check(t.includes("տվյալները՝ 23 սեպտ."), "says which week the Fed data describes");
  const march = renderPulse({ now, stables, liquidity: { ...liquidity, date: "2027-03-17" } });
  check(march.includes("տվյալները՝ 17 մարտ") && !/մարտի-ի|-ի դրությամբ/.test(march), "no double case ending («մարտի-ի»)");
  check(!/կաճի|կընկնի|կանխատես|bullish|bearish/i.test(t), "no forecast");
  const only = renderPulse({ now, stables, liquidity: { ok: false } });
  check(!only.includes("Fed") && !only.includes("FRED"), "without FRED: stablecoins only, no empty Fed section");
}

console.log("\n6. The stablecoin alert");
{
  const now = Date.UTC(2026, 9, 1, 12);
  const row = (symbol, change, extra = {}) => ({ ...STABLES.find((s) => s.symbol === symbol), cap: 172e9, change, price: 1.0, ...extra });
  check(dueAlerts([row("USDT", 1.2e9)], now).length === 1, "USDT +$1.2B → alert");
  check(dueAlerts([row("USDT", 0.9e9)], now).length === 0, "USDT +$0.9B → below threshold");
  check(dueAlerts([row("USDC", -0.6e9, { cap: 61e9 })], now).length === 1, "USDC −$0.6B → alert (a shrink counts)");
  check(dueAlerts([row("USDT", 1.2e9)], now, { USDT: now - 3_600_000 }).length === 0, "an hour after the last one → cooldown");
  check(dueAlerts([row("USDT", 1.2e9)], now, { USDT: now - ALERT_COOLDOWN_MS }).length === 1, "after the cooldown → again");
  check(ALERT_COOLDOWN_MS > 24 * 3_600_000, "the cooldown outlasts the 24h window — one mint is never announced twice");
  check(dueAlerts([row("USDT", 1.2e9)], now, { USDT: now - 23.5 * 3_600_000 }).length === 0, "23.5h later, same mint still in the window → silent");
  check(dueAlerts([row("USDT", 30e9)], now).length === 0, "a 17% jump in a day is a data glitch, not news");
  check(dueAlerts([row("USDT", 1.2e9, { price: 0.93 })], now).length === 0, "off its peg → the cap change is not a supply change");

  const t = renderStableAlert(row("USDT", 1.23e9));
  console.log(t.split("\n").map((l) => "       │ " + l).join("\n"));
  check(t.startsWith("<code>🟪🟪⬜</code> <b>USDT-ի շրջանառությունը 24 ժամում աճեց $1.2 մլրդ-ով</b>"), "headline with the medium mark");
  check(t.includes("Զուտ փոփոխություն") && !/թողարկեց|minted/i.test(t), "says NET change — never claims a mint");
  const down = renderStableAlert(row("USDC", -0.62e9, { cap: 60.5e9 }));
  check(down.includes("նվազեց $620 մլն-ով") && down.includes("$60.5 մլրդ"), "a decrease reads as one");
}

console.log("");
if (failures > 0) {
  console.log(`${failures} FAILURE(S)`);
  process.exit(1);
}
console.log("All checks passed.");
