var express = require("express");
var sharp = require("sharp");
var axios = require("axios");
var router = express.Router();
var crypto = require("crypto");
var countries = require("../data/countries");

function getDb(req) {
  return req.app.get("db");
}

function requireGroupAuth(req, res, next) {
  if (!req.session.user) {
    return res.redirect("/auth/login");
  }
  next();
}

function generateInviteCode() {
  return crypto.randomBytes(6).toString("hex");
}

// ── Helper: load a group + its members from DB ──────────────────────────
function loadGroup(db, groupId, callback) {
  db.query("SELECT * FROM tbl_groups WHERE id = ?", [groupId], function (err, rows) {
    if (err || rows.length === 0) return callback(err, null);
    var group = rows[0];
    group.cities = group.cities ? group.cities.split(",") : [];
    db.query("SELECT userId, username, email FROM tbl_group_members WHERE groupId = ?", [groupId], function (err2, members) {
      group.members = members || [];
      callback(null, group);
    });
  });
}

// ── Helper: load all groups for a user ──────────────────────────────────
function loadUserGroups(db, userId, callback) {
  db.query(
    "SELECT g.* FROM tbl_groups g INNER JOIN tbl_group_members gm ON g.id = gm.groupId WHERE gm.userId = ? ORDER BY g.createdAt DESC",
    [userId],
    function (err, rows) {
      if (err) return callback(err, []);
      var groups = rows.map(function (g) {
        g.cities = g.cities ? g.cities.split(",") : [];
        g.members = [];
        return g;
      });
      callback(null, groups);
    }
  );
}

// ── API: return user's groups as JSON (for sidebar) ─────────────────────
router.get("/api/my-groups", function (req, res) {
  var user = req.session.user;
  if (!user) return res.json([]);

  var db = getDb(req);
  loadUserGroups(db, user.id, function (err, groups) {
    res.json(groups.map(function (g) {
      return { id: g.id, name: g.name, destination: g.destination, flag: g.flag || "", color: g.color || "#3B5F8A", photo: g.photo || "" };
    }));
  });
});

// ── Group creation flow ─────────────────────────────────────────────────

router.get("/create/country", requireGroupAuth, function (req, res) {
  res.render("groups/create-country", {
    title: "Choose Destination",
    user: req.session.user || null,
    countries: countries
  });
});

router.get("/create/city", requireGroupAuth, function (req, res) {
  var countryName = req.query.country || "";
  var country = countries.find(function (c) {
    return c.name.toLowerCase() === countryName.toLowerCase();
  });
  var cities = country ? country.cities : [];
  var flag = country ? country.flag : "";

  res.render("groups/create-city", {
    title: "Choose Cities",
    user: req.session.user || null,
    countryName: country ? country.name : countryName,
    countryFlag: flag,
    cities: cities
  });
});

router.get("/create/days", requireGroupAuth, function (req, res) {
  res.render("groups/create-days", {
    title: "Trip Length",
    user: req.session.user || null,
    country: req.query.country || "",
    cities: req.query.cities || ""
  });
});

