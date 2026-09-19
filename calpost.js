// WHAT A CALENDAR POST LOOKS LIKE.
//
// Separate from telegram.js, which knows how to talk to the API, and separate
// from calendar.js, which knows what is due. This file only turns one into the
// other, so it can be tested by reading its output.
//
// THE RULE THESE POSTS FOLLOW
//
//   A warning states a scheduled fact and nothing else: what, when in Yerevan,
//   and why it matters in one sentence written in advance. It never predicts a
//   number, never says what the market "expects", and never suggests a trade.
//   Those would all be invented data, and the channel's whole claim is that it
//   does not invent.
//
//   The three-hour reminder is deliberately shorter than the day-before notice.
//   The reader has already seen the long version; a second full post would read
//   as the channel repeating itself.
//
// WHERE THE MARKS GO — one rule, applied everywhere
//
//   🗓️ and 📅 sit on a HEADER line and say what kind of post this is.
//   ●●● ●●○ ●○○ sit on an EVENT line and say how much that event matters.
//
//   Never both on one line. In the multi-event post and the Sunday overview
//   that falls out naturally, because the events are already a list; the
//   single-event warning follows the same shape, with the header on top and
//   the event's own line beneath it.
//
// WHY 🗓️ CARRIES A VARIATION SELECTOR
//
//   U+1F5D3 has Emoji_Presentation=No — verified against the Unicode character
//   database, not assumed. Left bare it defaults to TEXT presentation, which
//   means a monochrome outline on a conforming platform and a missing-glyph box
//   where the font has no such outline. U+FE0F forces the colour form. The same
//   is true of 🏛, which is why the category emoji were dropped from news posts
//   rather than quietly shipping one that renders differently on two phones.

import { esc, fit, noOrphan, LEVEL_WORDS } from "./telegram.js";
import {
  whenPhrase, yerevanClock, yerevanDate, yerevanWeekday, impactMark,
  ymdInTz, allOccurrences, partsInTz, CHANNEL_TZ, IMPACT,
} from "./calendar.js";

/** Forced to colour presentation. See the header note. */
const CAL = "🗓️";
const WEEK = "📅";

/**
 * A warning post — one event, or several that fall due together.
 *
 * `group` comes from groupWarnings(): `{ kind, at, rows }`, where each row is
 * an occurrence plus which moment this is.
 */
export function renderWarning(group, now) {
  const rows = Array.isArray(group.rows) ? group.rows : [group];
  return rows.length > 1 ? renderMany(group, rows, now) : renderOne(rows[0], now);
}

/**
 * The words at the top of a warning.
 *
 * Shared by the single and the combined post, because they were written twice
 * and drifted: the combined one said "ՎԱՂԸ" unconditionally, so an event warned
 * seven days ahead would have announced itself as tomorrow's. One function,
 * one answer.
 */
function headline(kind, daysBefore, hours) {
  if (kind === "soon") return hours ? `${hours} ԺԱՄ ԱՆՑ` : "ՄՈՏ ԺԱՄԵՐԻՆ";
  if (daysBefore === 1) return "ՎԱՂԸ";
  return `${daysBefore} ՕՐ ԱՆՑ`;
}

function renderMany(group, rows, now) {
  const first = rows[0];
  const head = headline(group.kind, first.daysBefore, first.hours);
  const lines = [`${CAL} <b>${esc(head)} · ${rows.length} իրադարձություն</b>`, ""];

  for (const r of rows) {
    const flag = r.event.flagged?.[r.ymd];
    // THE DATE, NOT JUST THE CLOCK.
    //
    // A list of bare times is only unambiguous when everything in it is
    // tomorrow. Warn three days ahead and "16:30" tells the reader nothing, so
    // the weekday is printed whenever the post is not about tomorrow.
    const when = first.daysBefore > 1
      ? `${esc(yerevanWeekday(r.ts))} ${esc(yerevanClock(r.ts))}`
      : esc(yerevanClock(r.ts));
    lines.push(
      `${impactMark(r.event.impact)} <b>${when}</b> · ${noOrphan(esc(r.event.name))}` +
      (flag ? ` <i>(${esc(flag)})</i>` : "")
    );
  }

  lines.push("", "<i>Ժամերը՝ Երևանի։ Արդյունքները կհրապարակվեն այս գրառման տակ։</i>");
  return fit(lines);
}

