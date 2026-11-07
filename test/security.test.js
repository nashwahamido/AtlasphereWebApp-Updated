const test = require("node:test");
const assert = require("node:assert/strict");
const { escapeHtml, siteBase, generateCode, createLimiter, createMembership } = require("../config/security");

test("escapeHtml neutralises markup in names", () => {
  assert.equal(escapeHtml('<a href="x">Bob</a> & \'co\''), "&lt;a href=&quot;x&quot;&gt;Bob&lt;/a&gt; &amp; &#39;co&#39;");
  assert.equal(escapeHtml(null), "");
});

test("siteBase never trusts the Host header on the live site", () => {
  const req = { protocol: "https", get: () => "evil.test" };
  const saved = { ...process.env };
  try {
    delete process.env.SITE_URL; delete process.env.RAILWAY_PUBLIC_DOMAIN; delete process.env.RAILWAY_ENVIRONMENT; delete process.env.NODE_ENV;
    assert.equal(siteBase(req), "https://evil.test"); // local development only
    process.env.RAILWAY_ENVIRONMENT = "production";
    assert.equal(siteBase(req), "https://atlasphere.up.railway.app");
    process.env.RAILWAY_PUBLIC_DOMAIN = "atlasphere.up.railway.app";
    assert.equal(siteBase(req), "https://atlasphere.up.railway.app");
    process.env.SITE_URL = "https://atlasphere.app/";
    assert.equal(siteBase(req), "https://atlasphere.app");
  } finally {
    process.env = saved;
  }
});

test("verification codes are 6 digits", () => {
  for (let i = 0; i < 200; i++) assert.match(generateCode(), /^\d{6}$/);
});

test("rate limiter blocks after the limit and per key", () => {
  const limit = createLimiter({ name: "t", windowMs: 60000, max: 3 });
  assert.equal(limit.take("a"), 0); assert.equal(limit.take("a"), 0); assert.equal(limit.take("a"), 0);
  assert.ok(limit.take("a") > 0);
  assert.equal(limit.take("b"), 0);
  limit.reset("a");
  assert.equal(limit.take("a"), 0);
});

test("membership: members and creators only", async () => {
  const rows = { "1:10": true, "2:10": false };
  const fakePool = { query: async (sql, params) => [rows[params[1] + ":" + params[0]] || (params[3] === 3 && params[2] === 10) ? [{ 1: 1 }] : []] };
  const { isMember, requireMember } = createMembership(fakePool);
  assert.equal(await isMember(1, 10), true);
  assert.equal(await isMember(2, 10), false);
  assert.equal(await isMember(3, 10), true); // creator
  assert.equal(await isMember(1, ""), false);

  const run = (user, query) => new Promise((resolve) => {
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { resolve({ status: this.statusCode, body: b }); }, redirect(u) { resolve({ redirect: u }); } };
    requireMember()({ session: { user }, params: {}, body: {}, query }, res, () => resolve({ next: true }));
  });
  assert.deepEqual(await run({ id: 1 }, { groupId: 10 }), { next: true });
  assert.equal((await run({ id: 2 }, { groupId: 10 })).status, 403);
  assert.equal((await run(null, { groupId: 10 })).status, 401);
  assert.equal((await run({ id: 1 }, {})).status, 400);
});
