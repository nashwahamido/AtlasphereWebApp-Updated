// Trips ("groups" in the database) for the mobile API: list, details, create,
// join by invite code, add friends, rename, leave, delete, photo, interests.
// The rules match the website (routes/groups.js): only members can see or
// change a trip, only its creator can delete it.
const crypto = require("crypto");
const countries = require("../data/countries");

const ACTIVITY_TAGS = ["Relax", "Nightlife", "Active", "Culture", "Nature", "Food", "Shopping", "Entertainment", "Family", "Fun", "Sightseeing"];
const COLORS = ["#3B5F8A", "#E8933A", "#2D8B6F", "#8B5A2B", "#6A5ACD"];

class TripError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function splitCities(value) {
  return String(value || "").split(",").map((c) => c.trim()).filter((c, i, a) => c && a.indexOf(c) === i);
}

function parsePrefs(value) {
  try {
    const v = JSON.parse(value || "[]");
    return Array.isArray(v) ? v.filter((t) => ACTIVITY_TAGS.includes(t)) : [];
  } catch (e) {
    return String(value || "").split(",").map((s) => s.trim()).filter((t) => ACTIVITY_TAGS.includes(t));
  }
}

function inviteCodeFrom(input) {
  const s = String(input || "").trim();
  const m = s.match(/groups\/join\/([A-Za-z0-9]+)/) || s.match(/^([A-Za-z0-9]{6,32})$/);
  return m ? m[1] : null;
}

