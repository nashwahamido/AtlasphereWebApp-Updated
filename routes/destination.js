// JSON for the Destination tab and the planning hints on the itinerary and
// recommendations:
//   GET /api/destination/:groupId          weather, local time, holidays per trip day
//   GET /api/destination/:groupId/places   closures and estimated crowds
// Both use the group's saved trip dates; ?start=YYYY-MM-DD&end=YYYY-MM-DD
// overrides them (the itinerary sends its live selection).
const express = require("express");
const createDestination = require("../services/destination");
const { tripFromItinerary, parseIso } = require("../services/destination").helpers;

const MAX_DAYS = 60;

module.exports = function createDestinationRouter(connection, opts) {
  const router = express.Router();
  const db = connection.promise();
  const destination = (opts && opts.destination) || createDestination();

  function requireAuth(req, res, next) {
    if (!req.session || !req.session.user) return res.status(401).json({ error: "Please log in." });
    next();
  }

  // The group, if the signed-in person belongs to it.
  async function loadGroup(req) {
    const userId = req.session.user.id;
    const [rows] = await db.query(
      `SELECT g.id, g.name, g.destination, g.flag, g.cities, g.days
         FROM tbl_groups g
        WHERE g.id = ? AND (g.createdBy = ? OR EXISTS (SELECT 1 FROM tbl_group_members m WHERE m.groupId = g.id AND m.userId = ?))`,
      [req.params.groupId, userId, userId]
    );
    return rows[0] || null;
  }

  async function tripFor(req, group) {
    const start = parseIso(req.query.start);
    const end = parseIso(req.query.end);
    if (start && end && end >= start && (end - start) / 86400000 < MAX_DAYS) {
      return { start: req.query.start, end: req.query.end };
    }
    try {
      const [rows] = await db.query("SELECT rangeStart, rangeEnd, calYear, calMonth FROM tbl_itinerary_dates WHERE groupId = ?", [group.id]);
      return tripFromItinerary(rows[0]);
    } catch (e) {
      return null; // table not created yet
    }
  }

  function handler(fn) {
    return async (req, res) => {
      try {
        const group = await loadGroup(req);
        if (!group) return res.status(404).json({ error: "Group not found." });
        const trip = await tripFor(req, group);
        res.set("Cache-Control", "no-store"); // trip dates can change at any time
        res.json(await fn(group, trip));
      } catch (err) {
        console.error("Destination info failed:", err.message);
        res.status(500).json({ error: "Couldn't load destination info right now." });
      }
    };
  }

  router.get("/api/destination/:groupId", requireAuth, handler((group, trip) => destination.overview(group, trip)));
  router.get("/api/destination/:groupId/places", requireAuth, handler((group, trip) => destination.placesInfo(group, trip)));

  return router;
};
