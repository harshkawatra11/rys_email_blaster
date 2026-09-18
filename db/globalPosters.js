const { query } = require("./pool");
const settingsDb = require("./settings");

function genId() {
  return "gp_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// Postgres folds unquoted column aliases to lowercase, so we select
// snake_case and map to camelCase in JS instead of relying on aliases.
function toCamel(row) {
  if (!row) return null;
  return {
    id: row.id,
    kind: row.kind,
    position: row.position,
    link: row.link || "",
    hasImage: !!row.has_image,
    imageMime: row.image_mime || null,
    imageName: row.image_name || null,
    imageSize: row.image_size || null,
  };
}

async function nextPosition() {
  const [rows] = await query("SELECT COALESCE(MAX(position), 0) AS max_pos FROM global_posters");
  return (rows[0]?.max_pos || 0) + 1;
}

// Metadata only — excludes image_base64 so listing/loading the settings
// page never pulls image bytes across the wire for every item at once.
async function listGlobalPosters() {
  const [rows] = await query(
    `SELECT id, kind, position, link, image_mime, image_name, image_size,
            (image_base64 IS NOT NULL) AS has_image
     FROM global_posters ORDER BY position ASC, id ASC`
  );
  return rows.map(toCamel);
}

async function getGlobalPosterImage(id) {
  const [rows] = await query(
    "SELECT image_base64, image_mime, image_name FROM global_posters WHERE id = ? AND kind = 'image'",
    [id]
  );
  const row = rows[0];
  if (!row || !row.image_base64) return null;
  return { base64: row.image_base64, mimeType: row.image_mime, filename: row.image_name };
}

// Bytes for every item, sorted images-first-then-links (each ascending by
// position) — images are guaranteed-present bytes, while Drive links can
// fail to fetch, so a failure only trims the tail of the poster stack
// instead of leaving a hole in the middle of it. Used once per /api/send.
async function getGlobalPosterPayload() {
  const [rows] = await query(
    `SELECT id, kind, position, link, image_base64, image_mime, image_name
     FROM global_posters ORDER BY position ASC, id ASC`
  );
  const images = rows.filter((r) => r.kind === "image");
  const links = rows.filter((r) => r.kind === "link");
  return [...images, ...links].map((r) => ({
    id: r.id,
    kind: r.kind,
    link: r.link || "",
    imageBase64: r.image_base64 || null,
    imageMime: r.image_mime || null,
    imageName: r.image_name || null,
  }));
}

async function countGlobalPosters() {
  const [rows] = await query("SELECT COUNT(*) AS n FROM global_posters");
  return Number(rows[0]?.n || 0);
}

async function addGlobalPosterImage({ base64, mimeType, filename, size }) {
  const id = genId();
  const position = await nextPosition();
  await query(
    `INSERT INTO global_posters (id, kind, position, image_base64, image_mime, image_name, image_size)
     VALUES (?, 'image', ?, ?, ?, ?, ?)`,
    [id, position, base64, mimeType, filename, size]
  );
  return { id, kind: "image", position, imageName: filename, imageMime: mimeType, imageSize: size };
}

async function addGlobalPosterLink(link) {
  const id = genId();
  const position = await nextPosition();
  await query(
    `INSERT INTO global_posters (id, kind, position, link) VALUES (?, 'link', ?, ?)`,
    [id, position, link]
  );
  return { id, kind: "link", position, link };
}

async function updateGlobalPosterLink(id, link) {
  const [result] = await query(
    "UPDATE global_posters SET link = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND kind = 'link'",
    [link, id]
  );
  return result;
}

async function removeGlobalPoster(id) {
  await query("DELETE FROM global_posters WHERE id = ?", [id]);
}

// One-time migration: if the list table is already empty, copy whatever
// single poster/link was configured under the old app_settings model into
// it, then clear the legacy columns. Self-idempotent — nothing is left to
// copy after the first successful run, so re-running it on every boot is
// safe (it just becomes a no-op once global_posters is non-empty).
async function migrateLegacySinglePoster() {
  const existing = await countGlobalPosters();
  if (existing > 0) return;

  const storedImage = await settingsDb.getPosterImage();
  if (storedImage) {
    await addGlobalPosterImage({
      base64: storedImage.base64,
      mimeType: storedImage.mimeType,
      filename: storedImage.filename,
      size: Buffer.byteLength(storedImage.base64, "base64"),
    });
  } else {
    const settings = await settingsDb.getSettings();
    if (settings?.posterLink) {
      await addGlobalPosterLink(settings.posterLink);
    }
  }
  await settingsDb.clearLegacyPoster();
}

module.exports = {
  listGlobalPosters,
  getGlobalPosterImage,
  getGlobalPosterPayload,
  countGlobalPosters,
  addGlobalPosterImage,
  addGlobalPosterLink,
  updateGlobalPosterLink,
  removeGlobalPoster,
  migrateLegacySinglePoster,
};
