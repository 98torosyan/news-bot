// Guards the 2026-09-24 quality pass: what earns 🟪🟪🟪, which report a post
// links to, and which headlines are not news at all. Every title marked REAL
// below is one the live bot actually handled.
//
//   node test-quality.mjs

import {
  SOURCE_WEIGHT, DEFAULT_WEIGHT, PRIMARY_WEIGHT, weightOf, itemWeight, isMarketMovingTopic,
  scoreCluster, rankStories, pickLead, pickSummarySource, MIN_SUMMARY_BODY,
} from "./rank.js";
import { FEEDS, looksLikeNews } from "./feeds.js";

let failures = 0;
const pass = (m) => console.log(`  ok   ${m}`);
const fail = (m) => {
  console.log(`  FAIL ${m}`);
  failures++;
};
const check = (cond, m) => (cond ? pass(m) : fail(m));

const lone = (source, title) => scoreCluster({ sources: new Set([source]), items: [{ source, title }] });

console.log("\n1. Every source has a weight someone chose");
{
  const missing = FEEDS.map((f) => f.name).filter((n) => !(n in SOURCE_WEIGHT));
  check(missing.length === 0, `all ${FEEDS.length} feeds weighted${missing.length ? ` — missing: ${missing.join(", ")}` : ""}`);
  const stale = Object.keys(SOURCE_WEIGHT).filter((n) => !FEEDS.some((f) => f.name === n));
  check(stale.length === 0, `no weight for a feed that no longer exists${stale.length ? ` — ${stale.join(", ")}` : ""}`);
  check(["The Block", "Blockworks", "DL News"].every((s) => weightOf(s) === weightOf("CoinDesk")), "The Block, Blockworks, DL News weigh the same as CoinDesk");
  check(["Glassnode Research", "FRED Blog", "Liberty Street Economics"].every((s) => weightOf(s) < PRIMARY_WEIGHT), "research blogs are never primary");
  check(weightOf("Coinpedia") < weightOf("CoinDesk") && weightOf("The Daily Hodl") < DEFAULT_WEIGHT, "thin republishers count for less than a full vote");
}

console.log("\n2. Primary-source noise no longer posts (REAL titles)");
{
  const noise = [
    ["Fed (all press)", "Federal Reserve Board announces approval of application by BancFirst Corporation"],
    ["Fed (all press)", "Federal Reserve Board announces termination of enforcement action with SNB Bancshares and Bank of Eufaula"],
    ["ECB", "Almost ten million people took part in ECB survey on new euro banknotes"],
    ["Bank of England", "Foreign Currency Reserves 2026 – Market Notice 22 September 2026"],
    ["SEC", "SEC Censures OTC Link LLC for Repeated Compliance Failures Related to Regulation SCI"],
    ["SEC", "SEC Charges South Florida Resident and His Company for Alleged Investment Scheme Defrauding Law Enforcement"],
    ["SEC", "SEC Publishes Updated Market Statistics, Highlighting Increase in IPOs and Proceeds Raised"],
    ["SEC", "SEC Proposes Rescission of Shareholder Proposal Rule and Reforms to Proxy Solicitation Process"],
    ["ECB", "Philip R. Lane: The Outlook for the Euro Area Economy"],
  ];
  for (const [src, t] of noise) {
    const c = lone(src, t);
    if (c.importance === "HIGH" || c.score >= 3.0 || c.primary.length) fail(`should not post alone: ${t} (${c.importance}, ${c.score})`);
  }
  pass(`${noise.length} administrative items from primary sources: none posts alone, none is marked primary`);
}

console.log("\n3. What primary sources are for still posts, alone, as 🟪🟪🟪");
{
  const signal = [
    ["Federal Reserve", "Federal Reserve issues FOMC statement"], // REAL
    ["FCA", "UK FCA sets crypto authorization guidance ahead of September application window"], // REAL
    ["BLS", "Consumer Price Index – August 2026"],
    ["BLS", "The Employment Situation — August 2026"],
    ["ECB", "Monetary policy decisions"],
    ["Bank of England", "Bank Rate maintained at 4% - September 2026"],
    ["Bank of Japan", "Statement on Monetary Policy"],
    ["SEC", "SEC Approves Listing of Spot Solana Exchange-Traded Products"],
  ];
  for (const [src, t] of signal) {
    const c = lone(src, t);
    if (c.importance !== "HIGH" || c.score < 3.0) fail(`should post as HIGH: ${t} (${c.importance}, ${c.score})`);
  }
  pass(`${signal.length} rate decisions, data releases and crypto rulings: all HIGH on their own`);
  check(!isMarketMovingTopic("Federal Reserve Board announces approval of application"), "no rate word, no crypto word — no primary status");
}

