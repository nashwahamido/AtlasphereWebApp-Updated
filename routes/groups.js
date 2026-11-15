var express = require("express");
var sharp = require("sharp");
var router = express.Router();
var crypto = require("crypto");
var countries = require("../data/countries");
var { siteBase, escapeHtml } = require("../config/security");
var { sendEmail } = require("../config/mailer");

// Only a trip's members may open or change it (membership helper is set up
// in server.js; see config/security.js).
function member(options) {
  return function (req, res, next) {
    return req.app.get("membership").requireMember(options)(req, res, next);
  };
}

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
    // Interests are saved as JSON in `preferences`; the page reads `activities`.
    if (!group.activities && group.preferences) {
      try { var prefs = JSON.parse(group.preferences); if (Array.isArray(prefs)) group.activities = prefs.join(","); } catch (e) { /* ignore */ }
    }
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
      return { id: g.id, name: g.name, destination: g.destination, cities: (g.cities || []).join(","), flag: g.flag || "", color: g.color || "#3B5F8A", photo: g.photo || "" };
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

      // Add creator as member, then show the invite page. Redirecting (rather
      // than rendering here) means a refresh doesn't create the trip again.
      db.query(
        "INSERT IGNORE INTO tbl_group_members (groupId, userId, username, email) VALUES (?, ?, ?, ?)",
        [groupData.id, user.id, user.username, user.email],
        function () {
          res.redirect("/groups/" + groupData.id + "/invite?new=1");
        }
      );
    }
  );
});

// The "invite your friends" page: shown right after creating a trip, and
// reachable later from the trip.
function renderInvite(req, res, group) {
  var flash = req.session.inviteFlash || {};
  delete req.session.inviteFlash;
  res.render("groups/create-confirm", {
    title: "Invite friends",
    user: req.session.user,
    group: group,
    isNew: req.query.new === "1",
    inviteLink: siteBase(req) + "/groups/join/" + group.inviteCode,
    inviteSuccess: flash.success || null,
    inviteError: flash.error || null,
  });
}

function backToInvite(req, res, groupId, flash) {
  req.session.inviteFlash = flash;
  req.session.save(function () {
    res.redirect("/groups/" + encodeURIComponent(groupId) + "/invite" + (req.body.isNew === "1" ? "?new=1" : ""));
  });
}

router.get("/:id/invite", member({ page: true }), function (req, res) {
  loadGroup(getDb(req), req.params.id, function (err, group) {
    if (!group) return res.status(404).render("error", { status: 404, message: "Group not found", user: req.session.user });
    renderInvite(req, res, group);
  });
});

// Who's on the trip (names only), so the invite page can show people joining.
router.get("/:id/members", member(), function (req, res) {
  getDb(req).query("SELECT userId, username FROM tbl_group_members WHERE groupId = ? ORDER BY id", [req.params.id], function (err, rows) {
    if (err) return res.status(500).json({ error: "Couldn't load members" });
    res.set("Cache-Control", "no-store");
    res.json({ members: (rows || []).map(function (r) { return { id: String(r.userId), username: r.username }; }) });
  });
});

// ── Upload group photo ──────────────────────────────────────────────────
router.post("/upload-photo", requireGroupAuth, member(), function (req, res) {
  var db = getDb(req);
  var groupId = req.body.groupId;

  // Where to go after saving. During creation the form omits redirectTo and we
  // fall back to the activities step; when changing the photo later the group
  // page passes redirectTo=/groups/<id> so the user stays where they were.
  var fallback = "/groups/create/activities?groupId=" + encodeURIComponent(groupId);
  var redirectTo = req.body.redirectTo;
  var dest = (typeof redirectTo === "string" && /^\/groups(\/|\?|$)/.test(redirectTo)) ? redirectTo : fallback;

  if (!req.files || !req.files.groupPhoto) {
    return res.redirect(dest);
  }

  // Stored in the database (services/images.js), so it survives redeploys.
  req.app.get("images").saveUpload(req.files.groupPhoto, { width: 800, height: 600, prefix: "group_" + String(groupId).replace(/\D/g, "") + "_" })
    .then(function (dbPath) {
      db.query("UPDATE tbl_groups SET photo = ? WHERE id = ?", [dbPath, groupId], function (dbErr) {
        if (dbErr) console.error("Group photo DB error:", dbErr.message);
        res.redirect(dest);
      });
    })
    .catch(function (upErr) {
      console.error("Group photo upload error:", upErr.message);
      res.redirect(dest);
    });
});

