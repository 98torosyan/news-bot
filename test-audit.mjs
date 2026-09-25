// Guards every fix from the 2026-09-24 whole-project audit, each one a thing
// seen in the channel or found by reading the code line by line.
//
//   node test-audit.mjs

import { polishArmenian, parseSummary, ask, TERMS } from "./ai.js";
import { withGloss, relatedNote, sendMessage, noOrphan } from "./telegram.js";
import { formatPriceLine, formatMove } from "./price.js";
import { scoreCluster } from "./rank.js";
import { priceBit, renderMorning } from "./morning.js";
import { renderWeeklyOutcomes, renderOutcomeReply } from "./outcomepost.js";
import { renderExpiry } from "./calpost.js";
import { EVENTS } from "./events.js";
import { readFileSync } from "fs";

let failures = 0;
const pass = (m) => console.log(`  ok   ${m}`);
const fail = (m) => {
  console.log(`  FAIL ${m}`);
  failures++;
};
const check = (cond, m) => (cond ? pass(m) : fail(m));

console.log("\n1. Armenian full stop (every post of 2026-09-24 had «:»)");
{
  const real = "NYSE-ը և Blockchain.com-ը միավորում են ջանքերը: Այս քայլը տեղավորվում է միտումների շրջանակում:";
  check(polishArmenian(real) === "NYSE-ը և Blockchain.com-ը միավորում են ջանքերը։ Այս քայլը տեղավորվում է միտումների շրջանակում։", "«:» closing a sentence → «։»");
  check(polishArmenian("ներգրավվել են այլ ընկերություններից.") === "ներգրավվել են այլ ընկերություններից։", "«.» closing a sentence → «։»");
  check(polishArmenian("16:30-ին, $1.2 մլրդ, Blockchain.com, 3.1%") === "16:30-ին, $1.2 մլրդ, Blockchain.com, 3.1%", "times, decimals and domains are untouched");
  check(polishArmenian("24 սեպտ. երեկոյան։") === "24 սեպտ. երեկոյան։", "an abbreviation mid-sentence is untouched");
  check(polishArmenian("ավարտվեց։:") === "ավարտվեց։", "a doubled mark collapses");
  const s = parseSummary("ՎԵՐՆԱԳԻՐ: Fed-ը իջեցրեց տոկոսադրույքը:\nԻՆՉ: Տոկոսադրույքը իջավ:\nԻՆՉՈՒ: Ազդում է շուկայի վրա.\nԲԱՌ: -\nԹԵԳ: FOMC");
  check(s.headline === "Fed-ը իջեցրեց տոկոսադրույքը" && s.what.endsWith("։") && s.why.endsWith("։"), "applied to every field; a headline gets no closing mark at all");
}

console.log("\n2. One word for one thing («tokenized» appeared three ways in one evening)");
{
  for (const v of ["թոքենավորված", "թոքենացված", "տոկենացված", "տոկենավորված"]) {
    if (polishArmenian(`${v} բաժնետոմսեր`) !== "թոքենացված բաժնետոմսեր") fail(`${v} not normalised`);
  }
  pass("all four spellings → «թոքենացված»");
  check(polishArmenian("տոկենների") === "թոքենների" && polishArmenian("Տոկենը") === "Թոքենը", "every form of «token», capitalised too");
  check(TERMS.length >= 3, "the dictionary is data, easy to extend");
  check(polishArmenian("թողարկել ստեյբլքոյններ") === "թողարկել stablecoin-ներ", "«ստեյբլքոյններ» (2026-09-25) → «stablecoin-ներ», like every other post");
  check(polishArmenian("Ստեյբլքոյնը") === "stablecoin-ը" && polishArmenian("ստեյբլքոյն") === "stablecoin", "every form, with or without an ending");
}

console.log("\n3. The gloss (two real breakages)");
{
  const ibm = withGloss("հանձնարարել տոկենացված ավանդների փոխանցումներ", "տոկենացված ավանդներ", "բլոկչեյնում թողարկված ավանդներ");
  check(ibm.includes("տոկենացված ավանդների (<i>") && ibm.includes("</i>) փոխանցումներ"), "the bracket goes after the case ending, not inside the word («ավանդներ (…)ի» before)");
  const zec = withGloss("ցուցակագրել է որպես ETP, իսկ", "ETP", "բորսայական գործիք, որը հետևում է ակտիվին:");
  check(zec.includes("ակտիվին</i>)") && !zec.includes(":)"), "the definition's own closing mark is dropped («արժեքին:):» before)");
  check(withGloss("որպես ETP-ների շարք", "ETP", "գործիք").includes("ETP-ների (<i>գործիք</i>)"), "a hyphenated ending on a Latin term");
  check(withGloss("x", "չկա", "y") === "x", "a term not in the text is still a silent no-op");
}

