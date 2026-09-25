// Guards the morning brief: when it is due, and what it says. No network —
// the fetchers are exercised live by the bot; everything they feed is plain
// data here, so every branch of the post can be checked.
//
//   node test-morning.mjs

import { morningDue, renderMorning, biggestMover, parseCbaRates, lastTwo, fetchMacro, MORNING_SILENT } from "./morning.js";
import { EVENTS } from "./events.js";
import { allOccurrences, zonedToUtc, CHANNEL_TZ } from "./calendar.js";
import { rememberRecentPost, recentPostsBetween, prune, RECENT_POSTS_KEEP_MS } from "./state.js";

let failures = 0;
const pass = (m) => console.log(`  ok   ${m}`);
const fail = (m) => {
  console.log(`  FAIL ${m}`);
  failures++;
};
const check = (cond, m) => (cond ? pass(m) : fail(m));

/** A Yerevan wall-clock moment. */
const at = (y, mo, d, hh, mm = 0) => zonedToUtc(y, mo, d, hh, mm, CHANNEL_TZ);

const MARKET = {
  ok: true,
  rows: [
    { symbol: "BTC", usd: 67234, change24h: 1.23 },
    { symbol: "ETH", usd: 3456.7, change24h: -0.8 },
    { symbol: "SOL", usd: 180.5, change24h: 2.1 },
    { symbol: "DOGE", usd: 0.2431, change24h: -7.4 },
  ],
};
const FNG = { ok: true, value: 62, label: "Greed" };

console.log("\n1. When it is due");
{
  check(morningDue(at(2026, 9, 24, 8, 59)) === null, "08:59 — not yet");
  const d = morningDue(at(2026, 9, 24, 9, 0));
  check(d && d.day === "2026-09-24" && !d.stale, "09:00 — due, not stale");
  check(d && d.from === at(2026, 9, 23, 23, 0), "the night starts at 23:00 the evening before");
  check(morningDue(at(2026, 9, 24, 9, 40), "2026-09-24") === null, "already sent today — not again");
  check(morningDue(at(2026, 9, 24, 11, 59))?.stale === false, "11:59 — still sent");
  check(morningDue(at(2026, 9, 24, 12, 0))?.stale === true, "12:00 — recorded, not sent");
  check(morningDue(at(2026, 9, 24, 23, 30), "2026-09-23")?.stale === true, "late evening after an outage — stale");
  check(morningDue(at(2026, 9, 25, 9, 5), "2026-09-24")?.day === "2026-09-25", "the next day is due again");
  check(MORNING_SILENT === false, "it rings — the one post a day meant to");
}

console.log("\n2. A full morning");
{
  const now = at(2026, 9, 24, 9, 10);
  const night = [
    { id: 101, headline: "LOW one", importance: "LOW", at: at(2026, 9, 24, 2) },
    { id: 102, headline: "Medium <story> & co", importance: "MEDIUM", at: at(2026, 9, 24, 1) },
    { id: 103, headline: "The big one", importance: "HIGH", at: at(2026, 9, 24, 4) },
  ];
  const t = renderMorning({ now, market: MARKET, fng: FNG, night, username: "AlphaTerminalNews", events: EVENTS }).replace(/\u00a0/g, " ");
  console.log(t.split("\n").map((l) => "       │ " + l).join("\n"));

  check(t.startsWith("\u2600\uFE0F <b>ԲԱՐԻ ԼՈՒՅՍ</b>"), "opens with the sun, forced to colour");
  check(t.includes("BTC $67,234 +1.2%") && t.includes("ETH $3,457 −0.8%"), "BTC and ETH with 24h change");
  check(t.includes("Ամենաշատը շարժվեց՝ DOGE $0.243 <b>−7.4%</b>"), "biggest mover is by size of move, down counts — and a move that big is bold");
  check(t.includes("Fear &amp; Greed՝ 62 · ագահություն"), "Fear & Greed, escaped, label in Armenian");
  check(t.indexOf("The big one") < t.indexOf("Medium"), "HIGH listed before MEDIUM");
  check(t.includes('href="https://t.me/AlphaTerminalNews/103"'), "headline links to its post");
  check(t.includes("Medium &lt;story&gt; &amp; co"), "headline HTML is escaped");
  check(!t.includes("LOW one") && t.includes("+ 1 սովորական"), "ordinary posts counted, not listed");
  check(!/ԿԱՐԵՎՈՐ|կանխատես|պետք է գնել/.test(t), "no opinion, no forecast words");
}

