// Guards the CPI/NFP data posts: which month, which series, which arithmetic,
// and what the post says. No network — BLS responses are built in the shape
// the BLS API returns.
//
//   node test-release.mjs

import {
  referenceMonth, parseBls, computeRelease, renderRelease, dueReleases, SERIES, POLL_WINDOW_MS, seriesFor, coveredByRelease,
} from "./release.js";
import { EVENTS } from "./events.js";
import { zonedToUtc } from "./calendar.js";

let failures = 0;
const pass = (m) => console.log(`  ok   ${m}`);
const fail = (m) => {
  console.log(`  FAIL ${m}`);
  failures++;
};
const check = (cond, m) => (cond ? pass(m) : fail(m));

/** A BLS API response. rows: { seriesId: { "2026-08": value, ... } } */
function blsJson(rows) {
  return {
    status: "REQUEST_SUCCEEDED",
    Results: {
      series: Object.entries(rows).map(([seriesID, byMonth]) => ({
        seriesID,
        data: Object.entries(byMonth).map(([ym, v]) => ({
          year: ym.slice(0, 4), period: `M${ym.slice(5)}`, value: String(v), footnotes: [{}],
        })),
      })),
    },
  };
}
const cpiEvent = EVENTS.find((e) => e.id === "cpi");
const nfpEvent = EVENTS.find((e) => e.id === "nfp");

console.log("\n1. Which month a release is about");
{
  const oct14 = zonedToUtc(2026, 10, 14, 8, 30, "America/New_York");
  const r = referenceMonth(oct14);
  check(r.y === 2026 && r.m === 9, "CPI on October 14 reports September");
  const jan = referenceMonth(zonedToUtc(2027, 1, 8, 8, 30, "America/New_York"));
  check(jan.y === 2026 && jan.m === 12, "January's release reports December of the previous year");
}

console.log("\n2. Parsing");
{
  const json = blsJson({ X: { "2026-08": "1,234.5", "2026-07": "-", "2026-13": 9 } });
  json.Results.series[0].data.push({ year: "2026", period: "M13", value: "5" });
  const m = parseBls(json).get("X");
  check(m.get("2026-08") === 1234.5, "thousands separators handled");
  check(!m.has("2026-07"), "a missing value ('-') is absent, not zero");
  check(![...m.keys()].some((k) => k.endsWith("-13")), "the annual average (M13) is ignored");
}

console.log("\n3. CPI arithmetic — the BLS's own convention");
{
  const S = SERIES.cpi;
  // Seasonally adjusted drives the monthly change, NSA the yearly one, and the
  // two are deliberately different here so a mix-up cannot pass.
  const series = parseBls(blsJson({
    [S.headSA]: { "2026-06": 320.0, "2026-07": 320.64, "2026-08": 321.603 },
    [S.headNSA]: {
      "2025-07": 310.0, "2025-08": 311.0, "2026-07": 318.37, "2026-08": 320.018,
    },
    [S.coreSA]: { "2026-06": 330.0, "2026-07": 330.99, "2026-08": 331.983 },
    [S.coreNSA]: { "2025-07": 320.0, "2025-08": 321.0, "2026-07": 330.08, "2026-08": 330.951 },
  }));
  const r = computeRelease("cpi", series, { y: 2026, m: 8 });
  check(r.headMoM === 0.3, `monthly from SA: 321.603/320.64 → +0.3% (${r.headMoM})`);
  check(r.headMoMPrev === 0.2, `previous monthly: 320.64/320.0 → +0.2% (${r.headMoMPrev})`);
  check(r.headYoY === 2.9, `yearly from NSA: 320.018/311.0 → 2.9% (${r.headYoY})`);
  check(r.headYoYPrev === 2.7, `previous yearly: 318.37/310.0 → 2.7% (${r.headYoYPrev})`);
  check(r.coreYoY === 3.1 && r.coreMoM === 0.3, `core: 3.1% y/y, +0.3% m/m (${r.coreYoY}, ${r.coreMoM})`);

  // A real print, from the published NSA index: August 2024 314.796 over
  // August 2023 307.026 — the BLS headline that month was 2.5%.
  const real = parseBls(blsJson({ [S.headSA]: { "2024-08": 1 }, [S.headNSA]: { "2023-08": 307.026, "2024-08": 314.796 } }));
  check(computeRelease("cpi", real, { y: 2024, m: 8 }).headYoY === 2.5, "reproduces a real BLS headline (Aug 2024, 2.5%)");

  const stale = parseBls(blsJson({ [S.headSA]: { "2026-07": 320.64 }, [S.headNSA]: { "2026-07": 318.37 } }));
  check(computeRelease("cpi", stale, { y: 2026, m: 8 }) === null, "API still on July — null, try again next run");
}

console.log("\n4. Payrolls arithmetic");
{
  const S = SERIES.nfp;
  const series = parseBls(blsJson({
    [S.payrolls]: { "2026-06": 159000, "2026-07": 159089, "2026-08": 159231 },
    [S.unemployment]: { "2026-07": 4.2, "2026-08": 4.3 },
    [S.wages]: { "2025-08": 35.0, "2026-07": 36.30, "2026-08": 36.41 },
  }));
  const r = computeRelease("nfp", series, { y: 2026, m: 8 });
  check(r.payrolls === 142 && r.payrollsPrev === 89, `+142K, previous +89K from the same (revised) response (${r.payrolls}, ${r.payrollsPrev})`);
  check(r.unemployment === 4.3 && r.unemploymentPrev === 4.2, "unemployment 4.3%, previous 4.2%");
  check(r.wagesMoM === 0.3 && r.wagesYoY === 4.0, `wages +0.3% m/m, 4.0% y/y (${r.wagesMoM}, ${r.wagesYoY})`);
  const neg = computeRelease("nfp", parseBls(blsJson({
    [S.payrolls]: { "2026-07": 159100, "2026-08": 159067 }, [S.unemployment]: { "2026-08": 4.4 },
  })), { y: 2026, m: 8 });
  check(neg.payrolls === -33 && neg.payrollsPrev === null, "a job loss is negative; a missing month is null, not zero");
}

