// THE PICTURE WHEN THE LINK HAS NONE.
//
// A post opens with its source's link preview, full width, above the text
// (see sendMessage in telegram.js). Since the 2026-09-24 quality pass the
// source is the ORIGINAL whenever there is one — the Fed, the SEC, the BLS —
// and those pages carry no preview image. So the most important posts were
// about to become the only plain-text ones. This file picks a picture for
// exactly those posts, and changes nothing for the rest.
//
// THE LADDER — first rung that works wins
//
//   1. The lead's own page, when it has an image.            (as before)
//   2. Another report of the SAME story that has one — CoinDesk's article
//      about the Fed decision, say. Still a link preview Telegram fetches
//      from the publisher, never a copied photo: the rule in telegram.js
//      about licensed images holds on every rung.
//   3. A 24-hour price chart, when the story is about a coin on the list.
//   4. The channel's own card for the story's topic (card-*.png in the repo).
//
// NEVER WORSE THAN BEFORE
//
//   The lead's page is replaced only when it is KNOWN to have no image: a PDF,
//   or a page that loaded and declares none. A page that refused the bot, timed
//   out or answered strangely keeps the old behaviour — Telegram's own fetcher
//   often gets through where this one did not, and guessing "no image" there
//   would swap a real photograph for a card.
//
// COST — at most a few small requests, only for the up-to-three posts a run
// makes. Every failure falls through to the next rung; the post never waits
// on a picture and never fails because of one.

import { COINS } from "./price.js";

export const MEDIA_TIMEOUT_MS = 6_000;
const MAX_HTML_BYTES = 300_000;