console.log("\n3. Quiet night, broken sources, no username");
{
  const now = at(2026, 9, 26, 9, 5); // Saturday
  const t = renderMorning({ now, market: { ok: false, rows: [] }, fng: { ok: false }, night: [], username: null, events: [] });
  check(t.includes("Գիշերը հանգիստ էր։"), "empty night says so, fills nothing");
  check(!t.includes("Շուկան"), "no market section when every price source failed");
  check(t.includes("Նախատեսված տնտեսական իրադարձություն չկա։"), "empty calendar says so");

  const t2 = renderMorning({
    now, market: MARKET, fng: FNG, username: null, events: [],
    night: [{ id: 7, headline: "X", importance: "HIGH", at: now - 3_600_000 }],
  });
  check(!t2.includes("<a "), "no username — no links, headline still shown");

  const t3 = renderMorning({
    now, market: MARKET, fng: FNG, username: "u", events: [],
    night: [{ id: 1, headline: "a", importance: "LOW", at: now }, { id: 2, headline: "b", importance: "LOW", at: now }],
  });
  check(t3.includes("2 սովորական նորություն, կարևոր՝ ոչ մեկը։"), "only ordinary posts — counted in a sentence");
}

console.log("\n4. Today's calendar");
{
  // Every day of one week, against the real events file.
  for (let d = 21; d <= 27; d++) {
    const now = at(2026, 9, d, 9, 10);
    const t = renderMorning({ now, market: MARKET, fng: FNG, night: [], events: EVENTS });
    const expect = allOccurrences(at(2026, 9, d, 0), at(2026, 9, d + 1, 0) - 1, EVENTS).length;
    const got = t.split("<b>Այսօր</b>")[1].split("\n").filter((l) => l.includes(" · ")).length;
    if (got !== expect) fail(`2026-09-${d}: expected ${expect} events, got ${got}`);
  }
  pass("every day of a week lists exactly that day's events");
}

console.log("\n5. Mover and length");
{
  check(biggestMover([{ symbol: "BTC", usd: 1, change24h: 50 }]) === null, "BTC/ETH are never the 'other' mover");
  check(biggestMover([]) === null, "no rows, no mover");
  const many = Array.from({ length: 200 }, (_, i) => ({
    id: i, headline: "Շատ երկար վերնագիր ".repeat(10), importance: "HIGH", at: at(2026, 9, 24, 1),
  }));
  const t = renderMorning({ now: at(2026, 9, 24, 9), market: MARKET, fng: FNG, night: many, username: "u", events: EVENTS });
  check(t.length <= 4096, `a huge night still fits one message (${t.length})`);
}

console.log("\n6. The state it reads");
{
  const s = { recentPosts: [] };
  const now = at(2026, 9, 24, 9);
  rememberRecentPost(s, { id: 5, headline: "h", importance: "HIGH", at: now - 3_600_000 });
  rememberRecentPost(s, { id: null, headline: "unknown send", importance: "MEDIUM", at: now - 2 * 3_600_000 });
  rememberRecentPost(s, { id: 6, headline: "old", importance: "HIGH", at: now - RECENT_POSTS_KEEP_MS - 1 });
  check(recentPostsBetween(s, at(2026, 9, 23, 23), now).length === 2, "window picks the night only");
  prune(s, now);
  check(s.recentPosts.length === 2, "prune drops posts older than two days");
  const t = renderMorning({ now, market: MARKET, fng: FNG, night: recentPostsBetween(s, 0, now), username: "u", events: [] }).replace(/\u00a0/g, " ");
  check(t.includes("unknown send") && !t.includes("/null"), "a post with no message id is shown, unlinked");
}

