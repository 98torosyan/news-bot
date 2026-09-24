// Guards the picture a post opens with when its link has none (media.js).
// No network: every request goes to a fake fetch that plays the part.
//
//   node test-media.mjs

import {
  declaredImage, pageHasImage, downsample, chartConfig, chartUrl, cardTopic, cardUrl, choosePreview,
} from "./media.js";
import { existsSync } from "fs";

let failures = 0;
const pass = (m) => console.log(`  ok   ${m}`);
const fail = (m) => {
  console.log(`  FAIL ${m}`);
  failures++;
};
const check = (cond, m) => (cond ? pass(m) : fail(m));

const html = (head) => `<!doctype html><html><head>${head}</head><body>x</body></html>`;
const OG = html('<meta property="og:image" content="https://img.example.com/a.jpg">');
const NONE = html('<meta name="description" content="Federal Reserve issues FOMC statement">');
const res = (body, { status = 200, type = "text/html; charset=utf-8" } = {}) =>
  new Response(body, { status, headers: { "content-type": type } });

/** A fake web: url → Response factory. Records every call. */
function web(routes) {
  const calls = [];
  const f = async (url, opt) => {
    calls.push({ url: String(url), method: opt?.method ?? "GET" });
    for (const [prefix, make] of Object.entries(routes)) if (String(url).startsWith(prefix)) return make(opt);
    throw new Error("offline");
  };
  f.calls = calls;
  return f;
}
const ENV = { GITHUB_REPOSITORY: "98torosyan/news-bot", GITHUB_REF_NAME: "main" };

console.log("\n1. Reading a page's preview image");
{
  check(declaredImage(OG) === "https://img.example.com/a.jpg", "og:image found");
  check(declaredImage(html("<meta content='https://i.x/y.png' name='twitter:image'>")) === "https://i.x/y.png", "twitter:image, attributes in any order, single quotes");
  check(declaredImage(html('<meta property="og:image" content="/relative.jpg">')) === null, "a relative path is not a usable image");
  check(declaredImage(NONE) === null, "a page without one");
}

console.log("\n2. Known / not known — never guess 'no image'");
{
  const f = web({
    "https://og.test": () => res(OG),
    "https://none.test": () => res(NONE),
    "https://blocked.test": () => res("denied", { status: 403 }),
    "https://pdf-by-type.test": () => res("%PDF", { type: "application/pdf" }),
    "https://json.test": () => res("{}", { type: "application/json" }),
    "https://cut.test": () => res("<html><he"),
  });
  check((await pageHasImage("https://og.test/a", { fetchImpl: f })) === true, "has one → true");
  check((await pageHasImage("https://none.test/a", { fetchImpl: f })) === false, "page loaded, declares none → false");
  check((await pageHasImage("https://www.ecb.europa.eu/press/key/date/2026/html/x.en.pdf", { fetchImpl: f })) === false, "a .pdf link → false, without fetching");
  check((await pageHasImage("https://pdf-by-type.test/doc", { fetchImpl: f })) === false, "a PDF by content type → false");
  check((await pageHasImage("https://blocked.test/a", { fetchImpl: f })) === null, "403 → unknown, not 'none'");
  check((await pageHasImage("https://json.test/a", { fetchImpl: f })) === null, "not HTML → unknown");
  check((await pageHasImage("https://cut.test/a", { fetchImpl: f })) === null, "a page cut before its <head> ends → unknown");
  check((await pageHasImage("https://offline.test/a", { fetchImpl: f })) === null, "network error → unknown");
}

console.log("\n3. The chart");
{
  const prices = Array.from({ length: 288 }, (_, i) => [i * 300_000, 60000 + i * 10]);
  const pts = downsample(prices);
  check(pts.length === 48 && pts[0] === prices[0] && pts[47] === prices[287], "288 points → 48, first and last kept");
  const cfg = chartConfig("BTC", pts);
  check(cfg.options.title.text === "BTC/USD · 24h · +4.8%", `title in Latin, change computed (${cfg.options.title.text})`);
  check(!/[\u0530-\u058f]/.test(JSON.stringify(cfg)), "no Armenian inside the chart — the renderer's fonts may not have it");

  let posted = null;
  const f = web({
    "https://api.coingecko.com": () => res(JSON.stringify({ prices }), { type: "application/json" }),
    "https://quickchart.io/chart/create": (opt) => {
      posted = JSON.parse(opt.body);
      return res(JSON.stringify({ success: true, url: "https://quickchart.io/chart/render/zf-abc" }), { type: "application/json" });
    },
  });
  const url = await chartUrl({ symbol: "BTC", id: "bitcoin" }, { fetchImpl: f });
  check(url === "https://quickchart.io/chart/render/zf-abc", "short URL from /chart/create");
  check(posted?.width === 1200 && posted?.height === 630 && posted?.backgroundColor === "#121124", "same size and ink as the cards");
  const down = web({ "https://api.coingecko.com": () => res("x", { status: 429 }) });
  check((await chartUrl({ symbol: "BTC", id: "bitcoin" }, { fetchImpl: down })) === null, "rate-limited → null, next rung");
}

