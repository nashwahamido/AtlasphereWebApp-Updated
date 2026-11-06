// Friends: requests, acceptances and profiles. Shared by the website routes
// (routes/friends.js) and the mobile API (routes/mobile.js).
//
// One row per pair of people in tbl_friendships. `pairKey` is the two user IDs
// in ascending order ("3:17"); its UNIQUE index guarantees a single row per
// pair whichever of them asked first.
//   status 'pending'  -> requesterId asked addresseeId
//   status 'accepted' -> they are friends
// Declining, cancelling and unfriending delete the row, so either person can
// ask again later. `addresseeSeen` / `requesterSeen` drive the bell: a new
// request is unseen by the addressee, an acceptance is unseen by the requester.
const countries = require("../data/countries");

const SCHEMA_SQL =
  "CREATE TABLE IF NOT EXISTS tbl_friendships (" +
  "id INT AUTO_INCREMENT PRIMARY KEY, " +
  "requesterId INT NOT NULL, " +
  "addresseeId INT NOT NULL, " +
  "pairKey VARCHAR(32) NOT NULL, " +
  "status VARCHAR(16) NOT NULL DEFAULT 'pending', " +
  "createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP, " +
  "respondedAt DATETIME NULL, " +
  "addresseeSeen TINYINT(1) NOT NULL DEFAULT 0, " +
  "requesterSeen TINYINT(1) NOT NULL DEFAULT 1, " +
  "UNIQUE KEY uq_pair (pairKey), " +
  "INDEX idx_requester (requesterId, status), " +
  "INDEX idx_addressee (addresseeId, status))";

class FriendError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status || 400;
  }
}

function pairKey(a, b) {
  const x = Number(a);
  const y = Number(b);
  return Math.min(x, y) + ":" + Math.max(x, y);
}

