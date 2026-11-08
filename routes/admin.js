// Private stats page: /admin/stats
// Only accounts whose email is listed in the ADMIN_EMAILS environment
// variable (comma-separated) can open it; everyone else gets "Not found".
const express = require("express");

function adminEmails() {
  return String(process.env.ADMIN_EMAILS || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

function isAdmin(user) {
  return !!(user && user.email && adminEmails().includes(String(user.email).toLowerCase()));
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
      return res.status(404).render("error", { status: 404, message: "Page not found", user: user || null });
    }

    const [users, signups, recent, trips, tripSizes, destinations, friendships, chat, votes, blocks, tracking] = await Promise.all([
      one(`SELECT COUNT(*) AS total, COALESCE(SUM(isConfirmed = 1), 0) AS verified, COALESCE(SUM(isConfirmed <> 1 OR isConfirmed IS NULL), 0) AS unverified,
                  COALESCE(SUM(isConfirmed = 1 AND profilePictureUrl IS NOT NULL AND profilePictureUrl <> ''), 0) AS withPhoto,
                  COALESCE(SUM(isConfirmed = 1 AND visitedCountries IS NOT NULL AND visitedCountries <> ''), 0) AS withVisited
             FROM tbl_users`),
      one(`SELECT COALESCE(SUM(createdAt >= NOW() - INTERVAL 7 DAY), 0) AS week, COALESCE(SUM(createdAt >= NOW() - INTERVAL 30 DAY), 0) AS month
             FROM tbl_users WHERE isConfirmed = 1`),
      one(`SELECT username, isConfirmed, createdAt FROM tbl_users ORDER BY IDuser DESC LIMIT 10`),
      one(`SELECT COUNT(*) AS total FROM tbl_groups`),
      one(`SELECT COUNT(*) AS trips, COALESCE(SUM(n > 1), 0) AS shared, AVG(n) AS avgMembers
             FROM (SELECT g.id, COUNT(m.userId) AS n FROM tbl_groups g LEFT JOIN tbl_group_members m ON m.groupId = g.id GROUP BY g.id) t`),
      one(`SELECT name, flag, COUNT(*) AS n FROM tbl_groups GROUP BY name, flag ORDER BY n DESC, name LIMIT 8`),
      one(`SELECT COALESCE(SUM(status = 'accepted'), 0) AS accepted, COALESCE(SUM(status = 'pending'), 0) AS pending FROM tbl_friendships`),
      one(`SELECT COUNT(*) AS total, COALESCE(SUM(createdAt >= NOW() - INTERVAL 7 DAY), 0) AS week, COUNT(DISTINCT groupId) AS activeTrips FROM tbl_chat_messages`),
      one(`SELECT COUNT(*) AS total FROM tbl_activity_votes`),
      one(`SELECT COUNT(*) AS total FROM tbl_itinerary_blocks`),
      one(`SELECT COALESCE(SUM(createdAt IS NULL), 0) AS undated FROM tbl_users WHERE isConfirmed = 1`),
    ]);

    res.render("admin-stats", {
      title: "Stats",
      user,
      generatedAt: new Date(),
      stats: {
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
      },
    });
  });

  return router;
};

module.exports.isAdmin = isAdmin;
