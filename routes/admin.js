// Private stats page: /admin/stats
// Only accounts whose email is listed in the ADMIN_EMAILS environment
// variable (comma-separated) can open it; everyone else gets "Not found".
const express = require("express");

// Accepts commas, semicolons or spaces between addresses, and ignores stray
// quotes (easy to add by accident in a hosting dashboard).
function emailsFrom(value) {
  return String(value || "")
    .split(/[,;\s]+/)
    .map((e) => e.trim().replace(/^["'<]+|["'>]+$/g, "").toLowerCase())
    .filter((e) => e.includes("@"));
}
function adminEmails() { return emailsFrom(process.env.ADMIN_EMAILS); }

// Accounts left out of the stats: the admins plus STATS_EXCLUDE_EMAILS
// (your team's test accounts), and anything they created.
function teamEmails() {
  return [...new Set(adminEmails().concat(emailsFrom(process.env.STATS_EXCLUDE_EMAILS)))];
}

function isAdmin(user) {
  return !!(user && user.email && adminEmails().includes(String(user.email).trim().toLowerCase()));
}

// "nashwa@example.com" → "n***@example.com" (for the server log).
function mask(email) {
  const [name, domain] = String(email || "").split("@");
  return name ? name.charAt(0) + "***@" + (domain || "?") : "(no email)";
}

module.exports = function createAdminRouter(connection) {
  const router = express.Router();
  const db = connection.promise();

  // Run a query, but don't let one missing table break the whole page.
  async function one(sql, params) {
    try {
      const [rows] = await db.query(sql, params || []);
      return rows;
    } catch (err) {
      console.error("Admin stats query failed:", err.message);
      return null;
    }
  }
  const num = (rows, key) => (rows && rows[0] && rows[0][key] !== null && rows[0][key] !== undefined ? Number(rows[0][key]) : null);

  router.get("/admin/stats", async (req, res) => {
    const user = req.session && req.session.user;
    if (!isAdmin(user)) {
      // Still a plain "Not found" for visitors, but the server log says why.
      const why = !user ? "not signed in"
        : !adminEmails().length ? "ADMIN_EMAILS is not set (or has no valid address)"
        : "signed in as " + mask(user.email) + ", which isn't in ADMIN_EMAILS (" + adminEmails().map(mask).join(", ") + ")";
      console.warn("Stats page refused: " + why);
      return res.status(404).render("error", { status: 404, message: "Page not found", user: user || null });
    }

    const team = teamEmails();
    const teamRows = team.length ? (await one("SELECT IDuser FROM tbl_users WHERE LOWER(TRIM(email)) IN (?)", [team])) || [] : [];
    const teamIds = teamRows.map((r) => r.IDuser);
    const [real, all] = await Promise.all([gather(teamIds), teamIds.length ? gather([]) : null]);

    res.render("admin-stats", {
      title: "Stats",
      user,
      generatedAt: new Date(),
      stats: real,
      everyone: all,
      team: { configured: team.length, found: teamIds.length },
    });
  });

  // All the numbers, leaving out the given accounts and the trips they made.
  async function gather(excludeIds) {
    const ids = excludeIds.length ? excludeIds : [0]; // 0 matches no account
    const realTrips = "(SELECT id FROM tbl_groups WHERE createdBy IS NULL OR createdBy NOT IN (?))";
    const [users, signups, recent, trips, tripSizes, destinations, friendships, chat, votes, blocks, tracking] = await Promise.all([
      one(`SELECT COUNT(*) AS total, COALESCE(SUM(isConfirmed = 1), 0) AS verified, COALESCE(SUM(isConfirmed <> 1 OR isConfirmed IS NULL), 0) AS unverified,
                  COALESCE(SUM(isConfirmed = 1 AND profilePictureUrl IS NOT NULL AND profilePictureUrl <> ''), 0) AS withPhoto,
                  COALESCE(SUM(isConfirmed = 1 AND visitedCountries IS NOT NULL AND visitedCountries <> ''), 0) AS withVisited
             FROM tbl_users WHERE IDuser NOT IN (?)`, [ids]),
      one(`SELECT COALESCE(SUM(s.createdAt >= NOW() - INTERVAL 7 DAY), 0) AS week, COALESCE(SUM(s.createdAt >= NOW() - INTERVAL 30 DAY), 0) AS month
             FROM tbl_users u JOIN tbl_user_signups s ON s.userId = u.IDuser WHERE u.isConfirmed = 1 AND u.IDuser NOT IN (?)`, [ids]),
      one(`SELECT u.username, u.isConfirmed, s.createdAt FROM tbl_users u LEFT JOIN tbl_user_signups s ON s.userId = u.IDuser WHERE u.IDuser NOT IN (?) ORDER BY u.IDuser DESC LIMIT 10`, [ids]),
      one(`SELECT COUNT(*) AS total FROM tbl_groups WHERE id IN ${realTrips}`, [ids]),
      one(`SELECT COUNT(*) AS trips, COALESCE(SUM(n > 1), 0) AS shared, AVG(n) AS avgMembers
             FROM (SELECT g.id, COUNT(m.userId) AS n FROM tbl_groups g LEFT JOIN tbl_group_members m ON m.groupId = g.id WHERE g.id IN ${realTrips} GROUP BY g.id) t`, [ids]),
      one(`SELECT name, flag, COUNT(*) AS n FROM tbl_groups WHERE id IN ${realTrips} GROUP BY name, flag ORDER BY n DESC, name LIMIT 8`, [ids]),
      one(`SELECT COALESCE(SUM(status = 'accepted'), 0) AS accepted, COALESCE(SUM(status = 'pending'), 0) AS pending FROM tbl_friendships
             WHERE requesterId NOT IN (?) AND addresseeId NOT IN (?)`, [ids, ids]),
      one(`SELECT COUNT(*) AS total, COALESCE(SUM(createdAt >= NOW() - INTERVAL 7 DAY), 0) AS week, COUNT(DISTINCT groupId) AS activeTrips
             FROM tbl_chat_messages WHERE groupId IN ${realTrips}`, [ids]),
      one(`SELECT COUNT(*) AS total FROM tbl_activity_votes WHERE groupId IN ${realTrips}`, [ids]),
      one(`SELECT COUNT(*) AS total FROM tbl_itinerary_blocks WHERE groupId IN ${realTrips}`, [ids]),
      one(`SELECT COUNT(*) AS undated FROM tbl_users u LEFT JOIN tbl_user_signups s ON s.userId = u.IDuser
             WHERE u.isConfirmed = 1 AND s.userId IS NULL AND u.IDuser NOT IN (?)`, [ids]),
    ]);
    return {
      users: {
        total: num(users, "total"), verified: num(users, "verified"), unverified: num(users, "unverified"),
        withPhoto: num(users, "withPhoto"), withVisited: num(users, "withVisited"),
        week: num(signups, "week"), month: num(signups, "month"),
        undated: num(tracking, "undated"),
      },
      recent: (recent || []).map((r) => ({ username: r.username, verified: Number(r.isConfirmed) === 1, createdAt: r.createdAt ? new Date(r.createdAt) : null })),
      trips: {
        total: num(trips, "total"), shared: num(tripSizes, "shared"),
        avgMembers: tripSizes && tripSizes[0] && tripSizes[0].avgMembers !== null ? Math.round(Number(tripSizes[0].avgMembers) * 10) / 10 : null,
      },
      destinations: (destinations || []).map((d) => ({ name: d.name, flag: d.flag || "", n: Number(d.n) })),
      friends: { accepted: num(friendships, "accepted"), pending: num(friendships, "pending") },
      chat: { total: num(chat, "total"), week: num(chat, "week"), activeTrips: num(chat, "activeTrips") },
      votes: num(votes, "total"),
      blocks: num(blocks, "total"),
    };
  }

  return router;
};

module.exports.isAdmin = isAdmin;
module.exports.adminEmails = adminEmails;
module.exports.teamEmails = teamEmails;
