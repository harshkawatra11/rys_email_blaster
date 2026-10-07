const { query, isPg } = require("./pool");

// Full address (not just the local part) so avni@gmail.com and avni@org.in
// can't collide on the primary key. Existing rows keep their old ids — the
// upsert below conflicts on email and never rewrites id.
function slugify(email) {
  return email.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
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
       ON CONFLICT (email) DO UPDATE SET display_name = EXCLUDED.display_name,
                                         refresh_token = EXCLUDED.refresh_token,
                                         updated_at = CURRENT_TIMESTAMP`
    : `INSERT INTO accounts (id, email, display_name, refresh_token)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE display_name = VALUES(display_name),
                               refresh_token = VALUES(refresh_token),
                               updated_at = CURRENT_TIMESTAMP`;
  await query(sql, [id, email, displayName, refreshToken]);
  return id;
}

async function deleteAccount(id) {
  await query("DELETE FROM accounts WHERE id = ?", [id]);
}

// Token age = seconds since the refresh token was last (re)stored. Computed
// in SQL so there's no Node/DB timezone skew. Google expires refresh tokens
// for OAuth apps in "Testing" status 7 days after issuance.
async function listAccountsWithAge() {
  const ageExpr = isPg
    ? "EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - updated_at))"
    : "TIMESTAMPDIFF(SECOND, updated_at, NOW())";
  const [rows] = await query(
    `SELECT id, email, display_name, ${ageExpr} AS token_age_s FROM accounts ORDER BY display_name`
  );
  return rows.map((r) => ({
    ...toCamel(r),
    tokenAgeSeconds: r.token_age_s === null || r.token_age_s === undefined ? null : Number(r.token_age_s),
  }));
}

async function listAccountsWithTokens() {
  const [rows] = await query("SELECT id, email, display_name, refresh_token FROM accounts");
  return rows.map(toCamel);
}

async function deleteAllAccounts() {
  await query("DELETE FROM accounts");
}

module.exports = {
  listAccounts,
  getAccountById,
  upsertAccount,
  deleteAccount,
  listAccountsWithAge,
  listAccountsWithTokens,
  deleteAllAccounts,
};
