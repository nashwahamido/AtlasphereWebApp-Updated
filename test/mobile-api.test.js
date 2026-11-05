// Tests for the mobile JSON API (routes/mobile.js).
// Runs the real router, validation and bcrypt against an in-memory users table,
// and captures verification emails instead of sending them.
// Run with: npm test
const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const bcrypt = require("bcrypt");
const tokens = require("../config/tokens");
const createMobileRouter = require("../routes/mobile");

function makeFakeDb() {
  const users = [];
  let nextId = 1;
  const find = (fn) => users.find(fn);
  async function query(sql, p = []) {
    const s = sql.replace(/\s+/g, " ").trim();
    if (/^SELECT .* FROM tbl_users WHERE email = \? OR username = \?/.test(s)) return [users.filter((u) => u.email === p[0] || u.username === p[1]).slice(0, 1)];
    if (/^SELECT .* FROM tbl_users WHERE email = \?/.test(s)) return [users.filter((u) => u.email === p[0]).slice(0, 1)];
    if (/^SELECT .* FROM tbl_users WHERE IDuser = \?/.test(s)) return [users.filter((u) => u.IDuser === p[0]).slice(0, 1)];
    if (/^DELETE FROM tbl_users WHERE IDuser = \? AND isConfirmed = 0/.test(s)) {
      const i = users.findIndex((u) => u.IDuser === p[0] && u.isConfirmed === 0);
      if (i >= 0) users.splice(i, 1);
      return [{ affectedRows: i >= 0 ? 1 : 0 }];
    }
    if (/^INSERT INTO tbl_users/.test(s)) {
      const u = { IDuser: nextId++, username: p[0], email: p[1], phonenumber: p[2], password: p[3], FIDgender: p[4], verificationCode: p[5], isConfirmed: p[7], profilePictureUrl: "" };
      users.push(u);
      return [{ insertId: u.IDuser }];
    }
    if (/^UPDATE tbl_users SET verificationCode = \? WHERE IDuser = \?/.test(s)) { find((u) => u.IDuser === p[1]).verificationCode = p[0]; return [{}]; }
    if (/^UPDATE tbl_users SET isConfirmed = 1 WHERE IDuser = \?/.test(s)) { find((u) => u.IDuser === p[0]).isConfirmed = 1; return [{}]; }
    if (/^UPDATE tbl_users SET resetToken = \?/.test(s)) { const u = find((x) => x.IDuser === p[2]); u.resetToken = p[0]; return [{}]; }
    throw new Error("Unexpected SQL in test: " + s);
  }
  return { users, connection: { promise: () => ({ query }) } };
}

