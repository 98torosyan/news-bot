// THE EVENING SUMMARY. 20:00 Yerevan, Monday to Saturday.
//
// ONLY WHAT THE READER HAS NOT SEEN YET
//
//   Someone who follows the channel saw today's posts as they came. A summary
//   that lists them again is the channel scrolled backwards, and readers learn
//   to swipe it away. So this post carries exactly three things that are new
//   at 20:00:
//
//     1. What the price actually did after today's big stories — the
//        accountability loop's results, which otherwise arrive one by one as
//        replies deep in the channel.
//     2. Tomorrow — which REPLACES the separate 20:00 warnings for ordinary
//        events (see below), so the evening gets quieter, not louder.
//     3. One line for the day's top story, and a count — not a list.
//
// WHAT HAPPENS TO THE 20:00 WARNINGS
//
//   Ordinary (non-HIGH) day-before warnings are folded into «Վաղը» here and
//   recorded as sent against THIS message — so tomorrow's results still thread
//   onto it, exactly as they threaded onto the warning. A HIGH event (FOMC,
//   CPI, payrolls, ECB) keeps its own post: it has the note and the reason to
//   care, and it is the one thing on the list a reader would want pushed.
//   If this post fails to send, nothing was recorded, and the warnings go out
//   on their own at the next run as before.
//
// SUNDAY IS SKIPPED — the weekly overview and the weekly results recap already
// go out at 20:00 on Sunday, and a third post in the same minute is noise.
//
// SILENT. The morning brief rings; this one does not. The day is over and
// nothing here needs acting on tonight.
//
// NO AI, like the morning brief and the calendar — it cannot be stopped by a
// spent Gemini quota.

import { esc, fit, noOrphan, band, LEVEL_WORDS } from "./telegram.js";
import {
  partsInTz, ymdInTz, zonedToUtc, parseYmd, addDaysYmd,
  yerevanClock, yerevanDate, yerevanWeekday, impactMark, allOccurrences,
  WARN_HOUR, QUIET_FROM, CHANNEL_TZ, IMPACT,
} from "./calendar.js";
import { priceBit, MORNING_HOUR } from "./morning.js";

export const EVENING_HOUR = WARN_HOUR; // 20:00 — the same moment as the day-before warnings
export const EVENING_SILENT = true;

/** "\u{1F319}" is Emoji_Presentation=Yes — colour everywhere, no selector needed. */
const MOON = "\u{1F319}";

const at = (ymd, hh) => {
  const { y, m, d } = parseYmd(ymd);
  return zonedToUtc(y, m, d, hh, 0, CHANNEL_TZ);
};

// ── when ────────────────────────────────────────────────────────────────────

/**
 * Due from 20:00 until the quiet hours begin, once a day, never on Sunday.
 * Returns null, or { day, stale, from, to } — `from` is 09:00 today (the night
 * belongs to the morning brief), `stale` means 23:00 has passed: record, skip.
 */
export function eveningDue(now, lastDay = null) {
  const p = partsInTz(now, CHANNEL_TZ);
  const day = ymdInTz(now, CHANNEL_TZ);
  if (p.weekday === 0) return null;
  if (day === lastDay) return null;
  if (p.hh < EVENING_HOUR) return null;
  return { day, stale: p.hh >= QUIET_FROM, from: at(day, MORNING_HOUR), to: now };
}

/**
 * Which due warning groups the summary takes over: day-before ("d1") groups
 * with no HIGH event in them, whose events are all TOMORROW. The last check is
 * what guarantees every absorbed warning appears under «Վաղը» — an event set
 * to be warned two days ahead would otherwise be recorded as sent and shown
 * nowhere. Everything else is left to the calendar.
 */
export function absorbable(group) {
  return (
    group.kind === "d1" &&
    group.rows.every((r) => r.event.impact !== IMPACT.HIGH && (r.daysBefore ?? 1) === 1)
  );
}

// ── render (pure) ───────────────────────────────────────────────────────────

function linked(username, id, html) {
  return username && id ? `<a href="https://t.me/${esc(username)}/${Number(id)}">${html}</a>` : html;
}

const RANK = { HIGH: 0, MEDIUM: 1, LOW: 2 };

/**
 *   now       the moment of the run
 *   posts     recentPosts from 09:00 today until now
 *   outcomes  outcomeHistory entries resolved today ({symbol, headline, pctChange, id?})
 *   market    fetchMarket() result
 *   username  the channel's @username, or null
 *   events    the calendar (EVENTS)
 */
export function renderEvening({ now, posts = [], outcomes = [], market = null, username = null, events }) {
  const lines = [`${MOON} <b>ՕՐՎԱ ԱՄՓՈՓՈՒՄ</b> · ${esc(yerevanWeekday(now))}, ${esc(yerevanDate(now))}`];

  // --- the day in one line ----------------------------------------------------
  lines.push("", "<b>Օրվա գլխավորը</b>");
  const ranked = [...posts].sort((a, b) => RANK[a.importance] - RANK[b.importance] || a.at - b.at);
  const top = ranked[0];
  if (!top) {
    lines.push("Այսօր կարևոր նորություն չկար։");
  } else {
    lines.push(`${band(top.importance)} ${linked(username, top.id, noOrphan(esc(top.headline)))}`);
    const n = (imp) => posts.filter((p) => p.importance === imp).length;
    const parts = [];
    if (n("HIGH")) parts.push(`${n("HIGH")} ${LEVEL_WORDS.HIGH}`);
    if (n("MEDIUM")) parts.push(`${n("MEDIUM")} ${LEVEL_WORDS.MEDIUM}`);
    if (posts.length > 1) {
      lines.push(`<i>Այսօր ալիքում՝ ${posts.length} նորություն${parts.length ? ` (${parts.join(", ")})` : ""}</i>`);
    }
  }

  // --- what the price did -----------------------------------------------------
  // Two numbers and the story they followed — the same claim, and the same
  // restraint, as the reply each one already got in its own thread.
  if (outcomes.length) {
    lines.push("", "<b>Ինչ արեց գինը</b>");
    for (const o of outcomes.slice(0, 5)) {
      const p = o.pctChange;
      const move = `${p >= 0 ? "▲" : "▼"}${Math.abs(p).toFixed(1)}%`;
      lines.push(`${esc(o.symbol)} ${move} · ${linked(username, o.id, noOrphan(esc(o.headline)))}`);
    }
  }

  // --- the market --------------------------------------------------------------
  const main = (market?.ok ? market.rows : []).filter((r) => r.symbol === "BTC" || r.symbol === "ETH");
  if (main.length) lines.push("", "<b>Շուկան՝ 24 ժամում</b>", main.map(priceBit).join(" · "));

  // --- tomorrow ----------------------------------------------------------------
  const tomorrow = addDaysYmd(ymdInTz(now, CHANNEL_TZ), 1);
  const tStart = at(tomorrow, 0);
  const occ = allOccurrences(tStart, at(addDaysYmd(tomorrow, 1), 0) - 1, events);
  lines.push("", `<b>Վաղը</b> · ${esc(yerevanWeekday(tStart))}`);
  if (occ.length === 0) {
    lines.push("Նախատեսված տնտեսական իրադարձություն չկա։");
  } else {
    for (const o of occ) {
      const flag = o.event.flagged?.[o.ymd];
      lines.push(
        `${impactMark(o.event.impact)} ${esc(yerevanClock(o.ts))} · ${noOrphan(esc(o.event.name))}` +
          (flag ? ` <i>(${esc(flag)})</i>` : "")
      );
    }
  }

  return fit(lines);
}
