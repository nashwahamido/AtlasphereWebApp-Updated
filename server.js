require("dotenv").config();
const express = require("express");
const path = require("path");
const countries = require("./data/countries");
const session = require("express-session");
const mysql = require("mysql2");
const bcrypt = require("bcrypt");
const fileUpload = require("express-fileupload");
const fs = require("fs");
const axios = require("axios");
const sharp = require("sharp");
const { sendEmail } = require("./config/mailer");
const { getRecommendations, getRecommendationsForCities } = require("./config/places");
const { verifyPassword, upgradeToHash } = require("./config/passwords");
const security = require("./config/security");
const { escapeHtml, siteBase } = security;


// ── Validation Rules ────────────────────────────────────────────────────
const { check, validationResult } = require("express-validator");

const validationRegisterRules = [
  check("username")
    .trim()
    .exists({ checkFalsy: true }).withMessage("Username is required")
    .isString().withMessage("Username must be a string")
    .isLength({ min: 3, max: 20 }).withMessage("Username must be 3–20 characters")
    .escape(),
  check("useremail")
    .trim()
    .exists({ checkFalsy: true }).withMessage("Email is required")
    .isEmail().withMessage("Invalid email format"),
  check("userphone")
    .trim()
    .isMobilePhone().withMessage("Invalid phone number"),
  check("gender")
    .optional(),
  check("psw")
    .trim()
    .exists({ checkFalsy: true }).withMessage("Password is required")
    .isLength({ min: 6, max: 12 }).withMessage("Password must be at least 6 characters or a maximum of 12")
];

const validationVerifyRules = [
  check(["code1", "code2", "code3", "code4", "code5", "code6"])
    .exists({ checkFalsy: true }).withMessage("All code fields are required")
    .isInt().withMessage("Each code must be a number")
    .isLength({ min: 1, max: 1 }).withMessage("Each code must be a single number")
    .trim(),
];

const validationLoginRules = [
  check("loginemail")
    .trim()
    .exists({ checkFalsy: true }).withMessage("Email is required")
    .isEmail().withMessage("Invalid email format"),
  check("loginpsw")
    .trim().exists({ checkFalsy: true }).withMessage("Password is required")
];



const app = express();
app.disable("x-powered-by");
// Railway terminates HTTPS at its proxy: trust it for req.ip / req.secure.
app.set("trust proxy", 1);
app.use(security.securityHeaders);

// ── VIEW ENGINE SETUP ────────────────────────────────────────────────────
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

// ── MIDDLEWARE ───────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, "public")));

// Absolute site/page URLs for the link-preview tags in views/partials/head-meta.ejs
// (WhatsApp, Instagram, iMessage etc. need absolute image URLs). Railway terminates
// HTTPS at its proxy, so honour X-Forwarded-Proto. SITE_URL can pin it explicitly.
app.use(function (req, res, next) {
  var proto = String(req.headers["x-forwarded-proto"] || req.protocol || "https").split(",")[0].trim();
  var site = siteBase(req);
  res.locals.siteUrl = site;
  res.locals.pageUrl = site + req.originalUrl.split("?")[0];
  next();
});
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static("assets"));
app.use(fileUpload({ limits: { fileSize: 10 * 1024 * 1024 }, abortOnLimit: true, responseOnLimit: "That photo is too big (10 MB max)." }));

// Where user uploads (profile + group photos) are written and served from.
// Railway's container disk is ephemeral, so in production this points at a
// mounted persistent volume via UPLOAD_DIR (e.g. /data/uploads); locally it
// defaults to assets/uploads.
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, "assets", "uploads");
if (!fs.existsSync(UPLOAD_DIR)) { fs.mkdirSync(UPLOAD_DIR, { recursive: true }); }
app.set("uploadDir", UPLOAD_DIR);
app.use("/uploads", express.static(UPLOAD_DIR, { maxAge: "365d", immutable: true }));

// ── DATABASE ─────────────────────────────────────────────────────────────
const connection = mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  user: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_DATABASE,
  ssl: { rejectUnauthorized: false },
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  timezone: '+00:00',
});

connection.getConnection((err, conn) => {
  if (err) {
    console.error("DB connection failed:", err.message);
  } else {
    console.log("DB connected to Aiven");
    conn.release();
  }
});

// Make DB connection accessible to route files
app.set('db', connection);
const friendsService = require("./services/friends")(connection.promise());
const images = require("./services/images")(connection, UPLOAD_DIR);
app.set("images", images);
// Photos missing from disk (e.g. after a redeploy) come from the database.
app.get("/uploads/:name", images.serve);
const membership = security.createMembership(connection);
app.set("membership", membership);
const requireMember = membership.requireMember;

// ── SESSION CONFIGURATION (stored in MySQL so sessions survive restarts) ──
const sessionConfig = require("./config/session");
try {
  var MySQLStore = require("express-mysql-session")(session);
  var sessionStore = new MySQLStore({}, connection.promise());
  sessionConfig.store = sessionStore;
  console.log("Sessions: stored in MySQL (persistent)");
} catch (e) {
  console.warn("Sessions: using memory store (install express-mysql-session for persistence)");
}
const sessionMiddleware = session(sessionConfig);
app.use(sessionMiddleware);
if (!process.env.SESSION_SECRET) {
  console.warn("WARNING: SESSION_SECRET is not set; using the built-in default. Set it in the environment.");
}

// ── RATE LIMITS ──────────────────────────────────────────────────────────
var emailKey = function (field) {
  return function (req) { return String((req.body && req.body[field]) || "").trim().toLowerCase() || null; };
};
var tooManyPage = function (view, extra) {
  return function (req, res) {
    res.status(429).render(view, Object.assign({ title: "Too many attempts", user: null, error: "Too many attempts. Please wait a few minutes and try again.", success: null }, extra ? extra(req) : {}));
  };
};
var limits = {
  loginIp: security.createLimiter({ name: "login-ip", windowMs: 15 * 60 * 1000, max: 40, onLimit: tooManyPage("login") }),
  loginAccount: security.createLimiter({ name: "login-acct", windowMs: 15 * 60 * 1000, max: 8, key: emailKey("loginemail"), onLimit: tooManyPage("login") }),
  register: security.createLimiter({ name: "register", windowMs: 60 * 60 * 1000, max: 15, onLimit: tooManyPage("register") }),
  forgotIp: security.createLimiter({ name: "forgot-ip", windowMs: 60 * 60 * 1000, max: 10, onLimit: tooManyPage("forgot-password") }),
  forgotEmail: security.createLimiter({ name: "forgot-email", windowMs: 60 * 60 * 1000, max: 3, key: emailKey("email"), onLimit: tooManyPage("forgot-password") }),
  resend: security.createLimiter({ name: "resend", windowMs: 60 * 60 * 1000, max: 6 }),
  inviteEmail: security.createLimiter({ name: "invite-email", windowMs: 60 * 60 * 1000, max: 20, key: function (req) { return req.session.user ? String(req.session.user.id) : req.ip; } }),
};
app.set("limits", limits);
var MAX_CODE_ATTEMPTS = 5;

// ── EMAIL SETUP ──────────────────────────────────────────────────────────
// Uses Brevo transactional HTTP API (port 443) — bypasses Railway SMTP port
// blocking. See config/mailer.js for configuration.
console.log("Email: using Brevo HTTP API");

// ── HELPERS ──────────────────────────────────────────────────────────────
function generateCode() {
  return security.generateCode();
}