console.log("\n4. Words in the channel");
{
  check(relatedNote().includes("հրապարակվածի") && !relatedNote().includes("հրապարկածի"), "«հրապարակվածի», not the misspelt «հրապարկածի»");
  const empty = renderWeeklyOutcomes({ from: Date.UTC(2026, 8, 20), to: Date.UTC(2026, 8, 27) }, []);
  check(!/story|coin|HIGH|post/.test(empty), "the weekly recap has no English words in its sentences");
  const full = renderWeeklyOutcomes({ from: Date.UTC(2026, 8, 20), to: Date.UTC(2026, 8, 27) }, [{ symbol: "BTC", headline: "x", pctChange: 1 }]);
  check(full.includes("փոստի պահի գնից") && !full.includes("post-ի"), "…nor in its footnote");
  check(!/crypto-/.test(EVENTS.map((e) => `${e.name} ${e.note ?? ""}`).join(" ")), "event notes say «կրիպտո», like the rest of the channel");
  const health = { rows: [{ event: { name: "CPI" }, lastYmd: "2026-12-10", remaining: 1, daysLeft: 20 }] };
  check(renderExpiry(health, Date.now(), { forAdmin: true }).includes("events.js"), "expiry notice to the admin names the file to edit");
  check(!renderExpiry(health, Date.now(), { forAdmin: false }).includes("events.js"), "…and to the channel does not");
}

console.log("\n5. The price line");
{
  check(formatPriceLine("BTC", { usd: 84234, change24h: 0.01 }) === "BTC $84,234", "«(+0.0% 24ժ)» is dropped when nothing moved");
  check(formatPriceLine("SOL", { usd: 114, change24h: -2.04 }) === "SOL $114 (−2.0% 24ժ)", "a real move is kept — down is ▼");
  check(formatPriceLine("BTC", { usd: 84234, change24h: 0.05 }).includes("+0.1%"), "0.05 rounds to a visible 0.1 — kept, up is ▲");
  check(formatPriceLine("BTC", { usd: 84600, change24h: 1.2 }) === "BTC $84,600 (+1.2% 24ժ)", "the real post of 2026-09-25: «(+1.2% 24ժ)» → «(+1.2% 24ժ)»");
}

