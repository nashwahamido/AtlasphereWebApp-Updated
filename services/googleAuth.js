// Sign in with Google (OpenID Connect, authorization code flow).
//
// One Google "Web application" OAuth client serves both the website and the
// app. The app opens /auth/google in a secure browser sheet; when Google sends
// the person back, the server hands the app a one-time code (bound to a PKCE
// verifier only that app instance knows), which the app swaps for its token.
//
// Env: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET. Redirect URI to register in
// Google Cloud: <site>/auth/google/callback.
const axios = require("axios");
const crypto = require("crypto");
const bcrypt = require("bcrypt");

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const FLOW_TTL = 10 * 60 * 1000;    // from leaving for Google to coming back
const APP_CODE_TTL = 2 * 60 * 1000; // from coming back to the app redeeming

const b64url = (buf) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const clientId = () => (process.env.GOOGLE_CLIENT_ID || "").trim();
const clientSecret = () => (process.env.GOOGLE_CLIENT_SECRET || "").trim();

module.exports = function createGoogleAuth(pool, deps) {
  const db = pool.promise ? pool.promise() : pool;
  const images = deps && deps.images;
  const flows = new Map();    // state -> { app, redirect, challenge, at }
  const appCodes = new Map(); // code -> { userId, challenge, isNew, at }

  function prune(map, ttl) {
    const now = Date.now();
    for (const [k, v] of map) if (now - v.at > ttl) map.delete(k);
  }

  const configured = () => !!(clientId() && clientSecret());

  async function ensureTable() {
    await db.query(
      "CREATE TABLE IF NOT EXISTS tbl_user_oauth (" +
        "provider VARCHAR(16) NOT NULL, subject VARCHAR(255) NOT NULL, userId INT NOT NULL, email VARCHAR(255) NULL, " +
        "createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (provider, subject), KEY idx_oauth_user (userId))"
    );
  }

  // The Google sign-in page to send the person to.
  function startUrl(redirectUri, flow) {
    prune(flows, FLOW_TTL);
    const state = b64url(crypto.randomBytes(24));
    flows.set(state, Object.assign({}, flow, { at: Date.now() }));
    const q = new URLSearchParams({
      client_id: clientId(),
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "openid email profile",
      state,
      prompt: "select_account",
    });
    return AUTH_URL + "?" + q.toString();
  }

  // The flow a callback belongs to (each state works once).
  function takeFlow(state) {
    const flow = flows.get(String(state || ""));
    flows.delete(String(state || ""));
    if (!flow || Date.now() - flow.at > FLOW_TTL) return null;
    return flow;
  }

  // Swap Google's code for the person's verified Google profile.
  async function profileFromCode(code, redirectUri) {
    const res = await axios.post(TOKEN_URL, new URLSearchParams({
      code: String(code || ""),
      client_id: clientId(),
      client_secret: clientSecret(),
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }).toString(), { headers: { "Content-Type": "application/x-www-form-urlencoded" }, timeout: 10000 });
    // The ID token comes straight from Google's token endpoint over TLS, so
    // its contents can be trusted without checking the signature (OIDC 3.1.3.7);
    // the claims are still checked.
    const parts = String((res.data && res.data.id_token) || "").split(".");
    if (parts.length !== 3) throw new Error("No ID token from Google");
    const claims = JSON.parse(Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    const issOk = claims.iss === "https://accounts.google.com" || claims.iss === "accounts.google.com";
    const audOk = Array.isArray(claims.aud) ? claims.aud.includes(clientId()) : claims.aud === clientId();
    if (!issOk || !audOk || !(Number(claims.exp) * 1000 > Date.now())) throw new Error("Google ID token failed checks");
    if (!claims.sub || !claims.email || !(claims.email_verified === true || claims.email_verified === "true")) {
      throw new Error("Google account has no verified email");
    }
    return { sub: String(claims.sub), email: String(claims.email).trim().toLowerCase(), name: String(claims.name || claims.given_name || ""), picture: String(claims.picture || "") };
  }

  async function uniqueUsername(name, email) {
    let base = String(name || "").replace(/[^\p{L}\p{N} ._-]/gu, "").replace(/\s+/g, " ").trim().slice(0, 20);
    if (base.length < 3) base = String(email || "").split("@")[0].replace(/[^\p{L}\p{N}._-]/gu, "").slice(0, 20);
    if (base.length < 3) base = "traveller";
    for (let i = 0; i < 8; i++) {
      const candidate = i === 0 ? base : base.slice(0, 15).trim() + " " + crypto.randomInt(1000, 10000);
      const [rows] = await db.query("SELECT 1 FROM tbl_users WHERE username = ? LIMIT 1", [candidate]);
      if (!rows.length) return candidate;
    }
    return "traveller " + crypto.randomInt(100000, 1000000);
  }

  async function savePhoto(userId, url) {
    if (!images || !/^https:\/\/[a-z0-9.-]+\.googleusercontent\.com\//i.test(url)) return;
    try {
      const res = await axios.get(url.replace(/=s\d+-c$/, "=s400-c"), { responseType: "arraybuffer", timeout: 6000, maxContentLength: 5 * 1024 * 1024 });
      const path = await images.saveUpload({ data: Buffer.from(res.data), name: "google.jpg" }, { width: 400, height: 400, prefix: "user" + userId + "_" });
      await db.query("UPDATE tbl_users SET profilePictureUrl = ?, profilePictureAlt = ? WHERE IDuser = ? AND (profilePictureUrl IS NULL OR profilePictureUrl = '')", [path, "Profile picture", userId]);
    } catch (e) {
      console.error("Google photo not saved:", e.message);
    }
  }

  const userById = async (id) => {
    const [rows] = await db.query("SELECT IDuser, username, email, profilePictureUrl, isConfirmed FROM tbl_users WHERE IDuser = ? LIMIT 1", [id]);
    return rows[0] || null;
  };

  // The Atlasphere account for this Google account: linked before, or the
  // account with the same email (Google has verified it), or a new one.
  async function accountFor(profile) {
    const [links] = await db.query("SELECT userId FROM tbl_user_oauth WHERE provider = 'google' AND subject = ? LIMIT 1", [profile.sub]);
    if (links.length) {
      const user = await userById(links[0].userId);
      if (user) {
        if (Number(user.isConfirmed) !== 1) await db.query("UPDATE tbl_users SET isConfirmed = 1 WHERE IDuser = ?", [user.IDuser]);
        return { user, isNew: false };
      }
      await db.query("DELETE FROM tbl_user_oauth WHERE provider = 'google' AND subject = ?", [profile.sub]); // account was deleted
    }
    const [same] = await db.query("SELECT IDuser FROM tbl_users WHERE LOWER(TRIM(email)) = ? ORDER BY isConfirmed DESC, IDuser LIMIT 1", [profile.email]);
    let userId, isNew = false;
    if (same.length) {
      userId = same[0].IDuser;
      await db.query("UPDATE tbl_users SET isConfirmed = 1, verificationCode = NULL WHERE IDuser = ?", [userId]);
    } else {
      const username = await uniqueUsername(profile.name, profile.email);
      const password = await bcrypt.hash(crypto.randomBytes(32).toString("hex"), 10); // no password: Google only, until they set one
      const [ins] = await db.query("INSERT INTO tbl_users (username, email, password, isConfirmed) VALUES (?, ?, ?, 1)", [username, profile.email, password]);
      userId = ins.insertId;
      isNew = true;
      await db.query("INSERT IGNORE INTO tbl_user_signups (userId) VALUES (?)", [userId]).catch(() => {});
    }
    await db.query("INSERT IGNORE INTO tbl_user_oauth (provider, subject, userId, email) VALUES ('google', ?, ?, ?)", [profile.sub, userId, profile.email]);
    if (profile.picture) await savePhoto(userId, profile.picture);
    return { user: await userById(userId), isNew };
  }

  // ── App hand-off ──────────────────────────────────────────────────────
  function issueAppCode(userId, challenge, isNew) {
    prune(appCodes, APP_CODE_TTL);
    const code = b64url(crypto.randomBytes(32));
    appCodes.set(code, { userId, challenge, isNew, at: Date.now() });
    return code;
  }

  // Returns { userId, isNew } if the code is fresh, unused and matches the verifier.
  function redeemAppCode(code, verifier) {
    const entry = appCodes.get(String(code || ""));
    appCodes.delete(String(code || ""));
    if (!entry || Date.now() - entry.at > APP_CODE_TTL) return null;
    const hashed = b64url(crypto.createHash("sha256").update(String(verifier || "")).digest());
    const a = Buffer.from(hashed), b = Buffer.from(String(entry.challenge || ""));
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    return { userId: entry.userId, isNew: entry.isNew };
  }

  // Where the app may be sent back to: its own scheme; Expo Go only when
  // ALLOW_EXPO_GO_LOGIN=1 (for testing).
  function appRedirectAllowed(url) {
    const u = String(url || "");
    if (/^atlasphere:\/\/[\w\-./]*$/.test(u)) return true;
    return process.env.ALLOW_EXPO_GO_LOGIN === "1" && /^exps?:\/\/[\w\-.:]+\/--\/[\w\-./]*$/.test(u);
  }

  return { configured, ensureTable, startUrl, takeFlow, profileFromCode, accountFor, issueAppCode, redeemAppCode, appRedirectAllowed, userById };
};
