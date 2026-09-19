// LOOK AT THE CALENDAR WITHOUT POSTING ANYTHING.
//
//   node calendar-check.mjs          the next 14 days
//   node calendar-check.mjs 60       the next 60 days
//
// No network, no key, no Telegram. This exists so the answer to "what is the
// bot going to post this week, and when do its dates run out" is one command
// rather than a guess — and so that adding new dates to events.js can be
// checked before they reach the channel.

import { EVENTS, CHANNEL_TZ } from "./events.js";
import {
  allOccurrences, warningMoments, calendarHealth, ymdInTz,
  yerevanClock, yerevanDate, yerevanWeekday, impactMark, whenPhrase,
  EXPIRY_WARN_DAYS,
} from "./calendar.js";

const days = Number(process.argv[2]) || 14;
const now = Date.now();
const to = now + days * 86_400_000;

console.log(`\n📅 ՕՐԱՑՈՒՅՑ · հաջորդ ${days} օրը · ժամերը Երևանի են`);
console.log("═".repeat(78));

const occ = allOccurrences(now, to, EVENTS);
let day = null;
for (const o of occ) {
  const d = ymdInTz(o.ts, CHANNEL_TZ);
  if (d !== day) {
    day = d;
    console.log("");
    console.log(`${yerevanWeekday(o.ts)}, ${yerevanDate(o.ts)}`);
  }
  const moments = o.event.warn ? warningMoments(o.event, o.ts) : [];
  const plan = moments.length
    ? moments.map((m) => whenPhrase(m.at, now)).join(" + ")
    : "— լուռ (warn: false)";
  console.log(
    `  ${impactMark(o.event.impact)} ${yerevanClock(o.ts)}  ${o.event.name.padEnd(46)} ⏰ ${plan}`
  );
}
if (occ.length === 0) console.log("\nԱյս ժամանակահատվածում իրադարձություն չկա։");

// How many posts this actually costs, counted rather than estimated.
//
// Two numbers, because they differ and the difference is the design: warnings
// that fall due at the same moment are sent as ONE post listing them, except
// for the high-impact ones, which always get a post to themselves.
let warnings = 0;
const groups = new Set();
for (const o of occ) {
  if (!o.event.warn) continue;
  for (const w of warningMoments(o.event, o.ts)) {
    warnings += 1;
    groups.add(o.event.impact === "HIGH" ? `${o.key}:${w.kind}` : `${w.kind}@${w.at}`);
  }
}
const weeks = Math.round(days / 7);
console.log("");
console.log("─".repeat(78));
console.log(
  `${occ.length} իրադարձություն · ${warnings} նախազգուշացում → ${groups.size} փոստ (խմբավորված) · ` +
  `${weeks} շաբաթական ակնարկ · օրական ~${((groups.size + weeks) / days).toFixed(1)}`
);

// --- the calendar's own runway ----------------------------------------------
console.log("");
console.log("ՕՐԱՑՈՒՅՑԻ ՊԱՇԱՐԸ");
console.log("─".repeat(78));
const health = calendarHealth(now, EVENTS);
for (const r of health.rows) {
  const flag = r.daysLeft < EXPIRY_WARN_DAYS ? "  ⚠️  ՆՈՐ ԱՄՍԱԹՎԵՐ ԳՐԵԼ events.js-ում" : "";
  console.log(
    `  ${r.event.short.padEnd(10)} ${String(r.remaining).padStart(3)} ամսաթիվ · ` +
    `վերջինը ${r.lastYmd} · ${String(r.daysLeft).padStart(4)} օր${flag}`
  );
}
console.log("");
console.log(
  health.ok
    ? `✅ Ամեն ցուցակ ${EXPIRY_WARN_DAYS} օրից ավել պաշար ունի։`
    : `⚠️  «${health.worst.event.short}»-ը սպառվում է ${health.worst.daysLeft} օրից։`
);
console.log(
  "   (Ժամկետների ավարտները հաշվարկվում են կանոնով՝ ամսվա վերջին ուրբաթ, և երբեք չեն սպառվում։)"
);
console.log("");
