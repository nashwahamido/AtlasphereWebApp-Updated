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
const { getRecommendations } = require("./config/places");


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

// ── VIEW ENGINE SETUP ────────────────────────────────────────────────────
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

// ── MIDDLEWARE ───────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, "public")));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static("assets"));
app.use(fileUpload());
app.use("/uploads", express.static(path.join(__dirname, "assets/uploads")));

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
app.use(session(sessionConfig));

// ── EMAIL SETUP ──────────────────────────────────────────────────────────
// Uses Brevo transactional HTTP API (port 443) — bypasses Railway SMTP port
// blocking. See config/mailer.js for configuration.
console.log("Email: using Brevo HTTP API");

// ── HELPERS ──────────────────────────────────────────────────────────────
function generateCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
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

app.post("/auth/login", validationLoginRules, (req, res) => {
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

  console.log("Login attempt:", { username, passwordLength: password ? password.length : 0, body: Object.keys(req.body) });

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
        console.log("Login: No user found for:", username);
        return res.render("login", {
          title: "Sign In",
          error: "Invalid username or password. Try again.",
          user: null,
        });
      }

      const user = results[0];
      let match = false;
      console.log("Login: Found user:", user.username, "email:", user.email, "has password hash:", !!user.password);

      try {
        match = await bcrypt.compare(password, user.password);
      } catch (err) {
        match = false;
      }

      if (!match && password === user.password) {
        match = true;
      }

      console.log("Login: bcrypt match:", match);

      if (!match) {
        return res.render("login", {
          title: "Sign In",
          error: "Invalid username or password. Try again.",
          user: null,
        });
      }

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
    }
  );
});

// ── REGISTER ─────────────────────────────────────────────────────────────
app.get("/auth/register", (req, res) => {
  res.render("register", { title: "Register", user: null });
});

