// Local dev uses MySQL (DB_HOST/DB_USER/...); Render deploys set DATABASE_URL
// for the free managed Postgres add-on, and we switch drivers automatically.
const isPg = !!process.env.DATABASE_URL;

function toPgPlaceholders(sql) {
  let n = 0;
  return sql.replace(/\?/g, () => `$${++n}`);
}

let query;

if (isPg) {
  const { Pool } = require("pg");
  // Render's internal Postgres URL uses a self-signed cert on their private
  // network (not internet-routable), so strict CA verification must be off —
  // this is Render's own documented requirement for the internal connection.
  const rawPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  query = async (sql, params = []) => {
    const { rows } = await rawPool.query(toPgPlaceholders(sql), params);
    return [rows];
  };
} else {
  const mysql = require("mysql2/promise");
  const rawPool = mysql.createPool({
    host:     process.env.DB_HOST || "localhost",
    user:     process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || "email_blaster",
    waitForConnections: true,
    connectionLimit: 5,
  });
  query = (sql, params = []) => rawPool.query(sql, params);
}

module.exports = { query, isPg };