function renderOne(due, now) {
  const e = due.event;
  const soon = due.kind === "soon";

  // Header line: what kind of post, and how far away. This is also the chat
  // list preview and the notification text, which is why the time-distance
  // comes before the event name — «ՎԱՂԸ» is the part that varies and the part
  // the reader is deciding on.
  const lines = [`${CAL} <b>${esc(headline(due.kind, due.daysBefore, due.hours))} · ${noOrphan(esc(e.name))}</b>`];

  // Event line: the mark, the time, and the one detail that distinguishes this
  // occurrence from the others. 🕘 and 📍 used to sit here and were deleted —
  // both appeared on every warning ever sent, and a glyph that never varies
  // tells a reader nothing while spending a glyph-width of their attention.
  //
  // AND IT DOES NOT SAY «ՎԱՂԸ» TWICE. The header already carries the
  // time-distance; repeating it two lines down as «վաղը 23:00» was a
  // duplication the redesign had explicitly removed and the header/event split
  // quietly reintroduced. The bare clock is enough once the header has spoken —
  // except where the phrase genuinely disagrees with the header, which happens
  // when a three-hour reminder crosses midnight.
  const phrase = whenPhrase(due.ts, now);
  const echoed = (due.daysBefore === 1 && phrase.startsWith("վաղը")) || (soon && phrase.startsWith("այսօր"));
  const flag = e.flagged?.[due.ymd];
  lines.push(
    `${impactMark(e.impact)} <b>${esc(echoed ? yerevanClock(due.ts) : phrase)}</b> · Երևան` +
    // INDENTED, so it reads as a footnote to the time above it rather than as a
    // third unrelated fact starting at the same left edge. Non-breaking spaces
    // because Telegram will not trim those.
    (flag ? `\n   <i>${esc(flag)}</i>` : "")
  );

  // The channel's own framing, on the rail — the same boundary a news post
  // draws between what happened and what we think it means.
  if (!soon && e.note) lines.push("", `<blockquote>${esc(e.note)}</blockquote>`);

  // KEPT ON THE DAY-BEFORE POST, DROPPED FROM THE REMINDER.
  //
  // It is the promise that keeps someone subscribed rather than going to look
  // elsewhere at 23:00, so it earns its place on first contact with an event.
  // Repeating it three hours later, about the same event, to the same reader,
  // is the channel talking to itself.
  if (!soon) lines.push("", "<i>Արդյունքը կհրապարակվի այս գրառման տակ։</i>");

  return fit(lines);
}

/**
 * The Sunday overview.
 *
 * Includes the events that do not warn individually — the whole point of having
 * one post a week is that it is the complete picture, so a reader who wants to
 * know when the oil inventories land has somewhere to look without the channel
 * posting about oil inventories.
 */
