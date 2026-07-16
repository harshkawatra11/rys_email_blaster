require("dotenv").config();
const express  = require("express");
const multer   = require("multer");
const fs       = require("fs");
const path     = require("path");
const { google } = require("googleapis");
const accountsDb = require("./db/accounts");
const { ensureSchema } = require("./db/init");

const app    = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ── OAuth2 app credentials ────────────────────────────────────────────────
const CLIENT_ID     = (process.env.GOOGLE_CLIENT_ID     || "").trim();
const CLIENT_SECRET = (process.env.GOOGLE_CLIENT_SECRET || "").trim();
const REDIRECT_URI  = (process.env.GOOGLE_OAUTH_REDIRECT_URI || "").trim();
const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";

function makeOAuthClient() {
  return new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
}

function makeGmailClient(acc) {
  const oauth2 = makeOAuthClient();
  oauth2.setCredentials({ refresh_token: acc.refreshToken });
  return google.gmail({ version: "v1", auth: oauth2 });
}

/*function buildRawMessage({ from, to, subject, body }) {
  const msg = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset=UTF-8`,
    ``,
    body,
  ].join("\r\n");
  return Buffer.from(msg).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}*/

function buildRawMessage({ from, to, subject, body, attachmentLink }) {
  // Convert plain text body to HTML (preserve line breaks)
  const htmlBody = body
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\n/g, "<br>");

  // Append a clickable button if attachment link exists
  const attachmentHtml = attachmentLink
    ? `<br><br>
       <a href="${attachmentLink}" 
          style="background:#4F46E5;color:#fff;padding:10px 20px;
                 text-decoration:none;border-radius:6px;font-family:sans-serif;">
         📎 View Attachment
       </a>`
    : "";

  const html = `
    <div style="font-family:sans-serif;font-size:14px;color:#222;">
      ${htmlBody}
      ${attachmentHtml}
    </div>`;

  const msg = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/html; charset=UTF-8`,
    ``,
    html,
  ].join("\r\n");

  return Buffer.from(msg).toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Accounts ──────────────────────────────────────────────────────────────
app.get("/api/accounts", async (req, res) => {
  try {
    const accounts = await accountsDb.listAccounts();
    res.json(accounts);
  } catch (err) {
    res.status(500).json({ error: "Failed to load accounts: " + err.message });
  }
});

app.delete("/api/accounts/:id", async (req, res) => {
  try {
    await accountsDb.deleteAccount(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete account: " + err.message });
  }
});

// ── OAuth: Add Account flow ──────────────────────────────────────────────
app.get("/api/oauth/start", (req, res) => {
  if (!CLIENT_ID || !CLIENT_SECRET || !REDIRECT_URI) {
    return res.status(500).send("Google OAuth is not configured (missing client id/secret/redirect URI in .env)");
  }
  const oauth2 = makeOAuthClient();
  const url = oauth2.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: [GMAIL_SEND_SCOPE],
  });
  res.redirect(url);
});

app.get("/api/oauth/callback", async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.redirect(`/?oauth=error&reason=${encodeURIComponent(error)}`);
  if (!code) return res.redirect(`/?oauth=error&reason=missing_code`);

  try {
    const oauth2 = makeOAuthClient();
    const { tokens } = await oauth2.getToken(code);
    if (!tokens.refresh_token) {
      return res.redirect(`/?oauth=error&reason=${encodeURIComponent("no_refresh_token_try_revoking_access_and_retry")}`);
    }
    oauth2.setCredentials(tokens);

    const gmail = google.gmail({ version: "v1", auth: oauth2 });
    const profile = await gmail.users.getProfile({ userId: "me" });
    const email = profile.data.emailAddress;
    const displayName = email.split("@")[0];

    await accountsDb.upsertAccount({ email, displayName, refreshToken: tokens.refresh_token });
    res.redirect(`/?oauth=success&email=${encodeURIComponent(email)}`);
  } catch (err) {
    res.redirect(`/?oauth=error&reason=${encodeURIComponent(err.message)}`);
  }
});

// ── Parse CSV ─────────────────────────────────────────────────────────────
app.post("/api/parse-csv", upload.single("csv"), (req, res) => {
  try {
    const text    = req.file.buffer.toString("utf-8");
    const lines   = text.trim().split(/\r?\n/);
    const headers = lines[0].split(",").map((h) => h.trim().toLowerCase().replace(/\s+/g, "_"));
    const rows    = lines.slice(1).map((line) => {
      const vals = line.split(",").map((v) => v.trim());
      const obj  = {};
      headers.forEach((h, i) => (obj[h] = vals[i] || ""));
      return obj;
    });
    res.json({ headers, rows, total: rows.length });
  } catch (err) {
    res.status(400).json({ error: "Failed to parse CSV: " + err.message });
  }
});

// ── Send emails (chunked) ─────────────────────────────────────────────────
const ACTIVE_JOBS = {};

app.post("/api/abort", (req, res) => {
  const { jobId } = req.body;
  if (jobId && ACTIVE_JOBS[jobId]) {
    ACTIVE_JOBS[jobId].aborted = true;
  }
  res.json({ ok: true });
});

app.post("/api/send", async (req, res) => {
  const { accountId, rows, subject, jobId } = req.body;
  const acc = await accountsDb.getAccountById(accountId);
  if (!acc) return res.status(400).json({ error: "Unknown account" });
  if (!CLIENT_ID || !CLIENT_SECRET)
    return res.status(500).json({ error: "GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET missing in .env" });

  const templatePath = path.join(__dirname, "template.txt");
  if (!fs.existsSync(templatePath))
    return res.status(500).json({ error: "template.txt not found" });

  const template   = fs.readFileSync(templatePath, "utf-8");
  const gmail      = makeGmailClient(acc);
  const EMAIL_DELAY = 2000; // ms between each email

  // Define delay function since it was missing
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

  // Set headers for chunked streaming
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Transfer-Encoding', 'chunked');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Crucial for Render/Nginx to not buffer chunks

  if (jobId) {
    ACTIVE_JOBS[jobId] = { aborted: false };
  }

  for (let i = 0; i < rows.length; i++) {
    if (jobId && ACTIVE_JOBS[jobId].aborted) {
      console.log(`[INFO] Job ${jobId} aborted by client. Stopping at SNO ${rows[i].sno}`);
      break;
    }
    
    const row = rows[i];

    let body = template;
    Object.entries(row).forEach(([k, v]) => { body = body.replaceAll(`{{${k}}}`, v); });

    /*const raw = buildRawMessage({
      from:    `"${acc.name}" <${acc.email}>`,
      to:      row.email,
      subject: subject || `Hello from ${acc.name}`,
      body,
    });*/

    const raw = buildRawMessage({
  from:           `"${acc.displayName}" <${acc.email}>`,
  to:             row.email,
  subject:        subject || `Hello from ${acc.displayName}`,
  body,
  attachmentLink: row.attachment_link || "",  // ← add this
});

    try {
      await gmail.users.messages.send({ userId: "me", requestBody: { raw } });
      res.write(JSON.stringify({ ok: true, sno: row.sno, email: row.email }) + "\n");
    } catch (err) {
      res.write(JSON.stringify({ ok: false, sno: row.sno, email: row.email, reason: err.message }) + "\n");
    }

    // Wait 2 seconds after each email — skip delay after the last one
    if (i < rows.length - 1) await delay(EMAIL_DELAY);
  }

  res.end();
});

// ── Start ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`\n✉  Email Blaster → http://localhost:${PORT}`);
  try {
    await ensureSchema();
    const accounts = await accountsDb.listAccounts();
    if (accounts.length === 0) {
      console.log(`   No accounts yet — click "Add account" in the app to sign in with Google.\n`);
    } else {
      accounts.forEach((a) => console.log(`   ${a.displayName} → ${a.email}`));
      console.log("");
    }
  } catch (err) {
    console.log(`   ⚠ Could not reach the database (${err.message}).\n`);
  }
});
