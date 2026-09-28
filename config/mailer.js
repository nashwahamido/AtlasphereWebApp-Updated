// ── EMAIL (Brevo transactional HTTP API) ─────────────────────────────────
// Sends over HTTPS (port 443) so it works on Railway, which blocks the
// outbound SMTP ports (25/465/587). Configure via env:
//   BREVO_API_KEY   — transactional API key from your Brevo account
//   MAIL_FROM       — sender email verified in Brevo (e.g. "Atlasphere" <you@example.com> or you@example.com)
//   MAIL_FROM_NAME  — optional display name (defaults to "Atlasphere")
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

// Send one transactional email. Returns true on success, false otherwise —
// callers already handle a false return gracefully (verification codes are
// also logged to the server console as a fallback).
async function sendEmail({ to, subject, html }) {
  const apiKey = (process.env.BREVO_API_KEY || "").trim();
  const sender = parseSender();

  if (!apiKey || !sender.email) {
    console.error(
      "Email not sent — set BREVO_API_KEY and MAIL_FROM (a sender address verified in Brevo)."
    );
    return false;
  }

  try {
    const response = await axios.post(
      BREVO_ENDPOINT,
      {
        sender: { name: sender.name, email: sender.email },
        to: [{ email: to }],
        subject: subject,
        htmlContent: html,
      },
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

module.exports = { sendEmail };