export function renderDigest(window, now, events) {
  const occ = allOccurrences(window.from, window.to, events);

  // THE MONTH ONCE, NOT TWICE. «12 հոկտեմբերի — 18 հոկտեմբերի» is 44 columns
  // of which 12 are a repeated word, and this line is the notification text.
  // An unspaced en dash is what a range takes, and it is already what the body
  // copy uses for «3.75–4.00%».
  const a = partsInTz(window.from, CHANNEL_TZ);
  const b = partsInTz(window.to - 60_000, CHANNEL_TZ);
  const range = a.m === b.m && a.y === b.y
    ? `${a.d}–${esc(yerevanDate(window.to - 60_000))}`
    : `${esc(yerevanDate(window.from))} – ${esc(yerevanDate(window.to - 60_000))}`;
  const lines = [`${WEEK} <b>ԱՅՍ ՇԱԲԱԹԸ · ${range}</b>`];

  if (occ.length === 0) {
    lines.push("", "Այս շաբաթ նախատեսված տնտեսական իրադարձություն չկա օրացույցում։");
    return fit(lines);
  }

  // Grouped by day, because "Thursday has three things in it" is the shape a
  // reader actually plans around. This is the one post where the blank lines
  // are doing structural work rather than decorating.
  let currentDay = null;
  for (const o of occ) {
    const day = ymdInTz(o.ts, CHANNEL_TZ);
    if (day !== currentDay) {
      currentDay = day;
      lines.push("", `<b>${esc(yerevanWeekday(o.ts))}, ${esc(yerevanDate(o.ts))}</b>`);
    }
    const flag = o.event.flagged?.[o.ymd];
    lines.push(
      `${impactMark(o.event.impact)} ${esc(yerevanClock(o.ts))} · ${noOrphan(esc(o.event.name))}` +
      (flag ? ` <i>(${esc(flag)})</i>` : "")
    );
  }

  // THE LEGEND LIVES HERE AND NOWHERE ELSE.
  //
  // Once a week, in the post whose job is already to give an overview, in the
  // place a reader is being taught the system anyway. The words used to sit on
  // every individual post instead, which is how an ordinary news item came to
  // open by announcing «ՍՈՎՈՐԱԿԱՆ» in bold capitals.
  //
  // Counted for all three, or for none. It used to read «🔴 կարևոր՝ 1 · 🟠 միջին
  // · ⚪️ սովորական» — a count on the first and not the others, which looks like
  // an oversight because it was one.
  const n = (imp) => occ.filter((o) => o.event.impact === imp).length;
  // Built from the marks and the words the rest of the channel uses, rather
  // than typed out again here. The hard-coded copy had already drifted from the
  // exported one before anybody noticed.
  //
  // Non-breaking spaces INSIDE each triple, ordinary ones between them: the
  // count is the only thing this line exists to deliver, and it was wrapping
  // away from its own word — «●○○ սովորական՝ / 4 · ժամերը…».
  const NB = " ";
  const part = (imp) => `${impactMark(imp)}${NB}${LEVEL_WORDS[imp]}՝${NB}${n(imp)}`;
  lines.push("");
  lines.push(
    `<i>${part(IMPACT.HIGH)} · ${part(IMPACT.MEDIUM)} · ${part(IMPACT.LOW)} · ժամերը${NB}Երևանի${NB}են։</i>`
  );

  return fit(lines);
}

/**
 * The bot telling its owner that its own calendar is running out.
 *
 * Goes to the owner's private chat when TELEGRAM_ADMIN_CHAT_ID is set. Written
 * to be understandable by a reader who is not the owner anyway, because without
 * that secret it goes to the channel, and a message that looks like an internal
 * error would be worse than one that plainly says what is happening.
 */
export function renderExpiry(health, now) {
  const lines = [
    "⚙️ <b>ՕՐԱՑՈՒՅՑԻ ԾԱՆՈՒՑՈՒՄ</b>",
    "",
    "Այս ալիքի իրադարձությունների ցուցակը սպառվում է։ Ահա թե ինչ է մնացել՝",
    "",
  ];
  for (const r of health.rows) {
    if (!r.lastYmd) {
      lines.push(`• ${esc(r.event.name)} — <b>ամսաթիվ չի մնացել</b>`);
      continue;
    }
    // THE YEAR, when it is not this one. «8 դեկտեմբերի» for a date in 2027
    // reads as this December and sits next to «10 դեկտեմբերի (12 օր)», which
    // genuinely is. The day count gave it away; the date should not need to.
    const ts = Date.parse(`${r.lastYmd}T12:00:00Z`);
    const when = yerevanDate(ts, { withYear: true });
    // The event names contain their own em dashes («CFTC COT — ֆյուչերսների
    // …»), so a second one joining the name to its numbers produced two dashes
    // doing different jobs in one wrapped line. Split, and indent the detail.
    lines.push(`• ${esc(r.event.name)}`);
    lines.push(`\u00A0\u00A0\u00A0${r.remaining} ամսաթիվ, վերջինը՝ ${esc(when)} (${r.daysLeft} օր)`);
  }
  lines.push("");
  lines.push(
    "<blockquote>Fed-ը և ԵԿԲ-ն ամսաթվերը հրապարակում են երկու տարով, " +
    "BLS-ը՝ մեկ տարով, այդ պատճառով CPI-ն ու աշխատաշուկան առաջինն են սպառվում։ " +
    "Նոր ամսաթվերը ավելացվում են events.js ֆայլում։</blockquote>"
  );
  return fit(lines);
}

/** The line added to a news post that is the result of a warned event. */
export function threadNote(occurrence) {
  return `🧵 <i>Արդյունքը՝ ${noOrphan(esc(occurrence.event.name))}</i>`;
}
