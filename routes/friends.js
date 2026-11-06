// Website pages for friends: /friends (search, requests, friends list) and
// /people/:id (someone's profile). Actions are plain form POSTs that redirect
// back, so they work without any client-side JavaScript.
const express = require("express");
const createFriends = require("../services/friends");
const { FriendError } = require("../services/friends");

module.exports = function createFriendsRouter(connection) {
  const router = express.Router();
  const friends = createFriends(connection.promise());

  function requireAuth(req, res, next) {
    if (!req.session.user) return res.redirect("/auth/login");
    next();
  }

  // Only same-site paths, so a crafted form can't bounce people elsewhere.
  function safeNext(value, fallback) {
    const v = String(value || "");
    return v.startsWith("/") && !v.startsWith("//") && !v.includes("\\") ? v : fallback;
  }

  router.get("/friends", requireAuth, async (req, res, next) => {
    const me = req.session.user.id;
    const q = String(req.query.q || "").trim();
    try {
      const [list, requests, results] = await Promise.all([
        friends.listFriends(me),
        friends.listRequests(me),
        q ? friends.search(me, q) : Promise.resolve(null),
      ]);
      res.render("friends", {
        title: "Friends",
        user: req.session.user,
        friends: list,
        incoming: requests.incoming,
        outgoing: requests.outgoing,
        q,
        results,
        flash: req.query.msg || null,
      });
    } catch (err) {
      next(err);
    }
  });

  router.get("/people/:id", requireAuth, async (req, res, next) => {
    const me = req.session.user.id;
    if (String(req.params.id) === String(me)) return res.redirect("/profile");
    try {
      const person = await friends.profile(me, req.params.id);
      res.render("person", { title: person.username, user: req.session.user, person, flash: req.query.msg || null });
    } catch (err) {
      if (err instanceof FriendError && err.status === 404) {
        return res.status(404).render("error", { user: req.session.user, message: "We couldn't find that person.", error: null, title: "Not found" });
      }
      next(err);
    }
  });

  const ACTIONS = {
    request: { run: (me, id) => friends.sendRequest(me, id) },
    accept: { run: (me, id) => friends.accept(me, id) },
    decline: { run: (me, id) => friends.decline(me, id) },
    cancel: { run: (me, id) => friends.cancel(me, id) },
    remove: { run: (me, id) => friends.unfriend(me, id) },
  };

  router.post("/friends/:id/:action", requireAuth, async (req, res, next) => {
    const action = ACTIONS[req.params.action];
    if (!action) return res.status(404).send("Not found");
    const back = safeNext(req.body.next, "/friends");
    try {
      await action.run(req.session.user.id, req.params.id);
      res.redirect(back);
    } catch (err) {
      if (err instanceof FriendError) {
        const sep = back.includes("?") ? "&" : "?";
        return res.redirect(back + sep + "msg=" + encodeURIComponent(err.message));
      }
      next(err);
    }
  });

  return router;
};