async function sendVerificationEmail(toEmail, code) {
  return sendEmail({
    to: toEmail,
    subject: "Atlasphere — Verify your email",
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px;">
        <h1 style="color: #0B3856; font-size: 24px;">Welcome to Atlasphere!</h1>
        <p style="color: #555; font-size: 16px; line-height: 1.6;">Your verification code is:</p>
        <div style="background: #f0f4f8; border-radius: 12px; padding: 24px; text-align: center; margin: 24px 0;">
          <span style="font-size: 36px; font-weight: 700; letter-spacing: 8px; color: #0B3856;">${code}</span>
        </div>
        <p style="color: #888; font-size: 14px;">This code expires in 30 minutes.</p>
      </div>
    `,
  });
}

// A trip's cities, in the order they were picked (falls back to its main
// destination).
function tripCities(group) {
  var list = String((group && group.cities) || "").split(",")
    .map(function(c) { return c.trim(); })
    .filter(function(c, i, a) { return c && a.indexOf(c) === i; });
  if (!list.length && group && group.destination) list = [group.destination];
  return list.slice(0, 12);
}
app.set("tripCities", tripCities);

function requireAuth(req, res, next) {
  if (!req.session.user) {
    return res.redirect("/auth/login");
  }
  next();
}

// ── ROUTES ───────────────────────────────────────────────────────────────

// Homepage
app.get("/", (req, res) => {
  res.render("index", { user: req.session.user || null });
});

// ── LOGIN ────────────────────────────────────────────────────────────────
app.get("/auth/login", (req, res) => {
  res.render("login", { title: "Sign In", error: null, user: null });
});

app.post("/auth/login", limits.loginIp, limits.loginAccount, validationLoginRules, (req, res) => {
  const errors = validationResult(req);
  
  if (!errors.isEmpty()) {
    return res.render("login", {
      title: "Sign In",
      error: errors.array().map(e => e.msg).join(", "),
      user: null,
    });
  }

  const username = req.body.loginuser || req.body.loginemail;
  const password = req.body.loginpsw;


  if (!username || !password) {
    return res.render("login", {
      title: "Sign In",
      error: "Please enter both username and password.",
      user: null,
    });
  }

  connection.query(
    "SELECT * FROM tbl_users WHERE (username = ? OR email = ?) LIMIT 1",
    [username, username],
    async (dbErr, results) => {
      if (dbErr) {
        console.error(dbErr);
        return res.render("login", { title: "Login", error: "Something went wrong. Please try again.", user: null });
      }

      if (results.length === 0) {
        return res.render("login", {
          title: "Sign In",
          error: "Invalid username or password. Try again.",
          user: null,
        });
      }

      const user = results[0];
      const { match, needsRehash } = await verifyPassword(password, user.password);
      if (match && needsRehash) {
        try { await upgradeToHash(connection, user.IDuser, password); }
        catch (e) { console.error("Password upgrade failed:", e.message); }
      }

      if (!match) {
        return res.render("login", {
          title: "Sign In",
          error: "Invalid username or password. Try again.",
          user: null,
        });
      }

      limits.loginAccount.reset(String(username).trim().toLowerCase());

      // Not verified yet: send a fresh code instead of signing in.
      if (Number(user.isConfirmed) !== 1) {
        const code = generateCode();
        connection.query("UPDATE tbl_users SET verificationCode = ? WHERE IDuser = ?", [Number(code), user.IDuser], async () => {
          await sendVerificationEmail(user.email, code);
          req.session.regenerate(() => {
            req.session.pendingVerification = { userId: user.IDuser, username: user.username, email: user.email, code, expiresAt: Date.now() + 30 * 60 * 1000, attempts: 0 };
            req.session.save(() => res.redirect("/auth/verify"));
          });
        });
        return;
      }

      // New session id on sign-in (prevents session fixation).
      var pendingInvite = req.session.pendingInvite;
      req.session.regenerate((regenErr) => {
      if (regenErr) {
        console.error("Session regenerate error:", regenErr);
        return res.render("login", { title: "Login", error: "Session error. Please try again.", user: null });
      }
      if (pendingInvite) req.session.pendingInvite = pendingInvite;
      req.session.user = {
        id: user.IDuser,
        username: user.username,
        email: user.email,
        profilePictureUrl: user.profilePictureUrl || '',
      };

      req.session.save((err) => {
        if (err) {
          console.error("Session save error:", err);
          return res.render("login", { title: "Login", error: "Session error. Please try again.", user: null });
        }

        // Check if user has any groups — if so, go straight to groups
        connection.query(
          "SELECT COUNT(*) as cnt FROM tbl_group_members WHERE userId = ?",
          [user.IDuser],
          function (grpErr, grpRows) {
            if (!grpErr && grpRows && grpRows[0].cnt > 0) {
              res.redirect("/groups");
            } else {
              res.redirect("/profile");
            }
          }
        );
      });
      });
    }
  );
});

// ── REGISTER ─────────────────────────────────────────────────────────────
app.get("/auth/register", (req, res) => {
  res.render("register", { title: "Register", user: null });
});

app.post("/auth/register", limits.register, validationRegisterRules, async (req, res) => {
  const errors = validationResult(req);
  
  if (!errors.isEmpty()) {
    return res.render("register", {
      title: "Register",
      error: errors.array().map(e => e.msg).join(", "),
      user: null,
    });
  }
  

  try {
    const { username, useremail, userphone, gender, psw } = req.body;

    connection.query(
      "SELECT IDuser, isConfirmed FROM tbl_users WHERE email = ? LIMIT 1",
      [useremail],
      async (checkErr, existingUsers) => {
        if (checkErr) {
          console.error("Email lookup error:", checkErr);
          return res.render("register", { title: "Register", error: "Something went wrong. Please try again.", user: null });
        }

        if (existingUsers.length > 0) {
          if (Number(existingUsers[0].isConfirmed) === 1) {
            return res.render("register", { title: "Register", error: "This email is already registered. Try logging in instead.", user: null });
          }
          // Unverified account — delete it and allow re-registration
          await connection.promise().query("DELETE FROM tbl_users WHERE email = ? AND isConfirmed = 0", [useremail]);
        }

        const hashedPassword = await bcrypt.hash(psw, 10);
        const code = generateCode();
        const genderId = gender && !isNaN(Number(gender)) ? Number(gender) : null;

        const insertSql = `
          INSERT INTO tbl_users
          (username, email, phonenumber, password, FIDgender, verificationCode, verificationExpiry, isConfirmed, GroupAdmin)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `;

        const insertValues = [
          username,
          useremail,
          userphone || "",
          hashedPassword,
          genderId,
          Number(code),
          "00:00:00",
          0,
          null,
        ];

        connection.query(insertSql, insertValues, async (insertErr, result) => {
          if (insertErr) {
            console.error("User insert error:", insertErr);
            return res.render("register", { title: "Register", error: "Registration failed. Please try again.", user: null });
          }

          const newUserId = result.insertId;

          req.session.pendingVerification = {
            userId: newUserId,
            username,
            email: useremail,
            code,
            expiresAt: Date.now() + 30 * 60 * 1000,
            attempts: 0,
          };

          const sent = await sendVerificationEmail(useremail, code);
          if (!sent) console.error("Verification email failed for new user", newUserId);

          req.session.save(() => {
            res.redirect("/auth/verify");
          });
        });
      }
    );
  } catch (err) {
    console.error("Registration error:", err);
    res.render("register", { title: "Register", error: "Something went wrong. Please try again.", user: null });
  }
});

// ── VERIFY ───────────────────────────────────────────────────────────────
app.get("/auth/verify", (req, res) => {
  

  if (!req.session.pendingVerification) {
    return res.redirect("/auth/register");
  }

  res.render("register-step2", {
    title: "Verify",
    user: null,
    email: req.session.pendingVerification.email,
    error: null,
    success: null,
  });
});

app.post("/auth/verify", validationVerifyRules, (req, res) => {
  const errors = validationResult(req);
  
  if (!errors.isEmpty()) {
    return res.render("register-step2", {
      title: "Verify",
      user: null,
      email: req.session.pendingVerification?.email || null,
      error: "Please enter all 6 numbers correctly.",
      success: null,
    });
  }

  const pending = req.session.pendingVerification;

  if (!pending) {
    return res.redirect("/auth/register");
  }

  const enteredCode = [
    req.body.code1,
    req.body.code2,
    req.body.code3,
    req.body.code4,
    req.body.code5,
    req.body.code6,
  ].join("");

  if (Date.now() > pending.expiresAt) {
    return res.render("register-step2", {
      title: "Verify",
      user: null,
      email: pending.email,
      error: 'Code has expired. Click "Send code again" below.',
      success: null,
    });
  }

  if ((pending.attempts || 0) >= MAX_CODE_ATTEMPTS) {
    return res.render("register-step2", {
      title: "Verify",
      user: null,
      email: pending.email,
      error: 'Too many wrong codes. Click "Send code again" below for a new one.',
      success: null,
    });
  }

  if (enteredCode !== pending.code) {
    pending.attempts = (pending.attempts || 0) + 1;
    req.session.save(() => {});
    return res.render("register-step2", {
      title: "Verify",
      user: null,
      email: pending.email,
      error: "Invalid code. Please try again.",
      success: null,
    });
  }

  connection.query(
    "UPDATE tbl_users SET isConfirmed = ?, verificationCode = ? WHERE IDuser = ?",
    [1, Number(enteredCode), pending.userId],
    (err) => {
      if (err) {
        console.error("Verification update error:", err);
        return res.render("register-step2", { title: "Verify", error: "Verification failed. Please try again.", email: pending.email, user: null });
      }

      // If user registered via invite link, add them to the group
      var pendingInvite = req.session.pendingInvite;
      req.session.regenerate(() => {
      req.session.user = {
        id: pending.userId,
        username: pending.username,
        email: pending.email,
      };

      if (pendingInvite) {
        connection.query(
          "SELECT * FROM tbl_groups WHERE inviteCode = ?",
          [pendingInvite],
          function(invErr, invRows) {
            if (!invErr && invRows && invRows.length > 0) {
              var group = invRows[0];
              connection.query(
                "INSERT IGNORE INTO tbl_group_members (groupId, userId, username, email) VALUES (?, ?, ?, ?)",
                [group.id, pending.userId, pending.username, pending.email],
                function() {
                  console.log(pending.username + " auto-joined group via invite: " + group.name);
                  req.session.save(() => {
                    res.redirect("/groups/" + group.id);
                  });
                }
              );
            } else {
              req.session.save(() => { res.redirect("/setup"); });
            }
          }
        );
      } else {
        req.session.save(() => {
          res.redirect("/setup");
        });
      }
      });
    }
  );
});

// ── RESEND CODE ──────────────────────────────────────────────────────────
app.get("/auth/resend-code", limits.resend, async (req, res) => {
  const pending = req.session.pendingVerification;
  if (!pending) return res.redirect("/auth/register");

  const newCode = generateCode();
  req.session.pendingVerification.code = newCode;
  req.session.pendingVerification.expiresAt = Date.now() + 30 * 60 * 1000;
  req.session.pendingVerification.attempts = 0;

  connection.query(
    "UPDATE tbl_users SET verificationCode = ? WHERE IDuser = ?",
    [Number(newCode), pending.userId],
    async (err) => {
      if (err) console.error("Resend code DB update error:", err);

      const sent = await sendVerificationEmail(pending.email, newCode);
      if (!sent) console.error("Resend verification email failed for user", pending.userId);

      req.session.save(() => {
        res.render("register-step2", {
          title: "Verify",
          user: null,
          email: pending.email,
          error: null,
          success: "A new code has been sent to your email.",
        });
      });
    }
  );
});

// ── LOGOUT ───────────────────────────────────────────────────────────────
app.get("/auth/logout", (req, res) => {
  req.session.destroy(() => {
    res.redirect("/");
  });
});

// ── FORGOT PASSWORD ─────────────────────────────────────────────────────
app.get("/auth/forgot-password", (req, res) => {
  res.render("forgot-password", { error: null, success: null });
});

app.post("/auth/forgot-password", limits.forgotIp, limits.forgotEmail, (req, res) => {
  var email = (req.body.email || '').trim();
  if (!email) {
    return res.render("forgot-password", { error: "Please enter your email.", success: null });
  }

  connection.query("SELECT IDuser, username, email, isConfirmed FROM tbl_users WHERE email = ? LIMIT 1", [email], function(err, rows) {
    if (err || !rows || rows.length === 0) {
      // Don't reveal whether the email exists
      return res.render("forgot-password", { error: null, success: "If an account with that email exists, a reset link has been sent." });
    }

    var user = rows[0];
    var crypto = require('crypto');
    var token = crypto.randomBytes(32).toString('hex');
    var expires = new Date(Date.now() + 3600000); // 1 hour

    connection.query(
      "UPDATE tbl_users SET resetToken = ?, resetTokenExpires = ? WHERE IDuser = ?",
      [token, expires, user.IDuser],
      function(updateErr) {
        if (updateErr) {
          console.error("Reset token save error:", updateErr.message);
          return res.render("forgot-password", { error: "Something went wrong. Please try again.", success: null });
        }

        var resetLink = siteBase(req) + '/auth/reset-password?token=' + token;

        sendEmail({
          to: email,
          subject: "Reset your Atlasphere password",
          html: '<div style="font-family:Arial;max-width:480px;margin:0 auto;padding:32px">' +
            '<h1 style="color:#0B3856">Reset your password</h1>' +
            '<p style="font-size:16px;color:#555">Hi ' + escapeHtml(user.username) + ', click the button below to reset your password. This link expires in 1 hour.</p>' +
            '<div style="text-align:center;margin:32px 0">' +
            '<a href="' + resetLink + '" style="display:inline-block;padding:14px 40px;background:#E8933A;color:#fff;text-decoration:none;border-radius:30px;font-weight:700;font-size:16px">Reset Password</a>' +
            '</div></div>'
        }).then(function(sent) {
          res.render("forgot-password", { error: null, success: "If an account with that email exists, a reset link has been sent." });
        }).catch(function(mailErr) {
          console.error("Reset email error:", mailErr.message);
          res.render("forgot-password", { error: null, success: "If an account with that email exists, a reset link has been sent." });
        });
      }
    );
  });
});

// ── RESET PASSWORD ──────────────────────────────────────────────────────
app.get("/auth/reset-password", (req, res) => {
  var token = req.query.token || '';
  if (!token) {
    return res.render("reset-password", { token: '', error: "Invalid or missing reset token.", success: null });
  }
  res.render("reset-password", { token: token, error: null, success: null });
});

app.post("/auth/reset-password", (req, res) => {
  var token = req.body.token || '';
  var password = req.body.password || '';
  var confirmPassword = req.body.confirmPassword || '';

  if (!token) {
    return res.render("reset-password", { token: '', error: "Invalid reset token.", success: null });
  }
  if (password.length < 6) {
    return res.render("reset-password", { token: token, error: "Password must be at least 6 characters.", success: null });
  }
  if (password !== confirmPassword) {
    return res.render("reset-password", { token: token, error: "Passwords do not match.", success: null });
  }

  connection.query(
    "SELECT IDuser FROM tbl_users WHERE resetToken = ? AND resetTokenExpires > NOW() LIMIT 1",
    [token],
    function(err, rows) {
      if (err || !rows || rows.length === 0) {
        return res.render("reset-password", { token: '', error: "This reset link has expired or is invalid.", success: null });
      }

      var userId = rows[0].IDuser;
      var bcrypt = require('bcrypt');
      bcrypt.hash(password, 10, function(hashErr, hash) {
        if (hashErr) {
          return res.render("reset-password", { token: token, error: "Something went wrong. Please try again.", success: null });
        }

        connection.query(
          "UPDATE tbl_users SET password = ?, resetToken = NULL, resetTokenExpires = NULL WHERE IDuser = ?",
          [hash, userId],
          function(updateErr) {
            if (updateErr) {
              return res.render("reset-password", { token: token, error: "Failed to update password.", success: null });
            }
            res.render("reset-password", { token: '', error: null, success: "Your password has been reset! You can now log in." });
          }
        );
      });
    }
  );
});

// ── PROFILE SETUP ────────────────────────────────────────────────────────
app.get("/setup", requireAuth, (req, res) => {
  res.render("setup", {
    title: "Profile Setup",
    user: req.session.user || null,
  });
});

app.post("/setup/upload", requireAuth, (req, res) => {
  if (!req.files || !req.files.profilePicture) {
    return res.redirect("/setup/countries");
  }

  var file = req.files.profilePicture;

  images.saveUpload(file, { width: 400, height: 400, prefix: "user{id}_".replace("{id}", req.session.user.id) }).then(function(dbPath) {

    connection.query(
      "UPDATE tbl_users SET profilePictureUrl = ?, profilePictureAlt = ? WHERE IDuser = ?",
      [dbPath, "Profile picture", req.session.user.id],
      function (dbErr) {
        if (dbErr) {
          console.error("DB update error:", dbErr);
        } else {
          req.session.user.profilePictureUrl = dbPath;
          console.log("Profile picture saved (resized):", dbPath);
        }

        req.session.save(function () {
          res.redirect("/setup/countries");
        });
      }
    );
  }).catch(function(upErr) {
    console.error("Profile photo upload error:", upErr.message);
    res.redirect("/setup/countries");
  });
});

// Upload from profile page (redirects back to /profile)
app.post("/profile/upload", requireAuth, (req, res) => {
  if (!req.files || !req.files.profilePicture) {
    return res.redirect("/profile");
  }

  var file = req.files.profilePicture;

  images.saveUpload(file, { width: 400, height: 400, prefix: "user{id}_".replace("{id}", req.session.user.id) }).then(function(dbPath) {

    connection.query(
      "UPDATE tbl_users SET profilePictureUrl = ?, profilePictureAlt = ? WHERE IDuser = ?",
      [dbPath, "Profile picture", req.session.user.id],
      function (dbErr) {
        if (dbErr) {
          console.error("DB update error:", dbErr);
        } else {
          req.session.user.profilePictureUrl = dbPath;
          console.log("Profile picture updated (resized):", dbPath);
        }

        req.session.save(function () {
          res.redirect("/profile");
        });
      }
    );
  }).catch(function(upErr) {
    console.error("Profile photo upload error:", upErr.message);
    res.redirect("/profile");
  });
});

app.get("/setup/countries", requireAuth, (req, res) => {
  res.render("groups/profile/countries", {
    title: "Countries Visited",
    user: req.session.user || null,
    countries: countries
  });
});

app.get("/setup/cities", requireAuth, (req, res) => {
  var selectedCodes = req.query["countries[]"] || req.query.countries || [];
  if (typeof selectedCodes === "string") selectedCodes = selectedCodes.split(",").filter(Boolean);

  var cities = [];
  var selectedCountryNames = [];
  selectedCodes.forEach(function(code) {
    var country = countries.find(function(c) { return c.code.toLowerCase() === code.toLowerCase(); });
    if (country) {
      selectedCountryNames.push(country.name);
      country.cities.forEach(function(cityName) {
        cities.push({ name: cityName, flag: country.flag, countryCode: country.code });
      });
    }
  });

  if (cities.length === 0) {
    countries.forEach(function(c) {
      c.cities.forEach(function(cityName) {
        cities.push({ name: cityName, flag: c.flag, countryCode: c.code });
      });
    });
  }

  res.render("groups/profile/cities", {
    title: "Cities Visited",
    user: req.session.user || null,
    cities: cities,
    selectedCodes: selectedCodes,
    selectedCountryNames: selectedCountryNames
  });
});

app.post("/setup/save-visited", requireAuth, (req, res) => {
  var visitedCountryCodes = (req.body.countries || "").split(",").filter(Boolean);
  var visitedCities = req.body['cities[]'] || req.body['cities'] || req.body.cities || [];
  if (typeof visitedCities === "string") visitedCities = [visitedCities];

  console.log("SAVE-VISITED countries:", visitedCountryCodes);
  console.log("SAVE-VISITED cities:", visitedCities);

  req.session.user.visitedCities = visitedCities;

  connection.query(
    "UPDATE tbl_users SET visitedCountries = ?, visitedCities = ? WHERE IDuser = ?",
    [visitedCountryCodes.join(","), visitedCities.join(","), req.session.user.id],
    function(err) {
      if (err) console.error("Save visited error:", err.message);
      req.session.save(function() {
        res.redirect("/profile/confirmed");
      });
    }
  );
});

// ── PROFILE ──────────────────────────────────────────────────────────────

app.get("/profile/confirmed", requireAuth, (req, res) => {
  try {
    res.render("groups/profile/confirmed", { user: req.session.user || null });
  } catch (err) {
    console.error("Profile confirmed render error:", err.message);
    res.redirect("/");
  }
});

app.get("/profile", requireAuth, (req, res) => {
  var userId = req.session.user.id;
  console.log('Profile userId:', userId);

  connection.query(
    "SELECT profilePictureUrl, visitedCountries, visitedCities FROM tbl_users WHERE IDuser = ?",
    [userId],
    function (err, results) {
      var image = null;
      var visitedFlags = [];
      var visitedCityList = [];

      if (err) {
        console.error("Profile query error:", err.message);
      }

      if (!err && results && results.length > 0) {
        image = results[0].profilePictureUrl || null;

        var visitedCodes = (results[0].visitedCountries || "").split(",").filter(Boolean);
        visitedCodes.forEach(function(code) {
          var country = countries.find(function(c) { return c.code.toLowerCase() === code.toLowerCase(); });
          if (country) visitedFlags.push({ code: country.code, name: country.name });
        });

        visitedCityList = (results[0].visitedCities || "").split(",").filter(Boolean);
        console.log('Profile DB visitedCities raw:', results[0].visitedCities);
        console.log('Profile DB visitedCityList parsed:', visitedCityList);
      }

      if (!image && req.session.user.profilePictureUrl) {
        image = req.session.user.profilePictureUrl;
      }
      if (visitedFlags.length === 0 && req.session.user.visitedCountries) {
        visitedFlags = req.session.user.visitedCountries;
      }
      if (visitedCityList.length === 0 && req.session.user.visitedCities) {
        visitedCityList = req.session.user.visitedCities;
      }

      connection.query(
        "SELECT g.* FROM tbl_groups g INNER JOIN tbl_group_members gm ON g.id = gm.groupId WHERE gm.userId = ?",
        [userId],
        function (grpErr, grpRows) {
          var groupCount = 0;
          var planningFlags = [];

          if (!grpErr && grpRows) {
            groupCount = grpRows.length;
            grpRows.forEach(function (g) {
              console.log('Group:', g.name, '| destination:', g.destination);
              var destination = g.name || g.destination || '';
              var country = countries.find(function(c) {
                return c.name.toLowerCase() === destination.toLowerCase();
              });
              if (country) {
                var alreadyAdded = planningFlags.some(function(f) { return f.code === country.code; });
                if (!alreadyAdded) {
                  planningFlags.push({ code: country.code, name: country.name });
                }
              }
            });
          }

          var user = req.session.user;
          user.visitedCountries = visitedFlags;
          user.visitedCities = visitedCityList;
          user.planningCountries = planningFlags;
          user.groups_created = groupCount;

          friendsService.countFriends(userId)
            .catch(function() { return null; })
            .then(function(friendCount) {
              res.render("profile", { user: user, image: image, friendCount: friendCount });
            });
        }
      );
    }
  );
});

// ── SETTINGS ─────────────────────────────────────────────────────────────
app.get("/settings", requireAuth, (req, res) => {
  const userId = req.session.user.id;
  connection.query(
    "SELECT u.*, g.Value as genderValue FROM tbl_users u LEFT JOIN tbl_gender g ON u.FIDgender = g.IDgender WHERE u.IDuser = ?",
    [userId],
    function(err, results) {
      if (err) {
        console.error("Settings query error:", err.message);
        return res.redirect("/");
      }
      
      const user = results[0] || req.session.user;
      // Parse visited countries and cities from DB
      const visitedCountryCodes = (typeof user.visitedCountries === 'string' ? user.visitedCountries : '').split(',').filter(Boolean);
      const visitedCityNames = (typeof user.visitedCities === 'string' ? user.visitedCities : '').split(',').filter(Boolean);
      user.visitedCountries = visitedCountryCodes;
      user.visitedCities = visitedCityNames;

      // Load user's groups from DB
      connection.query(
        "SELECT g.* FROM tbl_groups g INNER JOIN tbl_group_members gm ON g.id = gm.groupId WHERE gm.userId = ?",
        [userId],
        function(grpErr, grpRows) {
          var groups = (grpRows || []).map(function(g) {
            // Parse preferences JSON into comma-separated activities string for the template
            try {
              var prefs = JSON.parse(g.preferences || '[]');
              g.activities = Array.isArray(prefs) ? prefs.join(',') : '';
            } catch(e) {
              g.activities = g.preferences || '';
            }
            return g;
          });
          res.render("settings", {
            user: user,
            groups: groups,
            allCountriesData: countries
          });
        }
      );
    }
  );
});

// ── Activities ────────────────────────────────────────────────
app.get("/groups/create/activities", requireAuth, (req, res) => {
  res.render("groups/activities", {
    title: "Activities",
    user: req.session.user || null,
    groupId: req.query.groupId || ''
  });
});

// ── Save activity preferences for a group ───────────────────────────────
app.post("/groups/save-activities", requireAuth, requireMember(), (req, res) => {
  var { groupId, activities } = req.body;
  if (!groupId || !Array.isArray(activities)) {
    return res.status(400).json({ error: "Missing groupId or activities" });
  }
  //stores activities as a JSON string in the database
  var prefs = JSON.stringify(activities);
  connection.query(
    "UPDATE tbl_groups SET preferences = ? WHERE id = ?",
    [prefs, groupId],
    function(err) {
      if (err) {
        console.error("Save activities error:", err.message);
        return res.status(500).json({ error: "Failed to save" });
      }
      res.json({ success: true });
    }
  );
});

// ── GROUPS / USERS ROUTES ────────────────────────────────────────────────
app.use("/api/mobile", require("./routes/mobile")({ connection, bcrypt, sendVerificationEmail, sendEmail, generateCode }));
app.use(require("./routes/friends")(connection));
app.use(require("./routes/destination")(connection));
app.use(require("./routes/admin")(connection));
// Help, Privacy and Terms pages (also linked from the mobile app).
app.locals.supportEmail = process.env.SUPPORT_EMAIL || "atlasphere.app@gmail.com";
var INFO_PAGES = { help: "Help", privacy: "Privacy Policy", terms: "Terms of Service" };
Object.keys(INFO_PAGES).forEach(function (page) {
  app.get("/" + page, function (req, res) {
    res.render("info", { page: page, title: INFO_PAGES[page], updated: "7 November 2026", user: req.session.user || null });
  });
});
app.use("/groups", require("./routes/groups"));
app.use("/users", require("./routes/users"));

// ── API Route ────────────────────────────────────────────────

// Attraction recommendations come from Foursquare Places — see config/places.js.
// ?city=Rome, or ?cities=Seoul,Busan,Jeju for a trip with several cities.
app.get("/api/recommendations", requireAuth, async (req, res) => {
  var cities = String(req.query.cities || req.query.city || "Rome").split(",")
    .map(function(c) { return c.trim().slice(0, 80); })
    .filter(function(c, i, a) { return c && a.indexOf(c) === i; })
    .slice(0, 6);
  if (!cities.length) cities = ["Rome"];

  var preferences = req.query.activities
    ? String(req.query.activities).split(",").map(function(s) {
        return s.trim();
      }).filter(Boolean)
    : [];

  try {
    var results = cities.length > 1
      ? await getRecommendationsForCities(cities, preferences, 50)
      : await getRecommendations(cities[0], preferences);
    res.json(results.slice(0, 50));
  } catch (error) {
    console.error(
      "Recommendations error:",
      error.response ? JSON.stringify(error.response.data) : error.message
    );
    res.status(500).json({ error: "Failed to fetch recommendations." });
  }
});


// ── VOTE API ────────────────────────────────────────────────────────────

// saves or updates user's vote on an activity
app.post("/api/votes", requireAuth, requireMember(), (req, res) => {
  var userId = req.session.user.id;
  var userName = req.session.user.username || 'Someone';
  var { groupId, activityId, activityName, activityImage, activityDesc, activityTags, vote } = req.body;
  console.log("Vote POST:", { groupId, activityId, activityName: activityName ? activityName.substring(0, 30) : '', vote, userId });
  if (!groupId || !activityId || !vote) return res.status(400).json({ error: "Missing fields" });
  var tagsStr = Array.isArray(activityTags) ? activityTags.join(",") : (activityTags || "");
  connection.query(
    "INSERT INTO tbl_activity_votes (groupId, userId, activityId, activityName, activityImage, activityDesc, activityTags, `vote`) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE `vote` = ?, activityName = ?, activityImage = ?, activityDesc = ?, activityTags = ?",
    [groupId, userId, activityId, activityName || "", activityImage || "", activityDesc || "", tagsStr, vote, vote, activityName || "", activityImage || "", activityDesc || "", tagsStr],
    function(err) {
      if (err) { console.error("Vote save error:", err.message); return res.status(500).json({ error: "Failed" }); }

      // Create notifications for other group members
      if (vote !== 'downvote') {
        var voteLabel = vote === 'upvote' ? 'upvoted' : 'bookmarked';
        connection.query("SELECT g.name as groupName, gm.userId FROM tbl_group_members gm JOIN tbl_groups g ON g.id = gm.groupId WHERE gm.groupId = ? AND gm.userId != ?",
          [groupId, userId],
          function(nErr, members) {
            if (nErr || !members || members.length === 0) return;
            var groupName = members[0].groupName;
            var msg = userName + ' ' + voteLabel + ' "' + (activityName || 'an activity').substring(0, 60) + '"';
            var values = members.map(function(m) { return [m.userId, groupId, groupName, msg, 'vote']; });
            connection.query("INSERT INTO tbl_notifications (userId, groupId, groupName, message, type) VALUES ?", [values], function(iErr) {
              if (iErr) console.error("Notification insert error:", iErr.message);
              // Emit socket notification to group
              io.to("group-" + groupId).emit("new-notification", { groupId: groupId, groupName: groupName, message: msg });
            });
          }
        );
      }

      res.json({ success: true });
    }
  );
});

app.get("/api/votes", requireAuth, requireMember({ onMissing: function (req, res) { res.json([]); } }), (req, res) => {
  var groupId = req.query.groupId;
  if (!groupId) return res.json([]);
  connection.query(
    "SELECT DISTINCT activityId, activityName, activityImage, activityDesc, activityTags, `vote` FROM tbl_activity_votes WHERE groupId = ?",
    [groupId],
    function(err, rows) { res.json(!err && rows ? rows : []); }
  );
});

app.get("/api/votes/saved", requireAuth, requireMember({ onMissing: function (req, res) { res.json([]); } }), (req, res) => {
  var groupId = req.query.groupId;
  var type = req.query.type;
  console.log("Vote SAVED GET:", { groupId, type });
  if (!groupId) return res.json([]);
  var sql = "SELECT DISTINCT activityId, activityName, activityImage, activityDesc, activityTags, `vote` FROM tbl_activity_votes WHERE groupId = ?";
  var params = [groupId];
  if (type === 'upvote' || type === 'bookmark') { sql += " AND `vote` = ?"; params.push(type); }
  else { sql += " AND `vote` IN ('upvote', 'bookmark')"; }
  connection.query(sql, params, function(err, rows) {
    console.log("Vote saved result:", { err: err ? err.message : null, count: rows ? rows.length : 0 });
    res.json(!err && rows ? rows : []);
  });
});

// ── ITINERARY BLOCKS API ─────────────────────────────────────────────────

// Save a single block (upsert)
app.post("/api/itinerary/block", requireAuth, requireMember(), (req, res) => {
  var userId = req.session.user.id;
  var { groupId, dayIndex, timeSlot, activityName, activityColor, duration } = req.body;
  if (!groupId || dayIndex === undefined || !timeSlot || !activityName) return res.status(400).json({ error: "Missing fields" });
  var dur = duration || 1;
  connection.query(
    "INSERT INTO tbl_itinerary_blocks (groupId, dayIndex, timeSlot, activityName, activityColor, duration, updatedBy) VALUES (?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE activityName = ?, activityColor = ?, duration = ?, updatedBy = ?",
    [groupId, dayIndex, timeSlot, activityName, activityColor || '#E8933A', dur, userId, activityName, activityColor || '#E8933A', dur, userId],
    function(err) {
      if (err) { console.error("Block save error:", err.message); return res.status(500).json({ error: "Failed" }); }
      res.json({ success: true });
    }
  );
});

// Delete a single block
app.delete("/api/itinerary/block", requireAuth, requireMember(), (req, res) => {
  var { groupId, dayIndex, timeSlot } = req.body;
  if (!groupId || dayIndex === undefined || !timeSlot) return res.status(400).json({ error: "Missing fields" });
  connection.query(
    "DELETE FROM tbl_itinerary_blocks WHERE groupId = ? AND dayIndex = ? AND timeSlot = ?",
    [groupId, dayIndex, timeSlot],
    function(err) {
      if (err) { console.error("Block delete error:", err.message); return res.status(500).json({ error: "Failed" }); }
      res.json({ success: true });
    }
  );
});

// Save all blocks for a group (full replace) - kept for compatibility
app.post("/api/itinerary/blocks", requireAuth, requireMember(), (req, res) => {
  var userId = req.session.user.id;
  var { groupId, blocks } = req.body;
  console.log("Itinerary save:", { groupId, userId, blockCount: blocks ? blocks.length : 0 });
  if (!groupId) return res.status(400).json({ error: "Missing groupId" });

  // Delete existing blocks for this group, then insert new ones
  connection.query("DELETE FROM tbl_itinerary_blocks WHERE groupId = ?", [groupId], function(err) {
    if (err) { console.error("Itinerary delete error:", err.message); return res.status(500).json({ error: "Failed" }); }

    if (!blocks || blocks.length === 0) return res.json({ success: true });

    var values = blocks.map(function(b) {
      return [groupId, b.dayIndex, b.timeSlot, b.activityName, b.activityColor || '#E8933A', b.duration || 1, userId];
    });

    connection.query(
      "INSERT INTO tbl_itinerary_blocks (groupId, dayIndex, timeSlot, activityName, activityColor, duration, updatedBy) VALUES ?",
      [values],
      function(insertErr) {
        if (insertErr) { console.error("Itinerary insert error:", insertErr.message); return res.status(500).json({ error: "Failed" }); }
        res.json({ success: true });
      }
    );
  });
});

// Load blocks for a group
app.get("/api/itinerary/blocks", requireAuth, requireMember({ onMissing: function (req, res) { res.json([]); } }), (req, res) => {
  var groupId = req.query.groupId;
  if (!groupId) return res.json([]);
  connection.query(
    "SELECT dayIndex, timeSlot, activityName, activityColor, COALESCE(duration, 1) AS duration FROM tbl_itinerary_blocks WHERE groupId = ? ORDER BY dayIndex, timeSlot",
    [groupId],
    function(err, rows) {
      res.json(!err && rows ? rows : []);
    }
  );
});

// Save shared date range for a group
app.post("/api/itinerary/dates", requireAuth, requireMember(), (req, res) => {
  var { groupId, rangeStart, rangeEnd, calYear, calMonth } = req.body;
  if (!groupId) return res.status(400).json({ error: "Missing groupId" });
  connection.query(
    "INSERT INTO tbl_itinerary_dates (groupId, rangeStart, rangeEnd, calYear, calMonth) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE rangeStart = ?, rangeEnd = ?, calYear = ?, calMonth = ?",
    [groupId, rangeStart, rangeEnd, calYear, calMonth, rangeStart, rangeEnd, calYear, calMonth],
    function(err) {
      if (err) { console.error("Date save error:", err.message); return res.status(500).json({ error: "Failed" }); }
      res.json({ success: true });
    }
  );
});

// Load shared date range for a group
app.get("/api/itinerary/dates", requireAuth, requireMember({ onMissing: function (req, res) { res.json(null); } }), (req, res) => {
  var groupId = req.query.groupId;
  if (!groupId) return res.json(null);
  connection.query(
    "SELECT rangeStart, rangeEnd, calYear, calMonth FROM tbl_itinerary_dates WHERE groupId = ?",
    [groupId],
    function(err, rows) {
      if (!err && rows && rows.length > 0) return res.json(rows[0]);
      res.json(null);
    }
  );
});

// ── ITINERARY: which city each day is in ─────────────────────────────────
// Only days that were set are stored; a day without one follows the day
// before (the client works that out).
app.get("/api/itinerary/day-cities", requireAuth, requireMember({ onMissing: function (req, res) { res.json([]); } }), (req, res) => {
  connection.query(
    "SELECT dayIndex, city FROM tbl_itinerary_day_cities WHERE groupId = ? ORDER BY dayIndex",
    [req.query.groupId],
    function(err, rows) { res.json(!err && rows ? rows : []); }
  );
});

app.post("/api/itinerary/day-cities", requireAuth, requireMember(), (req, res) => {
  var groupId = req.body.groupId;
  var dayIndex = parseInt(req.body.dayIndex, 10);
  var city = String(req.body.city || "").trim();
  if (!(dayIndex >= 0 && dayIndex < 366) || !city) return res.status(400).json({ error: "Missing day or city" });
  connection.query("SELECT destination, cities FROM tbl_groups WHERE id = ?", [groupId], function(gErr, gRows) {
    if (gErr || !gRows || !gRows.length) return res.status(404).json({ error: "Trip not found" });
    var allowed = tripCities(gRows[0]);
    var match = allowed.find(function(c) { return c.toLowerCase() === city.toLowerCase(); });
    if (!match) return res.status(400).json({ error: "That city isn't part of this trip." });
    connection.query(
      "INSERT INTO tbl_itinerary_day_cities (groupId, dayIndex, city) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE city = VALUES(city)",
      [groupId, dayIndex, match],
      function(err) {
        if (err) { console.error("Day city save error:", err.message); return res.status(500).json({ error: "Failed" }); }
        res.json({ success: true, dayIndex: dayIndex, city: match });
      }
    );
  });
});

// ── ITINERARY COMMENTS API ────────────────────────────────────────────────
// Notes attached to a scheduled block, identified by (groupId, dayIndex, timeSlot).

// List comments for one block, oldest first.
app.get("/api/itinerary/comments", requireAuth, requireMember({ onMissing: function (req, res) { res.json([]); } }), (req, res) => {
  var { groupId, dayIndex, timeSlot } = req.query;
  if (!groupId || dayIndex === undefined || !timeSlot) return res.json([]);
  connection.query(
    "SELECT id, userId, userName, comment, createdAt FROM tbl_itinerary_comments WHERE groupId = ? AND dayIndex = ? AND timeSlot = ? ORDER BY createdAt ASC",
    [groupId, dayIndex, timeSlot],
    function(err, rows) {
      if (err) { console.error("Comment load error:", err.message); return res.json([]); }
      res.json((rows || []).map(function(r) {
        return { id: r.id, userId: r.userId, userName: r.userName, comment: r.comment, createdAt: r.createdAt ? new Date(r.createdAt).toISOString() : null };
      }));
    }
  );
});

// Count comments per block for a group, so the UI can badge which blocks have notes.
app.get("/api/itinerary/comments/counts", requireAuth, requireMember({ onMissing: function (req, res) { res.json([]); } }), (req, res) => {
  var groupId = req.query.groupId;
  if (!groupId) return res.json([]);
  connection.query(
    "SELECT dayIndex, timeSlot, COUNT(*) AS count FROM tbl_itinerary_comments WHERE groupId = ? GROUP BY dayIndex, timeSlot",
    [groupId],
    function(err, rows) {
      if (err) { console.error("Comment count error:", err.message); return res.json([]); }
      res.json(rows || []);
    }
  );
});

// Add a comment to a block (author taken from the session).
app.post("/api/itinerary/comments", requireAuth, requireMember(), (req, res) => {
  var userId = req.session.user.id;
  var userName = req.session.user.username || 'Someone';
  var { groupId, dayIndex, timeSlot, comment } = req.body;
  var text = (comment || '').toString().trim();
  if (!groupId || dayIndex === undefined || !timeSlot || !text) {
    return res.status(400).json({ error: "Missing fields" });
  }
  if (text.length > 1000) text = text.slice(0, 1000);
  connection.query(
    "INSERT INTO tbl_itinerary_comments (groupId, dayIndex, timeSlot, userId, userName, comment) VALUES (?, ?, ?, ?, ?, ?)",
    [groupId, dayIndex, timeSlot, userId, userName, text],
    function(err, result) {
      if (err) { console.error("Comment save error:", err.message); return res.status(500).json({ error: "Failed" }); }
      res.json({
        success: true,
        comment: { id: result.insertId, userId: userId, userName: userName, comment: text, createdAt: new Date().toISOString() }
      });
    }
  );
});

// Delete own comment.
app.delete("/api/itinerary/comments", requireAuth, (req, res) => {
  var userId = req.session.user.id;
  var { id } = req.body;
  if (!id) return res.status(400).json({ error: "Missing id" });
  connection.query(
    "DELETE FROM tbl_itinerary_comments WHERE id = ? AND userId = ?",
    [id, userId],
    function(err) {
      if (err) { console.error("Comment delete error:", err.message); return res.status(500).json({ error: "Failed" }); }
      res.json({ success: true });
    }
  );
});

// ── NOTIFICATIONS API ────────────────────────────────────────────────────

// Get notifications for current user
app.get("/api/notifications", requireAuth, (req, res) => {
  var userId = req.session.user.id;
  connection.query(
    "SELECT id, groupId, groupName, message, type, isRead, createdAt FROM tbl_notifications WHERE userId = ? ORDER BY createdAt DESC LIMIT 50",
    [userId],
    function(err, rows) {
      if (err) { console.error("Notif load error:", err.message); return res.json([]); }
      // Convert timestamps to ISO and group notifications
      var notifications = (rows || []).map(function(n) {
        return { id: n.id, groupId: n.groupId, groupName: n.groupName, message: n.message, type: n.type, isRead: n.isRead, createdAt: n.createdAt ? new Date(n.createdAt).toISOString() : null };
      });
      var unreadByGroup = {};
      notifications.forEach(function(n) {
        if (!n.isRead) {
          if (!unreadByGroup[n.groupId]) unreadByGroup[n.groupId] = { count: 0, groupName: n.groupName, groupId: n.groupId };
          unreadByGroup[n.groupId].count++;
        }
      });
      var summarizedGroups = {};
      var results = [];
      notifications.forEach(function(n) {
        if (!n.isRead && unreadByGroup[n.groupId] && unreadByGroup[n.groupId].count >= 4 && !summarizedGroups[n.groupId]) {
          summarizedGroups[n.groupId] = true;
          results.push({ id: n.id, groupId: n.groupId, groupName: n.groupName, message: n.groupName + ' has ' + unreadByGroup[n.groupId].count + ' new votes', type: 'vote-summary', isRead: 0, createdAt: n.createdAt });
        } else if (!n.isRead && unreadByGroup[n.groupId] && unreadByGroup[n.groupId].count >= 4) {
          // Skip individual ones for summarized groups
        } else {
          results.push(n);
        }
      });
      // Friend requests / acceptances live in tbl_friendships; merge them in.
      friendsService.notifications(userId)
        .then(function(friendNotes) {
          var all = results.concat(friendNotes).sort(function(a, b) {
            return new Date(b.createdAt || 0) - new Date(a.createdAt || 0);
          });
          res.json(all.slice(0, 50));
        })
        .catch(function(fErr) {
          console.error("Friend notif load error:", fErr.message);
          res.json(results);
        });
    }
  );
});

// Get unread count
app.get("/api/notifications/count", requireAuth, (req, res) => {
  var userId = req.session.user.id;
  connection.query(
    "SELECT COUNT(*) as cnt FROM tbl_notifications WHERE userId = ? AND isRead = 0",
    [userId],
    function(err, rows) {
      var base = (!err && rows && rows[0]) ? Number(rows[0].cnt) : 0;
      friendsService.unseenCount(userId)
        .then(function(n) { res.json({ count: base + n }); })
        .catch(function() { res.json({ count: base }); });
    }
  );
});

// Mark all as read
app.post("/api/notifications/read", requireAuth, (req, res) => {
  var userId = req.session.user.id;
  connection.query("UPDATE tbl_notifications SET isRead = 1 WHERE userId = ?", [userId], function(err) {
    friendsService.markSeen(userId)
      .catch(function(fErr) { console.error("Friend notif mark-read error:", fErr.message); })
      .then(function() { res.json({ success: !err }); });
  });
});

// Get last active time for a group
app.get("/api/groups/last-active", requireAuth, requireMember({ onMissing: function (req, res) { res.json({ lastActive: null }); } }), (req, res) => {
  var groupId = req.query.groupId;
  if (!groupId) return res.json({ lastActive: null });
  connection.query(
    "SELECT createdAt, userName FROM tbl_chat_messages WHERE groupId = ? ORDER BY createdAt DESC LIMIT 1",
    [groupId],
    function(err, rows) {
      if (!err && rows && rows.length > 0) {
        return res.json({ lastActive: new Date(rows[0].createdAt).toISOString(), userName: rows[0].userName });
      }
      res.json({ lastActive: null });
    }
  );
});

// ── Invite friend to group (JSON API) ─────────────────────────────────────
app.post("/api/groups/invite", requireAuth, requireMember(), (req, res) => {
  var userId = req.session.user.id;
  var userName = req.session.user.username;
  var { groupId, query } = req.body;
  if (!groupId || !query) return res.status(400).json({ error: "Missing groupId or search query" });

  // Try to find user by username or email
  connection.query(
    "SELECT IDuser, username, email FROM tbl_users WHERE username = ? OR email = ?",
    [query.trim(), query.trim()],
    function(err, rows) {
      if (err) return res.status(500).json({ error: "Database error" });

      // ── No account found — send an email invite if query looks like an email ──
      if (!rows || rows.length === 0) {
        var isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(query.trim());
        if (isEmail && limits.inviteEmail.take(String(userId))) {
          return res.status(429).json({ success: false, error: "You've sent a lot of invites. Please try again later." });
        }
        if (!isEmail) {
          return res.json({ success: false, error: 'No user found matching "' + query + '"' });
        }
        // Fetch group name + invite link to send in email
        connection.query(
          "SELECT name, inviteCode FROM tbl_groups WHERE id = ?",
          [groupId],
          function(gErr, gRows) {
            if (gErr || !gRows || !gRows.length) {
              return res.json({ success: false, error: 'Group not found' });
            }
            var gName = gRows[0].name;
            var joinLink = siteBase(req) + '/groups/join/' + gRows[0].inviteCode;
            var safeName = escapeHtml(userName), safeGroup = escapeHtml(gName);
            sendEmail({
              to: query.trim(),
              subject: userName + ' invited you to join "' + gName + '" on Atlasphere',
              html: `
                <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:32px;">
                  <h1 style="color:#0B3856;font-size:24px;">You've been invited!</h1>
                  <p style="color:#555;font-size:16px;line-height:1.6;">
                    <strong>${safeName}</strong> invited you to join the <strong>"${safeGroup}"</strong> group on Atlasphere.
                  </p>
                  <a href="${joinLink}" style="display:inline-block;margin:24px 0;padding:14px 32px;background:#E8933A;color:#fff;border-radius:30px;text-decoration:none;font-weight:700;font-size:16px;">
                    Join "${safeGroup}"
                  </a>
                  <p style="color:#888;font-size:13px;">
                    You'll need to create a free account to join. The link above will take you straight there.
                  </p>
                </div>
              `
            }).catch(function(e) { console.error('Invite email error:', e.message); });
            return res.json({ success: true, message: 'Invite sent to ' + query.trim() });
          }
        );
        return;
      }

      var friend = rows[0];
      if (String(friend.IDuser) === String(userId)) return res.json({ success: false, error: "You can't invite yourself" });

      // Check if already a member
      connection.query(
        "SELECT id FROM tbl_group_members WHERE groupId = ? AND userId = ?",
        [groupId, friend.IDuser],
        function(checkErr, checkRows) {
          if (checkRows && checkRows.length > 0) {
            return res.json({ success: false, error: friend.username + " is already in this group" });
          }

          // Add to group
          connection.query(
            "INSERT IGNORE INTO tbl_group_members (groupId, userId, username, email) VALUES (?, ?, ?, ?)",
            [groupId, friend.IDuser, friend.username, friend.email],
            function(insertErr) {
              if (insertErr) return res.status(500).json({ error: "Failed to add member" });

              // Fetch group name for the notification message
              connection.query(
                "SELECT name FROM tbl_groups WHERE id = ?",
                [groupId],
                function(gErr, gRows) {
                  var groupName = (gRows && gRows.length > 0) ? gRows[0].name : 'a group';
                  var notifMsg = userName + ' added you to "' + groupName + '"';
                  connection.query(
                    "INSERT INTO tbl_notifications (userId, groupId, groupName, message, type) VALUES (?, ?, ?, ?, ?)",
                    [friend.IDuser, groupId, groupName, notifMsg, 'invite'],
                    function() {}
                  );
                }
              );

              return res.json({ success: true, message: friend.username + " has been added!" });
            }
          );
        }
      );
    }
  );
});

// ── Get invite link for a group ───────────────────────────────────────────
app.get("/api/groups/invite-link", requireAuth, requireMember(), (req, res) => {
  var groupId = req.query.groupId;
  if (!groupId) return res.status(400).json({ error: "Missing groupId" });

  connection.query(
    "SELECT inviteCode FROM tbl_groups WHERE id = ?",
    [groupId],
    function(err, rows) {
      if (err || !rows || rows.length === 0) return res.status(404).json({ error: "Group not found" });
      var inviteLink = siteBase(req) + "/groups/join/" + rows[0].inviteCode;
      res.json({ inviteLink: inviteLink });
    }
  );
});

// ── ERROR HANDLING ───────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).render("error", {
    status: 404,
    message: "Page not found",
    user: req.session.user || null,
  });
});

app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).render("error", {
    status: 500,
    message: "Something went wrong",
    user: req.session.user || null,
  });
});

// ── SOCKET.IO + START SERVER ─────────────────────────────────────────────
const http = require("http");
const { Server } = require("socket.io");

const server = http.createServer(app);
const io = new Server(server);
var roomMembers = {}; // { "group-123": { "userId1": true, ... } }

// Sockets use the same login session as the website. Every trip room is
// checked against the trip's members, and who sent a message always comes
// from the session, never from the browser.
io.engine.use(sessionMiddleware);

io.on("connection", function(socket) {
  var me = socket.request.session && socket.request.session.user;
  if (!me) { socket.disconnect(true); return; }
  var allowed = {}; // groupId -> true once membership is confirmed

  function enterRoom(groupId) {
    var gid = String(groupId || "");
    if (!/^\d{1,20}$/.test(gid)) return Promise.resolve(false);
    if (allowed[gid]) return Promise.resolve(true);
    return membership.isMember(me.id, gid).then(function(ok) {
      if (ok) { allowed[gid] = true; socket.join("group-" + gid); }
      return ok;
    }).catch(function(err) { console.error("Socket membership check failed:", err.message); return false; });
  }

  // ── Notification socket: joins the user's trip rooms for navbar badges ──
  socket.on("join-notifications", function(data) {
    if (!data || !Array.isArray(data.groupIds)) return;
    data.groupIds.slice(0, 200).forEach(function(gid) { enterRoom(gid); });
  });

  // Itinerary live sync: listen to a trip without loading the chat.
  socket.on("watch-group", function(data) {
    if (data) enterRoom(data.groupId);
  });

  socket.on("join-group", function(data) {
    if (!data) return;
    enterRoom(data.groupId).then(function(ok) {
      if (!ok) { socket.emit("chat-error", { error: "You're not a member of this trip." }); return; }
      var room = "group-" + data.groupId;
      socket.userData = { userId: me.id, userName: me.username, groupId: String(data.groupId), userAvatar: me.profilePictureUrl || '' };

      // Load last 100 messages from DB
      connection.query(
        "SELECT id, groupId, userId, userName, userAvatar, `text`, `time`, `system` FROM tbl_chat_messages WHERE groupId = ? ORDER BY createdAt ASC LIMIT 100",
        [data.groupId],
        function (err, rows) {
          var history = [];
          if (!err && rows) {
            history = rows.map(function (r) {
              return { id: r.id, userId: r.userId, userName: r.userName, userAvatar: r.userAvatar || '', user: r.userName, text: r.text, time: r.time, system: !!r.system };
            });
          }
          socket.emit("chat-history", history);
        }
      );

      // Only broadcast "user joined" if they're not already in the room
      if (!roomMembers[room]) roomMembers[room] = {};
      if (!roomMembers[room][me.id]) {
        roomMembers[room][me.id] = true;
        socket.to(room).emit("user-joined", { userName: me.username });
      }
    });
  });

  socket.on("send-message", function(data) {
    if (!data) return;
    var gid = String(data.groupId || "");
    if (!allowed[gid]) return; // must have joined the trip first
    var text = typeof data.text === "string" ? data.text.trim().slice(0, 2000) : "";
    if (!text) return;
    var room = "group-" + gid;
    var msgId = Date.now() + "-" + require("crypto").randomBytes(3).toString("hex");
    var now = new Date();
    var timeStr = now.toISOString();                                    // full ISO → sent over socket
    var timeForDb = now.toTimeString().slice(0, 5);                    // "HH:MM" → fits the time column
    var avatar = me.profilePictureUrl || '';
    var msg = {
      id: msgId,
      groupId: gid,
      userId: me.id,
      userName: me.username,
      userAvatar: avatar,
      user: me.username,
      text: text,
      time: timeStr
    };

    // Save to DB
    connection.query(
      "INSERT INTO tbl_chat_messages (id, groupId, userId, userName, userAvatar, `text`, `time`, `system`) VALUES (?, ?, ?, ?, ?, ?, ?, 0)",
      [msgId, gid, me.id, me.username, avatar, text, timeForDb],
      function (err) {
        if (err) console.error("Message save error:", err.message);
      }
    );

    io.to(room).emit("new-message", msg);
  });

  // ── Itinerary real-time sync ─────────────────────────────────────────────
  socket.on("itinerary-update", function(data) {
    if (!data) return;
    enterRoom(data.groupId).then(function(ok) {
      if (ok) socket.to("group-" + data.groupId).emit("itinerary-update", data);
    });
  });

  socket.on("disconnect", function() {
    if (socket.userData) {
      var room = "group-" + socket.userData.groupId;
      if (roomMembers[room] && roomMembers[room][socket.userData.userId]) {
        // Check if user has any other sockets still in the room
        var room_sockets = io.sockets.adapter.rooms.get(room);
        var stillConnected = false;
        if (room_sockets) {
          room_sockets.forEach(function(sid) {
            var s = io.sockets.sockets.get(sid);
            if (s && s.userData && s.userData.userId === socket.userData.userId && s.id !== socket.id) {
              stillConnected = true;
            }
          });
        }
        if (!stillConnected) {
          delete roomMembers[room][socket.userData.userId];
        }
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', function() {
  console.log("Server running on port " + PORT);
  console.log("Socket.io enabled for real-time chat");

  // Auto-migrate: add duration column if it doesn't exist yet
  connection.query(
    "ALTER TABLE tbl_itinerary_blocks ADD COLUMN duration FLOAT NOT NULL DEFAULT 1",
    function(err) {
      if (err && err.code === 'ER_DUP_FIELDNAME') { /* column already exists, fine */ }
      else if (err) { console.error("Migration note:", err.message); }
      else { console.log("Added duration column to tbl_itinerary_blocks"); }
    }
  );

  // Auto-migrate: add preferences column to tbl_groups if it doesn't exist
  connection.query(
    "ALTER TABLE tbl_groups ADD COLUMN preferences TEXT",
    function(err) {
      if (err && err.code === 'ER_DUP_FIELDNAME') { /* column already exists, fine */ }
      else if (err) { console.error("Migration note:", err.message); }
      else { console.log("Added preferences column to tbl_groups"); }
    }
  );

  // Auto-migrate: add reset token columns to tbl_users if they don't exist
  connection.query(
    "ALTER TABLE tbl_users ADD COLUMN resetToken VARCHAR(255) DEFAULT NULL",
    function(err) {
      if (err && err.code === 'ER_DUP_FIELDNAME') { /* already exists */ }
      else if (err) { console.error("Migration note:", err.message); }
      else { console.log("Added resetToken column to tbl_users"); }
    }
  );
  connection.query(
    "ALTER TABLE tbl_users ADD COLUMN resetTokenExpires DATETIME DEFAULT NULL",
    function(err) {
      if (err && err.code === 'ER_DUP_FIELDNAME') { /* already exists */ }
      else if (err) { console.error("Migration note:", err.message); }
      else { console.log("Added resetTokenExpires column to tbl_users"); }
    }
  );

  // Auto-migrate: widen vote columns so long place IDs (Geoapify) and photo
  // URLs (Pexels) fit — otherwise inserts fail with "Data too long".
  connection.query(
    "ALTER TABLE tbl_activity_votes MODIFY activityId VARCHAR(255) NOT NULL",
    function(err) {
      if (err) { console.error("Migration note (activityId widen):", err.message); }
      else { console.log("Widened tbl_activity_votes.activityId to VARCHAR(255)"); }
    }
  );
  connection.query(
    "ALTER TABLE tbl_activity_votes MODIFY activityImage VARCHAR(1024)",
    function(err) {
      if (err) { console.error("Migration note (activityImage widen):", err.message); }
      else { console.log("Widened tbl_activity_votes.activityImage to VARCHAR(1024)"); }
    }
  );

  connection.query(
    "CREATE TABLE IF NOT EXISTS tbl_itinerary_day_cities (" +
    "groupId BIGINT NOT NULL, dayIndex INT NOT NULL, city VARCHAR(100) NOT NULL, " +
    "PRIMARY KEY (groupId, dayIndex))",
    function(err) {
      if (err) { console.error("Migration note (itinerary_day_cities):", err.message); }
      else { console.log("Ensured tbl_itinerary_day_cities table exists"); }
    }
  );

  // Record when each account signs up (for the stats page). Accounts that
  // existed before this column was added keep NULL: their date is unknown.
  connection.query(
    "ALTER TABLE tbl_users ADD COLUMN createdAt TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP",
    function(err) {
      if (err && err.code === 'ER_DUP_FIELDNAME') return; // already there
      if (err) { console.error("Migration note (users.createdAt):", err.message); return; }
      connection.query("UPDATE tbl_users SET createdAt = NULL", function(uErr) {
        if (uErr) console.error("Migration note (users.createdAt reset):", uErr.message);
        else console.log("Added createdAt column to tbl_users");
      });
    }
  );

  // Photos are kept in the database (see services/images.js); copy any that
  // are still only on disk.
  images.ensureSchema()
    .then(function() { return images.backfill([path.join(__dirname, "assets", "uploads")]); })
    .then(function(n) { console.log("Ensured tbl_images table exists" + (n ? "; saved " + n + " photo(s) from disk" : "")); })
    .catch(function(err) { console.error("Migration note (images):", err.message); });

  // Auto-migrate: friendships table (see services/friends.js).
  friendsService.ensureSchema()
    .then(function() { console.log("Ensured tbl_friendships table exists"); })
    .catch(function(err) { console.error("Migration note (friendships):", err.message); });

  // Auto-migrate: create the itinerary comments table if it doesn't exist yet.
  connection.query(
    "CREATE TABLE IF NOT EXISTS tbl_itinerary_comments (" +
    "id INT AUTO_INCREMENT PRIMARY KEY, " +
    "groupId VARCHAR(64) NOT NULL, " +
    "dayIndex INT NOT NULL, " +
    "timeSlot VARCHAR(16) NOT NULL, " +
    "userId VARCHAR(64), " +
    "userName VARCHAR(255), " +
    "comment VARCHAR(1000) NOT NULL, " +
    "createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP, " +
    "INDEX idx_block (groupId, dayIndex, timeSlot))",
    function(err) {
      if (err) { console.error("Migration note (itinerary_comments):", err.message); }
      else { console.log("Ensured tbl_itinerary_comments table exists"); }
    }
  );
});

module.exports = app;