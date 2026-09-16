// Guards the part of the bot that decides what reaches the channel.
//
//   node scripts/test-rank.mjs
//
// The ranking is the whole editorial policy. If it silently breaks, the channel
// does not go quiet — it starts posting the wrong things, which is worse,
// because nothing looks broken.

import {
  keyWords,
  similarity,
  clusterStories,
  scoreCluster,
  rankStories,
  weightOf,
} from "./rank.js";

let failures = 0;
const pass = (m) => console.log(`  ok   ${m}`);
const fail = (m) => {
  console.log(`  FAIL ${m}`);
  failures++;
};

const H = 3_600_000;
const NOW = Date.parse("2026-09-15T20:00:00Z");
const item = (source, title, hoursAgo = 1) => ({
  source,
  title,
  link: `https://x/${encodeURIComponent(title).slice(0, 20)}`,
  at: NOW - hoursAgo * H,
  body: "",
});

console.log("\n1. Identifying words");
{
  const w = keyWords("The Senate Blocks Clarity Act, Likely Killing It for 2026");
  if (w.has("the") || w.has("for") || w.has("it")) fail("stop words must be dropped");
  else pass("stop words dropped");
  if (!w.has("senate") || !w.has("clarity")) fail("content words must survive");
  else pass("content words kept");
  if (!w.has("2026")) fail("numbers identify stories and must be kept");
  else pass("numbers kept — they are often the most identifying token");

  const money = keyWords("Bybit halts withdrawals after $340 million exploit");
  if (!money.has("$340")) fail(`currency amounts must survive: ${[...money]}`);
  else pass("currency amounts survive tokenisation");
}

console.log("\n2. Same story, different outlets");
{
  const a = keyWords("Senate Blocks Clarity Act, Likely Killing It for 2026");
  const b = keyWords("Trump ethics fight sinks CLARITY Act in dramatic Senate defeat");
  const c = keyWords("Ethereum Fusaka upgrade goes live on mainnet");

  if (similarity(a, b) < similarity(a, c)) fail("two reports of one story must beat unrelated news");
  else pass("two reports of one story score above unrelated news");
  if (similarity(a, c) > 0.2) fail(`unrelated headlines must score low: ${similarity(a, c)}`);
  else pass("unrelated headlines score near zero");

  // The asymmetric-length case the smaller-set divisor exists for.
  const short = keyWords("Fed holds rates steady");
  const long = keyWords(
    "Federal Reserve holds rates steady as officials signal caution on further cuts this year"
  );
  if (similarity(short, long) < 0.5) fail(`a short headline inside a long one must match: ${similarity(short, long)}`);
  else pass("a short headline contained in a longer one still matches");
}

console.log("\n3. Clustering counts outlets, not articles");
{
  const items = [
    item("CoinDesk", "Senate blocks Clarity Act killing it for 2026"),
    item("Decrypt", "Senate blocks Clarity Act, likely dead for 2026"),
    item("CoinDesk", "Senate blocks Clarity Act — what happens to 2026 crypto rules"),
    item("Protos", "Ethereum Fusaka upgrade goes live on mainnet"),
  ];
  const clusters = clusterStories(items);
  const big = clusters.find((c) => c.items.length > 1);
  if (!big) fail("the three Clarity Act reports must cluster");
  else pass("reports of one story cluster together");
  if (big && big.sources.size !== 2) {
    fail(`one outlet publishing twice is one vote, got ${big && big.sources.size}`);
  } else pass("an outlet publishing twice still counts as one vote");
  if (clusters.length !== 2) fail(`expected 2 stories, got ${clusters.length}`);
  else pass("the unrelated story stays its own cluster");
}

console.log("\n4. Time separates recurring stories");
{
  const items = [
    item("CoinDesk", "Bitcoin falls below $70,000", 1),
    item("Decrypt", "Bitcoin falls below $70,000", 40), // a month of Mondays apart
  ];
  const clusters = clusterStories(items);
  if (clusters.length !== 2) fail("the same headline two days apart is two events");
  else pass("identical headlines outside the window are separate events");
}

console.log("\n5. One official source outranks a crowd of aggregators");
{
  const official = [item("Federal Reserve", "FOMC statement: rates unchanged")];
  const crowd = [
    item("U.Today", "Shiba Inu burn rate spikes 400 percent overnight"),
    item("NewsBTC", "Shiba Inu burn rate spikes 400 percent overnight"),
    item("BeInCrypto", "Shiba Inu burn rate spikes 400 percent overnight"),
  ];
  const fed = scoreCluster(clusterStories(official)[0]).score;
  const shib = scoreCluster(clusterStories(crowd)[0]).score;
  if (fed <= shib) fail(`a Fed release (${fed}) must outrank three aggregators (${shib})`);
  else pass(`a single Fed release outranks three aggregators (${fed.toFixed(1)} vs ${shib.toFixed(1)})`);

  if (weightOf("U.Today") >= weightOf("CoinDesk")) {
    fail("a high-volume republisher must not outweigh a primary newsroom");
  } else pass("volume does not buy influence");
}

