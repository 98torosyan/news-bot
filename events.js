// THE CALENDAR'S DATA — what happens, when, and whether it is worth a warning.
//
// WHY A FILE AND NOT A SCRAPER
//
//   Every one of these dates comes from an official page: federalreserve.gov,
//   ecb.europa.eu, bls.gov. A scraper pointed at those pages would be the
//   obvious design and the wrong one. The pages change layout once or twice a
//   year, the dates change once or twice a year, and a scraper that breaks does
//   not announce it — it returns an empty list and the channel simply stops
//   warning about anything. Silence that looks like "no events this week" is
//   the worst failure this project can have, and we have already been bitten by
//   exactly that shape of bug once, in the price feed.
//
//   A file cannot break silently. It can only run out, and running out is
//   VISIBLE: calendarHealth() in calendar.js counts the days left and makes the
//   bot warn its own owner before the last date passes.
//
// WHY NO TIMES ARE WRITTEN IN YEREVAN TIME
//
//   Every time below is stored as it is published — local to the institution —
//   together with its IANA timezone. Nothing here is converted by hand. The
//   United States and the European Union both change clocks, on different
//   weekends, and Armenia does not change at all: a hand-computed "21:00
//   Yerevan" for an FOMC decision is correct for eight months of the year and
//   an hour wrong for the other four. Node's own timezone database does the
//   conversion at render time and is never wrong about it.
//
// THE `warn` SWITCH
//
//   One word per event. `warn: false` keeps the event in the weekly overview
//   but stops it sending a post of its own. Nothing else has to change, and no
//   code has to be touched, if the channel ever feels too busy.

/** Everything the reader sees is in this zone. Armenia does not use DST. */
export const CHANNEL_TZ = "Asia/Yerevan";

/**
 * HIGH   moves the market on its own, and people position ahead of it.
 * MEDIUM watched, occasionally moves things.
 * LOW    routine; context rather than an event.
 */
export const IMPACT = { HIGH: "HIGH", MEDIUM: "MEDIUM", LOW: "LOW" };

