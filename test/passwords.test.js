// Tests for config/passwords.js (shared by the website and mobile logins).
const test = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcrypt");
const { verifyPassword, upgradeToHash, BCRYPT_HASH } = require("../config/passwords");

test("bcrypt-hashed accounts: right and wrong password", async () => {
  const hash = await bcrypt.hash("secret12", 10);
  assert.deepEqual(await verifyPassword("secret12", hash), { match: true, needsRehash: false });
  assert.deepEqual(await verifyPassword("wrong123", hash), { match: false, needsRehash: false });
});

test("typing the stored hash itself does not log in", async () => {
  const hash = await bcrypt.hash("secret12", 10);
  assert.equal((await verifyPassword(hash, hash)).match, false);
});

test("legacy plain-text accounts log in once and are flagged for upgrade", async () => {
  assert.deepEqual(await verifyPassword("oldpass1", "oldpass1"), { match: true, needsRehash: true });
  assert.deepEqual(await verifyPassword("nope", "oldpass1"), { match: false, needsRehash: false });
});

test("missing values never match", async () => {
  for (const [a, b] of [["", ""], [undefined, "x"], ["x", null], ["x", ""]]) {
    assert.equal((await verifyPassword(a, b)).match, false);
  }
});

test("upgradeToHash stores a bcrypt hash of the password", async () => {
  let saved;
  const connection = { promise: () => ({ query: async (sql, p) => { saved = { sql, p }; return [{}]; } }) };
  await upgradeToHash(connection, 7, "oldpass1");
  assert.match(saved.sql, /UPDATE tbl_users SET password = \? WHERE IDuser = \?/);
  assert.equal(saved.p[1], 7);
  assert.match(saved.p[0], BCRYPT_HASH);
  assert.equal(await bcrypt.compare("oldpass1", saved.p[0]), true);
});
