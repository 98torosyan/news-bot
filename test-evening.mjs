// Guards the evening summary: when it goes out, what it says, and — the part
// that can go wrong quietly — how it takes over the ordinary 20:00 warnings
// without losing or duplicating any of them.
//
//   node test-evening.mjs

import { eveningDue, renderEvening, absorbable, EVENING_SILENT } from "./evening.js";
import { EVENTS, IMPACT } from "./events.js";
import { zonedToUtc, CHANNEL_TZ, dueWarnings, groupWarnings, allOccurrences } from "./calendar.js";

let failures = 0;
const pass = (m) => console.log(`  ok   ${m}`);
const fail = (m) => {
  console.log(`  FAIL ${m}`);
  failures++;
};
const check = (cond, m) => (cond ? pass(m) : fail(m));
const at = (y, mo, d, hh, mm = 0) => zonedToUtc(y, mo, d, hh, mm, CHANNEL_TZ);
const MARKET = { ok: true, rows: [{ symbol: "BTC", usd: 67234, change24h: 1.23 }, { symbol: "ETH", usd: 3456.7, change24h: -0.8 }] };

console.log("\n1. When it is due");
{
  // 2026-09-24 is a Thursday, 2026-09-27 a Sunday.
  check(eveningDue(at(2026, 9, 24, 19, 59)) === null, "19:59 — not yet");
  const d = eveningDue(at(2026, 9, 24, 20, 5));
  check(d && d.day === "2026-09-24" && !d.stale, "20:05 — due");
  check(d && d.from === at(2026, 9, 24, 9), "covers the day from 09:00 — the night belongs to the morning brief");
  check(eveningDue(at(2026, 9, 24, 20, 35), "2026-09-24") === null, "once a day");
  check(eveningDue(at(2026, 9, 24, 23, 5))?.stale === true, "23:05 — too late: recorded, not sent");
  check(eveningDue(at(2026, 9, 27, 20, 5)) === null, "never on Sunday (weekly overview and recap own that slot)");
  check(eveningDue(at(2026, 9, 26, 20, 5))?.day === "2026-09-26", "Saturday — yes");
  check(EVENING_SILENT === true, "silent — the day is over");
}

console.log("\n2. Which warnings it takes over");
{
  const row = (impact) => ({ event: { impact, short: impact }, stateKey: impact });
  check(absorbable({ kind: "d1", rows: [row(IMPACT.LOW), row(IMPACT.MEDIUM)] }), "ordinary day-before warnings: yes");
  check(!absorbable({ kind: "d1", rows: [row(IMPACT.HIGH)] }), "a HIGH event keeps its own post");
  check(!absorbable({ kind: "soon", rows: [row(IMPACT.LOW)] }), "a same-day reminder is never absorbed");
  check(!absorbable({ kind: "d1", rows: [{ ...row(IMPACT.LOW), daysBefore: 2 }] }), "a warning for the day AFTER tomorrow is not absorbed — it would appear nowhere");

  // Against the real calendar: every d1 warning due at 20:00 on each evening of
  // a month is either absorbed (and so listed under «Վաղը») or left to post on
  // its own — none falls between the two.
  let absorbedCount = 0;
  let separate = 0;
  for (let d = 1; d <= 30; d++) {
    const now = at(2026, 11, d, 20, 5);
    if (!eveningDue(now)) continue;
    const text = renderEvening({ now, market: MARKET, events: EVENTS }).replace(/\u00a0/g, " ");
    for (const g of groupWarnings(dueWarnings(now, {}, EVENTS)).filter((x) => x.kind === "d1")) {
      if (absorbable(g)) {
        absorbedCount += g.rows.length;
        for (const r of g.rows) if (!text.includes(r.event.name)) fail(`${r.event.short} absorbed on 11-${d} but missing from «Վաղը»`);
      } else separate += g.rows.length;
    }
  }
  pass(`November: ${absorbedCount} ordinary warnings folded into the summary, ${separate} HIGH ones kept separate, none lost`);
}

