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
 * One post.
 *
 * The attribution line is not decoration. Reposting someone else's reporting
 * without naming them is the thing that turns a news channel into a plagiarism
 * complaint, and the link is what makes this a summary rather than a
 * substitute for the original. Both are always present.
 *
 * `why` carries the ranking's own explanation — the source count that caused
 * this story to be chosen. Publishing it makes the channel's editorial policy
 * visible to its readers, not just to whoever reads the code.
 */
/**
 * A small visual marker so the channel does not read as one grey wall.
 *
 * Two categories only. A dozen finely-judged emoji would be decoration; two
 * tell a reader at a glance whether this is crypto's own news or the wider
 * economy leaning on it, which is a distinction they actually act on.
 */
function mark(cat) {
  return cat === "MACRO" ? "🏛" : "🪙";
}

export function renderPost({ summary, source, link, why, cat }) {
  const lines = [`${mark(cat)} <b>${esc(summary.headline)}</b>`, "", esc(summary.what)];

  if (summary.why) lines.push("", `<i>${esc(summary.why)}</i>`);

  lines.push("", `📰 ${esc(source)} · <a href="${esc(link)}">կարդալ ամբողջը</a>`);
  if (why) lines.push(`<i>${esc(why)}</i>`);

  const text = lines.join("\n");
  return text.length > MAX_LEN ? `${text.slice(0, MAX_LEN - 1)}…` : text;
}

export async function sendMessage(token, chatId, text, { previewUrl = null } = {}) {
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
  const preview = previewUrl
    ? { url: previewUrl, prefer_large_media: true, show_above_text: true }
    : { is_disabled: true };

  const res = await fetch(`${API}/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      link_preview_options: preview,
    }),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || json?.ok !== true) {
    return { ok: false, why: json?.description ?? `HTTP ${res.status}` };
  }
  return { ok: true, messageId: json.result?.message_id };
}

/** Confirms the token works and names the bot, without posting anything. */
export async function getMe(token) {
  const res = await fetch(`${API}/bot${token}/getMe`);
  const json = await res.json().catch(() => null);
  if (!res.ok || json?.ok !== true) return { ok: false, why: json?.description ?? `HTTP ${res.status}` };
  return { ok: true, username: json.result?.username };
}
