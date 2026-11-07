// Uploaded photos (profile and trip photos) are kept in the database, so they
// survive redeploys whatever the server's disk is. The uploads folder is only
// a cache: /uploads/<name> is served from disk when the file is there, and
// otherwise read from the database (and written back to disk for next time).
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const sharp = require("sharp");

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,180}$/;
const MAX_BACKFILL_BYTES = 8 * 1024 * 1024;

module.exports = function createImages(pool, uploadDir) {
  const db = pool.promise ? pool.promise() : pool;

  async function ensureSchema() {
    await db.query(
      "CREATE TABLE IF NOT EXISTS tbl_images (" +
      "name VARCHAR(191) NOT NULL PRIMARY KEY, " +
      "mime VARCHAR(64) NOT NULL, " +
      "data MEDIUMBLOB NOT NULL, " +
      "createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP)"
    );
  }

  function writeCache(name, buffer) {
    try { fs.writeFileSync(path.join(uploadDir, name), buffer); }
    catch (e) { console.error("Upload cache write failed:", e.message); }
  }

  // Resize an uploaded image to a JPEG and store it. Returns "/uploads/<name>".
  async function saveUpload(file, opts) {
    const buffer = await sharp(file.data)
      .rotate() // respect the phone's orientation
      .resize(opts.width, opts.height, { fit: "cover", position: "centre" })
      .jpeg({ quality: 85 })
      .toBuffer();
    const base = String(file.name || "photo").replace(/\.[^.]*$/, "").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40) || "photo";
    const name = (opts.prefix || "") + Date.now() + "_" + crypto.randomBytes(4).toString("hex") + "_" + base + ".jpg";
    await db.query(
      "INSERT INTO tbl_images (name, mime, data) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE mime = VALUES(mime), data = VALUES(data)",
      [name, "image/jpeg", buffer]
    );
    writeCache(name, buffer);
    return "/uploads/" + name;
  }

  // Express handler for /uploads/:name when the file isn't on disk.
  async function serve(req, res, next) {
    const name = req.params.name;
    if (!NAME_RE.test(name)) return next();
    try {
      const [rows] = await db.query("SELECT mime, data FROM tbl_images WHERE name = ? LIMIT 1", [name]);
      if (!rows.length) return next();
      writeCache(name, rows[0].data);
      res.set("Content-Type", rows[0].mime);
      res.set("Cache-Control", "public, max-age=31536000, immutable");
      res.set("X-Content-Type-Options", "nosniff");
      res.send(rows[0].data);
    } catch (err) {
      console.error("Image load failed:", err.message);
      next();
    }
  }

  // Copy photos that only exist on disk (uploaded before this change) into
  // the database, so they're kept from now on. Very large originals are
  // shrunk first.
  async function backfill(extraDirs) {
    const dirs = [uploadDir].concat(extraDirs || []).filter((d, i, a) => d && a.indexOf(d) === i);
    const [rows] = await db.query("SELECT name FROM tbl_images");
    const have = new Set(rows.map((r) => r.name));
    let added = 0;
    for (const dir of dirs) {
      let names;
      try { names = fs.readdirSync(dir); } catch (e) { continue; }
      for (const n of names) {
        if (have.has(n) || !NAME_RE.test(n) || !/\.(jpe?g|png|webp|gif)$/i.test(n)) continue;
        try {
          const full = path.join(dir, n);
          const stat = fs.statSync(full);
          if (!stat.isFile()) continue;
          let data = fs.readFileSync(full);
          const ext = n.split(".").pop().toLowerCase();
          let mime = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : ext === "gif" ? "image/gif" : "image/jpeg";
          if (stat.size > MAX_BACKFILL_BYTES) {
            data = await sharp(data, { limitInputPixels: false }).rotate().resize(1600, 1600, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
            mime = "image/jpeg";
          }
          await db.query("INSERT IGNORE INTO tbl_images (name, mime, data) VALUES (?, ?, ?)", [n, mime, data]);
          have.add(n);
          added += 1;
        } catch (e) {
          console.error("Backfill failed for " + n + ":", e.message);
        }
      }
    }
    return added;
  }

  return { ensureSchema, saveUpload, serve, backfill };
};