export const EVENTS = [
  // ── HIGH ────────────────────────────────────────────────────────────────

  {
    id: "fomc",
    name: "Fed-ի տոկոսադրույքի որոշում (FOMC)",
    short: "FOMC",
    impact: IMPACT.HIGH,
    warn: true,
    warnDaysBefore: [1],
    sameDayHoursBefore: 3,
    tz: "America/New_York",
    time: "14:00",
    note: "Որոշումից 30 րոպե անց՝ Փաուելի ասուլիսը, որը հաճախ ավելի շատ է շարժում շուկան, քան ինքը որոշումը։",
    // Source: federalreserve.gov/monetarypolicy/fomccalendars.htm
    // The date is the SECOND day of the meeting — when the statement comes out.
    recur: {
      kind: "fixed",
      dates: [
        "2026-09-16", "2026-10-28", "2026-12-09",
        "2027-01-27", "2027-03-17", "2027-04-28", "2027-06-09",
        "2027-07-28", "2027-09-15", "2027-10-27", "2027-12-08",
      ],
    },
    // Meetings that also publish the Summary of Economic Projections — the dot
    // plot. Those matter more than the rate decision itself when no change is
    // expected, because the forecast is the news.
    flagged: {
      "2026-09-16": "SEP · կանխատեսումների ամփոփում (dot plot)",
      "2026-12-09": "SEP · կանխատեսումների ամփոփում (dot plot)",
      "2027-03-17": "SEP · կանխատեսումների ամփոփում (dot plot)",
      "2027-06-09": "SEP · կանխատեսումների ամփոփում (dot plot)",
      "2027-09-15": "SEP · կանխատեսումների ամփոփում (dot plot)",
      "2027-12-08": "SEP · կանխատեսումների ամփոփում (dot plot)",
    },
    keywords: ["fomc", "fed", "federal", "reserve", "powell", "rate", "rates", "interest", "hike", "cut", "dot", "plot"],
  },

  {
    id: "cpi",
    name: "ԱՄՆ գնաճ (CPI)",
    short: "CPI",
    impact: IMPACT.HIGH,
    warn: true,
    warnDaysBefore: [1],
    sameDayHoursBefore: 3,
    tz: "America/New_York",
    time: "08:30",
    note: "Գնաճի թիվն է, որ որոշում է՝ Fed-ը կիջեցնի՞ տոկոսադրույքը։ Անակնկալը սովորաբար արագ է հասնում կրիպտոյին։",
    // Source: bls.gov/schedule/news_release/cpi.htm — BLS publishes one year at
    // a time, so this list is the shortest one here and expires first.
    recur: {
      kind: "fixed",
      dates: ["2026-10-14", "2026-11-10", "2026-12-10"],
    },
    keywords: ["cpi", "inflation", "consumer", "price", "index", "core", "disinflation"],
  },

  {
    id: "nfp",
    name: "ԱՄՆ աշխատաշուկա (Nonfarm Payrolls)",
    short: "NFP",
    impact: IMPACT.HIGH,
    warn: true,
    warnDaysBefore: [1],
    sameDayHoursBefore: 3,
    tz: "America/New_York",
    time: "08:30",
    note: "Ամսվա նոր աշխատատեղերն ու գործազրկության մակարդակը։ Ուժեղ թիվը նշանակում է՝ Fed-ը շտապելու պատճառ չունի։",
    // Source: bls.gov/schedule/news_release/empsit.htm
    recur: {
      kind: "fixed",
      dates: ["2026-10-02", "2026-11-06", "2026-12-04"],
    },
    keywords: ["payrolls", "nonfarm", "jobs", "employment", "unemployment", "labor", "labour", "hiring"],
  },

  {
    id: "ecb",
    name: "ԵԿԲ-ի տոկոսադրույքի որոշում",
    short: "ECB",
    impact: IMPACT.HIGH,
    warn: true,
    warnDaysBefore: [1],
    sameDayHoursBefore: 3,
    tz: "Europe/Berlin",
    time: "14:15",
    note: "Որոշումից 30 րոպե անց՝ Լագարդի ասուլիսը։ Եվրոպան կրիպտոյի վրա ազդում է հիմնականում դոլարի փոխարժեքի միջոցով։",
    // Source: ecb.europa.eu/press/calendars — monetary policy meetings only.
    // The date is the day of the decision, not the first day of the meeting.
    recur: {
      kind: "fixed",
      dates: [
        "2026-10-29", "2026-12-17",
        "2027-02-04", "2027-03-18", "2027-04-29", "2027-06-10",
        "2027-07-22", "2027-09-09", "2027-10-28", "2027-12-16",
      ],
    },
    keywords: ["ecb", "lagarde", "euro", "eurozone", "deposit", "rate", "european", "central"],
  },

  {
    id: "expiry-quarterly",
    name: "Եռամսյակային օպցիոնների ժամկետի ավարտ",
    short: "Q-expiry",
    impact: IMPACT.HIGH,
    warn: true,
    warnDaysBefore: [1],
    tz: "UTC",
    time: "08:00",
    note: "Տարվա չորս ամենամեծ ժամկետները։ Միլիարդավոր դոլարի դիրքեր են փակվում, և գինը հաճախ «կպչում» է ամենամեծ ծավալի մակարդակին։",
    // COMPUTED, not listed. Exchanges settle on the last Friday of the quarter
    // and have for years; a rule cannot go stale the way a list of dates can,
    // so this part of the calendar never needs refreshing.
    recur: { kind: "quarterlyLastFriday" },
    keywords: ["expiry", "expiration", "options", "deribit", "settlement", "quarterly", "max", "pain"],
  },

  // ── MEDIUM ──────────────────────────────────────────────────────────────

  {
    id: "expiry-monthly",
    name: "Ամսական օպցիոնների ժամկետի ավարտ",
    short: "M-expiry",
    impact: IMPACT.MEDIUM,
    warn: true,
    warnDaysBefore: [1],
    tz: "UTC",
    time: "08:00",
    note: "Ամսվա ամենամեծ ժամկետը։ Եռամսյակայինից փոքր է, բայց շաբաթականից զգալի մեծ։",
    recur: { kind: "monthlyLastFriday", exceptQuarterEnd: true },
    keywords: ["expiry", "expiration", "options", "deribit", "settlement", "monthly"],
  },

  {
    id: "cot",
    name: "CFTC COT — ֆյուչերսների դիրքերի հաշվետվություն",
    short: "COT",
    impact: IMPACT.MEDIUM,
    warn: true,
    warnDaysBefore: [1],
    tz: "America/New_York",
    time: "15:30",
    note: "Ցույց է տալիս, թե խոշոր խաղացողները long են, թե short։ Ներառում է Bitcoin-ի ֆյուչերսները։ Տվյալները երեքշաբթի օրվանն են, այսինքն՝ երեք օր ուշացած։",
    recur: { kind: "weekly", weekday: 5 },
    keywords: ["cot", "cftc", "commitments", "traders", "positioning", "futures", "speculators"],
  },

  {
    id: "h41",
    name: "Fed-ի հաշվեկշիռ (H.4.1)",
    short: "H.4.1",
    impact: IMPACT.MEDIUM,
    warn: true,
    warnDaysBefore: [1],
    tz: "America/New_York",
    time: "16:30",
    note: "Շաբաթական իրացվելիության պատկերը՝ որքան դոլար կա համակարգում։ Ոչ մի շաբաթ չի շարժում շուկան, բայց ուղղությունը կարևոր է։",
    recur: { kind: "weekly", weekday: 4 },
    keywords: ["balance", "sheet", "liquidity", "reserves", "repo", "qt", "quantitative", "tightening"],
  },

  // ── LOW ─────────────────────────────────────────────────────────────────

  {
    id: "jobless",
    name: "ԱՄՆ գործազրկության նոր դիմումներ",
    short: "Jobless claims",
    impact: IMPACT.LOW,
    warn: true,
    warnDaysBefore: [1],
    tz: "America/New_York",
    time: "08:30",
    note: "Աշխատաշուկայի ամենաարագ ցուցանիշը՝ ամեն շաբաթ։ Մեկ շաբաթը քիչ բան է ասում, միտումը՝ շատ։",
    recur: { kind: "weekly", weekday: 4 },
    keywords: ["jobless", "claims", "initial", "unemployment", "benefits"],
  },

  {
    id: "expiry-weekly",
    name: "Deribit-ի շաբաթական օպցիոնների ժամկետ",
    short: "Weekly expiry",
    impact: IMPACT.LOW,
    warn: true,
    warnDaysBefore: [1],
    tz: "UTC",
    time: "08:00",
    note: "Ամեն ուրբաթ։ Փոքր ծավալ, բայց երբեմն բավական է ուրբաթ առավոտյան կարճ շարժման համար։",
    // The monthly and quarterly expiries fall on a Friday too. `skipIfAlso`
    // stops the channel announcing the same morning three times.
    recur: { kind: "weekly", weekday: 5 },
    skipIfAlso: ["expiry-monthly", "expiry-quarterly"],
    keywords: ["expiry", "expiration", "options", "deribit", "weekly"],
  },

  // ── ՆԱՎԹ — ցուցակում են, բայց լռում են ───────────────────────────────────
  //
  // These two are genuinely weekly, genuinely scheduled, and have almost
  // nothing to do with crypto. Left in the file so the weekly overview is a
  // complete picture of the week, and left with `warn: false` so they do not
  // spend 104 posts a year on the oil market. Change `false` to `true` in
  // either line and they start warning like everything else.

  {
    id: "eia",
    name: "EIA — ԱՄՆ նավթի պաշարներ",
    short: "EIA",
    impact: IMPACT.LOW,
    warn: false,
    warnDaysBefore: [1],
    tz: "America/New_York",
    time: "10:30",
    note: "Նավթի շաբաթական պաշարները։ Էներգիայի շուկայի համար է, կրիպտոյին ուղղակի կապ գրեթե չունի։",
    recur: { kind: "weekly", weekday: 3 },
    keywords: ["eia", "crude", "oil", "inventories", "petroleum"],
  },

  {
    id: "rigs",
    name: "Baker Hughes — հորատող սարքերի թիվ",
    short: "Rig count",
    impact: IMPACT.LOW,
    warn: false,
    warnDaysBefore: [1],
    tz: "America/New_York",
    time: "13:00",
    note: "Նավթի արդյունահանման ցուցանիշ։ Այստեղ է՝ շաբաթը ամբողջական տեսնելու համար։",
    recur: { kind: "weekly", weekday: 5 },
    keywords: ["baker", "hughes", "rig", "rigs", "drilling"],
  },
];

/** Events that could ever send a post of their own. */
export function warningEvents() {
  return EVENTS.filter((e) => e.warn);
}

export function eventById(id) {
  return EVENTS.find((e) => e.id === id) ?? null;
}