function toId(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function person(row) {
  return {
    id: row.IDuser,
    username: row.username,
    profilePictureUrl: row.profilePictureUrl || "",
  };
}

// Relationship from `me`'s point of view.
function stateFor(me, row) {
  if (!row) return "none";
  if (row.status === "accepted") return "friends";
  return Number(row.requesterId) === Number(me) ? "outgoing" : "incoming";
}

module.exports = function createFriends(db) {
  // db: a mysql2 promise pool/connection (connection.promise()).

  async function ensureSchema() {
    await db.query(SCHEMA_SQL);
  }

  async function findRow(me, other) {
    const [rows] = await db.query("SELECT * FROM tbl_friendships WHERE pairKey = ? LIMIT 1", [pairKey(me, other)]);
    return rows[0] || null;
  }

  async function relationship(me, other) {
    if (Number(me) === Number(other)) return "self";
    return stateFor(me, await findRow(me, other));
  }

  async function requireUser(id) {
    const [rows] = await db.query(
      "SELECT IDuser, username, profilePictureUrl FROM tbl_users WHERE IDuser = ? AND isConfirmed = 1 LIMIT 1",
      [id]
    );
    if (!rows.length) throw new FriendError("We couldn't find that person.", 404);
    return rows[0];
  }

  // ── actions ────────────────────────────────────────────────────────────
  // Each returns the new relationship state.

  async function sendRequest(me, otherRaw) {
    const other = toId(otherRaw);
    if (!other) throw new FriendError("We couldn't find that person.", 404);
    if (other === Number(me)) throw new FriendError("You can't add yourself.");
    await requireUser(other);
    const existing = await findRow(me, other);
    if (existing) {
      const state = stateFor(me, existing);
      // They already asked you: sending a request back means yes.
      if (state === "incoming") return accept(me, other);
      return state;
    }
    try {
      await db.query(
        "INSERT INTO tbl_friendships (requesterId, addresseeId, pairKey, status) VALUES (?, ?, ?, 'pending')",
        [me, other, pairKey(me, other)]
      );
    } catch (err) {
      // Both asked at the same moment: the unique pair key kept one row.
      if (err && err.code === "ER_DUP_ENTRY") return relationship(me, other);
      throw err;
    }
    return "outgoing";
  }

  async function accept(me, otherRaw) {
    const other = toId(otherRaw);
    if (!other) throw new FriendError("We couldn't find that person.", 404);
    const [res] = await db.query(
      "UPDATE tbl_friendships SET status = 'accepted', respondedAt = NOW(), addresseeSeen = 1, requesterSeen = 0 " +
        "WHERE pairKey = ? AND addresseeId = ? AND status = 'pending'",
      [pairKey(me, other), me]
    );
    if (!res.affectedRows) {
      const state = await relationship(me, other);
      if (state === "friends") return state;
      throw new FriendError("That friend request is no longer available.", 409);
    }
    return "friends";
  }

  async function decline(me, otherRaw) {
    const other = toId(otherRaw);
    if (!other) throw new FriendError("We couldn't find that person.", 404);
    await db.query(
      "DELETE FROM tbl_friendships WHERE pairKey = ? AND addresseeId = ? AND status = 'pending'",
      [pairKey(me, other), me]
    );
    return relationship(me, other);
  }

  async function cancel(me, otherRaw) {
    const other = toId(otherRaw);
    if (!other) throw new FriendError("We couldn't find that person.", 404);
    await db.query(
      "DELETE FROM tbl_friendships WHERE pairKey = ? AND requesterId = ? AND status = 'pending'",
      [pairKey(me, other), me]
    );
    return relationship(me, other);
  }

  async function unfriend(me, otherRaw) {
    const other = toId(otherRaw);
    if (!other) throw new FriendError("We couldn't find that person.", 404);
    await db.query("DELETE FROM tbl_friendships WHERE pairKey = ? AND status = 'accepted'", [pairKey(me, other)]);
    return relationship(me, other);
  }

  // ── lists ──────────────────────────────────────────────────────────────

  async function listFriends(me) {
    const [rows] = await db.query(
      "SELECT u.IDuser, u.username, u.profilePictureUrl, f.respondedAt FROM tbl_friendships f " +
        "JOIN tbl_users u ON u.IDuser = IF(f.requesterId = ?, f.addresseeId, f.requesterId) " +
        "WHERE (f.requesterId = ? OR f.addresseeId = ?) AND f.status = 'accepted' ORDER BY u.username",
      [me, me, me]
    );
    return rows.map(person);
  }

  async function listRequests(me) {
    const [incoming] = await db.query(
      "SELECT u.IDuser, u.username, u.profilePictureUrl, f.createdAt FROM tbl_friendships f " +
        "JOIN tbl_users u ON u.IDuser = f.requesterId WHERE f.addresseeId = ? AND f.status = 'pending' ORDER BY f.createdAt DESC",
      [me]
    );
    const [outgoing] = await db.query(
      "SELECT u.IDuser, u.username, u.profilePictureUrl, f.createdAt FROM tbl_friendships f " +
        "JOIN tbl_users u ON u.IDuser = f.addresseeId WHERE f.requesterId = ? AND f.status = 'pending' ORDER BY f.createdAt DESC",
      [me]
    );
    return { incoming: incoming.map(person), outgoing: outgoing.map(person) };
  }

  async function countFriends(userId) {
    const [rows] = await db.query(
      "SELECT COUNT(*) AS n FROM tbl_friendships WHERE (requesterId = ? OR addresseeId = ?) AND status = 'accepted'",
      [userId, userId]
    );
    return Number(rows[0].n) || 0;
  }

  // Search confirmed users by name (contains) or exact email, with each
  // result's relationship to `me`. Never returns `me` or anyone's email.
  async function search(me, rawQuery) {
    const q = String(rawQuery || "").trim().slice(0, 100);
    if (q.length < 2) return [];
    const byEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(q);
    const like = "%" + q.replace(/[\\%_]/g, (c) => "\\" + c) + "%";
    const [rows] = await db.query(
      "SELECT u.IDuser, u.username, u.profilePictureUrl, f.status, f.requesterId FROM tbl_users u " +
        "LEFT JOIN tbl_friendships f ON f.pairKey = CONCAT(LEAST(?, u.IDuser), ':', GREATEST(?, u.IDuser)) " +
        "WHERE u.isConfirmed = 1 AND u.IDuser <> ? AND " +
        (byEmail ? "u.email = ? " : "u.username LIKE ? ") +
        "ORDER BY u.username LIMIT 20",
      [me, me, me, byEmail ? q : like]
    );
    return rows.map((r) => Object.assign(person(r), { relationship: stateFor(me, r.status ? r : null) }));
  }

  // ── profiles ───────────────────────────────────────────────────────────
  // Everyone signed in sees name, photo and friend count. Travel details
  // (visited countries/cities, planned trips, trip count) only for friends
  // and the person themselves.
  async function profile(viewer, targetRaw) {
    const target = toId(targetRaw);
    if (!target) throw new FriendError("We couldn't find that person.", 404);
    const [rows] = await db.query(
      "SELECT IDuser, username, profilePictureUrl, visitedCountries, visitedCities FROM tbl_users " +
        "WHERE IDuser = ? AND isConfirmed = 1 LIMIT 1",
      [target]
    );
    if (!rows.length) throw new FriendError("We couldn't find that person.", 404);
    const row = rows[0];
    const rel = await relationship(viewer, target);
    const result = Object.assign(person(row), {
      relationship: rel,
      friendCount: await countFriends(target),
      canSeeDetails: rel === "friends" || rel === "self",
    });
    if (!result.canSeeDetails) return result;

    const visited = String(row.visitedCountries || "").split(",").filter(Boolean)
      .map((code) => countries.find((c) => c.code.toLowerCase() === code.toLowerCase()))
      .filter(Boolean)
      .map((c) => ({ code: c.code, name: c.name }));
    const cities = String(row.visitedCities || "").split(",").filter(Boolean);
    const [groups] = await db.query(
      "SELECT g.name, g.destination FROM tbl_groups g JOIN tbl_group_members gm ON g.id = gm.groupId WHERE gm.userId = ?",
      [target]
    );
    const planning = [];
    groups.forEach((g) => {
      const c = countries.find((x) => x.name.toLowerCase() === String(g.name || g.destination || "").toLowerCase());
      if (c && !planning.some((p) => p.code === c.code)) planning.push({ code: c.code, name: c.name });
    });
    return Object.assign(result, { visitedCountries: visited, visitedCities: cities, planningCountries: planning, tripCount: groups.length });
  }

  // ── notifications (merged into the bell) ───────────────────────────────

  async function notifications(me) {
    const [incoming] = await db.query(
      "SELECT u.IDuser, u.username, f.createdAt, f.addresseeSeen FROM tbl_friendships f JOIN tbl_users u ON u.IDuser = f.requesterId " +
        "WHERE f.addresseeId = ? AND f.status = 'pending' ORDER BY f.createdAt DESC LIMIT 20",
      [me]
    );
    const [accepted] = await db.query(
      "SELECT u.IDuser, u.username, f.respondedAt, f.requesterSeen FROM tbl_friendships f JOIN tbl_users u ON u.IDuser = f.addresseeId " +
        "WHERE f.requesterId = ? AND f.status = 'accepted' AND f.respondedAt > (NOW() - INTERVAL 30 DAY) ORDER BY f.respondedAt DESC LIMIT 20",
      [me]
    );
    return incoming
      .map((r) => ({
        type: "friend-request",
        message: r.username + " sent you a friend request",
        link: "/friends",
        personId: r.IDuser,
        isRead: Number(r.addresseeSeen) === 1 ? 1 : 0,
        createdAt: r.createdAt ? new Date(r.createdAt).toISOString() : null,
      }))
      .concat(accepted.map((r) => ({
        type: "friend-accepted",
        message: r.username + " accepted your friend request",
        link: "/people/" + r.IDuser,
        personId: r.IDuser,
        isRead: Number(r.requesterSeen) === 1 ? 1 : 0,
        createdAt: r.respondedAt ? new Date(r.respondedAt).toISOString() : null,
      })));
  }

  async function unseenCount(me) {
    const [rows] = await db.query(
      "SELECT " +
        "(SELECT COUNT(*) FROM tbl_friendships WHERE addresseeId = ? AND status = 'pending' AND addresseeSeen = 0) + " +
        "(SELECT COUNT(*) FROM tbl_friendships WHERE requesterId = ? AND status = 'accepted' AND requesterSeen = 0) AS n",
      [me, me]
    );
    return Number(rows[0].n) || 0;
  }

  async function markSeen(me) {
    await db.query("UPDATE tbl_friendships SET addresseeSeen = 1 WHERE addresseeId = ? AND addresseeSeen = 0", [me]);
    await db.query("UPDATE tbl_friendships SET requesterSeen = 1 WHERE requesterId = ? AND requesterSeen = 0", [me]);
  }

  async function removeAllFor(userId) {
    await db.query("DELETE FROM tbl_friendships WHERE requesterId = ? OR addresseeId = ?", [userId, userId]);
  }

  return {
    ensureSchema, relationship, sendRequest, accept, decline, cancel, unfriend,
    listFriends, listRequests, countFriends, search, profile,
    notifications, unseenCount, markSeen, removeAllFor,
  };
};

module.exports.FriendError = FriendError;
module.exports.pairKey = pairKey;
module.exports.SCHEMA_SQL = SCHEMA_SQL;
