// Guards the number check (verify.js): a wrong figure never reaches the
// channel, a legitimate rewording is never stopped.
//
//   node test-verify.mjs

import { verifyNumbers, extractNumbers } from "./verify.js";

let failures = 0;
const pass = (m) => console.log(`  ok   ${m}`);
const fail = (m) => {
  console.log(`  FAIL ${m}`);
  failures++;
};
const S = (what) => ({ headline: "", what, why: "", glossDef: "" });

// [summary, source, should it pass?, what it tests]
const CASES = [
  ["Fed-ը իջեցրեց տոկոսադրույքը 25 բազիսային կետով՝ մինչև 4.00–4.25%։", "The Fed cut rates by 25 basis points to a range of 4.00%-4.25%.", true, "exact basis points and range"],
  ["Fed-ը իջեցրեց տոկոսադրույքը 50 բազիսային կետով։", "The Fed cut rates by 25 basis points.", false, "50 bp where the Fed said 25"],
  ["Տոկոսադրույքը իջավ 0.25 տոկոսային կետով։", "cut by 25 basis points", true, "basis points → percentage points"],
  ["Ներհոսքը կազմեց $1.2 մլրդ։", "inflows reached $1,200 million", true, "$1,200 million → 1.2 մլրդ"],
  ["Ներհոսքը կազմեց $1.2 մլրդ։", "inflows reached $1.23 billion", true, "rounding 1.23 → 1.2"],
  ["Ներհոսքը կազմեց $12 մլրդ։", "inflows reached $1.2 billion", false, "12 where the source said 1.2"],
  ["Հաքերները գողացան $50 մլրդ։", "hackers stole $50 million", false, "billion where the source said million"],
  ["Հաքերները գողացան $50 մլն։", "hackers stole $50M from the exchange", true, "$50M → 50 մլն"],
  ["Գնաճը 2026-ի օգոստոսին 2,9% էր։", "CPI rose 2.9% in August 2026", true, "decimal comma; the year is not a claim"],
  ["BTC-ն 24 ժամում աճեց 3.1%-ով։", "bitcoin rose 3.1% on the day", true, "«24 ժամում» is a time span"],
  ["BTC-ն աճեց 13.1%-ով։", "bitcoin rose 3.1%", false, "13.1 where the source said 3.1"],
  ["Երեք երկիր՝ 3 կարգավորող։", "three regulators", true, "small counts are not checked"],
  ["Circle-ը ձեռք բերեց 100 մլն դոլարի բաժնեմաս", "Binance takes $100M stake in Circle", true, "$100M → 100 մլն"],
  ["Ընկերությունը կրճատեց 1,500 աշխատակից", "the company cut 1,500 jobs", true, "thousands separator"],
  ["Ընկերությունը կրճատեց 15,000 աշխատակից", "the company cut 1,500 jobs", false, "15,000 where the source said 1,500"],
  ["Q3-ում եկամուտը 5.2 մլրդ էր", "third quarter revenue of $5.2bn", true, "Q3 is not a claim; bn"],
  ["SEC-ը տուգանեց $4.3 մլրդ", "SEC fined the firm $4,300,000,000", true, "a spelled-out figure → մլրդ"],
];

console.log("\n1. Right numbers pass, wrong numbers stop");
for (const [sum, src, expect, label] of CASES) {
  const r = verifyNumbers(S(sum), [src]);
  if (r.ok !== expect) fail(`${expect ? "should pass" : "should stop"}: ${label} (unsupported: ${r.unsupported.join(", ")})`);
}
pass(`${CASES.length} cases judged correctly (${CASES.filter((c) => !c[2]).length} wrong figures stopped)`);

console.log("\n2. Evidence from every report of the story");
{
  const r = verifyNumbers(S("Ներհոսքը $1.2 մլրդ էր"), ["The Block: ETF inflows surge", "CoinDesk: inflows of $1.2 billion"]);
  r.ok ? pass("a figure from another outlet's report counts") : fail("a figure from another report was rejected");
  const none = verifyNumbers(S("Առանց թվերի նախադասություն"), ["x"]);
  none.ok && none.checked === 0 ? pass("no figures — nothing to check, passes") : fail("a summary without figures was stopped");
}

console.log("\n3. Reading figures");
{
  const f = extractNumbers("1,234 and 1,2 and $5.2bn and 25 bps");
  const vals = f.map((x) => x.value * x.scale);
  JSON.stringify(vals) === JSON.stringify([1234, 1.2, 5.2e9, 25]) ? pass("1,234 · 1,2 · $5.2bn · 25 bps") : fail(`read as ${vals}`);
  f[3].points ? pass("'bps' marks basis points") : fail("bps not recognised");
}

console.log("");
if (failures > 0) {
  console.log(`${failures} FAILURE(S)`);
  process.exit(1);
}
console.log("All checks passed.");
