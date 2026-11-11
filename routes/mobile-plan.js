// Mobile API (mounted at /api/mobile, before routes/mobile.js) for everything
// inside a trip plus your profile:
//   chat history · recommendations and votes · itinerary · destination info ·
//   notifications · profile photo, visited places, delete account.
// Same rules and tables as the website. Changes are pushed to the trip's live
// room, so people on the website see them straight away too.
const express = require("express");
const countries = require("../data/countries");
const { getRecommendations, getRecommendationsForCities } = require("../config/places");
const createMobileAuth = require("../config/mobileAuth");
const createTrips = require("../services/trips");
const { TripError } = require("../services/trips");
const createFriends = require("../services/friends");
const { tripFromItinerary } = require("../services/destination").helpers;

const HOURS = ["08.00", "09.00", "10.00", "11.00", "12.00", "13.00", "14.00", "15.00", "16.00", "17.00", "18.00", "19.00", "20.00", "21.00", "22.00", "23.00", "00.00", "01.00", "02.00"];
const VOTES = ["upvote", "bookmark", "downvote"];
const COLORS = /^#[0-9a-fA-F]{6}$/;
const ISO = /^\d{4}-\d{2}-\d{2}$/;

class BadRequest extends Error { constructor(message, status) { super(message); this.status = status || 400; } }

function splitCities(g) {
  const list = String(g.cities || "").split(",").map((c) => c.trim()).filter((c, i, a) => c && a.indexOf(c) === i);
  return list.length ? list : [g.destination].filter(Boolean);
}
function prefsOf(g) {
  try { const v = JSON.parse(g.preferences || "[]"); return Array.isArray(v) ? v : []; } catch (e) { return []; }
}
function parseIso(s) {
  if (!ISO.test(String(s || ""))) return null;
  const d = new Date(s + "T00:00:00Z");
  return isNaN(d) || d.toISOString().slice(0, 10) !== s ? null : d;
}

