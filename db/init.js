const fs = require("fs");
const path = require("path");
const { query, isPg } = require("./pool");
const settingsDb = require("./settings");
const globalPostersDb = require("./globalPosters");

const MYSQL_SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  id            VARCHAR(64) PRIMARY KEY,
  email         VARCHAR(255) NOT NULL UNIQUE,
  display_name  VARCHAR(255) NOT NULL,
  refresh_token TEXT NOT NULL,
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
)`;

const PG_SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  id            VARCHAR(64) PRIMARY KEY,
  email         VARCHAR(255) NOT NULL UNIQUE,
  display_name  VARCHAR(255) NOT NULL,
  refresh_token TEXT NOT NULL,
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)`;

const MYSQL_SETTINGS_SCHEMA = `
CREATE TABLE IF NOT EXISTS app_settings (
  id                   VARCHAR(32) PRIMARY KEY,
  message_template     TEXT NOT NULL DEFAULT '',
  poster_link          TEXT,
  poster_image_base64  LONGTEXT,
  poster_image_mime    VARCHAR(100),
  poster_image_name    VARCHAR(255),
  poster_image_size    INTEGER,
  created_at           TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at           TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
)`;

const PG_SETTINGS_SCHEMA = `
CREATE TABLE IF NOT EXISTS app_settings (
  id                   VARCHAR(32) PRIMARY KEY,
  message_template     TEXT NOT NULL DEFAULT '',
  poster_link          TEXT,
  poster_image_base64  TEXT,
  poster_image_mime    VARCHAR(100),
  poster_image_name    VARCHAR(255),
  poster_image_size    INTEGER,
  created_at           TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at           TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)`;

// A variable-length replacement for app_settings' old single poster slot —
// an operator can now configure any number of fallback poster images/links.
const MYSQL_GLOBAL_POSTERS_SCHEMA = `
CREATE TABLE IF NOT EXISTS global_posters (
  id            VARCHAR(64) PRIMARY KEY,
  kind          VARCHAR(8) NOT NULL,
  position      INTEGER NOT NULL,
  link          TEXT,
  image_base64  LONGTEXT,
  image_mime    VARCHAR(100),
  image_name    VARCHAR(255),
  image_size    INTEGER,
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_global_posters_position (position)
)`;

const PG_GLOBAL_POSTERS_SCHEMA = `
CREATE TABLE IF NOT EXISTS global_posters (
  id            VARCHAR(64) PRIMARY KEY,
  kind          VARCHAR(8) NOT NULL,
  position      INTEGER NOT NULL,
  link          TEXT,
  image_base64  TEXT,
  image_mime    VARCHAR(100),
  image_name    VARCHAR(255),
  image_size    INTEGER,
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)`;

const PG_GLOBAL_POSTERS_INDEX = `
CREATE INDEX IF NOT EXISTS idx_global_posters_position ON global_posters (position)`;

// Converts the legacy plain-text template.txt into the same escaped-HTML
// shape /api/send used to produce inline (server.js's old buildRawMessage
// step), so the DB-backed editor starts from identical rendered output.
function plainTextToHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\n/g, "<br>");
}

async function seedSettingsFromLegacyTemplate() {
  const templatePath = path.join(__dirname, "..", "template.txt");
  let defaultHtml = "";
  if (fs.existsSync(templatePath)) {
    defaultHtml = plainTextToHtml(fs.readFileSync(templatePath, "utf-8"));
  }
  await settingsDb.seedIfEmpty(defaultHtml);
}

async function ensureSchema() {
  await query(isPg ? PG_SCHEMA : MYSQL_SCHEMA);
  await query(isPg ? PG_SETTINGS_SCHEMA : MYSQL_SETTINGS_SCHEMA);
  await query(isPg ? PG_GLOBAL_POSTERS_SCHEMA : MYSQL_GLOBAL_POSTERS_SCHEMA);
  if (isPg) await query(PG_GLOBAL_POSTERS_INDEX);
  await seedSettingsFromLegacyTemplate();
  await globalPostersDb.migrateLegacySinglePoster();
}

module.exports = { ensureSchema };
