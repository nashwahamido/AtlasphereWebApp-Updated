// ── EMAIL (Mailjet transactional HTTP API) ────────────────────────────────
// Sends over HTTPS (port 443) so it works on Railway, which blocks the
// outbound SMTP ports (25/465/587). Configure via env:
//   MAILJET_API_KEY     — API key from your Mailjet account
//   MAILJET_SECRET_KEY  — matching secret key
//   MAIL_FROM           — sender verified in Mailjet (e.g. atlasphere.app@gmail.com
//                         or "Atlasphere" <atlasphere.app@gmail.com>)
//   MAIL_FROM_NAME      — optional display name (defaults to "Atlasphere")
const axios = require("axios");

const MAILJET_ENDPOINT = "https://api.mailjet.com/v3.1/send";

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
  const apiKey = process.env.MAILJET_API_KEY;
  const secretKey = process.env.MAILJET_SECRET_KEY;
  const sender = parseSender();

  if (!apiKey || !secretKey || !sender.email) {
    console.error(
      "Email not sent — set MAILJET_API_KEY, MAILJET_SECRET_KEY and MAIL_FROM (a sender verified in Mailjet)."
    );
    return false;
  }

  try {
    const response = await axios.post(
      MAILJET_ENDPOINT,
      {
        Messages: [
          {
            From: { Email: sender.email, Name: sender.name },
            To: [{ Email: to }],
            Subject: subject,
            HTMLPart: html,
          },
        ],
      },
      {
        auth: { username: apiKey, password: secretKey },
      }
    );

    const message = response.data && response.data.Messages && response.data.Messages[0];
    if (message && message.Status === "success") {
      console.log("Email sent via Mailjet to:", to);
      return true;
    }
    console.error("Mailjet send failed:", JSON.stringify(message || response.data));
    return false;
  } catch (err) {
    console.error(
      "Mailjet API error:",
      err.response ? JSON.stringify(err.response.data) : err.message
    );
    return false;
  }
}

module.exports = { sendEmail };
