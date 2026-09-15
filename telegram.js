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
export function renderPost({ summary, source, link, why }) {
  const lines = [`<b>${esc(summary.headline)}</b>`, "", esc(summary.what)];

  if (summary.why) lines.push("", `<i>${esc(summary.why)}</i>`);

  lines.push("", `📰 ${esc(source)} · <a href="${esc(link)}">կարդալ ամբողջը</a>`);
  if (why) lines.push(`<i>${esc(why)}</i>`);

  const text = lines.join("\n");
  return text.length > MAX_LEN ? `${text.slice(0, MAX_LEN - 1)}…` : text;
}

export async function sendMessage(token, chatId, text) {
  const res = await fetch(`${API}/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      // The preview would repeat the headline and the image under every post,
      // doubling its height for nothing the summary has not already said.
      link_preview_options: { is_disabled: true },
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
