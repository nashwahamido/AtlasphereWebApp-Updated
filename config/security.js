// Shared security helpers: trip membership checks, the site's trusted public
// address, HTML escaping for emails, rate limits and response headers.
const crypto = require("crypto");

// ── Escaping for HTML emails ─────────────────────────────────────────────
function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ── The site's own address ───────────────────────────────────────────────
// Links in emails (password reset, invites) must never be built from the
// request's Host header: anyone can send a fake one and receive the reset
// token on their own site. Use SITE_URL, else Railway's public domain; only
// local development falls back to the request.
function siteBase(req) {
  if (process.env.SITE_URL) return process.env.SITE_URL.replace(/\/$/, "");
  if (process.env.RAILWAY_PUBLIC_DOMAIN) return "https://" + process.env.RAILWAY_PUBLIC_DOMAIN;
  if (process.env.RAILWAY_ENVIRONMENT || process.env.NODE_ENV === "production") return "https://atlasphere.up.railway.app";
  return req.protocol + "://" + req.get("host");
}

// 6-digit verification code from a cryptographic source.
function generateCode() {
  return String(crypto.randomInt(100000, 1000000));
}

// ── Trip membership ──────────────────────────────────────────────────────
// A trip's members (and its creator) are the only people who may see or
// change anything in it.
function createMembership(pool) {
  const db = pool.promise ? pool.promise() : pool;

  async function isMember(userId, groupId) {
    if (!userId || groupId === undefined || groupId === null || groupId === "") return false;
    const [rows] = await db.query(
      "SELECT 1 FROM tbl_group_members WHERE groupId = ? AND userId = ? " +
      "UNION SELECT 1 FROM tbl_groups WHERE id = ? AND createdBy = ? LIMIT 1",
      [groupId, userId, groupId, userId]
    );
    return rows.length > 0;
  }

  // Express middleware. The trip id comes from the route, body or query.
  // Missing id → `onMissing` (default 400). Not a member → 403 JSON, or for
  // pages a 404 so trips can't be probed.
  function requireMember(options) {
    const opts = options || {};
    return async function (req, res, next) {
      const user = req.session && req.session.user;
      if (!user) return opts.page ? res.redirect("/auth/login") : res.status(401).json({ error: "Please log in." });
      const groupId = (req.params && req.params.id) || (req.body && req.body.groupId) || (req.query && req.query.groupId);
      if (groupId === undefined || groupId === null || groupId === "") {
        if (opts.onMissing) return opts.onMissing(req, res);
        return res.status(400).json({ error: "Missing groupId" });
      }
      try {
        if (await isMember(user.id, groupId)) return next();
      } catch (err) {
        console.error("Membership check failed:", err.message);
        return res.status(500).json({ error: "Something went wrong." });
      }
      if (opts.page) {
        return res.status(404).render("error", { status: 404, message: "Group not found", user: user });
      }
      return res.status(403).json({ error: "You're not a member of this trip." });
    };
  }

  return { isMember, requireMember };
}

// ── Rate limiting (in memory; one server instance) ───────────────────────
// limit({ windowMs, max, key }) → middleware. `key(req)` groups requests
// (e.g. by IP, or IP + email); return null to skip counting.
function createLimiter(opts) {
  const hits = new Map();
  const windowMs = opts.windowMs;
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
  }, Math.min(windowMs, 10 * 60 * 1000)).unref();

  function take(key) {
    const now = Date.now();
    let entry = hits.get(key);
    if (!entry || entry.reset <= now) { entry = { count: 0, reset: now + windowMs }; hits.set(key, entry); }
    entry.count += 1;
    return entry.count <= opts.max ? 0 : Math.ceil((entry.reset - now) / 1000);
  }

  const middleware = function (req, res, next) {
    const key = opts.key ? opts.key(req) : req.ip;
    if (key === null || key === undefined) return next();
    const wait = take(opts.name + ":" + key);
    if (!wait) return next();
    res.set("Retry-After", String(wait));
    if (opts.onLimit) return opts.onLimit(req, res, wait);
    return res.status(429).json({ error: "Too many attempts. Please wait a few minutes and try again." });
  };
  middleware.take = (key) => take(opts.name + ":" + key);
  middleware.reset = (key) => hits.delete(opts.name + ":" + key);
  return middleware;
}

// ── Response headers ─────────────────────────────────────────────────────
function securityHeaders(req, res, next) {
  res.set("X-Content-Type-Options", "nosniff");
  res.set("X-Frame-Options", "SAMEORIGIN");
  res.set("Content-Security-Policy", "frame-ancestors 'self'");
  res.set("Referrer-Policy", "strict-origin-when-cross-origin");
  if (req.secure) res.set("Strict-Transport-Security", "max-age=15552000");
  next();
}

module.exports = { escapeHtml, siteBase, generateCode, createMembership, createLimiter, securityHeaders };
