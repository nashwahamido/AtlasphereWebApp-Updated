// Friends service against a real MySQL/MariaDB database.
// Runs only when TEST_DATABASE_URL points at a database whose name ends in
// "_test" (it drops and recreates tables), e.g.
//   TEST_DATABASE_URL=mysql://user:pass@localhost/atlas_test npm test
const test = require("node:test");
const assert = require("node:assert/strict");
const mysql = require("mysql2");
const createFriends = require("../services/friends");

const URL_ENV = process.env.TEST_DATABASE_URL || "";
const dbName = URL_ENV ? new URL(URL_ENV).pathname.slice(1) : "";
const enabled = !!URL_ENV && /_test$/.test(dbName);

test("friends service (real database)", { skip: enabled ? false : "set TEST_DATABASE_URL to a *_test database to run" }, async (t) => {
  const pool = mysql.createPool({ uri: URL_ENV, multipleStatements: true });
  const db = pool.promise();
  t.after(() => pool.end());

  await db.query(`
    DROP TABLE IF EXISTS tbl_friendships, tbl_group_members, tbl_groups, tbl_users;
    CREATE TABLE tbl_users (IDuser INT AUTO_INCREMENT PRIMARY KEY, username VARCHAR(255), email VARCHAR(255),
      isConfirmed TINYINT(1) DEFAULT 0, profilePictureUrl VARCHAR(1024), visitedCountries TEXT, visitedCities TEXT);
    CREATE TABLE tbl_groups (id BIGINT PRIMARY KEY, name VARCHAR(255), destination VARCHAR(255));
    CREATE TABLE tbl_group_members (groupId BIGINT, userId INT);
    INSERT INTO tbl_users (IDuser, username, email, isConfirmed, visitedCountries, visitedCities) VALUES
      (1, 'Alice', 'alice@example.com', 1, 'IE,FR', 'Dublin,Paris'),
      (2, 'Bob', 'bob@example.com', 1, 'JP', 'Tokyo'),
      (3, 'Cara 100%', 'cara@example.com', 1, '', ''),
      (4, 'Alicia (unverified)', 'alicia@example.com', 0, '', '');
    INSERT INTO tbl_groups VALUES (1700000000000, 'Japan', 'Kyoto'), (1700000000001, 'Italy', 'Rome');
    INSERT INTO tbl_group_members VALUES (1700000000000, 2), (1700000000001, 2);
  `);
  const friends = createFriends(db);
  await friends.ensureSchema();
  await friends.ensureSchema(); // safe to run on every start

  await t.test("search: by name and exact email, never yourself or unverified people", async () => {
    const r = await friends.search(1, "ali");
    assert.deepEqual(r.map((p) => p.username), [], "only Alice (me) and an unverified Alicia match");
    assert.deepEqual((await friends.search(1, "bo")).map((p) => [p.username, p.relationship]), [["Bob", "none"]]);
    assert.deepEqual((await friends.search(1, "bob@example.com")).map((p) => p.id), [2]);
    assert.deepEqual(await friends.search(1, "bob@example"), [], "partial emails don't search by email");
    assert.equal((await friends.search(1, "b")).length, 0, "needs 2+ characters");
    assert.deepEqual((await friends.search(1, "100%")).map((p) => p.username), ["Cara 100%"], "% is literal");
    assert.deepEqual(await friends.search(1, "%"), [], "a bare % is not a wildcard");
    assert.equal((await friends.search(1, "bob"))[0].email, undefined, "emails are never returned");
  });

  await t.test("request → accept", async () => {
    assert.equal(await friends.sendRequest(1, 2), "outgoing");
    assert.equal(await friends.sendRequest(1, 2), "outgoing", "asking twice is harmless");
    assert.equal(await friends.relationship(2, 1), "incoming");
    assert.deepEqual((await friends.listRequests(2)).incoming.map((p) => p.username), ["Alice"]);
    assert.deepEqual((await friends.listRequests(1)).outgoing.map((p) => p.username), ["Bob"]);
    assert.equal(await friends.unseenCount(2), 1, "Bob has an unseen request");
    const bobNotes = await friends.notifications(2);
    assert.equal(bobNotes[0].type, "friend-request");
    assert.equal(bobNotes[0].link, "/friends");
    assert.equal(await friends.accept(2, 1), "friends");
    assert.equal(await friends.relationship(1, 2), "friends");
    assert.deepEqual((await friends.listFriends(1)).map((p) => p.username), ["Bob"]);
    assert.deepEqual((await friends.listFriends(2)).map((p) => p.username), ["Alice"]);
    assert.equal(await friends.countFriends(1), 1);
    const aliceNotes = await friends.notifications(1);
    assert.equal(aliceNotes[0].type, "friend-accepted");
    assert.equal(aliceNotes[0].link, "/people/2");
    assert.equal(await friends.unseenCount(1), 1);
    await friends.markSeen(1);
    assert.equal(await friends.unseenCount(1), 0);
    assert.equal((await friends.notifications(1))[0].isRead, 1);
    const [rows] = await db.query("SELECT COUNT(*) n FROM tbl_friendships");
    assert.equal(Number(rows[0].n), 1, "one row per pair");
  });

  await t.test("profiles: details only for friends and yourself", async () => {
    const asFriend = await friends.profile(1, 2);
    assert.equal(asFriend.canSeeDetails, true);
    assert.deepEqual(asFriend.visitedCountries.map((c) => c.code), ["JP"]);
    assert.deepEqual(asFriend.visitedCities, ["Tokyo"]);
    assert.deepEqual(asFriend.planningCountries.map((c) => c.name).sort(), ["Italy", "Japan"]);
    assert.equal(asFriend.tripCount, 2);
    assert.equal(asFriend.friendCount, 1);
    const asStranger = await friends.profile(3, 2);
    assert.equal(asStranger.relationship, "none");
    assert.equal(asStranger.canSeeDetails, false);
    assert.equal(asStranger.visitedCountries, undefined, "no travel details for non-friends");
    assert.equal(asStranger.friendCount, 1);
    assert.equal((await friends.profile(1, 1)).relationship, "self");
    await assert.rejects(friends.profile(1, 4), /couldn't find/, "unverified accounts have no profile");
    await assert.rejects(friends.profile(1, 999), /couldn't find/);
    await assert.rejects(friends.profile(1, "abc"), /couldn't find/);
  });

  await t.test("decline, cancel and unfriend all allow asking again", async () => {
    assert.equal(await friends.sendRequest(3, 1), "outgoing");
    assert.equal(await friends.decline(1, 3), "none");
    assert.equal(await friends.relationship(3, 1), "none");
    assert.equal(await friends.sendRequest(3, 1), "outgoing", "can ask again after a decline");
    assert.equal(await friends.cancel(3, 1), "none");
    assert.equal(await friends.cancel(1, 3), "none", "the other person can't 'cancel' it for you");
    assert.equal(await friends.unfriend(1, 2), "none");
    assert.deepEqual(await friends.listFriends(1), []);
  });

  await t.test("asking someone who already asked you makes you friends", async () => {
    assert.equal(await friends.sendRequest(2, 3), "outgoing");
    assert.equal(await friends.sendRequest(3, 2), "friends");
  });

  await t.test("only the recipient can accept or decline", async () => {
    await friends.sendRequest(1, 3);
    await assert.rejects(friends.accept(1, 3), /no longer available/, "the sender can't accept their own request");
    assert.equal(await friends.decline(1, 3), "outgoing", "the sender can't decline it either");
    assert.equal(await friends.relationship(3, 1), "incoming");
  });

  await t.test("bad input", async () => {
    await assert.rejects(friends.sendRequest(1, 1), /yourself/);
    await assert.rejects(friends.sendRequest(1, 4), /couldn't find/, "can't add unverified accounts");
    await assert.rejects(friends.sendRequest(1, 999), /couldn't find/);
    await assert.rejects(friends.sendRequest(1, "1 OR 1=1"), /couldn't find/);
  });

  await t.test("two people asking each other at the same moment end up with one row", async () => {
    await db.query("DELETE FROM tbl_friendships");
    const results = await Promise.all([friends.sendRequest(1, 2), friends.sendRequest(2, 1)]);
    const [rows] = await db.query("SELECT COUNT(*) n FROM tbl_friendships WHERE pairKey = '1:2'");
    assert.equal(Number(rows[0].n), 1);
    assert.ok(results.every((r) => ["outgoing", "incoming", "friends"].includes(r)), JSON.stringify(results));
  });

  await t.test("deleting an account removes its friendships", async () => {
    await friends.removeAllFor(1);
    const [rows] = await db.query("SELECT COUNT(*) n FROM tbl_friendships WHERE requesterId = 1 OR addresseeId = 1");
    assert.equal(Number(rows[0].n), 0);
  });
});
