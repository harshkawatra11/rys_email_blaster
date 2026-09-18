const fs = require("fs");
const path = require("path");
const { query, isPg } = require("./pool");
const settingsDb = require("./settings");

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
  await seedSettingsFromLegacyTemplate();
}

module.exports = { ensureSchema };
