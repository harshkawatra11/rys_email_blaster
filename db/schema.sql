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

-- Replaces app_settings' old single poster slot with a variable-length list
-- of fallback poster images/links (used only for CSV rows with none of
-- their own attachment_link*/poster_link* columns).
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
);

-- One row per gmail.send attempt (rolling 24h usage + invalid_grant detection).
CREATE TABLE IF NOT EXISTS send_log (
  id          BIGINT AUTO_INCREMENT PRIMARY KEY,
  email       VARCHAR(255) NOT NULL,
  ok          TINYINT(1) NOT NULL,
  error_code  VARCHAR(32),
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_send_log_email_created (email, created_at)
);

-- All-time per-email counters (survive log pruning and "Clear all tokens").
CREATE TABLE IF NOT EXISTS send_totals (
  email         VARCHAR(255) PRIMARY KEY,
  total_calls   INTEGER NOT NULL DEFAULT 0,
  total_ok      INTEGER NOT NULL DEFAULT 0,
  total_failed  INTEGER NOT NULL DEFAULT 0,
  last_call_at  TIMESTAMP NULL
);
