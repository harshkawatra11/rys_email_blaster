// Classifies an error thrown by googleapis' gmail.users.messages.send (or by
// the OAuth token refresh that runs right before it) so /api/send can record
// it and decide whether to stop the batch.
//   invalid_grant — the stored refresh token is expired/revoked. Every
//                   remaining row for this account will fail the same way.
//   rate_limit    — Gmail throttled or the account hit its daily send quota.
//   other         — anything else (bad address, network, etc).
function classifySendError(err) {
  const status = Number(err?.code ?? err?.response?.status ?? err?.status);
  const blob = [
    err?.message,
    safeJson(err?.response?.data),
    safeJson(err?.errors),
  ].join(" ");

  if (/invalid_grant/i.test(blob)) return "invalid_grant";
  if (
    status === 429 ||
    /rateLimitExceeded|userRateLimitExceeded|dailyLimitExceeded|quotaExceeded|User-rate limit|Daily Limit|sending limit/i.test(blob)
  ) return "rate_limit";
  return "other";
}

function safeJson(v) {
  if (v === undefined || v === null) return "";
  try { return typeof v === "string" ? v : JSON.stringify(v); } catch { return ""; }
}

module.exports = { classifySendError };