module.exports = function createTrips(pool, opts) {
  const db = pool.promise ? pool.promise() : pool;
  const friends = opts && opts.friends;

  function summary(g, userId) {
    return {
      id: String(g.id),
      name: g.name,
      destination: g.destination,
      cities: splitCities(g.cities).length ? splitCities(g.cities) : [g.destination].filter(Boolean),
      flag: g.flag || "",
      color: g.color || "#3B5F8A",
      photo: g.photo || "",
      days: g.days || 7,
      memberCount: Number(g.memberCount || 0),
      isOwner: String(g.createdBy) === String(userId),
      interests: parsePrefs(g.preferences),
    };
  }

  async function assertMember(userId, tripId) {
    const [rows] = await db.query(
      `SELECT g.*, (SELECT COUNT(*) FROM tbl_group_members m WHERE m.groupId = g.id) AS memberCount
         FROM tbl_groups g
        WHERE g.id = ? AND (g.createdBy = ? OR EXISTS (SELECT 1 FROM tbl_group_members m WHERE m.groupId = g.id AND m.userId = ?))`,
      [tripId, userId, userId]
    );
    if (!rows.length) throw new TripError(404, "Trip not found.");
    return rows[0];
  }

  async function list(userId) {
    const [rows] = await db.query(
      `SELECT g.*, (SELECT COUNT(*) FROM tbl_group_members m2 WHERE m2.groupId = g.id) AS memberCount,
              (SELECT MAX(c.createdAt) FROM tbl_chat_messages c WHERE c.groupId = g.id) AS lastActive
         FROM tbl_groups g
         JOIN tbl_group_members m ON m.groupId = g.id AND m.userId = ?
        ORDER BY COALESCE(lastActive, FROM_UNIXTIME(g.id / 1000)) DESC`,
      [userId]
    ).catch(async (err) => {
      // tbl_chat_messages may not exist on a fresh database
      if (!/tbl_chat_messages/.test(err.message)) throw err;
      return db.query(
        `SELECT g.*, (SELECT COUNT(*) FROM tbl_group_members m2 WHERE m2.groupId = g.id) AS memberCount
           FROM tbl_groups g JOIN tbl_group_members m ON m.groupId = g.id AND m.userId = ? ORDER BY g.id DESC`,
        [userId]
      );
    });
    return rows.map((g) => summary(g, userId));
  }

  async function detail(userId, tripId, base) {
    const g = await assertMember(userId, tripId);
    const [members] = await db.query(
      `SELECT u.IDuser AS id, u.username, u.profilePictureUrl
         FROM tbl_group_members m JOIN tbl_users u ON u.IDuser = m.userId
        WHERE m.groupId = ? ORDER BY (u.IDuser = ?) DESC, u.username`,
      [g.id, g.createdBy]
    );
    let dates = null;
    try {
      const [d] = await db.query("SELECT rangeStart, rangeEnd, calYear, calMonth FROM tbl_itinerary_dates WHERE groupId = ?", [g.id]);
      if (d.length && d[0].rangeStart !== null && d[0].calYear !== null) {
        const start = new Date(Date.UTC(d[0].calYear, d[0].calMonth, d[0].rangeStart));
        const end = new Date(Date.UTC(d[0].calYear, d[0].calMonth, Math.max(d[0].rangeStart, d[0].rangeEnd === null ? d[0].rangeStart : d[0].rangeEnd)));
        dates = { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
      }
    } catch (e) { /* table not created yet */ }
    return Object.assign(summary(g, userId), {
      memberCount: members.length,
      members: members.map((m) => ({ id: m.id, username: m.username, profilePictureUrl: m.profilePictureUrl || "", isOwner: String(m.id) === String(g.createdBy) })),
      inviteLink: base + "/groups/join/" + g.inviteCode,
      dates,
    });
  }

  // { country: "South Korea", cities: ["Seoul", "Busan"], days: 5, interests: [...] }
  async function create(user, input) {
    const country = countries.find((c) => c.name.toLowerCase() === String(input.country || "").trim().toLowerCase());
    if (!country) throw new TripError(400, "Please choose a country.");
    const wanted = Array.isArray(input.cities) ? input.cities : splitCities(input.cities);
    const cities = wanted.map((c) => country.cities.find((k) => k.toLowerCase() === String(c).trim().toLowerCase())).filter((c, i, a) => c && a.indexOf(c) === i);
    if (!cities.length) throw new TripError(400, "Please choose at least one city.");
    const days = Math.round(Number(input.days));
    if (!(days >= 1 && days <= 60)) throw new TripError(400, "Trip length must be 1–60 days.");
    const interests = Array.isArray(input.interests) ? input.interests.filter((t) => ACTIVITY_TAGS.includes(t)) : [];

    const id = Date.now();
    await db.query(
      "INSERT INTO tbl_groups (id, name, destination, flag, cities, inviteCode, days, color, createdBy, preferences) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [id, country.name, cities[0], country.flag, cities.join(","), crypto.randomBytes(6).toString("hex"), days, COLORS[id % COLORS.length], user.IDuser, JSON.stringify(interests)]
    );
    await db.query(
      "INSERT IGNORE INTO tbl_group_members (groupId, userId, username, email) VALUES (?, ?, ?, ?)",
      [id, user.IDuser, user.username, user.email]
    );
    return String(id);
  }

  async function join(user, codeOrLink) {
    const code = inviteCodeFrom(codeOrLink);
    if (!code) throw new TripError(400, "That doesn't look like an invite link.");
    const [rows] = await db.query("SELECT id FROM tbl_groups WHERE inviteCode = ? LIMIT 1", [code]);
    if (!rows.length) throw new TripError(404, "That invite link is invalid or has expired.");
    await db.query(
      "INSERT IGNORE INTO tbl_group_members (groupId, userId, username, email) VALUES (?, ?, ?, ?)",
      [rows[0].id, user.IDuser, user.username, user.email]
    );
    return String(rows[0].id);
  }

  // Add one of your friends to a trip you're in (with a notification for them).
  async function addFriend(user, tripId, friendId) {
    const g = await assertMember(user.IDuser, tripId);
    if (!friends || (await friends.relationship(user.IDuser, friendId)) !== "friends") {
      throw new TripError(403, "You can only add your friends. Share the invite link with anyone else.");
    }
    const [u] = await db.query("SELECT IDuser, username, email FROM tbl_users WHERE IDuser = ?", [friendId]);
    if (!u.length) throw new TripError(404, "We couldn't find that person.");
    const [res] = await db.query(
      "INSERT IGNORE INTO tbl_group_members (groupId, userId, username, email) VALUES (?, ?, ?, ?)",
      [g.id, u[0].IDuser, u[0].username, u[0].email]
    );
    if (res.affectedRows) {
      await db.query(
        "INSERT INTO tbl_notifications (userId, groupId, groupName, message, type) VALUES (?, ?, ?, ?, ?)",
        [u[0].IDuser, g.id, g.name, user.username + ' added you to "' + g.name + '"', "invite"]
      ).catch(() => {});
    }
    return { added: !!res.affectedRows };
  }

  async function rename(userId, tripId, name) {
    await assertMember(userId, tripId);
    const clean = String(name || "").trim().slice(0, 100);
    if (!clean) throw new TripError(400, "Name can't be empty.");
    await db.query("UPDATE tbl_groups SET name = ? WHERE id = ?", [clean, tripId]);
  }

  async function setInterests(userId, tripId, interests) {
    await assertMember(userId, tripId);
    const list = (Array.isArray(interests) ? interests : []).filter((t) => ACTIVITY_TAGS.includes(t));
    await db.query("UPDATE tbl_groups SET preferences = ? WHERE id = ?", [JSON.stringify(list), tripId]);
    return list;
  }

  async function setPhoto(userId, tripId, photoPath) {
    await assertMember(userId, tripId);
    await db.query("UPDATE tbl_groups SET photo = ? WHERE id = ?", [photoPath, tripId]);
  }

  async function leave(userId, tripId) {
    await assertMember(userId, tripId);
    await db.query("DELETE FROM tbl_group_members WHERE groupId = ? AND userId = ?", [tripId, userId]);
  }

  async function remove(userId, tripId) {
    const g = await assertMember(userId, tripId);
    if (String(g.createdBy) !== String(userId)) throw new TripError(403, "Only the person who created the trip can delete it.");
    const tables = ["tbl_group_members", "tbl_chat_messages", "tbl_notifications", "tbl_activity_votes", "tbl_itinerary_blocks", "tbl_itinerary_dates", "tbl_itinerary_comments", "tbl_itinerary_day_cities"];
    for (const t of tables) {
      await db.query("DELETE FROM " + t + " WHERE groupId = ?", [g.id]).catch(() => {}); // some tables may not exist
    }
    await db.query("DELETE FROM tbl_groups WHERE id = ?", [g.id]);
  }

  return { list, detail, create, join, addFriend, rename, setInterests, setPhoto, leave, remove, assertMember };
};

module.exports.TripError = TripError;
module.exports.ACTIVITY_TAGS = ACTIVITY_TAGS;
module.exports.inviteCodeFrom = inviteCodeFrom;
