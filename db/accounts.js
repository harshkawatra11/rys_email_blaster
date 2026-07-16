const { query, isPg } = require("./pool");

function slugify(email) {
  return email.split("@")[0].toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

// Postgres folds unquoted column aliases to lowercase, so we select snake_case
// and map to camelCase in JS instead of relying on "AS displayName" aliases.
function toCamel(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    ...(row.refresh_token !== undefined ? { refreshToken: row.refresh_token } : {}),
  };
}

async function listAccounts() {
  const [rows] = await query("SELECT id, email, display_name FROM accounts ORDER BY display_name");
  return rows.map(toCamel);
}

async function getAccountById(id) {
  const [rows] = await query(
    "SELECT id, email, display_name, refresh_token FROM accounts WHERE id = ?",
    [id]
  );
  return toCamel(rows[0]);
}

async function upsertAccount({ email, displayName, refreshToken }) {
  const id = slugify(email);
  const sql = isPg
    ? `INSERT INTO accounts (id, email, display_name, refresh_token)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (email) DO UPDATE SET display_name = EXCLUDED.display_name, refresh_token = EXCLUDED.refresh_token`
    : `INSERT INTO accounts (id, email, display_name, refresh_token)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE display_name = VALUES(display_name), refresh_token = VALUES(refresh_token)`;
  await query(sql, [id, email, displayName, refreshToken]);
  return id;
}

async function deleteAccount(id) {
  await query("DELETE FROM accounts WHERE id = ?", [id]);
}

module.exports = { listAccounts, getAccountById, upsertAccount, deleteAccount };
