// JSON API for the Atlasphere mobile app (mounted at /api/mobile).
// Uses the same users table, password hashing, validation limits and
// verification emails as the website, but authenticates with signed bearer
// tokens instead of the browser session cookie.
const express = require("express");
const { check, validationResult } = require("express-validator");
const tokens = require("../config/tokens");
const { verifyPassword, upgradeToHash } = require("../config/passwords");
const createFriends = require("../services/friends");
const { FriendError } = require("../services/friends");
const { createLimiter, escapeHtml, siteBase } = require("../config/security");
const createTrips = require("../services/trips");
const { TripError, ACTIVITY_TAGS } = require("../services/trips");
const countries = require("../data/countries");

const ACCESS_TTL = 60 * 60 * 24 * 30; // 30 days
const PENDING_TTL = 60 * 30;          // 30 minutes, same as the emailed code

module.exports = function createMobileRouter(deps) {
  const { connection, bcrypt, sendVerificationEmail, sendEmail, generateCode } = deps;
  const db = connection.promise();
  const friends = createFriends(db);
  const router = express.Router();

  // Brute-force protection: sign-in and code checks are limited per IP and
  // per account; a code stops working after 5 wrong tries (ask for a new one).
  const json429 = (req, res) => fail(res, 429, "Too many attempts. Please wait a few minutes and try again.");
  const lowerField = (f) => (req) => String((req.body && req.body[f]) || "").trim().toLowerCase() || null;
  const limitLoginIp = createLimiter({ name: "m-login-ip", windowMs: 15 * 60 * 1000, max: 40, onLimit: json429 });
  const limitLoginAcct = createLimiter({ name: "m-login-acct", windowMs: 15 * 60 * 1000, max: 8, key: lowerField("email"), onLimit: json429 });
  const limitRegister = createLimiter({ name: "m-register", windowMs: 60 * 60 * 1000, max: 15, onLimit: json429 });
  const limitResend = createLimiter({ name: "m-resend", windowMs: 60 * 60 * 1000, max: 6, onLimit: json429 });
  const limitForgotIp = createLimiter({ name: "m-forgot-ip", windowMs: 60 * 60 * 1000, max: 10, onLimit: json429 });
  const limitForgotEmail = createLimiter({ name: "m-forgot-email", windowMs: 60 * 60 * 1000, max: 3, key: lowerField("email"), onLimit: json429 });
  const limitVerifyIp = createLimiter({ name: "m-verify-ip", windowMs: 15 * 60 * 1000, max: 30, onLimit: json429 });
  const wrongCodes = new Map(); // userId -> wrong guesses for the current code
  const MAX_CODE_ATTEMPTS = 5;

  // ── helpers ──────────────────────────────────────────────────────────
  function fail(res, status, error, extra) {
    return res.status(status).json(Object.assign({ error }, extra || {}));
  }

  function firstValidationError(req) {
    const errors = validationResult(req);
    return errors.isEmpty() ? null : errors.array()[0].msg;
  }

  function publicUser(row) {
    return {
      id: row.IDuser,
      username: row.username,
      email: row.email,
      profilePictureUrl: row.profilePictureUrl || "",
    };
  }

  function accessToken(row) {
    return tokens.sign({ typ: "access", uid: row.IDuser }, ACCESS_TTL);
  }

  function pendingToken(userId, email) {
    return tokens.sign({ typ: "pending", uid: userId, email }, PENDING_TTL);
  }

  async function issueAndSendCode(userId, email) {
    const code = generateCode();
    await db.query("UPDATE tbl_users SET verificationCode = ? WHERE IDuser = ?", [Number(code), userId]);
    wrongCodes.delete(userId);
    const sent = await sendVerificationEmail(email, code);
    if (!sent) console.error("Mobile: verification email failed for user", userId);
    return pendingToken(userId, email);
  }

  // Bearer-token auth for endpoints that need a signed-in user.
  async function requireMobileAuth(req, res, next) {
    const header = req.get("authorization") || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    const payload = tokens.verify(token, "access");
    if (!payload) return fail(res, 401, "Please sign in again.");
    try {
      const [rows] = await db.query(
        "SELECT IDuser, username, email, profilePictureUrl FROM tbl_users WHERE IDuser = ? LIMIT 1",
        [payload.uid]
      );
      if (!rows.length) return fail(res, 401, "Please sign in again.");
      req.mobileUser = rows[0];
      next();
    } catch (err) {
      console.error("Mobile auth lookup error:", err.message);
      fail(res, 500, "Something went wrong. Please try again.");
    }
  }

  // ── LOGIN ────────────────────────────────────────────────────────────
  router.post(
    "/auth/login",
    limitLoginIp, limitLoginAcct,
    [
      check("email").trim().exists({ checkFalsy: true }).withMessage("Email is required")
        .isEmail().withMessage("Invalid email format"),
      check("password").exists({ checkFalsy: true }).withMessage("Password is required"),
    ],
    async (req, res) => {
      const invalid = firstValidationError(req);
      if (invalid) return fail(res, 400, invalid);
      const { email, password } = req.body;
      try {
        const [rows] = await db.query(
          "SELECT IDuser, username, email, password, isConfirmed, profilePictureUrl FROM tbl_users WHERE email = ? OR username = ? LIMIT 1",
          [email, email]
        );
        const row = rows[0];
        const { match, needsRehash } = row ? await verifyPassword(password, row.password) : { match: false, needsRehash: false };
        if (!match) return fail(res, 401, "Invalid email or password. Try again.");
        limitLoginAcct.reset(String(email).trim().toLowerCase());
        if (needsRehash) {
          try { await upgradeToHash(connection, row.IDuser, password); }
          catch (e) { console.error("Mobile password upgrade failed:", e.message); }
        }

        if (Number(row.isConfirmed) !== 1) {
          const pending = await issueAndSendCode(row.IDuser, row.email);
          return fail(res, 403, "Please verify your email first. We've sent you a new code.", {
            needsVerification: true,
            pendingToken: pending,
            email: row.email,
          });
        }

        res.json({ token: accessToken(row), user: publicUser(row) });
      } catch (err) {
        console.error("Mobile login error:", err.message);
        fail(res, 500, "Something went wrong. Please try again.");
      }
    }
  );

  // ── REGISTER ─────────────────────────────────────────────────────────
  router.post(
    "/auth/register",
    limitRegister,
    [
      check("username").trim()
        .exists({ checkFalsy: true }).withMessage("Username is required")
        .isLength({ min: 3, max: 20 }).withMessage("Username must be 3–20 characters")
        .escape(),
      check("email").trim()
        .exists({ checkFalsy: true }).withMessage("Email is required")
        .isEmail().withMessage("Invalid email format"),
      check("phone").trim().isMobilePhone().withMessage("Invalid phone number"),
      check("gender").optional(),
      check("password")
        .exists({ checkFalsy: true }).withMessage("Password is required")
        .isLength({ min: 6, max: 12 }).withMessage("Password must be 6–12 characters"),
    ],
    async (req, res) => {
      const invalid = firstValidationError(req);
      if (invalid) return fail(res, 400, invalid);
      const { username, email, phone, gender, password } = req.body;
      try {
        const [existing] = await db.query(
          "SELECT IDuser, isConfirmed FROM tbl_users WHERE email = ? LIMIT 1",
          [email]
        );
        if (existing.length) {
          if (Number(existing[0].isConfirmed) === 1) {
            return fail(res, 409, "This email is already registered. Try logging in instead.");
          }
          // Unverified leftover sign-up: replace it (same as the website).
          await db.query("DELETE FROM tbl_users WHERE IDuser = ? AND isConfirmed = 0", [existing[0].IDuser]);
        }

        const hash = await bcrypt.hash(password, 10);
        const genderId = gender && !isNaN(Number(gender)) ? Number(gender) : null;
        const [result] = await db.query(
          `INSERT INTO tbl_users
             (username, email, phonenumber, password, FIDgender, verificationCode, verificationExpiry, isConfirmed, GroupAdmin)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [username, email, phone || "", hash, genderId, 0, "00:00:00", 0, null]
        );
        const pending = await issueAndSendCode(result.insertId, email);
        res.status(201).json({ pendingToken: pending, email });
      } catch (err) {
        console.error("Mobile register error:", err.message);
        fail(res, 500, "Registration failed. Please try again.");
      }
    }
  );

  // ── VERIFY EMAIL CODE ────────────────────────────────────────────────
  router.post(
    "/auth/verify",
    limitVerifyIp,
    [
      check("pendingToken").exists({ checkFalsy: true }).withMessage("Your sign-up has expired. Please register again."),
      check("code").trim().matches(/^\d{6}$/).withMessage("Please enter the 6-digit code."),
    ],
    async (req, res) => {
      const invalid = firstValidationError(req);
      if (invalid) return fail(res, 400, invalid);
      const pending = tokens.verify(req.body.pendingToken, "pending");
      if (!pending) return fail(res, 410, 'Code has expired. Tap "Send code again".', { expired: true });
      try {
        const [rows] = await db.query(
          "SELECT IDuser, username, email, verificationCode, isConfirmed, profilePictureUrl FROM tbl_users WHERE IDuser = ? LIMIT 1",
          [pending.uid]
        );
        const row = rows[0];
        if (!row) return fail(res, 410, "Your sign-up has expired. Please register again.", { expired: true });
        if (Number(row.isConfirmed) !== 1) {
          const tries = wrongCodes.get(row.IDuser) || 0;
          if (tries >= MAX_CODE_ATTEMPTS) {
            return fail(res, 429, 'Too many wrong codes. Tap "Send code again" for a new one.');
          }
          if (Number(row.verificationCode) !== Number(req.body.code)) {
            wrongCodes.set(row.IDuser, tries + 1);
            return fail(res, 400, "Invalid code. Please try again.");
          }
          wrongCodes.delete(row.IDuser);
          await db.query("UPDATE tbl_users SET isConfirmed = 1 WHERE IDuser = ?", [row.IDuser]);
        }
        res.json({ token: accessToken(row), user: publicUser(row), isNewUser: true });
      } catch (err) {
        console.error("Mobile verify error:", err.message);
        fail(res, 500, "Verification failed. Please try again.");
      }
    }
  );

  // ── RESEND CODE ──────────────────────────────────────────────────────
  router.post("/auth/resend", limitResend, async (req, res) => {
    // Allow resending for an expired pending token too (that's the point), but
    // only if its signature is genuine: check signature/type, ignore expiry.
    const raw = String(req.body.pendingToken || "");
    const payload = tokens.verify(raw, "pending", 60 * 60 * 24 * 7);
    if (!payload) return fail(res, 400, "Please register again.");
    try {
      const [rows] = await db.query("SELECT IDuser, email, isConfirmed FROM tbl_users WHERE IDuser = ? LIMIT 1", [payload.uid]);
      if (!rows.length || Number(rows[0].isConfirmed) === 1) return fail(res, 400, "Please log in instead.");
      const pending = await issueAndSendCode(rows[0].IDuser, rows[0].email);
      res.json({ pendingToken: pending, message: "A new code has been sent to your email." });
    } catch (err) {
      console.error("Mobile resend error:", err.message);
      fail(res, 500, "Couldn't send a new code. Please try again.");
    }
  });

  // ── FORGOT PASSWORD ──────────────────────────────────────────────────
  // Emails the same reset link as the website; the reset itself happens on the
  // web page the link opens.
  router.post("/auth/forgot-password", limitForgotIp, limitForgotEmail, async (req, res) => {
    const email = String(req.body.email || "").trim();
    const generic = { message: "If an account with that email exists, a reset link has been sent." };
    if (!email) return fail(res, 400, "Please enter your email.");
    try {
      const [rows] = await db.query("SELECT IDuser, username FROM tbl_users WHERE email = ? LIMIT 1", [email]);
      if (!rows.length) return res.json(generic);
      const token = require("crypto").randomBytes(32).toString("hex");
      await db.query(
        "UPDATE tbl_users SET resetToken = ?, resetTokenExpires = ? WHERE IDuser = ?",
        [token, new Date(Date.now() + 3600000), rows[0].IDuser]
      );
      const base = siteBase(req);
      const link = base + "/auth/reset-password?token=" + token;
      await sendEmail({
        to: email,
        subject: "Reset your Atlasphere password",
        html: '<div style="font-family:Arial;max-width:480px;margin:0 auto;padding:32px">' +
          '<h1 style="color:#0B3856">Reset your password</h1>' +
          '<p style="font-size:16px;color:#555">Hi ' + escapeHtml(rows[0].username) + ', tap the button below to reset your password. This link expires in 1 hour.</p>' +
          '<div style="text-align:center;margin:32px 0"><a href="' + link + '" style="display:inline-block;padding:14px 40px;background:#E8933A;color:#fff;text-decoration:none;border-radius:30px;font-weight:700;font-size:16px">Reset Password</a></div></div>',
      }).catch((e) => console.error("Mobile reset email error:", e.message));
      res.json(generic);
    } catch (err) {
      console.error("Mobile forgot-password error:", err.message);
      fail(res, 500, "Something went wrong. Please try again.");
    }
  });

  // ── CURRENT USER ─────────────────────────────────────────────────────
  router.get("/me", requireMobileAuth, (req, res) => {
    res.json({ user: publicUser(req.mobileUser) });
  });

  // ── FRIENDS ──────────────────────────────────────────────────────────
  // Same rules as the website (services/friends.js).
  function friendRoute(handler) {
    return async (req, res) => {
      try {
        res.json(await handler(req));
      } catch (err) {
        if (err instanceof FriendError) return fail(res, err.status, err.message);
        console.error("Mobile friends error:", err.message);
        fail(res, 500, "Something went wrong. Please try again.");
      }
    };
  }
  const me = (req) => req.mobileUser.IDuser;

  router.get("/friends", requireMobileAuth, friendRoute(async (req) => {
    const [list, requests] = await Promise.all([friends.listFriends(me(req)), friends.listRequests(me(req))]);
    return { friends: list, incoming: requests.incoming, outgoing: requests.outgoing };
  }));
  router.get("/people/search", requireMobileAuth, friendRoute(async (req) => ({ results: await friends.search(me(req), req.query.q) })));
  router.get("/people/:id", requireMobileAuth, friendRoute(async (req) => ({ person: await friends.profile(me(req), req.params.id) })));

  const ACTIONS = {
    request: (m, id) => friends.sendRequest(m, id),
    accept: (m, id) => friends.accept(m, id),
    decline: (m, id) => friends.decline(m, id),
    cancel: (m, id) => friends.cancel(m, id),
    remove: (m, id) => friends.unfriend(m, id),
  };
  router.post("/people/:id/:action", requireMobileAuth, async (req, res, next) => {
    const action = ACTIONS[req.params.action];
    if (!action) return next();
    return friendRoute(async () => ({ relationship: await action(me(req), req.params.id) }))(req, res);
  });

  // ── TRIPS ────────────────────────────────────────────────────────────
  // Same rules as the website: members only; the creator can delete.
  const trips = createTrips(connection, { friends });
  const limitJoin = createLimiter({ name: "m-join", windowMs: 60 * 60 * 1000, max: 30, key: (req) => String(me(req)), onLimit: json429 });
  function tripRoute(handler) {
    return async (req, res) => {
      try {
        res.json(await handler(req, res));
      } catch (err) {
        if (err instanceof TripError) return fail(res, err.status, err.message);
        console.error("Mobile trips error:", err.message);
        fail(res, 500, "Something went wrong. Please try again.");
      }
    };
  }

  // Countries and their cities for the "new trip" flow, plus the interests.
  const countryList = countries.map((c) => ({ code: c.code, name: c.name, flag: c.flag, continent: c.continent, cities: c.cities }));
  router.get("/countries", requireMobileAuth, (req, res) => {
    res.set("Cache-Control", "private, max-age=86400");
    res.json({ countries: countryList, interests: ACTIVITY_TAGS });
  });

  router.get("/trips", requireMobileAuth, tripRoute(async (req) => ({ trips: await trips.list(me(req)) })));
  router.post("/trips", requireMobileAuth, tripRoute(async (req) => {
    const id = await trips.create(req.mobileUser, req.body || {});
    return { trip: await trips.detail(me(req), id, siteBase(req)) };
  }));
  router.post("/trips/join", requireMobileAuth, limitJoin, tripRoute(async (req) => {
    const id = await trips.join(req.mobileUser, req.body && req.body.code);
    return { trip: await trips.detail(me(req), id, siteBase(req)) };
  }));
  router.get("/trips/:id", requireMobileAuth, tripRoute(async (req) => ({ trip: await trips.detail(me(req), req.params.id, siteBase(req)) })));
  router.post("/trips/:id/members", requireMobileAuth, tripRoute(async (req) => {
    const out = await trips.addFriend(req.mobileUser, req.params.id, req.body && req.body.userId);
    return Object.assign(out, { trip: await trips.detail(me(req), req.params.id, siteBase(req)) });
  }));
  router.post("/trips/:id/rename", requireMobileAuth, tripRoute(async (req) => {
    await trips.rename(me(req), req.params.id, req.body && req.body.name);
    return { trip: await trips.detail(me(req), req.params.id, siteBase(req)) };
  }));
  router.post("/trips/:id/interests", requireMobileAuth, tripRoute(async (req) => {
    await trips.setInterests(me(req), req.params.id, req.body && req.body.interests);
    return { trip: await trips.detail(me(req), req.params.id, siteBase(req)) };
  }));
  // Multipart upload, field "photo". Stored in the database like the website's.
  router.post("/trips/:id/photo", requireMobileAuth, tripRoute(async (req) => {
    await trips.assertMember(me(req), req.params.id);
    const file = req.files && (req.files.photo || req.files.groupPhoto);
    if (!file) throw new TripError(400, "Please choose a photo.");
    let photoPath;
    try {
      photoPath = await req.app.get("images").saveUpload(file, { width: 800, height: 600, prefix: "group_" + String(req.params.id).replace(/\D/g, "") + "_" });
    } catch (e) {
      throw new TripError(400, "That file isn't a photo we can use.");
    }
    await trips.setPhoto(me(req), req.params.id, photoPath);
    return { trip: await trips.detail(me(req), req.params.id, siteBase(req)) };
  }));
  router.post("/trips/:id/leave", requireMobileAuth, tripRoute(async (req) => { await trips.leave(me(req), req.params.id); return { ok: true }; }));
  router.delete("/trips/:id", requireMobileAuth, tripRoute(async (req) => { await trips.remove(me(req), req.params.id); return { ok: true }; }));

  router.use((req, res) => fail(res, 404, "Not found."));

  return router;
};