// Create the group and save to DB
router.get("/create/confirm", requireGroupAuth, function (req, res) {
  var db = getDb(req);
  var user = req.session.user;

var countryName = req.query.country || "My Trip";
var cities = req.query.cities || "";
var days = parseInt(req.query.days) || 7;
var inviteCode = generateInviteCode();

var cityList = cities.split(",").map(function (c) {
  return c.trim();
}).filter(Boolean);

var primaryCity = cityList.length > 0 ? cityList[0] : countryName;
  var inviteCode = generateInviteCode();

  var country = countries.find(function (c) {
    return c.name.toLowerCase() === countryName.toLowerCase();
  });
  var flag = country ? country.flag : "";

  var colors = ["#3B5F8A", "#E8933A", "#2D8B6F", "#8B5A2B", "#6A5ACD"];
  var groupId = Date.now();
  var colorIndex = groupId % colors.length;

var groupData = {
  id: groupId,
  name: countryName,
  destination: primaryCity,
  flag: flag,
  cities: cities,
  inviteCode: inviteCode,
  days: days,
  color: colors[colorIndex],
  createdBy: user.id
};

  // Insert group into DB
  db.query(
    "INSERT INTO tbl_groups (id, name, destination, flag, cities, inviteCode, days, color, createdBy) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [groupData.id, groupData.name, groupData.destination, groupData.flag, groupData.cities, groupData.inviteCode, groupData.days, groupData.color, groupData.createdBy],
    function (err) {
      if (err) {
        console.error("Group insert error:", err.message);
        return res.status(500).send("Failed to create group");
      }

      // Add creator as member
      db.query(
        "INSERT IGNORE INTO tbl_group_members (groupId, userId, username, email) VALUES (?, ?, ?, ?)",
        [groupData.id, user.id, user.username, user.email],
        function () {
          var inviteLink = req.protocol + "://" + req.get("host") + "/groups/join/" + inviteCode;

          groupData.members = [{ id: user.id, username: user.username, email: user.email }];

          res.render("groups/create-confirm", {
            title: "Group Created",
            user: user,
            group: groupData,
            inviteLink: inviteLink,
            inviteSuccess: null,
            inviteError: null
          });
        }
      );
    }
  );
});

// ── Upload group photo ──────────────────────────────────────────────────
router.post("/upload-photo", requireGroupAuth, function (req, res) {
  var db = getDb(req);
  var groupId = req.body.groupId;

  // Where to go after saving. During creation the form omits redirectTo and we
  // fall back to the activities step; when changing the photo later the group
  // page passes redirectTo=/groups/<id> so the user stays where they were.
  var fallback = "/groups/create/activities?groupId=" + groupId;
  var redirectTo = req.body.redirectTo;
  var dest = (typeof redirectTo === "string" && /^\/groups(\/|\?|$)/.test(redirectTo)) ? redirectTo : fallback;

  if (!req.files || !req.files.groupPhoto) {
    return res.redirect(dest);
  }

  var path = require("path");
  var fs = require("fs");
  var file = req.files.groupPhoto;
  var uploadDir = path.join(__dirname, "..", "assets", "uploads");

  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
  }

  var timestamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 15);
  var safeName = file.name.replace(/[^a-zA-Z0-9.\-_]/g, "_");
  var fileName = "group_" + groupId + "_" + timestamp + "_" + safeName;
  var filePath = path.join(uploadDir, fileName);

  sharp(file.data)
    .resize(800, 600, { fit: 'cover', position: 'centre' })
    .jpeg({ quality: 85 })
    .toFile(filePath, function(sharpErr) {
    if (sharpErr) {
      console.error("Group photo upload error:", sharpErr);
      return res.redirect(dest);
    }
    var dbPath = "/uploads/" + fileName;

    db.query("UPDATE tbl_groups SET photo = ? WHERE id = ?", [dbPath, groupId], function (dbErr) {
      if (dbErr) console.error("Group photo DB error:", dbErr.message);
      else console.log("Group photo saved (resized):", dbPath);
      res.redirect(dest);
    });
  });
});