console.log("\n5. The posts");
{
  const cpi = renderRelease({
    kind: "cpi", ref: { y: 2026, m: 8 }, headYoY: 2.9, headYoYPrev: 2.7, headMoM: 0.3, headMoMPrev: 0.2,
    coreYoY: 3.1, coreYoYPrev: 3.1, coreMoM: 0.3, coreMoMPrev: 0.2,
  }, cpiEvent);
  console.log(cpi.split("\n").map((l) => "       │ " + l).join("\n"));
  check(cpi.startsWith("<code>🟪🟪🟪</code> <b>ԱՄՆ գնաճ (CPI) · օգոստոս</b>"), "headline: mark, event name, month in the nominative");
  check(cpi.includes("Տարեկան՝ <b>2.9%</b> <i>(նախորդ՝ 2.7%)</i>"), "yearly with previous");
  check(cpi.includes("Ամսական՝ <b>+0.3%</b>"), "a monthly change carries the channel's arrow");
  check(cpi.includes('href="https://www.bls.gov/news.release/cpi.nr0.htm"'), "links the BLS release itself");
  check(cpi.includes("համեմատությունը՝ նախորդ ամսվա հետ"), "says what it compares against — not a forecast");

  const nfp = renderRelease({
    kind: "nfp", ref: { y: 2026, m: 8 }, payrolls: -33, payrollsPrev: 89,
    unemployment: 4.4, unemploymentPrev: 4.3, wagesMoM: 0.2, wagesYoY: 3.9,
  }, nfpEvent);
  console.log(nfp.split("\n").map((l) => "       │ " + l).join("\n"));
  check(nfp.includes("Նոր աշխատատեղեր՝ <b>−33K</b>"), "a job loss is ▼");
  check(nfp.includes("+89K, վերանայված"), "the previous month is labelled revised");
  check(!/կանխատես|սպասվ|consensus/i.test(cpi + nfp), "no forecast, no 'expected'");
  check(cpi.length < 1000 && nfp.length < 1000, "short — well inside one message");
}

console.log("\n6. When a release is due");
{
  // A synthetic calendar, not events.js: the real file's dates are replaced
  // every year, and a test pinned to one of them would start failing — and,
  // since the workflow runs the tests first, stop the bot — the day they go.
  const EV = [
    { ...cpiEvent, recur: { kind: "fixed", dates: ["2031-03-12"] } },
    { ...EVENTS.find((e) => e.id === "fomc"), recur: { kind: "fixed", dates: ["2031-03-12"] } },
  ];
  const cpiTs = zonedToUtc(2031, 3, 12, 8, 30, "America/New_York");
  check(dueReleases(cpiTs - 60_000, {}, EV).length === 0, "a minute before: nothing");
  const d = dueReleases(cpiTs + 10 * 60_000, {}, EV);
  check(d.length === 1 && d[0].event.id === "cpi" && !d[0].expired, "ten minutes after: CPI due (FOMC the same day is not a data release)");
  check(dueReleases(cpiTs + 10 * 60_000, { [d[0].key]: 1 }, EV).length === 0, "recorded — never again");
  const late = dueReleases(cpiTs + POLL_WINDOW_MS + 60_000, {}, EV);
  check(late.length === 1 && late[0].expired, "past the window: due, but as expired (recorded and dropped)");
  check(dueReleases(cpiTs + 3 * 86_400_000, {}, EV).length === 0, "days later: forgotten entirely");
  check(seriesFor("cpi").length === 4 && seriesFor("nfp").length === 3, "one request carries every series a release needs");
}

console.log("\n7. No second 🟪🟪🟪 for the same numbers");
{
  const EV = [{ ...cpiEvent, recur: { kind: "fixed", dates: ["2031-03-12"] } }];
  const ts = zonedToUtc(2031, 3, 12, 8, 30, "America/New_York");
  const done = { [dueReleases(ts + 60_000, {}, EV)[0].key]: ts + 60_000 };
  const words = new Set(["consumer", "price", "index", "august"]);
  check(coveredByRelease({ source: "BLS" }, words, ts + 3_600_000, done, EV)?.event.id === "cpi", "the BLS's own CPI item is suppressed once the numbers are out");
  check(coveredByRelease({ source: "CoinDesk" }, words, ts + 3_600_000, done, EV) === null, "a newsroom's reaction story still posts");
  check(coveredByRelease({ source: "BLS" }, words, ts + 3_600_000, {}, EV) === null, "if the data post never went out, the BLS item posts as before");
  check(coveredByRelease({ source: "BLS" }, new Set(["productivity", "costs"]), ts + 3_600_000, done, EV) === null, "another BLS release the same day is unaffected");
}

console.log("");
if (failures > 0) {
  console.log(`${failures} FAILURE(S)`);
  process.exit(1);
}
console.log("All checks passed.");
