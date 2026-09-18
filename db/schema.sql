CREATE TABLE IF NOT EXISTS accounts (
  id            VARCHAR(64) PRIMARY KEY,
  email         VARCHAR(255) NOT NULL UNIQUE,
  display_name  VARCHAR(255) NOT NULL,
  refresh_token TEXT NOT NULL,
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

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
);
