const { query, isPg } = require("./pool");

const SETTINGS_ID = "default";

// Postgres folds unquoted column aliases to lowercase, so we select snake_case
// and map to camelCase in JS instead of relying on "AS messageTemplate" aliases.
function toCamel(row) {
  if (!row) return null;
  return {
    messageTemplate: row.message_template || "",
    posterLink: row.poster_link || "",
    hasPosterImage: !!row.has_poster_image,
    posterImageName: row.poster_image_name || null,
    posterImageMime: row.poster_image_mime || null,
    posterImageSize: row.poster_image_size || null,
  };
}

// Deliberately excludes poster_image_base64 — this is called on every page
// load and every /api/send, and pulling a multi-MB blob into each of those
// reads would be wasteful. Use getPosterImage() when the bytes are needed.
async function getSettings() {
  const [rows] = await query(
    `SELECT message_template, poster_link, poster_image_name, poster_image_mime, poster_image_size,
            (poster_image_base64 IS NOT NULL) AS has_poster_image
     FROM app_settings WHERE id = ?`,
    [SETTINGS_ID]
  );
  return toCamel(rows[0]);
}

async function saveSettings({ messageTemplate, posterLink }) {
  const sql = isPg
    ? `INSERT INTO app_settings (id, message_template, poster_link)
       VALUES (?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET message_template = EXCLUDED.message_template,
                                       poster_link = EXCLUDED.poster_link,
                                       updated_at = CURRENT_TIMESTAMP`
    : `INSERT INTO app_settings (id, message_template, poster_link)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE message_template = VALUES(message_template),
                                poster_link = VALUES(poster_link),
                                updated_at = CURRENT_TIMESTAMP`;
  await query(sql, [SETTINGS_ID, messageTemplate, posterLink || null]);
}

// Uploading an image and setting a Drive link are mutually exclusive —
// uploading clears any stored link so the two sources can't conflict.
async function setPosterImage({ base64, mimeType, filename, size }) {
  const sql = isPg
    ? `INSERT INTO app_settings (id, poster_link, poster_image_base64, poster_image_mime, poster_image_name, poster_image_size)
       VALUES (?, NULL, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET poster_link = NULL,
                                       poster_image_base64 = EXCLUDED.poster_image_base64,
                                       poster_image_mime = EXCLUDED.poster_image_mime,
                                       poster_image_name = EXCLUDED.poster_image_name,
                                       poster_image_size = EXCLUDED.poster_image_size,
                                       updated_at = CURRENT_TIMESTAMP`
    : `INSERT INTO app_settings (id, poster_link, poster_image_base64, poster_image_mime, poster_image_name, poster_image_size)
       VALUES (?, NULL, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE poster_link = NULL,
                                poster_image_base64 = VALUES(poster_image_base64),
                                poster_image_mime = VALUES(poster_image_mime),
                                poster_image_name = VALUES(poster_image_name),
                                poster_image_size = VALUES(poster_image_size),
                                updated_at = CURRENT_TIMESTAMP`;
  await query(sql, [SETTINGS_ID, base64, mimeType, filename, size]);
}

async function clearPosterImage() {
  await query(
    `UPDATE app_settings SET poster_image_base64 = NULL, poster_image_mime = NULL,
                              poster_image_name = NULL, poster_image_size = NULL,
                              updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [SETTINGS_ID]
  );
}

async function getPosterImage() {
  const [rows] = await query(
    `SELECT poster_image_base64, poster_image_mime, poster_image_name
     FROM app_settings WHERE id = ?`,
    [SETTINGS_ID]
  );
  const row = rows[0];
  if (!row || !row.poster_image_base64) return null;
  return { base64: row.poster_image_base64, mimeType: row.poster_image_mime, filename: row.poster_image_name };
}

// On first boot, seed the template from the legacy template.txt file so
// existing default copy isn't lost when moving to the DB-backed editor.
async function seedIfEmpty(defaultHtml) {
  const [rows] = await query("SELECT id FROM app_settings WHERE id = ?", [SETTINGS_ID]);
  if (rows.length > 0) return;
  await saveSettings({ messageTemplate: defaultHtml || "", posterLink: "" });
}

module.exports = {
  SETTINGS_ID,
  getSettings,
  saveSettings,
  setPosterImage,
  clearPosterImage,
  getPosterImage,
  seedIfEmpty,
};
