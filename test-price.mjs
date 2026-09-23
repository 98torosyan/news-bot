// Guards the price snapshot: which coin a headline names, and how its price
// is shown. No network call is made here — fetchPrice's own HTTP path is
// exercised live by the bot, not by a test — but every pure function around
// it (the allowlist match, the cache's de-duplication, the formatting) is
// cheap to get wrong and expensive to get wrong silently, since a wrong price
// line would sit under real news for anyone to read.
//
//   node test-price.mjs

import { COINS, detectCoin, formatUsd, formatPriceLine, makePriceCache } from "./price.js";

let failures = 0;
const pass = (m) => console.log(`  ok   ${m}`);
const fail = (m) => {
  console.log(`  FAIL ${m}`);
  failures++;
};

console.log("\n1. Detecting a coin by symbol or name");
{
  const btc = detectCoin("BTC breaks $70,000 as ETF inflows surge");
  if (btc?.symbol !== "BTC") fail(`expected BTC, got ${JSON.stringify(btc)}`);
  else pass("all-caps symbol matches");

  const eth = detectCoin("Ethereum upgrade goes live on mainnet");
  if (eth?.symbol !== "ETH") fail(`expected ETH from full name, got ${JSON.stringify(eth)}`);
  else pass("full name matches case-insensitively");

  const none = detectCoin("Congress debates a new stablecoin bill");
  if (none !== null) fail(`expected no match, got ${JSON.stringify(none)}`);
  else pass("ordinary prose with no coin mention resolves to null");
}

console.log("\n2. The allowlist rejects words that only look like tickers");
{
  // "ONE" and "SOL" are ordinary English words far more often than they are
  // the coins Harmony or Solana — this is the whole reason for an allowlist
  // instead of a bare \b[A-Z]{2,5}\b regex.
  const one = detectCoin("This is the one thing that matters this quarter");
  if (one !== null) fail(`lowercase "one" inside prose must not match Harmony's ONE: got ${JSON.stringify(one)}`);
  else pass('lowercase "one" does not falsely match a ticker');

  const sol = detectCoin("Regulators want a solution to the sol problem");
  if (sol !== null) fail(`lowercase "sol" must not match Solana's SOL ticker: got ${JSON.stringify(sol)}`);
  else pass('lowercase "sol" does not falsely match a ticker');

  // But the real ticker, in caps, as its own word, must still match.
  const realSol = detectCoin("SOL rallies 12% after network upgrade");
  if (realSol?.symbol !== "SOL") fail(`expected SOL to match in caps, got ${JSON.stringify(realSol)}`);
  else pass("SOL in all caps matches Solana");
}

console.log("\n3. First match wins, deterministically");
{
  const both = detectCoin("BTC and ETH both rally on the Fed's decision");
  if (both?.symbol !== "BTC") fail(`expected BTC first (list order), got ${JSON.stringify(both)}`);
  else pass("a headline naming two coins resolves to the first one listed");
}

console.log("\n4. Every listed coin's id is unique and non-empty");
{
  const ids = COINS.map((c) => c.id);
  const uniqueIds = new Set(ids);
  if (uniqueIds.size !== ids.length) fail("two coins share a CoinGecko id");
  else pass("every coin has its own CoinGecko id");
  if (COINS.some((c) => !c.symbol || !c.name || !c.id)) fail("a coin entry is missing a field");
  else pass("every coin entry is complete");
}

console.log("\n5. Formatting a dollar amount");
{
  if (formatUsd(67234) !== "$67,234") fail(`expected $67,234, got ${formatUsd(67234)}`);
  else pass("amounts of $100+ round to whole dollars");
  if (formatUsd(1.5) !== "$1.5") fail(`expected $1.5, got ${formatUsd(1.5)}`);
  else pass("amounts between $1 and $100 keep up to two decimals");
  if (formatUsd(0.4231) !== "$0.423") fail(`expected $0.423, got ${formatUsd(0.4231)}`);
  else pass("amounts under $1 keep three significant digits, not rounded to cents");
  if (formatUsd(NaN) !== "?") fail(`expected "?" for a non-finite input, got ${formatUsd(NaN)}`);
  else pass("a non-finite input degrades to a plain question mark, never a crash");
}

console.log("\n6. The line attached to a post");
{
  const up = formatPriceLine("BTC", { usd: 67234, change24h: 2.34 });
  if (up !== "BTC $67,234 (+2.3% 24ժ)") fail(`unexpected: ${up}`);
  else pass("a positive 24h change gets an explicit plus sign");

  const down = formatPriceLine("ETH", { usd: 3200, change24h: -1.2 });
  if (down !== "ETH $3,200 (-1.2% 24ժ)") fail(`unexpected: ${down}`);
  else pass("a negative 24h change keeps its own minus sign, not doubled");

  const noChange = formatPriceLine("LTC", { usd: 90, change24h: null });
  if (noChange !== "LTC $90") fail(`unexpected: ${noChange}`);
  else pass("a missing 24h change omits the parenthetical rather than printing a false 0%");
}

console.log("\n7. The per-run cache de-duplicates concurrent lookups");
{
  let calls = 0;
  const fakeFetcher = async (id) => {
    calls += 1;
    return { ok: true, usd: id === "bitcoin" ? 67000 : 3000, change24h: 1 };
  };
  const cached = makePriceCache(fakeFetcher);
  // Two callers asking for the SAME coin back to back, before either has
  // resolved — this is what a run with three BTC-related stories does.
  const [a, b] = await Promise.all([cached("bitcoin"), cached("bitcoin")]);
  if (calls !== 1) fail(`expected exactly one underlying fetch, got ${calls}`);
  else pass("two concurrent requests for the same coin cost one fetch");
  if (a.usd !== 67000 || b.usd !== 67000) fail("both callers must see the same resolved price");
  else pass("both callers receive the same result");

  await cached("ethereum");
  if (calls !== 2) fail(`a different coin must still trigger its own fetch, got ${calls} calls`);
  else pass("a different coin is fetched separately");
}

console.log("");
if (failures > 0) {
  console.log(`${failures} FAILURE(S)`);
  process.exit(1);
}
console.log("All checks passed.");