console.log("\n3. A full evening");
{
  const now = at(2026, 9, 24, 20, 5);
  const posts = [
    { id: 11, headline: "Binance takes $100M stake in Circle", importance: "MEDIUM", at: at(2026, 9, 24, 11) },
    { id: 12, headline: "Fed <hikes> & more", importance: "HIGH", at: at(2026, 9, 24, 14) },
    { id: 13, headline: "Something small", importance: "LOW", at: at(2026, 9, 24, 16) },
    { id: 14, headline: "Another medium", importance: "MEDIUM", at: at(2026, 9, 24, 17) },
  ];
  const outcomes = [{ symbol: "BTC", headline: "Fed hikes rates", pctChange: 3.14, id: 12 }];
  const t = renderEvening({ now, posts, outcomes, market: MARKET, username: "AlphaTerminalNews", events: EVENTS })
    .replace(/\u00a0/g, " ");
  console.log(t.split("\n").map((l) => "       │ " + l).join("\n"));
  check(t.startsWith("\u{1F319} <b>ՕՐՎԱ ԱՄՓՈՓՈՒՄ</b> · հինգշաբթի, 24 սեպտեմբերի"), "header with the date");
  check(t.includes('<code>🟪🟪🟪</code> <a href="https://t.me/AlphaTerminalNews/12">Fed &lt;hikes&gt; &amp; more</a>'), "the day's top story: the HIGH one, linked, escaped");
  check(!t.includes("Binance takes") && !t.includes("Something small"), "not a list of the day — one line");
  check(t.includes("Այսօր ալիքում՝ 4 նորություն (1 կարևոր, 2 միջին)"), "a count instead of a list");
  check(t.includes("BTC +3.1% · <a"), "what the price did after it");
  check(t.includes("BTC $67,234 +1.2% · ETH $3,457 −0.8%"), "the market");
  check(t.includes("<b>Վաղը</b> · ուրբաթ"), "tomorrow, named");
  const fri = allOccurrences(at(2026, 9, 25, 0), at(2026, 9, 26, 0) - 1, EVENTS);
  check(fri.every((o) => t.includes(o.event.name)), `every one of Friday's ${fri.length} events listed`);
}

console.log("\n4. Quiet day, nothing resolved, prices down");
{
  const now = at(2026, 9, 26, 20, 5);
  const t = renderEvening({ now, posts: [], outcomes: [], market: { ok: false, rows: [] }, events: [] });
  check(t.includes("Այսօր կարևոր նորություն չկար։"), "an empty day says so");
  check(!t.includes("Ինչ արեց գինը") && !t.includes("Շուկան"), "empty sections are left out, not shown empty");
  check(t.includes("Նախատեսված տնտեսական իրադարձություն չկա։"), "an empty tomorrow says so");
  const one = renderEvening({ now, posts: [{ id: 1, headline: "Only one", importance: "LOW", at: now }], events: [] })
    .replace(/\u00a0/g, " ");
  check(!one.includes("Only one") && one.includes("Այսօր ալիքում՝ 1 նորություն, կարևոր՝ ոչ մեկը։"), "an ordinary-only day gets a count, not a crowned 🟪⬜⬜");
  // The real evening of 2026-09-24: three 🟪⬜⬜ posts before 20:00.
  const real = renderEvening({ now, events: [], posts: [
    { id: 85, headline: "HIFI-ն ներգրավել է 37 միլիոն դոլար", importance: "LOW", at: now - 3 * 3_600_000 },
    { id: 86, headline: "Zcash-ը հասել է 1,600 դոլարի", importance: "LOW", at: now - 3 * 3_600_000 },
    { id: 87, headline: "IBM-ը գործարկել է Swift-ի կապը", importance: "LOW", at: now - 2 * 3_600_000 },
  ] });
  check(!real.includes("<code>🟪⬜⬜</code>") && real.includes("3 նորություն, կարևոր՝ ոչ մեկը"), "2026-09-24 evening: no «top story» made of an ordinary one");
}

console.log("");
if (failures > 0) {
  console.log(`${failures} FAILURE(S)`);
  process.exit(1);
}
console.log("All checks passed.");