// ── Invite by email ─────────────────────────────────────────────────────
router.post("/invite", requireGroupAuth, async function (req, res) {
  var db = getDb(req);
  var groupId = req.body.groupId;
  var friendEmail = req.body.friendEmail || '';
  var friendUsername = req.body.friendUsername || '';
  var user = req.session.user;

  loadGroup(db, groupId, function (err, group) {
    if (!group) return res.status(404).send("Group not found");

    var inviteLink = req.protocol + "://" + req.get("host") + "/groups/join/" + group.inviteCode;

    // Username invite: look up user and add directly
    if (friendUsername) {
      db.query("SELECT IDuser, username, email FROM tbl_users WHERE username = ?", [friendUsername], function(uErr, uRows) {
        if (uErr || !uRows || uRows.length === 0) {
          return res.render("groups/create-confirm", {
            title: "Group Created", user: user, group: group,
            inviteLink: inviteLink,
            inviteSuccess: null,
            inviteError: 'User "' + friendUsername + '" not found'
          });
        }
        var friend = uRows[0];
        db.query(
          "INSERT IGNORE INTO tbl_group_members (groupId, userId, username, email) VALUES (?, ?, ?, ?)",
          [group.id, friend.IDuser, friend.username, friend.email],
          function() {
            // Send notification to the invited user
            var inviterName = user ? user.username : 'Someone';
            var notifMsg = inviterName + ' added you to "' + group.name + '"';
            db.query(
              "INSERT INTO tbl_notifications (userId, groupId, groupName, message, type) VALUES (?, ?, ?, ?, ?)",
              [friend.IDuser, group.id, group.name, notifMsg, 'invite'],
              function(nErr) {
                if (nErr) console.error("Invite notification error:", nErr.message);
                else console.log("Invite notification sent to", friend.username, "for group", group.name);
              }
            );

            return res.render("groups/create-confirm", {
              title: "Group Created", user: user, group: group,
              inviteLink: inviteLink,
              inviteSuccess: friend.username + ' has been added to ' + group.name + '!',
              inviteError: null
            });
          }
        );
      });
      return;
    }

    // Email invite flow
    if (!friendEmail) {
      return res.render("groups/create-confirm", {
        title: "Group Created", user: user, group: group,
        inviteLink: inviteLink,
        inviteSuccess: null,
        inviteError: "Please enter an email or username"
      });
    }

    var senderName = user ? user.username : "Someone";
    axios.post(
      "https://api.mailjet.com/v3.1/send",
      {
        Messages: [{
          From: { Email: process.env.MAIL_FROM || "atlasphretravelapp@gmail.com", Name: "Atlasphere" },
          To: [{ Email: friendEmail }],
          Subject: senderName + " invited you to join " + group.name + " on Atlasphere!",
          HTMLPart: "<div style=\"font-family:Arial;max-width:480px;margin:0 auto;padding:32px\">" +
                "<h1 style=\"color:#0B3856\">You're invited!</h1>" +
                "<p style=\"font-size:16px;color:#555\">" + senderName + " wants you to join their trip group <strong>" + group.name + "</strong> on Atlasphere.</p>" +
                "<div style=\"text-align:center;margin:32px 0\">" +
                "<a href=\"" + inviteLink + "\" style=\"display:inline-block;padding:14px 40px;background:#E8933A;color:#fff;text-decoration:none;border-radius:30px;font-weight:700;font-size:16px\">Join Group</a>" +
                "</div></div>"
        }]
      },
      { auth: { username: process.env.MAILJET_API_KEY, password: process.env.MAILJET_SECRET_KEY } }
    ).then(function () {
      res.render("groups/create-confirm", {
        title: "Group Created", user: user, group: group,
        inviteLink: inviteLink,
        inviteSuccess: "Invite sent to " + friendEmail + "!",
        inviteError: null
      });
    }).catch(function (mailErr) {
      console.error("Invite email error:", mailErr.response ? JSON.stringify(mailErr.response.data) : mailErr.message);
      res.render("groups/create-confirm", {
        title: "Group Created", user: user, group: group,
        inviteLink: inviteLink,
        inviteSuccess: null,
        inviteError: "Failed to send email. Share this link instead: " + inviteLink
      });
    });
  });
});

// ── Join via invite link ────────────────────────────────────────────────
router.get("/join/:code", function (req, res) {
  var db = getDb(req);

  db.query("SELECT * FROM tbl_groups WHERE inviteCode = ?", [req.params.code], function (err, rows) {
    if (err || rows.length === 0) {
      return res.status(404).render("error", {
        status: 404, message: "Invalid or expired invite link", user: req.session.user || null
      });
    }

    var group = rows[0];
    var user = req.session.user;

    if (!user) {
      req.session.pendingInvite = req.params.code;
      req.session.save(function () { res.redirect("/auth/register"); });
      return;
    }

    db.query(
      "INSERT IGNORE INTO tbl_group_members (groupId, userId, username, email) VALUES (?, ?, ?, ?)",
      [group.id, user.id, user.username, user.email],
      function () {
        console.log(user.username + " joined group: " + group.name);
        res.redirect("/groups/" + group.id);
      }
    );
  });
});