console.log("\n6. The Kiyosaki case — the one a regex could not solve");
{
  // One man's opinion, carried by the outlets that carry opinions.
  const opinion = [
    item("BeInCrypto", "Robert Kiyosaki says the biggest stock market crash in history has started"),
    item("U.Today", "Robert Kiyosaki says biggest stock market crash in history has started"),
  ];
  // A real event, carried by everyone.
  const event = [
    item("CoinDesk", "SEC approves spot Solana ETF applications"),
    item("Decrypt", "SEC approves spot Solana ETF applications from three issuers"),
    item("Protos", "SEC approves spot Solana ETFs"),
    item("Cointelegraph", "SEC approves spot Solana ETF filings"),
  ];
  const op = scoreCluster(clusterStories(opinion)[0]).score;
  const ev = scoreCluster(clusterStories(event)[0]).score;
  if (op >= ev) fail(`a pundit quote (${op}) must not outrank a regulator decision (${ev})`);
  else pass(`a pundit quote scores below a real event (${op.toFixed(1)} vs ${ev.toFixed(1)})`);

  const ranked = rankStories([...opinion, ...event], { minScore: 3.0, limit: 5 });
  if (ranked.some((r) => r.lead.title.includes("Kiyosaki"))) {
    fail("the pundit quote passed the threshold without anyone writing a rule about it");
  } else pass("the pundit quote falls below the threshold on its own");
}

console.log("\n7. Every posted story can say why");
{
  const items = [
    item("CoinDesk", "SEC approves spot Solana ETF applications"),
    item("Decrypt", "SEC approves spot Solana ETF applications from issuers"),
    item("Protos", "SEC approves spot Solana ETFs"),
  ];
  const [top] = rankStories(items, { minScore: 2.0, limit: 1 });
  if (!top) fail("expected one ranked story");
  else if (!top.why.includes("CoinDesk") || !top.why.includes("3 աղբյուր")) {
    fail(`the explanation must name the count and the sources: ${top.why}`);
  } else pass(`every story carries its reason: "${top.why}"`);
}

console.log("\n8. A quiet half hour posts nothing");
{
  // The failure mode that matters most: rather than lowering the bar to fill
  // the channel, an hour with no corroborated story must produce no posts.
  const thin = [
    item("U.Today", "Analyst says altcoin season may begin soon"),
    item("NewsBTC", "Trader spots bullish pattern on XRP chart"),
  ];
  const ranked = rankStories(thin, { minScore: 3.0, limit: 3 });
  if (ranked.length !== 0) fail(`nothing corroborated must mean nothing posted, got ${ranked.length}`);
  else pass("a quiet period posts nothing rather than lowering the bar");
}

console.log("\n9. The limit is respected");
{
  const many = [];
  for (let i = 0; i < 12; i++) {
    many.push(item("CoinDesk", `Distinct story number ${i} about exchange ${i}`, i * 0.1));
    many.push(item("Decrypt", `Distinct story number ${i} about exchange ${i}`, i * 0.1));
    many.push(item("Protos", `Distinct story number ${i} about exchange ${i}`, i * 0.1));
  }
  const ranked = rankStories(many, { minScore: 2.0, limit: 3 });
  if (ranked.length > 3) fail(`limit must cap the batch, got ${ranked.length}`);
  else pass("the per-run limit caps the batch — the API quota depends on it");
}

console.log("\n10. One subject does not take the whole run");
{
  // The exact batch the first live run produced: three CLARITY Act stories,
  // different angles, all genuinely corroborated. The ranking was right and the
  // batch was still wrong.
  const clarity = [
    item("CoinDesk", "Crypto stocks slide after CLARITY Act fails to advance in Senate", 1),
    item("Decrypt", "Crypto stocks slide as CLARITY Act fails to advance", 1),
    item("Protos", "Crypto stocks fall after CLARITY Act stalls in Senate", 1),
    item("Cointelegraph", "Democrats move the goalposts on CLARITY Act hours before Senate vote", 2),
    item("Decrypt", "Democrats 'move the goalposts' on CLARITY Act before key vote", 2),
    item("CoinDesk", "Democrats shift position on CLARITY Act ahead of vote", 2),
  ];
  // Something else entirely, equally well corroborated.
  const other = [
    item("CoinDesk", "Bybit halts withdrawals after $340 million exploit", 1.5),
    item("Decrypt", "Bybit halts withdrawals following $340 million exploit", 1.5),
    item("Protos", "Bybit suspends withdrawals after $340 million hack", 1.5),
  ];

  const ranked = rankStories([...clarity, ...other], { minScore: 2.0, limit: 3 });
  const clarityCount = ranked.filter((r) => /clarity/i.test(r.lead.title)).length;
  if (clarityCount > 1) fail(`one subject must not take several slots, got ${clarityCount}`);
  else pass("one subject takes at most one slot in a batch");
  if (!ranked.some((r) => /Bybit/i.test(r.lead.title))) {
    fail("the unrelated story must not be crowded out by the dominant subject");
  } else pass("a different subject still gets its slot");

  // On a genuinely one-story day, posting once is the right answer.
  const onlyOne = rankStories(clarity, { minScore: 2.0, limit: 3 });
  if (onlyOne.length !== 1) fail(`a one-subject day posts once, got ${onlyOne.length}`);
  else pass("a one-subject day posts one story rather than three variations");
}

console.log("");
if (failures > 0) {
  console.log(`${failures} FAILURE(S)`);
  process.exit(1);
}
console.log("All checks passed.");