console.log("\n4. A demoted primary item still counts as corroboration");
{
  // A big enforcement case the press picks up must still post — through the
  // outlets that carried it, like any other story.
  const c = scoreCluster({
    sources: new Set(["SEC", "CoinDesk", "The Block"]),
    items: [
      { source: "SEC", title: "SEC Charges Founder of Trading Firm With Fraud" },
      { source: "CoinDesk", title: "SEC charges trading firm founder with fraud" },
      { source: "The Block", title: "SEC charges trading firm founder" },
    ],
  });
  check(c.score >= 3.0 && c.importance === "MEDIUM", `off-topic SEC + two newsrooms: posts, as MEDIUM (${c.score.toFixed(1)}, ${c.importance})`);
  check(c.primary.length === 0, "and is not labelled 'official source'");
  check(itemWeight({ source: "SEC", title: "SEC charges X" }) === DEFAULT_WEIGHT, "one ordinary vote, not zero");
}

console.log("\n5. The post links the original, not the newest retelling");
{
  const t0 = Date.UTC(2026, 8, 16, 18, 0);
  const items = [
    { source: "Yahoo Finance", title: "Fed hikes rates for first time since 2023", at: t0 + 20 * 60_000, body: "y".repeat(600) },
    { source: "CoinDesk", title: "Fed hikes rates, bitcoin spikes", at: t0 + 10 * 60_000, body: "c".repeat(900) },
    { source: "Federal Reserve", title: "Federal Reserve issues FOMC statement", at: t0, body: "" },
  ];
  const lead = pickLead(items);
  check(lead.source === "Federal Reserve", "lead is the Fed's own release, though it is the oldest");
  const mat = pickSummarySource(lead, items);
  check(mat.source === "CoinDesk", "the Fed item has no body — the model reads CoinDesk, the fullest heavy report");

  const richFed = { ...items[2], body: "f".repeat(MIN_SUMMARY_BODY) };
  check(pickSummarySource(richFed, [items[0], items[1], richFed]) === richFed, "when the original has enough text, the model reads the original");

  const noPrimary = [
    { source: "U.Today", title: "X", at: t0 + 30 * 60_000 },
    { source: "Decrypt", title: "X", at: t0 + 5 * 60_000 },
    { source: "Protos", title: "X", at: t0 + 15 * 60_000 },
  ];
  check(pickLead(noPrimary).source === "Protos", "no primary: heaviest outlet wins, newest among equals (Protos over Decrypt, both over U.Today)");

  const offTopic = [
    { source: "CoinDesk", title: "SEC charges trading firm founder", at: t0 + 10 },
    { source: "SEC", title: "SEC Charges Founder of Trading Firm With Fraud", at: t0 },
  ];
  check(pickLead(offTopic).source === "CoinDesk", "a demoted primary item does not take the lead from a heavier newsroom");
}

console.log("\n6. End to end through rankStories");
{
  const now = Date.now();
  const items = [
    { source: "Fed (all press)", title: "Federal Reserve Board announces approval of application by BancFirst Corporation", at: now - 60_000, link: "a" },
    { source: "Federal Reserve", title: "Federal Reserve issues FOMC statement", at: now - 3_600_000, link: "fed", body: "" },
    { source: "CoinDesk", title: "Federal Reserve FOMC statement: rates raised", at: now - 3_000_000, link: "cd", body: "c".repeat(400) },
  ];
  const ranked = rankStories(items, { minScore: 3.0, limit: 5 });
  check(ranked.length === 1, `only the FOMC story ranks (${ranked.length})`);
  check(ranked[0]?.lead.link === "fed", "and it links to the Fed");
  check(ranked[0]?.summarySource.link === "cd", "and is summarised from CoinDesk's text");
  check(ranked[0]?.importance === "HIGH", "and is marked HIGH");
}

console.log("\n7. Headlines that are not news (REAL titles)");
{
  for (const t of ["Why is Crypto Market Going Down Today?", "Eco Data 9/24/26", "Major Economic Indicators Latest Numbers"]) {
    if (looksLikeNews(t)) fail(`should be filtered: ${t}`);
  }
  pass("the explainer and two data-dump pages are filtered");
  for (const t of [
    "Fed Hikes Rates for the First Time Since 2023, Bitcoin Spikes",
    "Binance takes $100M stake in Circle under expanded USDC deal",
    "Treasury Sanctions Crypto Exchange Behind Iran's Bitcoin Tolls on Hormuz Ships",
  ]) {
    if (!looksLikeNews(t)) fail(`must not be filtered: ${t}`);
  }
  pass("real news around them is untouched");
}

console.log("");
if (failures > 0) {
  console.log(`${failures} FAILURE(S)`);
  process.exit(1);
}
console.log("All checks passed.");
