// Bearer-token sign-in for the mobile app (shared by the /api/mobile routers
// and the chat socket).
const tokens = require("./tokens");

function tokenFromHeader(req) {
  const header = req.get("authorization") || "";
  return header.startsWith("Bearer ") ? header.slice(7) : "";
}

module.exports = function createMobileAuth(pool) {
  const db = pool.promise ? pool.promise() : pool;

  // The account behind an access token, or null.
  async function userForToken(token) {
    const payload = tokens.verify(String(token || ""), "access");
    if (!payload) return null;
    const [rows] = await db.query(
      "SELECT IDuser, username, email, profilePictureUrl FROM tbl_users WHERE IDuser = ? AND isConfirmed = 1 LIMIT 1",
      [payload.uid]
    );
    return rows[0] || null;
  }

  async function requireMobileAuth(req, res, next) {
    try {
      const user = await userForToken(tokenFromHeader(req));
      if (!user) return res.status(401).json({ error: "Please sign in again." });
      req.mobileUser = user;
      next();
    } catch (err) {
      console.error("Mobile auth lookup error:", err.message);
      res.status(500).json({ error: "Something went wrong. Please try again." });
    }
  }

  return { userForToken, requireMobileAuth };
};