console.log("\n6. Nothing can hold a run past GitHub's limit");
{
  const t0 = Date.now();
  const r = await ask("k", "p", { models: ["m1", "m2"], gapMs: 10, deadline: Date.now() - 1 });
  check(r.ok === false && r.outOfTime === true && Date.now() - t0 < 500, "a passed deadline stops the AI ladder at once");

  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw Object.assign(new Error("aborted"), { name: "AbortError" }); };
  const s = await sendMessage("t", "c", "hi");
  globalThis.fetch = realFetch;
  check(s.ok === false && s.unknown === true && /չպատասխանեց/.test(s.why), "a Telegram timeout is UNKNOWN — recorded, never re-sent");

  for (const f of ["ai.js", "telegram.js"]) {
    const src = readFileSync(f, "utf8");
    const calls = (src.match(/await fetch\(|await timedFetch\(/g) ?? []).length;
    const guarded = (src.match(/signal: controller\.signal|timedFetch\(/g) ?? []).length;
    check(guarded >= calls, `${f}: every request carries a timeout (${calls} requests)`);
  }
  const run = readFileSync("run.js", "utf8");
  check(/deadline: newsDeadline\(\)/.test(run) && (run.match(/deadline: newsDeadline\(\)/g) ?? []).length === 2, "both AI calls in the news half get the run's deadline");
  check(/detectCoin\(lead\.title\)/.test(run), "the coin comes from the headline, not the body");
}

console.log("\n7. Invisible characters are visible in the source");
{
  for (const f of ["telegram.js", "calpost.js"]) {
    const bad = readFileSync(f, "utf8").split("\n").filter((l) => l.includes("\u00a0") && !/^\s*(\/\/|\*)/.test(l));
    check(bad.length === 0, `${f}: no literal no-break spaces left in code`);
  }
  check(noOrphan("a b c").includes("\u00a0"), "…and the behaviour they carried is unchanged");
}

console.log("\n8. Each primary source is primary only in its own field (2026-09-25)");
{
  const lone = (source, title) => scoreCluster({ sources: new Set([source]), items: [{ source, title }] });
  const boj = lone("Bank of Japan", "Core CPI (All items less fresh food) — August 2026");
  check(boj.importance !== "HIGH" && boj.score < 3.0, "the BoJ's monthly CPI statistics no longer post alone as 🟪🟪🟪");
  check(lone("Bank of Japan", "Statement on Monetary Policy").importance === "HIGH", "…while a BoJ policy decision still does");
  check(lone("BLS", "Consumer Price Index – August 2026").importance === "HIGH", "CPI from the BLS is still 🟪🟪🟪 — it is the BLS's field");
  check(lone("ECB", "ECB publishes inflation expectations survey").score < 3.0, "a central bank's survey is not its field");
  check(lone("SEC", "SEC Charges Florida Resident").score < 3.0 && lone("SEC", "SEC Approves Spot Solana ETF").importance === "HIGH", "the SEC: crypto rulings yes, other enforcement no");
}

console.log("\n9. No arrow on a move that rounds to nothing (morning brief, 2026-09-25)");
{
  check(priceBit({ symbol: "BTC", usd: 84217, change24h: -0.04 }) === "BTC $84,217", "«BTC $84,217 −0.0%» → «BTC $84,217»");
  check(priceBit({ symbol: "ETH", usd: 2681, change24h: -0.4 }) === "ETH $2,681 −0.4%", "a real move keeps its arrow");
  const t = renderMorning({
    now: Date.UTC(2026, 8, 25, 5, 10), market: { ok: false, rows: [] }, fng: { ok: false }, events: [],
    macro: { ok: true, rows: [
      { label: "S&P 500", kind: "pct", date: "2026-09-24", value: 7704, prev: 7705 },
      { label: "VIX", kind: "level", date: "2026-09-24", value: 14.2, prev: 14.22 },
    ] },
  });
  check(t.includes("S&amp;P 500 7,704 · VIX 14.2") && !t.includes("0.0"), "S&P and VIX: no «−0.0» either");
}

console.log("\n10. No arrow on an unchanged price anywhere (30-day simulation, 2026-09-25)");
{
  const r = renderOutcomeReply({ symbol: "ETH", priceAtPost: 3400, priceAtCheck: 3400.5, pctChange: 0.01, elapsedMs: 8 * 3_600_000 });
  check(r.includes("(0.0%)") && !r.includes("+0.0%"), "accountability reply: «(0.0%)», not «(+0.0%)»");
  const w = renderWeeklyOutcomes({ from: 0, to: 7 * 86_400_000 }, [{ symbol: "BTC", headline: "x", pctChange: -0.03 }]);
  check(w.includes("0.0% · BTC") && !/[▲▼] [+-]?0\.0%/.test(w), "weekly recap: the same");
  check(priceBit({ symbol: "LINK", usd: 13.37, change24h: 7.5 }).includes("<b>+7.5%</b>"), "a big move is bold");
  check(!priceBit({ symbol: "ETH", usd: 2681, change24h: -0.4 }).includes("<b>"), "a small one is not");
}

console.log("\n11. Karen's rule, final: every move is a clean signed number, no arrows (2026-09-25)");
{
  check(formatMove(1.2) === "+1.2%" && formatMove(-2.5) === "−2.5%", "«+1.2%», «−2.5%»");
  check(formatMove(0.03) === null && formatMove(-0.04) === null, "a move that rounds to zero: nothing at all");
  check(formatMove(-2.5).includes("−") && !formatMove(-2.5).includes("-"), "a real minus sign (U+2212), never a hyphen");
  check(formatMove(15, { digits: 0, suffix: " բ.կ." }) === "+15 բ.կ.", "basis points follow the same rule");
  check(formatMove(4.2e10 / 1e9, { prefix: "$", suffix: " մլրդ" }) === "+$42.0 մլրդ", "and money");
  // every module that shows a move builds it with formatMove — and no arrow is drawn anywhere
  for (const f of ["price.js", "morning.js", "evening.js", "liquidity.js", "release.js", "outcomepost.js"]) {
    const own = readFileSync(f, "utf8").split("\n").filter((l) => /["`]▲|["`]▼|\? "▲"|: "▼"/.test(l) && !/^\s*(\/\/|\*)/.test(l) && !/formatMove|"▲ \+" : "−"/.test(l));
    check(own.length === 0, `${f}: no arrow drawn outside formatMove${own.length ? ` — ${own[0].trim()}` : ""}`);
  }
}

console.log("");
if (failures > 0) {
  console.log(`${failures} FAILURE(S)`);
  process.exit(1);
}
console.log("All checks passed.");
