// Guards the accountability loop's own half of the channel: the follow-up
// reply on a single story, and the Sunday recap built from a week of them.
//
//   node test-outcomepost.mjs

import { renderOutcomeReply, renderWeeklyOutcomes } from "./outcomepost.js";

let failures = 0;
const pass = (m) => console.log(`  ok   ${m}`);
const fail = (m) => {
  console.log(`  FAIL ${m}`);
  failures++;
};

const H = 3_600_000;
const DAY = 24 * H;

console.log("\n1. The single follow-up reply");
{
  const up = renderOutcomeReply({
    symbol: "BTC", priceAtPost: 60000, priceAtCheck: 61500, pctChange: 2.5, elapsedMs: 8 * H,
  });
  if (!up.includes("▲")) fail("a price that rose must show the up arrow");
  else pass("a rise shows ▲");
  if (!up.includes("+2.5%")) fail(`expected +2.5% somewhere in: ${up}`);
  else pass("a positive change gets an explicit plus sign");
  if (!up.includes("8ժ")) fail(`expected the elapsed hours (8ժ) somewhere in: ${up}`);
  else pass("elapsed time is shown in hours");
  if (!/\$60,000/.test(up) || !/\$61,500/.test(up)) fail(`expected both prices in: ${up}`);
  else pass("both the starting and ending price are shown");

  const down = renderOutcomeReply({
    symbol: "ETH", priceAtPost: 3000, priceAtCheck: 2850, pctChange: -5, elapsedMs: 8 * H,
  });
  if (!down.includes("▼")) fail("a price that fell must show the down arrow");
  else pass("a fall shows ▼");
  if (!down.includes("-5.0%")) fail(`expected -5.0% (own minus sign, not doubled) somewhere in: ${down}`);
  else pass("a negative change keeps its own minus sign, not doubled with an explicit one");
}

console.log("\n2. Elapsed time rounds to whole hours, never to zero");
{
  const almostNoTime = renderOutcomeReply({
    symbol: "BTC", priceAtPost: 100, priceAtCheck: 101, pctChange: 1, elapsedMs: 10_000,
  });
  if (!almostNoTime.includes("1ժ")) fail(`a near-instant check-back must still read as at least 1ժ: ${almostNoTime}`);
  else pass("elapsed time never rounds down to zero hours");
}

console.log("\n3. This is a fact, never a verdict");
{
  const text = renderOutcomeReply({
    symbol: "BTC", priceAtPost: 60000, priceAtCheck: 61500, pctChange: 2.5, elapsedMs: 8 * H,
  });
  // The one rule outcomepost.js states for itself: two numbers and the time
  // between them, never a score or a claim that the channel "called it".
  if (/(?:score|verdict|կանխատես|ճիշտ էր|սխալ էր)/i.test(text)) {
    fail(`must not grade or predict, found scoring language in: ${text}`);
  } else pass("the reply contains no scoring or prediction language");
}

console.log("\n4. The weekly recap, ranked by the size of the move");
{
  const from = Date.parse("2026-09-14T16:00:00Z"); // Sunday 20:00 Yerevan
  const to = from + 7 * DAY - 1;
  const history = [
    { symbol: "BTC", headline: "Fed holds rates steady", pctChange: 1.2, postedAt: from + DAY },
    { symbol: "ETH", headline: "ETF outflows accelerate", pctChange: -8.4, postedAt: from + 2 * DAY },
    { symbol: "SOL", headline: "Network outage resolved", pctChange: 3.0, postedAt: from + 3 * DAY },
  ];
  const text = renderWeeklyOutcomes({ from, to }, history);

  const ethLine = text.split("\n").findIndex((l) => l.includes("ETH"));
  const btcLine = text.split("\n").findIndex((l) => l.includes("BTC"));
  const solLine = text.split("\n").findIndex((l) => l.includes("SOL"));
  if (!(ethLine < solLine && solLine < btcLine)) {
    fail(`expected ETH (8.4%) before SOL (3.0%) before BTC (1.2%), by absolute move; got order in:\n${text}`);
  } else pass("entries are ranked by the size of the move, largest first, regardless of sign");

  if (!text.includes("▼") || !text.includes("▲")) fail("expected both arrow directions to appear");
  else pass("falls and rises are both marked with their own arrow");
}

console.log("\n5. An empty week says so, rather than staying silent");
{
  const from = Date.parse("2026-09-14T16:00:00Z");
  const to = from + 7 * DAY - 1;
  const text = renderWeeklyOutcomes({ from, to }, []);
  if (text.length === 0) fail("an empty week must still produce a post, not nothing");
  else pass("an empty week still produces a post");
  if (!/HIGH|story|նորություն/i.test(text) && !text.includes("չեղավ")) {
    fail(`expected an explicit explanation of the empty week, got: ${text}`);
  } else pass("the empty week explains itself rather than posting a bare title");
}

console.log("");
if (failures > 0) {
  console.log(`${failures} FAILURE(S)`);
  process.exit(1);
}
console.log("All checks passed.");