console.log("\n7. Central Bank of Armenia rates");
{
  // The shape api.cba.am documents for ExchangeRatesLatest.
  const rate = (iso, amount, r, d) =>
    `<ExchangeRate><ISO>${iso}</ISO><Amount>${amount}</Amount><Rate>${r}</Rate><Difference>${d}</Difference></ExchangeRate>`;
  const xml = `<?xml version="1.0"?><soap:Envelope><soap:Body><ExchangeRatesLatestResponse xmlns="http://www.cba.am/">
    <ExchangeRatesLatestResult><CurrentDate>2026-09-25T00:00:00</CurrentDate><Rates>
    ${rate("RUB", "1", "4.62", "0.01")}${rate("GBP", "1", "515.3", "1.2")}${rate("USD", "1", "386.40", "-0.35")}
    ${rate("EUR", "1", "452.1", "0")}${rate("JPY", "100", "260.1", "")}${rate("XXX", "1", "garbage", "1")}
    </Rates></ExchangeRatesLatestResult></ExchangeRatesLatestResponse></soap:Body></soap:Envelope>`;

  const rows = parseCbaRates(xml);
  check(rows.map((r) => r.iso).join(",") === "USD,EUR,RUB", "USD, EUR, RUB in that order, others ignored");
  check(rows[0].rate === 386.4 && rows[0].diff === -0.35, "rate and signed difference parsed");
  check(parseCbaRates(xml, ["XXX"]).length === 0, "an unparseable rate is skipped, not guessed");
  check(parseCbaRates(xml, ["JPY"])[0]?.diff === null, "an empty difference is null, not zero");
  check(parseCbaRates("<html>maintenance</html>").length === 0, "a non-SOAP page yields nothing");

  const now = at(2026, 9, 25, 9, 10);
  const t = renderMorning({ now, market: MARKET, fng: FNG, cba: { ok: true, rows }, night: [], events: [] });
  check(t.includes("<b>ՀՀ ԿԲ փոխարժեք</b>\nUSD 386.40 −0.35 · EUR 452.10 · RUB 4.62 +0.01"), "the dram line: two decimals, arrows, no arrow for no change");
  const j = renderMorning({ now, market: MARKET, fng: FNG, cba: { ok: true, rows: parseCbaRates(xml, ["JPY"]) }, events: [] });
  check(j.includes("100 JPY 260.10"), "a rate quoted per 100 says so");
  const none = renderMorning({ now, market: MARKET, fng: FNG, cba: { ok: false, rows: [] }, events: [] });
  check(!none.includes("ԿԲ"), "no rates — no line, no empty header");
}

console.log("\n8. The US close (FRED)");
{
  // FRED returns newest first; "." marks a market holiday.
  const two = lastTwo([
    { date: "2026-09-25", value: "." },
    { date: "2026-09-24", value: "6512.3" },
    { date: "2026-09-23", value: "6486.1" },
  ]);
  check(two?.date === "2026-09-24" && two.value === 6512.3 && two.prev === 6486.1, "a holiday is skipped, not read as zero");
  check(lastTwo([{ date: "2026-09-24", value: "1" }]) === null, "one value is not enough for a change");

  const macro = {
    ok: true,
    rows: [
      { id: "SP500", label: "S&P 500", kind: "pct", date: "2026-09-24", value: 6512.3, prev: 6486.1 },
      { id: "VIXCLS", label: "VIX", kind: "level", date: "2026-09-24", value: 16.2, prev: 17.0 },
      { id: "DGS10", label: "10Y", kind: "bp", date: "2026-09-24", value: 4.21, prev: 4.18 },
    ],
  };
  const now = at(2026, 9, 25, 9, 10);
  const t = renderMorning({ now, market: MARKET, fng: FNG, macro, night: [], events: [] });
  check(t.includes("<b>ԱՄՆ շուկա · փակում 24 սեպտ.</b>"), "the header says WHICH close — never an old number passed off as fresh");
  check(t.includes("S&amp;P 500 6,512 +0.4% · VIX 16.2 −0.8 · 10Y 4.21% +3 բ.կ."), "S&P %, VIX points, 10Y in basis points — every change with its arrow");
  check(t.indexOf("ԱՄՆ շուկա") > t.indexOf("Շուկան՝ 24 ժամում") && t.indexOf("ԱՄՆ շուկա") < t.indexOf("Գիշերը"), "sits after crypto, before the night");
  const none = await fetchMacro("");
  check(!none.ok && !renderMorning({ now, market: MARKET, fng: FNG, macro: none, events: [] }).includes("ԱՄՆ շուկա"), "no FRED key — no section, no network call, no error");
}

console.log("");
if (failures > 0) {
  console.log(`${failures} FAILURE(S)`);
  process.exit(1);
}
console.log("All checks passed.");
