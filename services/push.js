// Push notifications to the mobile app, through Expo's push service.
//
// The app registers its Expo push token (POST /api/mobile/me/push-token).
// We then send a push for:
//   - every row added to tbl_notifications (votes, invites, joins, …), picked
//     up by a small poller, so no call site needs to know about push;
//   - friend requests and acceptances (services/friends.js);
//   - chat messages, to trip members who don't have the chat open, at most
//     one per trip per person every couple of minutes.
// Optional env: EXPO_ACCESS_TOKEN (only if "enhanced push security" is on in
// the Expo project).
const axios = require("axios");

const EXPO_URL = "https://exp.host/--/api/v2/push/send";
const TOKEN_RE = /^Expo(nent)?PushToken\[[A-Za-z0-9_-]{10,200}\]$/;

let db = null;
const lastSent = new Map(); // throttle key -> time

function init(pool) {
  db = pool.promise ? pool.promise() : pool;
}

async function ensureTable() {
  await db.query(
    "CREATE TABLE IF NOT EXISTS tbl_push_tokens (" +
      "token VARCHAR(255) NOT NULL PRIMARY KEY, " +
      "userId INT NOT NULL, " +
      "platform VARCHAR(16) NULL, " +
      "createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP, " +
      "updatedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, " +
      "KEY idx_push_user (userId))"
  );
}

const isToken = (t) => typeof t === "string" && TOKEN_RE.test(t);

// A phone has one token; if someone else signs in on it, it moves to them.
async function saveToken(userId, token, platform) {
  if (!db || !isToken(token)) return false;
  await db.query(
    "INSERT INTO tbl_push_tokens (token, userId, platform) VALUES (?, ?, ?) " +
      "ON DUPLICATE KEY UPDATE userId = VALUES(userId), platform = VALUES(platform), updatedAt = NOW()",
    [token, userId, String(platform || "").slice(0, 16) || null]
  );
  return true;
}

async function removeToken(userId, token) {
  if (!db) return;
  await db.query("DELETE FROM tbl_push_tokens WHERE token = ? AND userId = ?", [String(token || ""), userId]);
}

async function removeUser(userId) {
  if (!db) return;
  await db.query("DELETE FROM tbl_push_tokens WHERE userId = ?", [userId]);
}

// Skip people who got a push with the same key within `ms`.
function throttled(key, ms) {
  if (!key || !ms) return false;
  const now = Date.now();
  const t = lastSent.get(key);
  if (t && now - t < ms) return true;
  lastSent.set(key, now);
  if (lastSent.size > 5000) {
    for (const [k, v] of lastSent) if (now - v > 60 * 60 * 1000) lastSent.delete(k);
  }
  return false;
}

// Send one notification to some users (all their phones). Never throws.
async function sendToUsers(userIds, msg) {
  try {
    if (!db) return 0;
    let ids = [...new Set((userIds || []).map(Number).filter(Boolean))];
    if (msg.throttleKey) ids = ids.filter((id) => !throttled(msg.throttleKey + ":" + id, msg.throttleMs));
    if (!ids.length) return 0;
    const [rows] = await db.query("SELECT token FROM tbl_push_tokens WHERE userId IN (?)", [ids]);
    if (!rows.length) return 0;
    const messages = rows.map((r) => ({
      to: r.token,
      title: String(msg.title || "Atlasphere").slice(0, 100),
      body: String(msg.body || "").slice(0, 300),
      data: msg.data || {},
      sound: "default",
      channelId: "default",
    }));
    const headers = { "Content-Type": "application/json", Accept: "application/json" };
    if (process.env.EXPO_ACCESS_TOKEN) headers.Authorization = "Bearer " + process.env.EXPO_ACCESS_TOKEN.trim();
    for (let i = 0; i < messages.length; i += 100) {
      const chunk = messages.slice(i, i + 100);
      const res = await axios.post(EXPO_URL, chunk, { headers, timeout: 10000 });
      const tickets = (res.data && res.data.data) || [];
      // Phones that uninstalled the app or turned notifications off.
      const dead = chunk.filter((m, j) => tickets[j] && tickets[j].status === "error" &&
        tickets[j].details && tickets[j].details.error === "DeviceNotRegistered").map((m) => m.to);
      if (dead.length) await db.query("DELETE FROM tbl_push_tokens WHERE token IN (?)", [dead]);
    }
    return messages.length;
  } catch (err) {
    console.error("Push error:", err.response ? JSON.stringify(err.response.data).slice(0, 300) : err.message);
    return 0;
  }
}

// ── Notifications table → push ──────────────────────────────────────────
let pollTimer = null;
function startNotificationPoller(intervalMs) {
  if (!db || pollTimer) return;
  let lastId = null;
  let busy = false;
  async function tick() {
    if (busy) return;
    busy = true;
    try {
      if (lastId === null) {
        // Start from now: nothing older is pushed after a restart.
        const [r] = await db.query("SELECT COALESCE(MAX(id), 0) AS id FROM tbl_notifications");
        lastId = Number(r[0].id) || 0;
        return;
      }
      const [rows] = await db.query(
        "SELECT id, userId, groupId, groupName, message, type FROM tbl_notifications WHERE id > ? ORDER BY id LIMIT 200",
        [lastId]
      );
      for (const n of rows) {
        lastId = Math.max(lastId, Number(n.id));
        await sendToUsers([n.userId], {
          title: n.groupName || "Atlasphere",
          body: n.message || "",
          data: { type: n.type || "", groupId: n.groupId ? String(n.groupId) : null },
        });
      }
    } catch (err) {
      console.error("Push poller error:", err.message);
    } finally {
      busy = false;
    }
  }
  pollTimer = setInterval(tick, intervalMs || 8000);
  if (pollTimer.unref) pollTimer.unref();
  tick();
}

module.exports = { init, ensureTable, saveToken, removeToken, removeUser, sendToUsers, startNotificationPoller, isToken };