console.log("\n4. The card");
{
  check(cardTopic({ source: "Federal Reserve" }) === "fed" && cardTopic({ source: "Fed (all press)" }) === "fed", "Fed");
  check(cardTopic({ source: "ECB" }) === "ecb", "ECB");
  check(cardTopic({ source: "SEC" }) === "regulation" && cardTopic({ source: "FCA" }) === "regulation", "regulators");
  check(cardTopic({ source: "CoinDesk", title: "Exchange hacked for $40M" }) === "security", "a hack, whoever reports it");
  check(cardTopic({ source: "BLS", cat: "MACRO" }) === "macro", "macro");
  check(cardTopic({ source: "Decrypt", cat: "CRYPTO", title: "ETF inflows rise" }) === "crypto", "crypto by default");

  const u = cardUrl("fed", "https://x/1", ENV);
  check(/^https:\/\/raw\.githubusercontent\.com\/98torosyan\/news-bot\/main\/card-fed-[12]\.png$/.test(u), "raw GitHub URL from the workflow's own repository");
  check(cardUrl("fed", "https://x/1", ENV) === u, "the same story always gets the same card");
  const seen = new Set(Array.from({ length: 40 }, (_, i) => cardUrl("fed", `https://x/${i}`, ENV)));
  check(seen.size === 2, "both versions are used");
  check(cardUrl("fed", "s", {}) === null, "outside GitHub Actions → no card");
  check(cardUrl("fed", "s", { GITHUB_REPOSITORY: "a/b c" }) === null, "a malformed repository name is refused");

  // Every topic has both files, under the exact names the URL uses.
  const dir = process.env.CARDS_DIR ?? ".";
  const missing = ["fed", "ecb", "regulation", "security", "macro", "crypto"]
    .flatMap((t) => [1, 2].map((v) => `card-${t}-${v}.png`))
    .filter((f) => !existsSync(`${dir}/${f}`));
  // Strict only when asked (CARDS_DIR). In the workflow a missing card must
  // not fail the tests: that would stop the whole bot over a picture, while
  // the bot itself survives a missing card (Telegram just shows no preview).
  if (process.env.CARDS_DIR) check(missing.length === 0, `all 12 card files present${missing.length ? ` — missing ${missing.join(", ")}` : ""}`);
  else if (missing.length === 0) pass("all 12 card files present");
  else console.log(`  WARN ${missing.length} card file(s) not uploaded yet: ${missing.join(", ")} — posts that need them go without a picture`);
}

console.log("\n5. The ladder");
{
  const lead = { source: "Federal Reserve", link: "https://none.test/fomc", title: "Federal Reserve issues FOMC statement" };
  const cd = { source: "CoinDesk", link: "https://og.test/cd" };
  const f = web({
    "https://og.test": () => res(OG),
    "https://none.test": () => res(NONE),
    "https://blocked.test": () => res("denied", { status: 403 }),
  });

  let p = await choosePreview({ ...lead, link: "https://og.test/x" }, [], null, { fetchImpl: f, env: ENV });
  check(p.kind === "lead", "the lead has a picture → unchanged");
  p = await choosePreview({ ...lead, link: "https://blocked.test/x" }, [cd], null, { fetchImpl: f, env: ENV });
  check(p.kind === "lead" && p.url === "https://blocked.test/x", "can't tell → unchanged (never worse than before)");
  p = await choosePreview(lead, [lead, cd], null, { fetchImpl: f, env: ENV });
  check(p.kind === "other" && p.url === "https://og.test/cd", "the Fed page has none → CoinDesk's report of the same story");

  const chartWeb = web({
    "https://none.test": () => res(NONE),
    "https://api.coingecko.com": () => res(JSON.stringify({ prices: Array.from({ length: 100 }, (_, i) => [i, 1 + i]) }), { type: "application/json" }),
    "https://quickchart.io/chart/create": () => res(JSON.stringify({ success: true, url: "https://quickchart.io/chart/render/q" }), { type: "application/json" }),
  });
  p = await choosePreview({ source: "SEC", link: "https://none.test/sec", title: "SEC approves spot Solana ETF" }, [], { symbol: "SOL", id: "solana" }, { fetchImpl: chartWeb, env: ENV });
  check(p.kind === "chart", "no picture anywhere, a coin → the chart");
  p = await choosePreview(lead, [lead], null, { fetchImpl: f, env: ENV });
  check(p.kind === "card" && /card-fed-/.test(p.url), "no picture, no coin → the Fed card");
  p = await choosePreview({ ...lead, link: "https://x/doc.pdf" }, [], null, { fetchImpl: f, env: {} });
  check(p.kind === "none" && p.url === null, "nothing at all → no preview (as for a PDF before)");

  const counting = web({ "https://none.test": () => res(NONE) });
  await choosePreview(lead, [lead, ...Array.from({ length: 6 }, (_, i) => ({ source: "X", link: `https://none.test/${i}` }))], null, { fetchImpl: counting, env: ENV });
  check(counting.calls.length <= 3, `bounded: at most 3 page fetches per post (${counting.calls.length})`);
}

console.log("");
if (failures > 0) {
  console.log(`${failures} FAILURE(S)`);
  process.exit(1);
}
console.log("All checks passed.");
