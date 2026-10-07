const { query, isPg } = require("./pool");

// All time windows are computed inside the database so Node's timezone
// (UTC on Render, IST locally) never skews the numbers.
const SINCE_24H   = isPg ? "CURRENT_TIMESTAMP - INTERVAL '24 hours'" : "NOW() - INTERVAL 24 HOUR";
const RETENTION   = isPg ? "CURRENT_TIMESTAMP - INTERVAL '8 days'"   : "NOW() - INTERVAL 8 DAY";
const AGE_SECONDS = (col) => isPg
  ? `EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - ${col}))`
  : `TIMESTAMPDIFF(SECOND, ${col}, NOW())`;

// One row per gmail.send attempt (ok or failed). Never throws — a usage
// bookkeeping failure must never break an actual email send.
async function recordSend({ email, ok, errorCode = null }) {
  try {
    await query(
      "INSERT INTO send_log (email, ok, error_code) VALUES (?, ?, ?)",
      [email, !!ok, errorCode]
    );
    const totalsSql = isPg
      ? `INSERT INTO send_totals (email, total_calls, total_ok, total_failed, last_call_at)
         VALUES (?, 1, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT (email) DO UPDATE SET
           total_calls  = send_totals.total_calls + 1,
           total_ok     = send_totals.total_ok + EXCLUDED.total_ok,
           total_failed = send_totals.total_failed + EXCLUDED.total_failed,
           last_call_at = CURRENT_TIMESTAMP`
      : `INSERT INTO send_totals (email, total_calls, total_ok, total_failed, last_call_at)
         VALUES (?, 1, ?, ?, CURRENT_TIMESTAMP)
         ON DUPLICATE KEY UPDATE
           total_calls  = total_calls + 1,
           total_ok     = total_ok + VALUES(total_ok),
           total_failed = total_failed + VALUES(total_failed),
           last_call_at = CURRENT_TIMESTAMP`;
    await query(totalsSql, [email, ok ? 1 : 0, ok ? 0 : 1]);
  } catch (err) {
    console.log(`[WARN] Could not record usage for ${email}: ${err.message}`);
  }
}

// send_log only needs to cover the rolling 24h window plus a little history
// for "token expired" detection; all-time numbers live in send_totals.
async function pruneOldLogs() {
  try {
    await query(`DELETE FROM send_log WHERE created_at < ${RETENTION}`);
  } catch (err) {
    console.log(`[WARN] Could not prune send_log: ${err.message}`);
  }
}

// Raw per-email aggregates. Postgres returns SUM/COUNT/EXTRACT as strings,
// so callers must wrap every numeric field in Number().
async function getUsageSummary() {
  const [recent] = await query(
    `SELECT email,
            SUM(CASE WHEN ok THEN 1 ELSE 0 END) AS ok_24h,
            SUM(CASE WHEN ok THEN 0 ELSE 1 END) AS failed_24h
     FROM send_log
     WHERE created_at > ${SINCE_24H}
     GROUP BY email`
  );
  const [totals] = await query(
    `SELECT email, total_calls, total_ok, total_failed,
            ${AGE_SECONDS("last_call_at")} AS last_call_age_s
     FROM send_totals`
  );
  const [grants] = await query(
    `SELECT email, ${AGE_SECONDS("MAX(created_at)")} AS grant_age_s
     FROM send_log
     WHERE error_code = 'invalid_grant'
     GROUP BY email`
  );
  return { recent, totals, grants };
}

module.exports = { recordSend, pruneOldLogs, getUsageSummary };
