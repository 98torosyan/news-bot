// POSTING TO THE CHANNEL.
//
// Telegram's HTML mode understands a very small set of tags — b, i, u, s, a,
// code, pre — and rejects the whole message with a 400 if anything else appears
// or if a stray "<" looks like a tag. Model output is not trusted to be safe
// HTML, so every piece of text that came from the model is escaped, and only
// the tags this file writes itself survive.

const API = "https://api.telegram.org";

/** Telegram's hard cap for a text message. */
const MAX_LEN = 4096;

export function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * ESCAPING FOR AN ATTRIBUTE, WHICH IS A DIFFERENT JOB.
 *
 * esc() is correct for text and wrong inside href="...", because it leaves the
 * double quote alone. A feed carrying a URL such as
 *
 *     https://example.com/x?q="b"&c=1
 *
 * produced <a href="https://example.com/x?q="b"&amp;c=1"> — the attribute ends
 * at the first quote inside it, the tag is malformed, Telegram answers 400, and
 * run.js logs the rejection and moves on WITHOUT remembering the story. So the
 * same broken link is re-summarised, at the cost of a paced Gemini call, and
 * re-rejected on every run for a day.
 *
 * The URL comes from an RSS feed, which is to say from outside, which is to say
 * it is not ours to trust.
 */
