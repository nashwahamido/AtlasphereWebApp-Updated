// Small signed tokens for the mobile app (no extra dependency).
// Format: base64url(payload JSON) + "." + base64url(HMAC-SHA256 signature).
// `typ` separates long-lived access tokens from short-lived pending sign-ups,
// so one can never be used in place of the other.
const crypto = require("crypto");
const sessionConfig = require("./session");

const SECRET = process.env.MOBILE_TOKEN_SECRET || sessionConfig.secret;

function b64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function sign(payload, ttlSeconds) {
  const body = Object.assign({}, payload, { exp: Math.floor(Date.now() / 1000) + ttlSeconds });
  const data = b64url(JSON.stringify(body));
  const sig = b64url(crypto.createHmac("sha256", SECRET).update(data).digest());
  return data + "." + sig;
}

// Returns the payload, or null if the token is malformed, tampered with,
// expired, or not of the expected type. `graceSeconds` accepts a genuine token
// up to that long after it expired (used to resend an expired sign-up code).
function verify(token, expectedType, graceSeconds) {
  if (typeof token !== "string" || token.split(".").length !== 2) return null;
  const [data, sig] = token.split(".");
  const expected = b64url(crypto.createHmac("sha256", SECRET).update(data).digest());
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
  } catch (e) {
    return null;
  }
  if (!payload || typeof payload.exp !== "number") return null;
  if (payload.exp + (graceSeconds || 0) < Math.floor(Date.now() / 1000)) return null;
  if (expectedType && payload.typ !== expectedType) return null;
  return payload;
}

module.exports = { sign, verify };
