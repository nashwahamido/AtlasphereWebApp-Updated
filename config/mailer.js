// ── EMAIL (Brevo transactional HTTP API) ─────────────────────────────────
// Sends over HTTPS (port 443) so it works on Railway, which blocks the
// outbound SMTP ports (25/465/587). Configure via env:
//   BREVO_API_KEY   — transactional API key from your Brevo account
//   MAIL_FROM       — sender email verified in Brevo (e.g. "Atlasphere" <you@example.com> or you@example.com)
//   MAIL_FROM_NAME  — optional display name (defaults to "Atlasphere")
//   MAIL_REPLY_TO   — optional reply-to address (replies are a trust signal)
const axios = require("axios");

const BREVO_ENDPOINT = "https://api.brevo.com/v3/smtp/email";

// Accept either a plain email ("you@example.com") or the display-name form
// ('"Atlasphere" <you@example.com>') in MAIL_FROM.
function parseSender() {
  const raw = (process.env.MAIL_FROM || "").trim();
  const nameEnv = process.env.MAIL_FROM_NAME;
  const match = raw.match(/^\s*"?([^"<]*)"?\s*<\s*([^>]+)\s*>\s*$/);
  if (match) {
    return { name: (nameEnv || match[1].trim() || "Atlasphere"), email: match[2].trim() };
  }
  return { name: nameEnv || "Atlasphere", email: raw };
}

// Plain-text version of an HTML body. Mail with only an HTML part looks
// more like spam to filters, so every email also carries a text part.
function htmlToText(html) {
  return String(html || "")
    .replace(/<(br|\/p|\/div|\/h[1-6]|\/li)\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .split("\n").map(function(l) { return l.trim(); })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Send one transactional email. Returns true on success, false otherwise —
// callers already handle a false return gracefully (verification codes are
// also logged to the server console as a fallback).
async function sendEmail({ to, subject, html, text }) {
  const apiKey = (process.env.BREVO_API_KEY || "").trim();
  const sender = parseSender();

  if (!apiKey || !sender.email) {
    console.error(
      "Email not sent — set BREVO_API_KEY and MAIL_FROM (a sender address verified in Brevo)."
    );
    return false;
  }

  const payload = {
    sender: { name: sender.name, email: sender.email },
    to: [{ email: to }],
    subject: subject,
    htmlContent: html,
    textContent: text || htmlToText(html),
  };
  const replyTo = (process.env.MAIL_REPLY_TO || "").trim();
  if (replyTo) payload.replyTo = { email: replyTo };

  try {
    const response = await axios.post(
      BREVO_ENDPOINT,
      payload,
      {
        headers: {
          "api-key": apiKey,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
      }
    );

    const messageId = response.data && response.data.messageId ? response.data.messageId : "(no id)";
    console.log("Email sent via Brevo to:", to, "| messageId:", messageId);
    return true;
  } catch (err) {
    console.error(
      "Brevo API error:",
      err.response ? JSON.stringify(err.response.data) : err.message
    );
    return false;
  }
}

module.exports = { sendEmail, htmlToText };