export function escAttr(s) {
  return esc(s).replace(/"/g, "&quot;");
}

/**
 * How much of the model's text is allowed through.
 *
 * Nothing upstream bounds these. parseSummary reads whatever the model wrote,
 * and a model that ignores its instructions can write four thousand characters.
 * Clamping here, per field and before any tag is added, is what makes the final
 * length guard unreachable in practice — and the final guard cutting blind
 * through the middle of a <b> is itself a 400 from Telegram.
 */
const MAX_HEADLINE = 200;
const MAX_WHAT = 1400;
const MAX_WHY = 400;

function clamp(s, n) {
  const t = String(s ?? "");
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`;
}

/**
 * One post.
 *
 * The attribution line is not decoration. Reposting someone else's reporting
 * without naming them is the thing that turns a news channel into a plagiarism
 * complaint, and the link is what makes this a summary rather than a
 * substitute for the original. Both are always present.
 *
 * The ranking's own explanation for why this story was chosen — the source
 * count and names — is what `evidenceLine()` below actually publishes, built
 * from `sourceCount`/`primary`/`sources`/`source`. An earlier version also
 * accepted a plain-English `why` string from rank.js's `scoreCluster()` for
 * the same purpose; `evidenceLine()` superseded it (it names sources rather
 * than just counting them) and the parameter was left in the signature,
 * accepted and silently dropped, for who knows how long. Removed here rather
 * than left as a trap for the next person who assumes passing `why` does
 * something.
 */
/**
 * A small visual marker so the channel does not read as one grey wall.
 *
 * Two categories only. A dozen finely-judged emoji would be decoration; two
 * tell a reader at a glance whether this is crypto's own news or the wider
 * economy leaning on it, which is a distinction they actually act on.
 */
function category(cat) {
  return cat === "MACRO" ? "Մակրո" : "Կրիպտո";
}

/**
 * THE IMPORTANCE MARK.
 *
 *   🟪🟪🟪  a primary source (Fed, SEC, ECB, BLS), or five or more independent
 *          newsrooms carried it
 *   🟪🟪⬜  three or more newsrooms, or a strong mid-tier report
 *   🟪⬜⬜  it cleared the bar and no more than that
 *
 * WHY NOT A TRAFFIC LIGHT, WHICH IS WHAT THIS WAS
 *
 *   🔴🟠⚪️ failed on four counts, and two independent design reviews reached
 *   the same conclusion separately.
 *
 *   It read as an ALARM. The red circle is the most alarm-coded glyph in the
 *   set — record button, alert, fault — and a news channel is not a fault list.
 *   Karen said the markers felt like warnings, and she was right about the
 *   cause.
 *
 *   Red and orange differ by HUE ALONE — not shape, not size, not weight. At
 *   reading size in peripheral vision they are two warm dots, and red/orange is
 *   the single worst pair there is for the commonest form of colour blindness.
 *   ⚪️ is nearly invisible on a light theme and blown out on a dark one.
 *
 *   And it keeps red in reserve. If every routine Fed meeting is red, nothing
 *   is left for the day something actually breaks.
 *
 * WHY A SINGLE HUE, NOT A SECOND TRAFFIC LIGHT
 *
 *   ●●○ replaced the circles above and solved every one of those problems by
 *   being plain text — but Karen asked for the mark to carry the channel's own
 *   colour rather than whatever colour the reader's theme happens to render
 *   bullets in. A second attempt at colour has to avoid the exact mistake the
 *   first one made: HUE must never be the thing doing the work.
 *
 *   🟪⬜⬜ still varies by FILL, the same ordinal signal ●○○ used — one purple
 *   square is visibly less than three without anyone having to learn which
 *   colour outranks which. There is exactly one hue in the whole system, so
 *   there is no red/green or red/orange pair for colour blindness to collapse,
 *   and nothing here reads as a fault — purple carries none of red's alarm
 *   association.
 *
 *   🟪 and ⬜ ARE emoji, unlike ● and ○ before them — but both have
 *   Emoji_Presentation=Yes (unlike 🗓 and 🏛 elsewhere in this file), so they
 *   render in colour on every client with no variation selector needed and no
 *   missing-glyph risk. The failure this file has spent the most words
 *   guarding against is a glyph whose INTERPRETATION drifts between phones —
 *   a face, an object, a coloured circle that reads as an alert on one client
 *   and a bullet on another. A flat coloured square carries no such second
 *   reading to drift into.
 *
 * WHY <code> AROUND IT
 *
 *   <code> is one of the tags Telegram's own client already understands, and
 *   Telegram draws it as a small, rounded, light-grey chip — a real visual
 *   distinction the app itself renders, not a colour or a background this file
 *   fakes with characters. Wrapping the squares in it turns three emoji into
 *   one small badge instead of three characters floating loose in the line.
 *
 * WHAT THIS IS NOT
 *
 *   Not the model's opinion of the story, and not a guess about the price. Two
 *   counts — which sources, and how many — with the evidence printed directly
 *   underneath, where a reader can check the mark against the names.
 */
const MARKS = {
  HIGH: "<code>🟪🟪🟪</code>",
  MEDIUM: "<code>🟪🟪⬜</code>",
  LOW: "<code>🟪⬜⬜</code>",
};

export function band(importance) {
  return MARKS[importance] ?? MARKS.LOW;
}

/**
 * The words for each level, which live in ONE place: the Sunday legend, built
 * by renderDigest from this map.
 *
 * They used to sit on every post, in bold capitals, in the most prominent slot
 * available. Which meant the channel opened an ordinary post by announcing
 * «ՍՈՎՈՐԱԿԱՆ» — telling the reader, in the largest type on the screen, not to
 * bother. Nobody writes "this one is filler" at the top of their own copy.
 *
 * The word teaches the mark exactly once. After that it is the mark spelled
 * out, in the space the headline should be occupying.
 *
 * Exported as data rather than as a finished sentence because the digest needs
 * to interleave counts. The first version exported the sentence, the digest
 * hard-coded its own near-copy, and the two were already different by the time
 * anyone looked.
 */
export const LEVEL_WORDS = { HIGH: "կարևոր", MEDIUM: "միջին", LOW: "սովորական" };

/**
 * The line that lets a reader check the band instead of trusting it.
 *
 * A primary source is NAMED. "1 աղբյուր՝ Federal Reserve" reads as a confession
 * — one lonely source — when it is the opposite: the institution that made the
 * news said so itself, and there is nothing to corroborate it against.
 */
export function evidenceLine({ sourceCount = 0, primary = [], sources = [], source = null }) {
  // "ևս N" MEANS "N MORE THAN THE ONES ALREADY NAMED ON THIS LINE", and the
  // link at the head of the line is one of them.
  //
  // This counted `sourceCount - primary.length`, which is right only when the
  // linked outlet IS the primary source. It usually is not: the wire services
  // republish the Fed within minutes and the cluster's lead is the NEWEST item,
  // so the post links CoinDesk and names the Fed. The line then read
  // «CoinDesk · պաշտոնական աղբյուր՝ Federal Reserve · ևս 1 աղբյուր» — and that
  // "1 more" was CoinDesk, already named as the link. A two-source story
  // publishing itself as three. The channel's one rule is that it does not
  // invent numbers, and this invented one on most primary-source posts.
  const named = new Set([source, ...primary].filter(Boolean));
  const rest = (sources.length ? sources : []).filter((s) => !named.has(s));
  const more = sources.length ? rest.length : Math.max(0, sourceCount - named.size);

  if (primary.length > 0) {
    // DO NOT SAY THE NAME TWICE. Naming the primary source is only worth the
    // characters when it is NOT the outlet being linked.
    const toName = primary.filter((p) => p !== source);
    const label = toName.length > 0 ? `պաշտոնական աղբյուր՝ ${toName.join(", ")}` : "պաշտոնական աղբյուր";
    return label + (more > 0 ? ` · ևս ${more} աղբյուր` : "");
  }

  if (more > 0) {
    // NAME THEM, DO NOT JUST COUNT THEM. It used to print the ranking's own
    // sentence, «3 աղբյուր՝ CoinDesk, Decrypt, Protos» — with CoinDesk already
    // the link two items to the left. Same stutter, same line, untreated.
    return rest.length ? `ևս ${more} աղբյուր՝ ${rest.join(", ")}` : `ևս ${more} աղբյուր`;
  }
  return null;
}

/**
 * A NON-BREAKING SPACE BEFORE THE LAST WORD, so a line does not wrap leaving
 * one short word stranded on its own.
 *
 * «●●● Fed-ը իջեցրեց տոկոսադրույքը 25 բազիսային / կետով» — five characters
 * alone on a second line under a full first one. It is the commonest ugly thing
 * a phone does to a headline, and the only lever available without touching
 * what the model wrote. Unlike a character limit it works at every screen width
 * and every font size.
 *
 * Guarded so it can never glue two long words into something that overflows
 * and makes the wrap worse than it was.
 */
export function noOrphan(s) {
  const t = String(s);
  const i = t.lastIndexOf(" ");
  if (i < 0) return t;
  const last = t.slice(i + 1);
  const prev = t.slice(0, i).split(" ").pop() ?? "";
  if (last.length > 12 || last.length + prev.length > 22) return t;
  return `${t.slice(0, i)} ${last}`;
}

export function renderPost({
  summary, source, link, cat,
  sourceCount = 0, importance = "LOW", primary = [], sources = [], thread = null,
  priceLine = null,
}) {
  // THE HEADLINE IS THE FIRST LINE. This is the whole redesign in one rule.
  //
  // Telegram's chat list and its push notification both show the START of the
  // message, with every tag stripped — bold does nothing there. So whatever
  // occupies line one is what a subscriber reads on a lock screen, and for most
  // subscribers it is the only thing they ever read.
  //
  // That line used to say «🔴 ԿԱՐԵՎՈՐ · 🏛 Մակրո»: eighteen characters of the
  // channel's own filing system, ahead of the news. On an ordinary post it was
  // «⚪️ ՍՈՎՈՐԱԿԱՆ · 🪙 Կրիպտո» — nine characters spent telling the reader this
  // one was not worth opening, placed in front of the only sentence in it.
  //
  // The mark stays, as a prefix on the headline line. It costs no vertical
  // space there and the notification now reads «●●● Fed-ը իջեցրեց…».
  const lines = [
    `${band(importance)} <b>${noOrphan(esc(clamp(summary.headline, MAX_HEADLINE)))}</b>`,
    "",
    esc(clamp(summary.what, MAX_WHAT)),
  ];

  // THE PRICE, WHEN THE STORY NAMES A COIN.
  //
  // Placed right under the facts and above the channel's own interpretation —
  // a number belongs with the other things that are simply true, not mixed
  // into the sentence explaining what the channel thinks it means. Italic to
  // match this file's existing convention for secondary, non-model text (the
  // attribution line below uses the same styling for the same reason).
  if (priceLine) lines.push("", `<i>${esc(priceLine)}</i>`);

  // THE CHANNEL'S OWN READ, SET APART.
  //
  // «Էժան փողը պատմականորեն աջակցում է ռիսկային ակտիվներին» is not something
  // the Fed said. It is this channel's interpretation, and it used to sit in
  // exactly the same type as the sourced facts above it, distinguished only by
  // italics that most readers would not register as a claim boundary.
  //
  // Telegram's <blockquote> draws a vertical rail down the left of the block.
  // One glance separates "this is what happened" from "this is what we think it
  // means", every time, in the same place. For a channel whose entire claim is
  // that it does not invent, that boundary is worth more than the decoration.
  if (summary.why) lines.push("", `<blockquote>${esc(clamp(summary.why, MAX_WHY))}</blockquote>`);

  // ONE ATTRIBUTION LINE, NOT TWO.
  //
  // It used to be «📰 Federal Reserve · կարդալ ամբողջը» and then «պաշտոնական
  // աղբյուր՝ Federal Reserve · ևս 2 աղբյուր» underneath — the same name twice,
  // in near-identical register, stacked. And 📰 appeared on every news post
  // ever sent, which is another way of saying it carried no information.
  //
  // The source name IS the link now. That is what a link is for.
  const tail = [category(cat)];
  const evidence = evidenceLine({ sourceCount, primary, sources, source });
  if (evidence) tail.push(evidence);
  // ATTRIBUTION IS NOT DROPPABLE. fit() trims from the end, and this redesign
  // put the source and the link at the end — so the one line run.js promises
  // never to omit became the first thing thrown overboard. Marked, and fit()
  // keeps marked lines whatever else it has to drop.
  lines.push("", KEEP + `<a href="${escAttr(link)}">${esc(source)}</a> · <i>${esc(tail.join(" · "))}</i>`);

  // THE THREAD LINE, LAST.
  //
  // When this story is the outcome of an event the channel warned about, the
  // post is also sent as a reply to that warning, so Telegram draws the link
  // between them. The line is for the reader who sees the post in a
  // notification, where the reply relationship is not visible — and it belongs
  // at the bottom with the other provenance, not wedged between the summary and
  // the sentence explaining why it matters, which is where it was first put.
  if (thread) lines.push(thread);

  return fit(lines);
}

/**
 * Join the lines and keep the result inside Telegram's cap WITHOUT cutting
 * through a tag.
 *
 * The old version sliced at 4095 characters wherever that landed, which for a
 * long field ended the message with an unclosed <b> or <i>. Telegram rejects
 * the whole message with a 400, and the post is lost. Dropping whole lines from
 * the end cannot produce an unbalanced tag, because every tag this file writes
 * opens and closes on one line.
 *
 * With the per-field clamps above this should never trigger. It is here because
 * "should never" is how the last one got through.
 */
export function fit(lines, max = MAX_LEN) {
  let out = [...lines];

  // DROP THE DROPPABLE FIRST, from the end, and never the attribution.
  //
  // Popping blindly from the end was correct when the source line sat in the
  // middle. After the redesign moved it to the bottom, a post long enough to
  // trim lost its source and its link — while keeping the channel's own
  // opinion on the blockquote rail above. Exactly backwards, and against
  // run.js's own stated rule that nothing is published without naming the
  // source and linking the original. It took roughly 800 escaped ampersands in
  // one summary to reach, which a model echoing HTML can produce.
  const droppable = () => out.map((l, i) => [l, i]).filter(([l]) => !l.startsWith(KEEP)).map(([, i]) => i);
  while (render(out).length > max) {
    const idx = droppable();
    if (idx.length === 0) break;
    out.splice(idx[idx.length - 1], 1);
  }

  // Only protected lines left and still over the cap — which needs a link of a
  // few thousand characters, so it should be unreachable. Cut at a LINE
  // boundary rather than mid-string: every tag this file writes opens and
  // closes on one line, so a whole number of lines is always balanced, and a
  // blind slice is what produced the unclosed <b> that Telegram rejects.
  const text = render(out);
  if (text.length <= max) return text;
  const cut = text.lastIndexOf("\n", max - 1);
  return cut > 0 ? text.slice(0, cut) : text.slice(0, max);
}

/** The marker that means "this line is never dropped". Stripped on render. */
const KEEP = "\u0000";
const render = (lines) => lines.map((l) => (l.startsWith(KEEP) ? l.slice(1) : l)).join("\n");

export async function sendMessage(token, chatId, text, { previewUrl = null, replyTo = null, silent = false } = {}) {
  // THE PICTURE.
  //
  // The first version disabled the preview outright, because underneath the
  // text it repeated the headline and doubled the post's height for nothing.
  // That was the right complaint and the wrong fix: the channel then read as a
  // wall of grey text and, in Karen's words, caught no one's eye in the feed.
  //
  // The preview can sit ABOVE the text instead, at full width. Then it is not a
  // repetition below the summary, it is the photograph a news post opens with.
  //
  // Two details that are easy to get wrong:
  //   - `url` must be passed EXPLICITLY. Telegram's documentation is clear that
  //     prefer_large_media is disregarded when the URL is only inferred from
  //     the message text, so leaving it out silently gives a small preview.
  //   - This is a LINK PREVIEW, not a copied image. Telegram fetches it from
  //     the publisher, exactly as it would for anyone sharing the link. Copying
  //     a news outlet's photo into the channel would be a different act, and a
  //     riskier one — their photos are frequently licensed, and a summary with
  //     attribution is fair in a way that republishing a Getty image is not.
  //
  // NOT EVERY SOURCE LINK IS A PHOTOGRAPH.
  //
  // Central banks in particular publish speeches and statements as a bare
  // .pdf (an ECB speech is a URL that ends in .en.pdf, not an HTML page).
  // Telegram still "fetches it from the publisher" as promised above, but a
  // PDF has no picture to show — Telegram renders it as a document card
  // instead: a file icon, the filename, the byte count, sitting where a
  // photograph was supposed to open the post. That is worse than no preview
  // at all, so a link ending in .pdf is treated the same as no link.
  const isPdfLink = (url) => /\.pdf(?:[?#]|$)/i.test(url);
  const usablePreviewUrl = previewUrl && !isPdfLink(previewUrl) ? previewUrl : null;
  const preview = usablePreviewUrl
    ? { url: usablePreviewUrl, prefer_large_media: true, show_above_text: true }
    : { is_disabled: true };

  const body = {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    link_preview_options: preview,
    // THE MARK DECIDES WHETHER THE PHONE BUZZES.
    //
    // The post still arrives, still sits in the channel, still shows in the
    // chat list — it just makes no sound. Which turns the three-level scale
    // from a label into a promise about someone's evening: ●●● wakes you, ●○○
    // waits for you. Notification noise is the main reason people leave a
    // channel, and it is the only cost this one imposes on a person who is not
    // reading it.
    disable_notification: silent === true,
  };

  // REPLYING TO THE WARNING.
  //
  // `allow_sending_without_reply` matters more than it looks. The warning it
  // points at may have been deleted by then, or be older than the channel's
  // history if the channel was migrated. Without this flag Telegram rejects the
  // whole message with a 400 and the news post is lost — trading a real post
  // for a decorative thread line. With it, the post goes out unthreaded.
  if (replyTo) {
    body.reply_parameters = { message_id: replyTo, allow_sending_without_reply: true };
  }

  const post = async (payload) => {
    let res;
    try {
      res = await fetch(`${API}/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch (e) {
      // A DROPPED CONNECTION COSTS ONE MESSAGE, NOT THE RUN.
      //
      // There was no try here at all, so an ECONNRESET or a DNS blip threw
      // straight out of runCalendar, past main, into process.exit(1) — every
      // remaining warning skipped and the news half never running. ai.js wraps
      // every network call for exactly this reason; this one did not.
      //
      // And it is UNKNOWN, not failed: the request may well have been
      // delivered before the connection died. See the note below.
      return { ok: false, unknown: true, why: `ցանց՝ ${e?.message ?? e}` };
    }

    let json = null;
    let parsed = true;
    try {
      json = await res.json();
    } catch {
      parsed = false;
    }

    if (parsed && json?.ok === true) return { ok: true, messageId: json.result?.message_id };

    // DELIVERED-BUT-UNREADABLE IS NOT THE SAME AS REJECTED.
    //
    // Telegram answering 2xx means it accepted the message. If the body then
    // cannot be parsed — a truncated response, an edge node returning an HTML
    // page after acceptance — the old code called it a failure, run.js logged
    // «Telegram-ը մերժեց» and recorded nothing, and thirty minutes later the
    // same post went out again. Reproduced end to end.
    //
    // So this reports `unknown`, and the caller records it without a message
    // id. Losing the ability to thread a result onto that warning is a much
    // smaller harm than publishing it twice, and "never post twice" is the
    // promise this project keeps having to defend.
    if (res.ok) return { ok: false, unknown: true, why: parsed ? "պատասխանը անընթեռնելի էր" : `HTTP ${res.status}՝ պատասխանը անընթեռնելի էր` };

    return { ok: false, why: json?.description ?? `HTTP ${res.status}` };
  };

  const first = await post(body);
  if (first.ok) return first;

  // ONE RETRY WITHOUT THE RAIL, AND ONLY FOR A PARSING COMPLAINT.
  //
  // <blockquote> arrived in Bot API 7.0 and is long since standard, so this
  // should never fire. It exists because the cost of being wrong is not a
  // missing rail — Telegram rejects the WHOLE message on a tag it does not
  // understand, and the post is simply lost. A channel that quietly stops
  // publishing is the failure mode this project keeps having to design out.
  //
  // Narrow on purpose: a rate limit, a bad token or a blocked chat must not be
  // retried into a second failure.
  // Narrow on purpose, and narrower than it was: /tag/ alone matched any
  // description with "tag" inside a word, and an `unknown` result must never be
  // retried at all, because the first attempt may already be in the channel.
  if (!first.unknown && /can't parse|unsupported start tag|unclosed|entities/i.test(String(first.why))) {
    const plain = { ...body, text: stripBlockquotes(body.text) };
    if (plain.text !== body.text) {
      const second = await post(plain);
      if (second.ok) return { ...second, degraded: "blockquote" };
      return second;
    }
  }
  return first;
}

/**
 * Keeps the words, drops the rail. Used only by the retry above.
 *
 * The opener pattern matches any attributes, not just the bare `expandable`
 * this file happens to write today. Matching only the exact form it writes
 * meant that the day anyone wrote `<blockquote expandable="true">` the opener
 * survived and the closer did not — and the retry, whose whole job is to
 * recover from a parse error, would send an unclosed tag and earn a second one.
 */
export function stripBlockquotes(text) {
  return String(text).replace(/<blockquote\b[^>]*>/g, "").replace(/<\/blockquote>/g, "");
}

/** Confirms the token works and names the bot, without posting anything. */
export async function getMe(token) {
  const res = await fetch(`${API}/bot${token}/getMe`);
  const json = await res.json().catch(() => null);
  if (!res.ok || json?.ok !== true) return { ok: false, why: json?.description ?? `HTTP ${res.status}` };
  return { ok: true, username: json.result?.username };
}