// ── List all groups ─────────────────────────────────────────────────────
router.get("/", function (req, res) {
  var user = req.session.user;
  if (!user) return res.redirect("/auth/login");

  var db = getDb(req);
  loadUserGroups(db, user.id, function (err, userGroups) {
    if (userGroups.length === 0) {
      return res.redirect("/groups/create/country");
    }

    console.log("GROUP OBJECT:", userGroups[0]);
    res.render("groups/groupPage", {
      user: user,
      group: userGroups[0],
      groups: userGroups,
      tripDays: userGroups[0].days || 7
    });
  });
});

// ── Individual group page (MUST be last) ────────────────────────────────
router.get("/:id", function (req, res) {
  var user = req.session.user;
  if (!user) return res.redirect("/auth/login");

  var db = getDb(req);
  var groupId = req.params.id;

  loadGroup(db, groupId, function (err, group) {
    if (!group) {
      return res.status(404).render("error", {
        status: 404, message: "Group not found", user: user
      });
    }

    loadUserGroups(db, user.id, function (err2, userGroups) {
      console.log("GROUP OBJECT:", group);
      res.render("groups/groupPage", {
        user: user,
        group: group,
        groups: userGroups,
        tripDays: group.days || 7
      });
    });
  });
});

// ── Delete group (owner only) ────────────────────────────────────────────
router.post("/delete/:id", requireGroupAuth, function (req, res) {
  var db = getDb(req);
  var userId = req.session.user.id;
  var groupId = req.params.id;

  // Verify the requesting user is the group creator
  db.query("SELECT createdBy FROM tbl_groups WHERE id = ?", [groupId], function (err, rows) {
    if (err || !rows || rows.length === 0) return res.status(404).json({ error: "Group not found" });
    if (String(rows[0].createdBy) !== String(userId)) {
      return res.status(403).json({ error: "Only the group creator can delete this group" });
    }
    // Cascade delete
    db.query("DELETE FROM tbl_group_members WHERE groupId = ?", [groupId], function () {
      db.query("DELETE FROM tbl_chat_messages WHERE groupId = ?", [groupId], function () {
        db.query("DELETE FROM tbl_notifications WHERE groupId = ?", [groupId], function () {
          db.query("DELETE FROM tbl_groups WHERE id = ?", [groupId], function () {
            res.json({ success: true });
          });
        });
      });
    });
  });
});

// ── Leave group (any member, including creator) ───────────────────────────
router.post("/leave/:id", requireGroupAuth, function (req, res) {
  var db = getDb(req);
  var userId = req.session.user.id;
  var groupId = req.params.id;

  db.query("DELETE FROM tbl_group_members WHERE groupId = ? AND userId = ?", [groupId, userId], function (err) {
    if (err) return res.status(500).json({ error: "Failed to leave group" });
    res.json({ success: true });
  });
});

// ── Rename group ────────────────────────────────────────────────────────
router.post("/rename/:id", requireGroupAuth, function (req, res) {
  var db = getDb(req);
  var newName = req.body.newName;
  if (!newName || !newName.trim()) {
    return res.json({ success: false, error: "Name cannot be empty" });
  }
  db.query("UPDATE tbl_groups SET name = ? WHERE id = ?", [newName.trim(), req.params.id], function (err) {
    if (err) return res.status(500).json({ success: false, error: "Failed to rename" });
    res.json({ success: true });
  });
});

// ── Update group activities/interests ────────────────────────────────────
router.post("/update-activities/:id", requireGroupAuth, function (req, res) {
  var db = getDb(req);
  var groupId = req.params.id;
  var activities = req.body.activities || [];
  if (!Array.isArray(activities)) activities = [activities];

  var prefsJson = JSON.stringify(activities);

  db.query("UPDATE tbl_groups SET preferences = ? WHERE id = ?", [prefsJson, groupId], function (err) {
    if (err) {
      console.error("Update activities error:", err.message);
      return res.status(500).json({ success: false, error: "Failed to update activities" });
    }
    res.json({ success: true });
  });
});

module.exports = router;