app.post("/auth/register", validationRegisterRules, async (req, res) => {
  const errors = validationResult(req);
  
  if (!errors.isEmpty()) {
    return res.render("register", {
      title: "Register",
      error: errors.array().map(e => e.msg).join(", "),
      user: null,
    });
  }
  
  console.log("New registration:", req.body);

  try {
    const { username, useremail, userphone, gender, psw } = req.body;

    connection.query(
      "SELECT IDuser FROM tbl_users WHERE email = ? LIMIT 1",
      [useremail],
      async (checkErr, existingUsers) => {
        if (checkErr) {
          console.error("Email lookup error:", checkErr);
          return res.render("register", { title: "Register", error: "Something went wrong. Please try again.", user: null });
        }

        if (existingUsers.length > 0) {
          if (existingUsers[0].isConfirmed === 1) {
            return res.render("register", { title: "Register", error: "This email is already registered. Try logging in instead.", user: null });
          }
          // Unverified account — delete it and allow re-registration
          await connection.promise().query("DELETE FROM tbl_users WHERE email = ?", [useremail]);
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
          };

          const sent = await sendVerificationEmail(useremail, code);
          if (sent) {
            console.log("Verification code sent to:", useremail);
          } else {
            console.log("Email failed — code is:", code);
          }

          console.log("=================================");
          console.log("VERIFICATION CODE:", code);
          console.log("=================================");

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

  if (enteredCode !== pending.code) {
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

      req.session.user = {
        id: pending.userId,
        username: pending.username,
        email: pending.email,
      };

      delete req.session.pendingVerification;

      // If user registered via invite link, add them to the group
      var pendingInvite = req.session.pendingInvite;
      if (pendingInvite) {
        delete req.session.pendingInvite;
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
    }
  );
});

// ── RESEND CODE ──────────────────────────────────────────────────────────
app.get("/auth/resend-code", async (req, res) => {
  const pending = req.session.pendingVerification;
  if (!pending) return res.redirect("/auth/register");

  const newCode = generateCode();
  req.session.pendingVerification.code = newCode;
  req.session.pendingVerification.expiresAt = Date.now() + 30 * 60 * 1000;

  connection.query(
    "UPDATE tbl_users SET verificationCode = ? WHERE IDuser = ?",
    [Number(newCode), pending.userId],
    async (err) => {
      if (err) console.error("Resend code DB update error:", err);

      const sent = await sendVerificationEmail(pending.email, newCode);
      console.log(sent ? "Resend OK" : "Resend failed — code: " + newCode);
      console.log("=================================");
      console.log("NEW VERIFICATION CODE:", newCode);
      console.log("=================================");

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

app.post("/auth/forgot-password", (req, res) => {
  var email = (req.body.email || '').trim();
  console.log("Forgot password request for:", email);
  if (!email) {
    return res.render("forgot-password", { error: "Please enter your email.", success: null });
  }

  connection.query("SELECT IDuser, username, email, isConfirmed FROM tbl_users WHERE email = ? LIMIT 1", [email], function(err, rows) {
    console.log("Forgot password DB lookup:", { email, err: err ? err.message : null, found: rows ? rows.length : 0 });
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

        var resetLink = req.protocol + '://' + req.get('host') + '/auth/reset-password?token=' + token;

        sendEmail({
          to: email,
          subject: "Reset your Atlasphere password",
          html: '<div style="font-family:Arial;max-width:480px;margin:0 auto;padding:32px">' +
            '<h1 style="color:#0B3856">Reset your password</h1>' +
            '<p style="font-size:16px;color:#555">Hi ' + user.username + ', click the button below to reset your password. This link expires in 1 hour.</p>' +
            '<div style="text-align:center;margin:32px 0">' +
            '<a href="' + resetLink + '" style="display:inline-block;padding:14px 40px;background:#E8933A;color:#fff;text-decoration:none;border-radius:30px;font-weight:700;font-size:16px">Reset Password</a>' +
            '</div></div>'
        }).then(function(sent) {
          console.log("Reset email sent:", sent, "to:", email);
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
  var uploadDir = path.join(__dirname, "assets/uploads");

  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
  }

  var timestamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 15);
  var safeName = file.name.replace(/[^a-zA-Z0-9.\-_]/g, "_");
  var fileName = timestamp + "_" + safeName;
  var filePath = path.join(uploadDir, fileName);

  sharp(file.data)
    .resize(400, 400, { fit: 'cover', position: 'centre' })
    .jpeg({ quality: 85 })
    .toFile(filePath, function(sharpErr) {
    if (sharpErr) {
      console.error("File upload error:", sharpErr);
      return res.redirect("/setup/countries");
    }

    var dbPath = "/uploads/" + fileName;

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
  });
});

// Upload from profile page (redirects back to /profile)
app.post("/profile/upload", requireAuth, (req, res) => {
  if (!req.files || !req.files.profilePicture) {
    return res.redirect("/profile");
  }

  var file = req.files.profilePicture;
  var uploadDir = path.join(__dirname, "assets/uploads");

  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
  }

  var timestamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 15);
  var safeName = file.name.replace(/[^a-zA-Z0-9.\-_]/g, "_");
  var fileName = timestamp + "_" + safeName;
  var filePath = path.join(uploadDir, fileName);

  sharp(file.data)
    .resize(400, 400, { fit: 'cover', position: 'centre' })
    .jpeg({ quality: 85 })
    .toFile(filePath, function(sharpErr) {
    if (sharpErr) {
      console.error("File upload error:", sharpErr);
      return res.redirect("/profile");
    }

    var dbPath = "/uploads/" + fileName;

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
        res.redirect("/");
      });
    }
  );
});

// ── PROFILE ──────────────────────────────────────────────────────────────

app.get("/profile/confirmed", requireAuth, (req, res) => {
  try {
    res.render("profile/confirmed", { user: req.session.user || null });
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

          res.render("profile", { user: user, image: image });
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
app.post("/groups/save-activities", requireAuth, (req, res) => {
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
app.use("/groups", require("./routes/groups"));
app.use("/users", require("./routes/users"));

// ── API Route ────────────────────────────────────────────────

// Attraction recommendations come from Foursquare Places — see config/places.js.
app.get("/api/recommendations", requireAuth, async (req, res) => {
  var city = req.query.city || "Rome";

  var preferences = req.query.activities
    ? req.query.activities.split(",").map(function(s) {
        return s.trim();
      }).filter(Boolean)
    : [];

  console.log("Recommendations request:", { city: city, preferences: preferences });

  try {
    var results = await getRecommendations(city, preferences);
    res.json(results.slice(0, 50));
  } catch (error) {
    console.error(
      "Foursquare API error:",
      error.response ? JSON.stringify(error.response.data) : error.message
    );
    res.status(500).json({ error: "Failed to fetch recommendations." });
  }
});


// ── VOTE API ────────────────────────────────────────────────────────────

// saves or updates user's vote on an activity
app.post("/api/votes", requireAuth, (req, res) => {
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

app.get("/api/votes", requireAuth, (req, res) => {
  var groupId = req.query.groupId;
  if (!groupId) return res.json([]);
  connection.query(
    "SELECT DISTINCT activityId, activityName, activityImage, activityDesc, activityTags, `vote` FROM tbl_activity_votes WHERE groupId = ?",
    [groupId],
    function(err, rows) { res.json(!err && rows ? rows : []); }
  );
});

app.get("/api/votes/saved", requireAuth, (req, res) => {
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
app.post("/api/itinerary/block", requireAuth, (req, res) => {
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
app.delete("/api/itinerary/block", requireAuth, (req, res) => {
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
app.post("/api/itinerary/blocks", requireAuth, (req, res) => {
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
app.get("/api/itinerary/blocks", requireAuth, (req, res) => {
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
app.post("/api/itinerary/dates", requireAuth, (req, res) => {
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
app.get("/api/itinerary/dates", requireAuth, (req, res) => {
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
      res.json(results);
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
      res.json({ count: (!err && rows && rows[0]) ? rows[0].cnt : 0 });
    }
  );
});

// Mark all as read
app.post("/api/notifications/read", requireAuth, (req, res) => {
  var userId = req.session.user.id;
  connection.query("UPDATE tbl_notifications SET isRead = 1 WHERE userId = ?", [userId], function(err) {
    res.json({ success: !err });
  });
});

// Get last active time for a group
app.get("/api/groups/last-active", requireAuth, (req, res) => {
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
app.post("/api/groups/invite", requireAuth, (req, res) => {
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
            var joinLink = req.protocol + '://' + req.get('host') + '/groups/join/' + gRows[0].inviteCode;
            sendEmail({
              to: query.trim(),
              subject: userName + ' invited you to join "' + gName + '" on Atlasphere',
              html: `
                <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:32px;">
                  <h1 style="color:#0B3856;font-size:24px;">You've been invited!</h1>
                  <p style="color:#555;font-size:16px;line-height:1.6;">
                    <strong>${userName}</strong> invited you to join the <strong>"${gName}"</strong> group on Atlasphere.
                  </p>
                  <a href="${joinLink}" style="display:inline-block;margin:24px 0;padding:14px 32px;background:#E8933A;color:#fff;border-radius:30px;text-decoration:none;font-weight:700;font-size:16px;">
                    Join "${gName}"
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
app.get("/api/groups/invite-link", requireAuth, (req, res) => {
  var groupId = req.query.groupId;
  if (!groupId) return res.status(400).json({ error: "Missing groupId" });

  connection.query(
    "SELECT inviteCode FROM tbl_groups WHERE id = ?",
    [groupId],
    function(err, rows) {
      if (err || !rows || rows.length === 0) return res.status(404).json({ error: "Group not found" });
      var inviteLink = req.protocol + "://" + req.get("host") + "/groups/join/" + rows[0].inviteCode;
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

io.on("connection", function(socket) {
  console.log("Socket connected:", socket.id);

  // ── Notification socket: joins multiple group rooms for navbar badge updates ──
  socket.on("join-notifications", function(data) {
    if (!data.groupIds || !Array.isArray(data.groupIds)) return;
    data.groupIds.forEach(function(gid) {
      socket.join("group-" + gid);
    });
    console.log("Notification socket joined " + data.groupIds.length + " group rooms for user badges");
  });

  socket.on("join-group", function(data) {
    var room = "group-" + data.groupId;
    socket.join(room);
    socket.userData = { userId: data.userId, userName: data.userName, groupId: data.groupId, userAvatar: data.userAvatar || '' };

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
    if (!roomMembers[room][data.userId]) {
      roomMembers[room][data.userId] = true;
      socket.to(room).emit("user-joined", { userName: data.userName });
      console.log(data.userName + " joined room " + room);
    }
  });

  socket.on("send-message", function(data) {
    var room = "group-" + data.groupId;
    var msgId = Date.now() + "-" + Math.random().toString(36).substr(2, 5);
    var now = new Date();
    var timeStr = now.toISOString();                                    // full ISO → sent over socket
    var timeForDb = now.toTimeString().slice(0, 5);                    // "HH:MM" → fits the time column
    var msg = {
      id: msgId,
      groupId: data.groupId,
      userId: data.userId,
      userName: data.userName,
      userAvatar: data.userAvatar || '',
      user: data.userName,
      text: data.text,
      time: timeStr
    };

    // Save to DB
    connection.query(
      "INSERT INTO tbl_chat_messages (id, groupId, userId, userName, userAvatar, `text`, `time`, `system`) VALUES (?, ?, ?, ?, ?, ?, ?, 0)",
      [msgId, data.groupId, data.userId, data.userName, data.userAvatar || '', data.text, timeForDb],
      function (err) {
        if (err) console.error("Message save error:", err.message);
      }
    );

    io.to(room).emit("new-message", msg);
  });

  // ── Itinerary real-time sync ─────────────────────────────────────────────
  socket.on("itinerary-update", function(data) {
    // Broadcast to everyone else in the group room
    var room = "group-" + data.groupId;
    socket.to(room).emit("itinerary-update", data);
  });

  socket.on("disconnect", function() {
    console.log("Socket disconnected:", socket.id);
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
});

module.exports = app;