module.exports = function createMobilePlanRouter(deps) {
  const { connection } = deps;
  const db = connection.promise();
  const router = express.Router();
  const { requireMobileAuth } = createMobileAuth(connection);
  const friends = createFriends(db);
  const trips = createTrips(connection, { friends });

  const me = (req) => req.mobileUser.IDuser;
  const io = (req) => req.app.get("io");
  const emit = (req, groupId, event, data) => { const s = io(req); if (s) s.to("group-" + groupId).emit(event, data); };

  function route(handler) {
    return async (req, res) => {
      try {
        res.json(await handler(req, res));
      } catch (err) {
        if (err instanceof TripError || err instanceof BadRequest) return res.status(err.status).json({ error: err.message });
        console.error("Mobile plan error:", err.message);
        res.status(500).json({ error: "Something went wrong. Please try again." });
      }
    };
  }
  // Member check; returns the trip row.
  const trip = (req) => trips.assertMember(me(req), req.params.id);

  async function tripDates(groupId) {
    try {
      const [rows] = await db.query("SELECT rangeStart, rangeEnd, calYear, calMonth FROM tbl_itinerary_dates WHERE groupId = ?", [groupId]);
      return tripFromItinerary(rows[0]);
    } catch (e) { return null; }
  }

  // ── CHAT HISTORY (live messages go over the socket) ───────────────────
  router.get("/trips/:id/messages", requireMobileAuth, route(async (req) => {
    const g = await trip(req);
    const [rows] = await db.query(
      "SELECT id, userId, userName, userAvatar, `text`, `system`, createdAt FROM tbl_chat_messages WHERE groupId = ? ORDER BY createdAt DESC LIMIT 100",
      [g.id]
    ).catch(() => [[]]);
    return {
      messages: rows.reverse().map((r) => ({
        id: r.id, userId: r.userId, userName: r.userName, userAvatar: r.userAvatar || "", text: r.text,
        system: !!r.system, time: r.createdAt ? new Date(r.createdAt).toISOString() : null,
      })),
    };
  }));

  // ── RECOMMENDATIONS + VOTES ───────────────────────────────────────────
  router.get("/trips/:id/recommendations", requireMobileAuth, route(async (req) => {
    const g = await trip(req);
    const cities = splitCities(g);
    const prefs = prefsOf(g);
    const items = cities.length > 1 ? await getRecommendationsForCities(cities, prefs, 50) : await getRecommendations(cities[0], prefs);
    const [voted] = await db.query("SELECT activityId FROM tbl_activity_votes WHERE groupId = ? AND userId = ?", [g.id, me(req)]).catch(() => [[]]);
    const done = new Set(voted.map((v) => String(v.activityId)));

    // "Closed on your dates" notes from opening hours (same as the website).
    const closures = {};
    const dates = await tripDates(g.id);
    if (dates) {
      const destination = req.app.get("destination");
      const infos = await Promise.all(cities.map((c) => destination.placesInfo(Object.assign({}, g, { destination: c }), dates).catch(() => null)));
      infos.forEach((info) => {
        if (!info) return;
        const total = info.dates.length;
        info.places.forEach((p) => {
          if (!p.closedOn.length) return;
          const text = p.closedOn.length === total ? (p.seasonal ? "Closed for the season on your dates" : "Closed on your dates")
            : p.closedOn.length === 1 ? "Closed on one of your days" : "Closed on " + p.closedOn.length + " of your " + total + " days";
          closures[String(p.id)] = text;
          closures["name:" + String(p.name).trim().toLowerCase()] = text;
        });
      });
    }

    return {
      cities,
      items: items.filter((a) => !done.has(String(a.id))).map((a) => ({
        id: String(a.id), name: a.name, tags: a.tags || [], description: a.description || "", image: a.image || "", city: a.location || cities[0],
        closure: closures[String(a.id)] || closures["name:" + String(a.name).trim().toLowerCase()] || null,
      })),
    };
  }));

  router.post("/trips/:id/votes", requireMobileAuth, route(async (req) => {
    const g = await trip(req);
    const a = (req.body && req.body.activity) || {};
    const vote = req.body && req.body.vote;
    if (!a.id || !a.name || !VOTES.includes(vote)) throw new BadRequest("Missing activity or vote.");
    const tags = Array.isArray(a.tags) ? a.tags.join(",") : String(a.tags || "");
    const vals = [String(a.name).slice(0, 255), String(a.image || "").slice(0, 1024), String(a.description || "").slice(0, 1000), tags.slice(0, 500)];
    await db.query(
      "INSERT INTO tbl_activity_votes (groupId, userId, activityId, activityName, activityImage, activityDesc, activityTags, `vote`) VALUES (?, ?, ?, ?, ?, ?, ?, ?) " +
      "ON DUPLICATE KEY UPDATE `vote` = ?, activityName = ?, activityImage = ?, activityDesc = ?, activityTags = ?",
      [g.id, me(req), String(a.id).slice(0, 255), ...vals, vote, vote, ...vals]
    );
    if (vote !== "downvote") {
      const msg = req.mobileUser.username + " " + (vote === "upvote" ? "upvoted" : "bookmarked") + ' "' + String(a.name).slice(0, 60) + '"';
      const [members] = await db.query("SELECT userId FROM tbl_group_members WHERE groupId = ? AND userId <> ?", [g.id, me(req)]);
      if (members.length) {
        await db.query("INSERT INTO tbl_notifications (userId, groupId, groupName, message, type) VALUES ?",
          [members.map((m) => [m.userId, g.id, g.name, msg, "vote"])]).catch((e) => console.error("Notification insert error:", e.message));
        emit(req, g.id, "new-notification", { groupId: g.id, groupName: g.name, message: msg });
      }
    }
    return { ok: true };
  }));

  // Upvoted and saved activities (to add to the itinerary), with vote counts.
  router.get("/trips/:id/saved", requireMobileAuth, route(async (req) => {
    const g = await trip(req);
    const [rows] = await db.query(
      `SELECT activityId, MAX(activityName) AS name, MAX(activityImage) AS image,
              SUM(\`vote\` = 'upvote') AS upvotes, SUM(\`vote\` = 'bookmark') AS saves,
              MAX(CASE WHEN userId = ? THEN \`vote\` END) AS mine
         FROM tbl_activity_votes WHERE groupId = ? AND \`vote\` IN ('upvote', 'bookmark')
        GROUP BY activityId ORDER BY upvotes DESC, saves DESC, name`,
      [me(req), g.id]
    ).catch(() => [[]]);
    return { items: rows.map((r) => ({ id: String(r.activityId), name: r.name, image: r.image || "", upvotes: Number(r.upvotes), saves: Number(r.saves), mine: r.mine || null })) };
  }));

  // ── ITINERARY ─────────────────────────────────────────────────────────
  router.get("/trips/:id/itinerary", requireMobileAuth, route(async (req) => {
    const g = await trip(req);
    const [dates, blocks, dayCities, counts] = await Promise.all([
      tripDates(g.id),
      db.query("SELECT dayIndex, timeSlot, activityName, activityColor, COALESCE(duration, 1) AS duration FROM tbl_itinerary_blocks WHERE groupId = ? ORDER BY dayIndex, timeSlot", [g.id]).then((r) => r[0]).catch(() => []),
      db.query("SELECT dayIndex, city FROM tbl_itinerary_day_cities WHERE groupId = ? ORDER BY dayIndex", [g.id]).then((r) => r[0]).catch(() => []),
      db.query("SELECT dayIndex, timeSlot, COUNT(*) AS n FROM tbl_itinerary_comments WHERE groupId = ? GROUP BY dayIndex, timeSlot", [g.id]).then((r) => r[0]).catch(() => []),
    ]);
    return {
      cities: splitCities(g),
      days: g.days || 7,
      dates,
      hours: HOURS,
      blocks: blocks.map((b) => ({ dayIndex: b.dayIndex, timeSlot: b.timeSlot, name: b.activityName, color: b.activityColor || "#E8933A", duration: Number(b.duration) || 1 })),
      dayCities: dayCities.map((d) => ({ dayIndex: d.dayIndex, city: d.city })),
      comments: counts.map((c) => ({ dayIndex: c.dayIndex, timeSlot: c.timeSlot, count: Number(c.n) })),
    };
  }));

  // { start: "YYYY-MM-DD", end: "YYYY-MM-DD" }, stored the website's way.
  router.post("/trips/:id/itinerary/dates", requireMobileAuth, route(async (req) => {
    const g = await trip(req);
    const start = parseIso(req.body && req.body.start), end = parseIso(req.body && req.body.end);
    if (!start || !end || end < start) throw new BadRequest("Please pick a start and an end date.");
    const length = Math.round((end - start) / 86400000) + 1;
    if (length > 60) throw new BadRequest("Trips can be up to 60 days.");
    const rangeStart = start.getUTCDate(), rangeEnd = rangeStart + length - 1, calYear = start.getUTCFullYear(), calMonth = start.getUTCMonth();
    await db.query(
      "INSERT INTO tbl_itinerary_dates (groupId, rangeStart, rangeEnd, calYear, calMonth) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE rangeStart = VALUES(rangeStart), rangeEnd = VALUES(rangeEnd), calYear = VALUES(calYear), calMonth = VALUES(calMonth)",
      [g.id, rangeStart, rangeEnd, calYear, calMonth]
    );
    emit(req, g.id, "itinerary-update", { groupId: String(g.id), action: "dates", rangeStart, rangeEnd, calYear, calMonth });
    return { dates: { start: req.body.start, end: req.body.end } };
  }));

  // Add or move an activity. Body: { dayIndex, timeSlot, name, color?, duration?, from?: { dayIndex, timeSlot } }
  router.put("/trips/:id/itinerary/block", requireMobileAuth, route(async (req) => {
    const g = await trip(req);
    const b = req.body || {};
    const dayIndex = parseInt(b.dayIndex, 10);
    const name = String(b.name || "").trim().slice(0, 255);
    const duration = Math.min(6, Math.max(1, Math.round(Number(b.duration) || 1)));
    const color = COLORS.test(String(b.color || "")) ? b.color : "#E8933A";
    if (!(dayIndex >= 0 && dayIndex < 366) || !HOURS.includes(b.timeSlot) || !name) throw new BadRequest("Missing day, time or activity.");
    if (b.from && (String(b.from.dayIndex) !== String(dayIndex) || b.from.timeSlot !== b.timeSlot) && HOURS.includes(b.from.timeSlot)) {
      await db.query("DELETE FROM tbl_itinerary_blocks WHERE groupId = ? AND dayIndex = ? AND timeSlot = ?", [g.id, parseInt(b.from.dayIndex, 10), b.from.timeSlot]);
      emit(req, g.id, "itinerary-update", { groupId: String(g.id), action: "delete", dayIndex: parseInt(b.from.dayIndex, 10), timeSlot: b.from.timeSlot });
    }
    await db.query(
      "INSERT INTO tbl_itinerary_blocks (groupId, dayIndex, timeSlot, activityName, activityColor, duration, updatedBy) VALUES (?, ?, ?, ?, ?, ?, ?) " +
      "ON DUPLICATE KEY UPDATE activityName = VALUES(activityName), activityColor = VALUES(activityColor), duration = VALUES(duration), updatedBy = VALUES(updatedBy)",
      [g.id, dayIndex, b.timeSlot, name, color, duration, me(req)]
    );
    const block = { name, color, duration };
    emit(req, g.id, "itinerary-update", { groupId: String(g.id), action: "set", dayIndex, timeSlot: b.timeSlot, block });
    return { block: Object.assign({ dayIndex, timeSlot: b.timeSlot }, block) };
  }));

  router.delete("/trips/:id/itinerary/block", requireMobileAuth, route(async (req) => {
    const g = await trip(req);
    const dayIndex = parseInt((req.body || {}).dayIndex, 10), timeSlot = (req.body || {}).timeSlot;
    if (!(dayIndex >= 0) || !HOURS.includes(timeSlot)) throw new BadRequest("Missing day or time.");
    await db.query("DELETE FROM tbl_itinerary_blocks WHERE groupId = ? AND dayIndex = ? AND timeSlot = ?", [g.id, dayIndex, timeSlot]);
    emit(req, g.id, "itinerary-update", { groupId: String(g.id), action: "delete", dayIndex, timeSlot });
    return { ok: true };
  }));

  router.post("/trips/:id/itinerary/day-city", requireMobileAuth, route(async (req) => {
    const g = await trip(req);
    const dayIndex = parseInt((req.body || {}).dayIndex, 10);
    const city = splitCities(g).find((c) => c.toLowerCase() === String((req.body || {}).city || "").trim().toLowerCase());
    if (!(dayIndex >= 0 && dayIndex < 366)) throw new BadRequest("Missing day.");
    if (!city) throw new BadRequest("That city isn't part of this trip.");
    await db.query("INSERT INTO tbl_itinerary_day_cities (groupId, dayIndex, city) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE city = VALUES(city)", [g.id, dayIndex, city]);
    emit(req, g.id, "itinerary-update", { groupId: String(g.id), action: "day-city", dayIndex, city });
    return { dayIndex, city };
  }));

  router.get("/trips/:id/itinerary/comments", requireMobileAuth, route(async (req) => {
    const g = await trip(req);
    const [rows] = await db.query(
      "SELECT id, userId, userName, comment, createdAt FROM tbl_itinerary_comments WHERE groupId = ? AND dayIndex = ? AND timeSlot = ? ORDER BY createdAt ASC",
      [g.id, parseInt(req.query.dayIndex, 10), String(req.query.timeSlot || "")]
    ).catch(() => [[]]);
    return { comments: rows.map((r) => ({ id: r.id, userId: Number(r.userId), userName: r.userName, comment: r.comment, createdAt: r.createdAt ? new Date(r.createdAt).toISOString() : null })) };
  }));

  router.post("/trips/:id/itinerary/comments", requireMobileAuth, route(async (req) => {
    const g = await trip(req);
    const b = req.body || {};
    const text = String(b.comment || "").trim().slice(0, 1000);
    const dayIndex = parseInt(b.dayIndex, 10);
    if (!(dayIndex >= 0) || !HOURS.includes(b.timeSlot) || !text) throw new BadRequest("Write a note first.");
    const [r] = await db.query(
      "INSERT INTO tbl_itinerary_comments (groupId, dayIndex, timeSlot, userId, userName, comment) VALUES (?, ?, ?, ?, ?, ?)",
      [g.id, dayIndex, b.timeSlot, me(req), req.mobileUser.username, text]
    );
    return { comment: { id: r.insertId, userId: me(req), userName: req.mobileUser.username, comment: text, createdAt: new Date().toISOString() } };
  }));

  router.delete("/trips/:id/itinerary/comments/:commentId", requireMobileAuth, route(async (req) => {
    const g = await trip(req);
    await db.query("DELETE FROM tbl_itinerary_comments WHERE id = ? AND groupId = ? AND userId = ?", [req.params.commentId, g.id, me(req)]);
    return { ok: true };
  }));

  // ── DESTINATION ───────────────────────────────────────────────────────
  async function destinationArgs(req) {
    const g = await trip(req);
    const cities = splitCities(g);
    const wanted = String(req.query.city || "").trim().toLowerCase();
    const city = cities.find((c) => c.toLowerCase() === wanted) || cities[0];
    const start = parseIso(req.query.start), end = parseIso(req.query.end);
    const dates = start && end && end >= start && (end - start) / 86400000 < 60 ? { start: req.query.start, end: req.query.end } : await tripDates(g.id);
    return { g: Object.assign({}, g, { destination: city }), cities, city, dates };
  }
  router.get("/trips/:id/destination", requireMobileAuth, route(async (req) => {
    const { g, cities, city, dates } = await destinationArgs(req);
    return Object.assign({ cities, city }, await req.app.get("destination").overview(g, dates));
  }));
  router.get("/trips/:id/destination/places", requireMobileAuth, route(async (req) => {
    const { g, cities, city, dates } = await destinationArgs(req);
    return Object.assign({ cities, city }, await req.app.get("destination").placesInfo(g, dates));
  }));

  // ── NOTIFICATIONS ─────────────────────────────────────────────────────
  router.get("/notifications", requireMobileAuth, route(async (req) => {
    const [rows] = await db.query(
      "SELECT id, groupId, groupName, message, type, isRead, createdAt FROM tbl_notifications WHERE userId = ? ORDER BY createdAt DESC LIMIT 50",
      [me(req)]
    ).catch(() => [[]]);
    const own = rows.map((n) => ({ id: "n" + n.id, groupId: n.groupId ? String(n.groupId) : null, message: n.message, type: n.type, isRead: !!n.isRead, createdAt: n.createdAt ? new Date(n.createdAt).toISOString() : null }));
    const friendNotes = await friends.notifications(me(req)).catch(() => []);
    const all = own.concat(friendNotes.map((f) => ({ id: "f-" + f.type + "-" + f.personId, groupId: null, personId: f.personId || null, message: f.message, type: f.type || "friend", isRead: !!f.isRead, createdAt: f.createdAt || null })))
      .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
    return { notifications: all.slice(0, 50) };
  }));
  router.get("/notifications/count", requireMobileAuth, route(async (req) => {
    const [rows] = await db.query("SELECT COUNT(*) AS n FROM tbl_notifications WHERE userId = ? AND isRead = 0", [me(req)]).catch(() => [[{ n: 0 }]]);
    const friendsUnseen = await friends.unseenCount(me(req)).catch(() => 0);
    return { count: Number(rows[0].n) + Number(friendsUnseen || 0) };
  }));
  router.post("/notifications/read", requireMobileAuth, route(async (req) => {
    await db.query("UPDATE tbl_notifications SET isRead = 1 WHERE userId = ?", [me(req)]);
    await friends.markSeen(me(req)).catch(() => {});
    return { ok: true };
  }));

  // ── PROFILE ───────────────────────────────────────────────────────────
  router.get("/me/profile", requireMobileAuth, route(async (req) => {
    const [[u]] = await db.query("SELECT IDuser, username, email, profilePictureUrl, visitedCountries, visitedCities FROM tbl_users WHERE IDuser = ?", [me(req)]);
    const codes = String(u.visitedCountries || "").split(",").filter(Boolean);
    const [[tc]] = await db.query("SELECT COUNT(*) AS n FROM tbl_group_members WHERE userId = ?", [me(req)]);
    return {
      user: { id: u.IDuser, username: u.username, email: u.email, profilePictureUrl: u.profilePictureUrl || "" },
      visitedCountries: codes.map((c) => countries.find((k) => k.code.toLowerCase() === c.toLowerCase())).filter(Boolean).map((k) => ({ code: k.code, name: k.name, flag: k.flag })),
      visitedCities: String(u.visitedCities || "").split(",").map((c) => c.trim()).filter(Boolean),
      tripCount: Number(tc.n),
      friendCount: await friends.countFriends(me(req)).catch(() => 0),
    };
  }));

  router.put("/me/visited", requireMobileAuth, route(async (req) => {
    const b = req.body || {};
    const codes = (Array.isArray(b.countries) ? b.countries : []).map((c) => countries.find((k) => k.code.toLowerCase() === String(c).toLowerCase())).filter(Boolean).map((k) => k.code);
    const allCities = new Set(countries.flatMap((k) => k.cities));
    const cities = (Array.isArray(b.cities) ? b.cities : []).map((c) => String(c).trim()).filter((c, i, a) => allCities.has(c) && a.indexOf(c) === i);
    await db.query("UPDATE tbl_users SET visitedCountries = ?, visitedCities = ? WHERE IDuser = ?", [[...new Set(codes)].join(","), cities.join(","), me(req)]);
    return { ok: true };
  }));

  router.post("/me/photo", requireMobileAuth, route(async (req) => {
    const file = req.files && (req.files.photo || req.files.profilePicture);
    if (!file) throw new BadRequest("Please choose a photo.");
    let photo;
    try { photo = await req.app.get("images").saveUpload(file, { width: 400, height: 400, prefix: "user" + me(req) + "_" }); }
    catch (e) { throw new BadRequest("That file isn't a photo we can use."); }
    await db.query("UPDATE tbl_users SET profilePictureUrl = ?, profilePictureAlt = ? WHERE IDuser = ?", [photo, "Profile picture", me(req)]);
    return { user: { id: me(req), username: req.mobileUser.username, email: req.mobileUser.email, profilePictureUrl: photo } };
  }));

  // Same as the website's Settings → Delete account.
  router.delete("/me", requireMobileAuth, route(async (req) => {
    if (!(req.body && req.body.confirm === true)) throw new BadRequest("Please confirm.");
    await db.query("DELETE FROM tbl_friendships WHERE requesterId = ? OR addresseeId = ?", [me(req), me(req)]).catch(() => {});
    await db.query("DELETE FROM tbl_users WHERE IDuser = ?", [me(req)]);
    return { ok: true };
  }));

  return router;
};

module.exports.HOURS = HOURS;