const isPdf = (url) => /\.pdf(?:[?#]|$)/i.test(String(url ?? ""));

// ── 1–2: does a page have a preview image? ──────────────────────────────────

/** Pure: the og:image / twitter:image a page declares, or null. */
export function declaredImage(html) {
  const h = String(html ?? "");
  const metas = h.match(/<meta\b[^>]*>/gi) ?? [];
  for (const m of metas) {
    const key = /(?:property|name)\s*=\s*["']?(og:image(?::secure_url|:url)?|twitter:image(?::src)?)["'\s>]/i.exec(m);
    const content = /content\s*=\s*["']([^"']+)["']/i.exec(m);
    if (key && content && /^https?:\/\//i.test(content[1].trim())) return content[1].trim();
  }
  return null;
}

/**
 * true  — the page declares a preview image
 * false — it is KNOWN to have none (a PDF, or an HTML page without one)
 * null  — could not tell; the caller keeps the old behaviour
 */
export async function pageHasImage(url, { fetchImpl = fetch } = {}) {
  if (!url) return false;
  if (isPdf(url)) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MEDIA_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: { "user-agent": "Mozilla/5.0 (compatible; TelegramBot (like TwitterBot))", accept: "text/html" },
    });
    if (!res.ok) return null;
    const type = res.headers?.get?.("content-type") ?? "";
    if (/application\/pdf/i.test(type)) return false;
    if (!/html/i.test(type)) return null;
    const html = (await res.text()).slice(0, MAX_HTML_BYTES);
    // Only a page that clearly reached its <head> counts as "no image".
    if (!/<\/head>|<body/i.test(html)) return null;
    return declaredImage(html) ? true : false;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ── 3: a price chart ────────────────────────────────────────────────────────
//
// QuickChart renders a Chart.js config to a PNG and, through /chart/create,
// hands back a short, stable URL — the long form would carry every price in
// the query string. Latin labels only: the renderer's fonts are not known to
// carry Armenian, and a chart of empty boxes is worse than none.

const PURPLE = "#7F77DD";
const INK = "#121124";

/** Pure: CoinGecko market_chart prices → at most `n` evenly spaced points. */
export function downsample(prices, n = 48) {
  const p = (prices ?? []).filter((x) => Array.isArray(x) && Number.isFinite(x[1]));
  if (p.length <= n) return p;
  const out = [];
  for (let i = 0; i < n; i++) out.push(p[Math.round((i * (p.length - 1)) / (n - 1))]);
  return out;
}

/** Pure: the Chart.js config for one coin's last 24 hours. */
export function chartConfig(symbol, points) {
  const vals = points.map((x) => x[1]);
  const first = vals[0];
  const last = vals[vals.length - 1];
  const pct = first ? ((last / first - 1) * 100).toFixed(1) : "0.0";
  const sign = Number(pct) >= 0 ? "+" : "";
  return {
    type: "line",
    data: {
      labels: points.map(() => ""),
      datasets: [{
        data: vals, borderColor: PURPLE, borderWidth: 4, pointRadius: 0, fill: true,
        backgroundColor: "rgba(127,119,221,0.15)", tension: 0.25,
      }],
    },
    options: {
      legend: { display: false },
      title: {
        display: true, text: `${symbol}/USD · 24h · ${sign}${pct}%`,
        fontColor: "#F2F0FC", fontSize: 28, fontStyle: "bold", padding: 20,
      },
      scales: {
        xAxes: [{ display: false }],
        yAxes: [{ gridLines: { color: "rgba(255,255,255,0.06)" }, ticks: { fontColor: "#B8B4E2", fontSize: 16 } }],
      },
      layout: { padding: { left: 24, right: 32, top: 8, bottom: 24 } },
    },
  };
}

async function postJson(url, body, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MEDIA_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, {
      method: "POST", signal: controller.signal,
      headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    return res.ok ? await res.json().catch(() => null) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function getJson(url, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MEDIA_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { signal: controller.signal, headers: { accept: "application/json" } });
    return res.ok ? await res.json().catch(() => null) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function chartUrl(coin, { fetchImpl = fetch } = {}) {
  if (!coin?.id) return null;
  const hist = await getJson(
    `https://api.coingecko.com/api/v3/coins/${encodeURIComponent(coin.id)}/market_chart?vs_currency=usd&days=1`,
    fetchImpl
  );
  const points = downsample(hist?.prices);
  if (points.length < 12) return null;
  const made = await postJson("https://quickchart.io/chart/create", {
    chart: chartConfig(coin.symbol, points), width: 1200, height: 630, backgroundColor: INK, format: "png",
    version: "2",
  }, fetchImpl);
  const url = made?.success && typeof made.url === "string" ? made.url : null;
  return url && /^https:\/\//.test(url) ? url : null;
}

// ── 4: the channel's own card ────────────────────────────────────────────────

const FED = new Set(["Federal Reserve", "Fed (all press)", "FRED Blog", "Liberty Street Economics"]);
const REGULATORS = new Set(["SEC", "CFTC", "FCA", "ESMA"]);
const SECURITY_WORDS = /\b(hack(ed|er|ers)?|exploit(ed)?|drain(ed)?|stolen|breach|phishing|scam|rug ?pull|frozen|freeze)\b/i;

/** Pure: which card a story gets — fed, ecb, regulation, security, macro or crypto. */
export function cardTopic(lead) {
  const src = String(lead?.source ?? "");
  const title = String(lead?.title ?? "");
  if (FED.has(src)) return "fed";
  if (src === "ECB") return "ecb";
  if (REGULATORS.has(src)) return "regulation";
  if (src === "SlowMist" || SECURITY_WORDS.test(title)) return "security";
  if (lead?.cat === "MACRO") return "macro";
  return "crypto";
}

/**
 * The card's public URL, from the repository the workflow runs in — never a
 * hard-coded owner or name, so a renamed repository keeps working. Outside
 * GitHub Actions (a local run) there is no URL and the rung is skipped.
 * Two versions of each card; the story's link picks one, so a story keeps its
 * card across reruns and the channel does not repeat one image all day.
 */
export function cardUrl(topic, seed, env = process.env) {
  const repo = env.GITHUB_REPOSITORY;
  const branch = env.GITHUB_REF_NAME || "main";
  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) return null;
  let h = 0;
  for (const ch of String(seed ?? "")) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `https://raw.githubusercontent.com/${repo}/${encodeURIComponent(branch)}/card-${topic}-${(h % 2) + 1}.png`;
}

// ── the ladder ──────────────────────────────────────────────────────────────

/**
 * → { url, kind } where kind is lead | other | chart | card | none.
 * `items` are the story's reports, heaviest first is not required — the lead
 * is tried first and the rest in the order given.
 */
export async function choosePreview(lead, items = [], coin = null, { fetchImpl = fetch, env = process.env, maxOthers = 2 } = {}) {
  const leadHas = await pageHasImage(lead?.link, { fetchImpl });
  if (leadHas !== false) return { url: lead?.link ?? null, kind: "lead" };

  const others = items.filter((i) => i !== lead && i.link && i.link !== lead.link && !isPdf(i.link)).slice(0, maxOthers);
  for (const o of others) {
    if ((await pageHasImage(o.link, { fetchImpl })) === true) return { url: o.link, kind: "other", source: o.source };
  }

  if (coin) {
    const url = await chartUrl(coin, { fetchImpl });
    if (url) return { url, kind: "chart" };
  }

  const url = cardUrl(cardTopic(lead), lead?.link, env);
  return url ? { url, kind: "card" } : { url: null, kind: "none" };
}

export { COINS };