async function startApp() {
  const fake = makeFakeDb();
  const sent = [];
  const app = express();
  app.use(express.json());
  app.use(
    "/api/mobile",
    createMobileRouter({
      connection: fake.connection,
      bcrypt,
      generateCode: () => String(100000 + sent.length + 1),
      sendVerificationEmail: async (to, code) => { sent.push({ to, code }); return true; },
      sendEmail: async (msg) => { sent.push(msg); return true; },
    })
  );
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = "http://127.0.0.1:" + server.address().port + "/api/mobile";
  const call = async (method, path, body, token) => {
    const res = await fetch(base + path, {
      method,
      headers: Object.assign({ "Content-Type": "application/json" }, token ? { Authorization: "Bearer " + token } : {}),
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };
  return { call, sent, users: fake.users, close: () => server.close() };
}

const NEW_USER = { username: "nashwa", email: "nashwa@example.com", phone: "+353871234567", password: "secret12" };

test("full sign-up: register → verify → /me", async (t) => {
  const app = await startApp();
  t.after(app.close);

  const reg = await app.call("POST", "/auth/register", NEW_USER);
  assert.equal(reg.status, 201);
  assert.ok(reg.body.pendingToken);
  assert.equal(app.sent.length, 1);
  assert.equal(app.sent[0].to, NEW_USER.email);
  assert.notEqual(app.users[0].password, NEW_USER.password, "password must be hashed");

  const wrong = await app.call("POST", "/auth/verify", { pendingToken: reg.body.pendingToken, code: "999999" });
  assert.equal(wrong.status, 400);

  const ok = await app.call("POST", "/auth/verify", { pendingToken: reg.body.pendingToken, code: app.sent[0].code });
  assert.equal(ok.status, 200);
  assert.ok(ok.body.token);
  assert.equal(ok.body.user.email, NEW_USER.email);
  assert.equal(ok.body.user.password, undefined, "never return the password hash");

  const me = await app.call("GET", "/me", null, ok.body.token);
  assert.equal(me.status, 200);
  assert.equal(me.body.user.username, "nashwa");
});

test("login: right and wrong password, unknown user", async (t) => {
  const app = await startApp();
  t.after(app.close);
  const reg = await app.call("POST", "/auth/register", NEW_USER);
  await app.call("POST", "/auth/verify", { pendingToken: reg.body.pendingToken, code: app.sent[0].code });

  assert.equal((await app.call("POST", "/auth/login", { email: NEW_USER.email, password: "nope123" })).status, 401);
  assert.equal((await app.call("POST", "/auth/login", { email: "nobody@example.com", password: "secret12" })).status, 401);
  const ok = await app.call("POST", "/auth/login", { email: NEW_USER.email, password: NEW_USER.password });
  assert.equal(ok.status, 200);
  assert.ok(ok.body.token);
});

test("login with the stored hash itself does not work", async (t) => {
  const app = await startApp();
  t.after(app.close);
  const reg = await app.call("POST", "/auth/register", NEW_USER);
  await app.call("POST", "/auth/verify", { pendingToken: reg.body.pendingToken, code: app.sent[0].code });
  const res = await app.call("POST", "/auth/login", { email: NEW_USER.email, password: app.users[0].password });
  assert.equal(res.status, 401);
});

test("an unverified account gets a fresh code instead of a session", async (t) => {
  const app = await startApp();
  t.after(app.close);
  await app.call("POST", "/auth/register", NEW_USER);
  const res = await app.call("POST", "/auth/login", { email: NEW_USER.email, password: NEW_USER.password });
  assert.equal(res.status, 403);
  assert.equal(res.body.needsVerification, true);
  assert.ok(res.body.pendingToken);
  assert.equal(res.body.token, undefined);
  assert.equal(app.sent.length, 2, "a new code was emailed");
  const ok = await app.call("POST", "/auth/verify", { pendingToken: res.body.pendingToken, code: app.sent[1].code });
  assert.equal(ok.status, 200);
});

test("registering with a confirmed email is refused and does not touch the account", async (t) => {
  const app = await startApp();
  t.after(app.close);
  const reg = await app.call("POST", "/auth/register", NEW_USER);
  await app.call("POST", "/auth/verify", { pendingToken: reg.body.pendingToken, code: app.sent[0].code });
  const before = JSON.stringify(app.users);
  const again = await app.call("POST", "/auth/register", Object.assign({}, NEW_USER, { password: "other123" }));
  assert.equal(again.status, 409);
  assert.equal(JSON.stringify(app.users), before);
});

test("re-registering an unverified email replaces the leftover sign-up", async (t) => {
  const app = await startApp();
  t.after(app.close);
  await app.call("POST", "/auth/register", NEW_USER);
  const again = await app.call("POST", "/auth/register", NEW_USER);
  assert.equal(again.status, 201);
  assert.equal(app.users.length, 1);
});

test("validation messages", async (t) => {
  const app = await startApp();
  t.after(app.close);
  assert.match((await app.call("POST", "/auth/register", Object.assign({}, NEW_USER, { email: "bad" }))).body.error, /email/i);
  assert.match((await app.call("POST", "/auth/register", Object.assign({}, NEW_USER, { password: "123" }))).body.error, /6–12/);
  assert.match((await app.call("POST", "/auth/register", Object.assign({}, NEW_USER, { username: "ab" }))).body.error, /3–20/);
  assert.match((await app.call("POST", "/auth/login", { email: "", password: "" })).body.error, /required/i);
  assert.match((await app.call("POST", "/auth/verify", { pendingToken: "x", code: "12" })).body.error, /6-digit/);
});

test("tokens can't be forged or swapped", async (t) => {
  const app = await startApp();
  t.after(app.close);
  const reg = await app.call("POST", "/auth/register", NEW_USER);
  const ok = await app.call("POST", "/auth/verify", { pendingToken: reg.body.pendingToken, code: app.sent[0].code });

  const tampered = ok.body.token.slice(0, -2) + (ok.body.token.endsWith("AA") ? "BB" : "AA");
  assert.equal((await app.call("GET", "/me", null, tampered)).status, 401);
  assert.equal((await app.call("GET", "/me", null, reg.body.pendingToken)).status, 401, "pending token is not an access token");
  assert.equal((await app.call("GET", "/me")).status, 401);
  const forgedUser = tokens.sign({ typ: "access", uid: 1 }, -10);
  assert.equal((await app.call("GET", "/me", null, forgedUser)).status, 401, "expired access token");
});

test("expired sign-up code: verify says expired, resend issues a new one", async (t) => {
  const app = await startApp();
  t.after(app.close);
  await app.call("POST", "/auth/register", NEW_USER);
  const expired = tokens.sign({ typ: "pending", uid: app.users[0].IDuser, email: NEW_USER.email }, -60);
  const v = await app.call("POST", "/auth/verify", { pendingToken: expired, code: app.sent[0].code });
  assert.equal(v.status, 410);
  assert.equal(v.body.expired, true);
  const r = await app.call("POST", "/auth/resend", { pendingToken: expired });
  assert.equal(r.status, 200);
  const ok = await app.call("POST", "/auth/verify", { pendingToken: r.body.pendingToken, code: app.sent[app.sent.length - 1].code });
  assert.equal(ok.status, 200);
});

test("forgot password never reveals whether an email exists", async (t) => {
  const app = await startApp();
  t.after(app.close);
  const reg = await app.call("POST", "/auth/register", NEW_USER);
  await app.call("POST", "/auth/verify", { pendingToken: reg.body.pendingToken, code: app.sent[0].code });
  const known = await app.call("POST", "/auth/forgot-password", { email: NEW_USER.email });
  const unknown = await app.call("POST", "/auth/forgot-password", { email: "nobody@example.com" });
  assert.equal(known.status, 200);
  assert.deepEqual(known.body, unknown.body);
  assert.ok(app.users[0].resetToken, "reset token stored for the real account");
  assert.match(app.sent[app.sent.length - 1].html, /\/auth\/reset-password\?token=/);
});

test("unknown endpoints answer with JSON 404", async (t) => {
  const app = await startApp();
  t.after(app.close);
  const res = await app.call("GET", "/nope");
  assert.equal(res.status, 404);
  assert.ok(res.body.error);
});
