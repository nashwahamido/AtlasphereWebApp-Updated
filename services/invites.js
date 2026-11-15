// Joining a trip with its invite link, shared by the website's sign-up,
// login and join pages (the app goes through services/trips.js, which uses
// the same notification).

// Accepts a full invite link (".../groups/join/abc123") or just the code.
function inviteCodeFrom(input) {
  const s = String(input || "").trim();
  const m = s.match(/groups\/join\/([A-Za-z0-9]+)/) || s.match(/^([A-Za-z0-9]{6,32})$/);
  return m ? m[1] : null;
}

// Tell everyone already on the trip that someone new joined.
async function notifyJoined(db, trip, user) {
  const name = user.username || "Someone";
  await db.query(
    `INSERT INTO tbl_notifications (userId, groupId, groupName, message, type)
     SELECT userId, ?, ?, ?, 'join' FROM tbl_group_members WHERE groupId = ? AND userId <> ?`,
    [trip.id, trip.name, name + ' joined "' + trip.name + '"', trip.id, user.id]
  );
}

function createInvites(pool) {
  const db = pool.promise ? pool.promise() : pool;

  async function findTrip(codeOrLink) {
    const code = inviteCodeFrom(codeOrLink);
    if (!code) return null;
    const [rows] = await db.query("SELECT id, name, flag FROM tbl_groups WHERE inviteCode = ? LIMIT 1", [code]);
    return rows.length ? { id: rows[0].id, name: rows[0].name || "a trip", flag: rows[0].flag || "", code } : null;
  }

  // Adds the user to the trip. Returns true if they weren't in it already.
  async function joinTrip(trip, user) {
    const [result] = await db.query(
      "INSERT IGNORE INTO tbl_group_members (groupId, userId, username, email) VALUES (?, ?, ?, ?)",
      [trip.id, user.id, user.username, user.email]
    );
    const joined = result && result.affectedRows === 1;
    if (joined) {
      await notifyJoined(db, trip, user).catch((e) => console.error("Join notification error:", e.message));
    }
    return joined;
  }

  return { findTrip, joinTrip };
}

module.exports = createInvites;
module.exports.inviteCodeFrom = inviteCodeFrom;
module.exports.notifyJoined = notifyJoined;
