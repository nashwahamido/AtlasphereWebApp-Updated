// Password checking shared by the website and mobile logins.
//
// Normal accounts store a bcrypt hash and are checked with bcrypt only, so
// typing the stored hash itself never logs anyone in.
// Some older accounts stored the password as plain text. Those still log in
// (compared in constant time), and the caller then replaces the plain text
// with a bcrypt hash, so each one upgrades itself on its next login.
const crypto = require("crypto");
const bcrypt = require("bcrypt");

const BCRYPT_HASH = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;

async function verifyPassword(entered, stored) {
  if (typeof entered !== "string" || !entered || typeof stored !== "string" || !stored) {
    return { match: false, needsRehash: false };
  }
  if (BCRYPT_HASH.test(stored)) {
    try {
      return { match: await bcrypt.compare(entered, stored), needsRehash: false };
    } catch (e) {
      return { match: false, needsRehash: false };
    }
  }
  const a = Buffer.from(entered);
  const b = Buffer.from(stored);
  const match = a.length === b.length && crypto.timingSafeEqual(a, b);
  return { match, needsRehash: match };
}

async function upgradeToHash(connection, userId, password) {
  const hash = await bcrypt.hash(password, 10);
  await connection.promise().query("UPDATE tbl_users SET password = ? WHERE IDuser = ?", [hash, userId]);
}

module.exports = { verifyPassword, upgradeToHash, BCRYPT_HASH };