// ── Invite by email or username (the form on the invite page) ──────────
router.post("/invite", requireGroupAuth, member(), function (req, res) {
  var db = getDb(req);
  var groupId = req.body.groupId;
  var friendEmail = String(req.body.friendEmail || "").trim();
  var friendUsername = String(req.body.friendUsername || "").trim();
  var user = req.session.user;

  loadGroup(db, groupId, function (err, group) {
    if (!group) return res.status(404).send("Group not found");
    var inviteLink = siteBase(req) + "/groups/join/" + group.inviteCode;

    // Username invite: look up user and add directly
    if (friendUsername) {
      db.query("SELECT IDuser, username, email FROM tbl_users WHERE username = ? AND isConfirmed = 1", [friendUsername], function (uErr, uRows) {
        if (uErr || !uRows || uRows.length === 0) {
          return backToInvite(req, res, group.id, { error: 'No one called "' + friendUsername + '" is on Atlasphere. Try their email instead.' });
        }
        var friend = uRows[0];
        db.query(
          "INSERT IGNORE INTO tbl_group_members (groupId, userId, username, email) VALUES (?, ?, ?, ?)",
          [group.id, friend.IDuser, friend.username, friend.email],
          function (mErr, result) {
            if (result && result.affectedRows === 1) {
              db.query(
                "INSERT INTO tbl_notifications (userId, groupId, groupName, message, type) VALUES (?, ?, ?, ?, ?)",
                [friend.IDuser, group.id, group.name, user.username + ' added you to "' + group.name + '"', "invite"],
                function (nErr) { if (nErr) console.error("Invite notification error:", nErr.message); }
              );
            }
            backToInvite(req, res, group.id, { success: friend.username + " is now on the trip!" });
          }
        );
      });
      return;
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(friendEmail) || friendEmail.length > 254) {
      return backToInvite(req, res, group.id, { error: "Enter an email address or an Atlasphere username." });
    }

    var limiter = req.app.get("limits") && req.app.get("limits").inviteEmail;
    if (limiter && limiter.take(String(user.id))) {
      return backToInvite(req, res, group.id, { error: "You've sent a lot of invites. Please try again later, or share the link instead." });
    }

    sendEmail(inviteEmail(user.username, group.name, inviteLink, friendEmail)).then(function (sent) {
      backToInvite(req, res, group.id, sent
        ? { success: "Invite sent to " + friendEmail + ". Tell them to check their spam folder if it doesn't arrive." }
        : { error: "We couldn't send that email. Copy the link and send it to them instead." });
    });
  });
});

// The invitation email (also used by the trip chat's invite box).
function inviteEmail(fromName, tripName, link, to) {
  var safeFrom = escapeHtml(fromName || "A friend");
  var safeTrip = escapeHtml(tripName || "a trip");
  return {
    to: to,
    subject: (fromName || "A friend") + ' invited you to plan "' + (tripName || "a trip") + '" on Atlasphere',
    text: [
      (fromName || "A friend") + ' invited you to plan their trip "' + (tripName || "a trip") + '" together on Atlasphere.',
      "",
      "Join the trip: " + link,
      "",
      "It's free. If you don't have an account yet, the link takes you to sign-up and then straight into the trip.",
    ].join("\n"),
    html:
      '<div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:32px;">' +
      '<h1 style="color:#0B3856;font-size:24px;">You\'re invited!</h1>' +
      '<p style="color:#555;font-size:16px;line-height:1.6;"><strong>' + safeFrom + '</strong> invited you to plan their trip <strong>&ldquo;' + safeTrip + '&rdquo;</strong> together on Atlasphere.</p>' +
      '<p style="text-align:center;margin:28px 0;"><a href="' + escapeHtml(link) + '" style="display:inline-block;padding:14px 32px;background:#E8933A;color:#fff;border-radius:30px;text-decoration:none;font-weight:700;font-size:16px;">Join the trip</a></p>' +
      '<p style="color:#888;font-size:13px;line-height:1.6;">It\'s free. If you don\'t have an account yet, the link takes you to sign-up and then straight into the trip.</p>' +
      '</div>',
  };
}

// ── Join via invite link ────────────────────────────────────────────────
router.get("/join/:code", function (req, res) {
  var invites = req.app.get("invites");
  invites.findTrip(req.params.code).then(function (trip) {
    if (!trip) {
      return res.status(404).render("error", {
        status: 404, message: "This invite link doesn't work any more. Ask your friend to send a new one.", user: req.session.user || null
      });
    }
    var user = req.session.user;
    if (!user) {
      // Remember the invite through sign-up (or login) and say which trip it is.
      req.session.pendingInvite = trip.code;
      req.session.pendingInviteTrip = { name: trip.name, flag: trip.flag };
      return req.session.save(function () { res.redirect("/auth/register"); });
    }
    return invites.joinTrip(trip, user).then(function () {
      res.redirect("/groups/" + trip.id);
    });
  }).catch(function (err) {
    console.error("Join error:", err.message);
    res.status(500).render("error", { status: 500, message: "Something went wrong. Please try again.", user: req.session.user || null });
  });
});

// ── List all groups ─────────────────────────────────────────────────────
router.get("/", function (req, res) {
  var user = req.session.user;
  if (!user) return res.redirect("/auth/login");

  var db = getDb(req);
  loadUserGroups(db, user.id, function (err, userGroups) {
    if (userGroups.length === 0) {
      return res.redirect("/welcome");
    }

    res.render("groups/groupPage", {
      user: user,
      group: userGroups[0],
      groups: userGroups,
      tripDays: userGroups[0].days || 7
    });
  });
});

// ── Individual group page (MUST be last) ────────────────────────────────
router.get("/:id", member({ page: true }), function (req, res) {
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
router.post("/rename/:id", requireGroupAuth, member(), function (req, res) {
  var db = getDb(req);
  var newName = req.body.newName;
  if (!newName || !newName.trim()) {
    return res.json({ success: false, error: "Name cannot be empty" });
  }
  db.query("UPDATE tbl_groups SET name = ? WHERE id = ?", [newName.trim().slice(0, 100), req.params.id], function (err) {
    if (err) return res.status(500).json({ success: false, error: "Failed to rename" });
    res.json({ success: true });
  });
});

// ── Update group activities/interests ────────────────────────────────────
router.post("/update-activities/:id", requireGroupAuth, member(), function (req, res) {
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
module.exports.inviteEmail = inviteEmail;