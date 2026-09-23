// WHAT AN OUTCOME POST LOOKS LIKE — the accountability loop's own half of the
// channel, parallel to calpost.js for the calendar's half.
//
// THE ONE RULE THESE POSTS FOLLOW
//
//   A price delta, and nothing dressed up as more than that. Not "the channel
//   called it", not a score, not a verdict on whether the story mattered. Two
//   numbers and the time between them — a reader checks the claim against the
//   original post themselves, because it is right there in the same thread.
//
// WHY A REPLY, NOT A NEW POST
//
//   Sent with `replyTo` pointing at the original story, so Telegram threads
//   them together and a reader who saw the news sees the follow-up in the
//   same conversation, not as an unrelated line item thirty posts later.

import { esc, fit } from "./telegram.js";
import { formatUsd } from "./price.js";
import { yerevanDate } from "./calendar.js";

/** Rounds to whole hours for the reader; the scheduling itself is exact. */
function roundHours(ms) {
  return Math.max(1, Math.round(ms / 3_600_000));
}

/**
 * The follow-up reply on a single HIGH-importance, coin-resolved story.
 *
 * `pctChange` is computed by the caller from the two prices — kept out of
 * this file so the arithmetic has exactly one home (in run.js, next to where
 * the two prices are read) rather than being recomputed wherever it is
 * rendered, which is how two numbers quietly drift apart.
 */
export function renderOutcomeReply({ symbol, priceAtPost, priceAtCheck, pctChange, elapsedMs }) {
  const up = pctChange >= 0;
  const sign = up ? "+" : "";
  const arrow = up ? "▲" : "▼";
  const hours = roundHours(elapsedMs);

  const lines = [
    `📌 <b>Թարմացում, ${hours}ժ անց</b>`,
    "",
    `${esc(symbol)}՝ ${esc(formatUsd(priceAtPost))} → ${esc(formatUsd(priceAtCheck))} (${arrow} ${sign}${pctChange.toFixed(1)}%)`,
  ];
  return fit(lines);
}

/**
 * One line of the weekly recap — exported separately so the sort order and
 * the line's own wording can each be tested without building a whole post.
 */
function outcomeLine(o) {
  const up = o.pctChange >= 0;
  const sign = up ? "+" : "";
  const arrow = up ? "▲" : "▼";
  return `${arrow} ${sign}${o.pctChange.toFixed(1)}% · ${esc(o.symbol)} · ${esc(o.headline)}`;
}

/**
 * The Sunday "what actually happened" recap — the backward-looking twin of
 * calpost.js's renderDigest, which only ever looks forward.
 *
 * Built entirely from state.js's outcome history: every HIGH-importance story
 * this channel followed up on in the past week, ranked by how far the price
 * actually moved. An empty week says so plainly rather than staying silent,
 * because a channel that sometimes just does not post a weekly feature reads
 * as broken, not as having had a quiet week.
 */
export function renderWeeklyOutcomes({ from, to }, history) {
  const lines = ["📊 <b>ՇԱԲԱԹԱԿԱՆ ԱՄՓՈՓՈՒՄ · ինչ իրապես եղավ</b>", ""];

  if (history.length === 0) {
    lines.push("Այս շաբաթ չափելու ենթակա story չեղավ — ոչ մի HIGH-կարևորության նորություն coin-ի հետ կապված չէր հրապարակվել։");
    return fit(lines);
  }

  const sorted = [...history].sort((a, b) => Math.abs(b.pctChange) - Math.abs(a.pctChange));
  for (const o of sorted) lines.push(outcomeLine(o));

  lines.push(
    "",
    `<i>${esc(yerevanDate(from))} – ${esc(yerevanDate(to - 60_000))} · Յուրաքանչյուր տոկոսը՝ post-ի պահի գնից մինչև ստուգման պահը։</i>`
  );
  return fit(lines);
}
