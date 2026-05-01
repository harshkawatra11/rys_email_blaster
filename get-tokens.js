/**
 * Run this ONCE per account to get your refresh tokens.
 * Usage:
 *   node get-tokens.js
 * It will open a browser, you sign in, paste the code back — done.
 */

require("dotenv").config();
const { google } = require("googleapis");
const http       = require("http");
const url        = require("url");
const open       = require("open");
const readline   = require("readline");

const CLIENT_ID     = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI  = "http://localhost:4000/oauth2callback";

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("\n❌  GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set in .env first.\n");
  process.exit(1);
}

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

const authUrl = oauth2Client.generateAuthUrl({
  access_type: "offline",
  prompt:      "consent",           // forces refresh_token to always be returned
  scope:       ["https://mail.google.com/"],
});

console.log("\n────────────────────────────────────────────────────");
console.log("  Gmail OAuth2 Token Helper");
console.log("────────────────────────────────────────────────────");
console.log("\n1. A browser window will open.");
console.log("2. Sign in with the Gmail account you want to authorize.");
console.log("3. The refresh token will be printed here automatically.\n");

// Start a temporary local server to catch the OAuth callback
const server = http.createServer(async (req, res) => {
  const qs    = new url.URL(req.url, REDIRECT_URI).searchParams;
  const code  = qs.get("code");

  if (!code) {
    res.end("No code found. Please try again.");
    return;
  }

  res.end("<h2 style='font-family:monospace'>✅ Authorized! You can close this tab and check your terminal.</h2>");

  try {
    const { tokens } = await oauth2Client.getToken(code);
    console.log("\n✅  SUCCESS — copy the refresh token below into your .env:\n");
    console.log(`   REFRESH_TOKEN=${tokens.refresh_token}\n`);
    console.log("────────────────────────────────────────────────────\n");
  } catch (e) {
    console.error("❌  Token exchange failed:", e.message);
  }

  server.close();
});

server.listen(4000, async () => {
  console.log("Opening browser...\n");
  try {
    await open(authUrl);
  } catch {
    console.log("Could not auto-open browser. Open this URL manually:\n");
    console.log(authUrl + "\n");
  }
});
