require("dotenv").config();
const express  = require("express");
const multer   = require("multer");
const fs       = require("fs");
const path     = require("path");
const { google } = require("googleapis");
const accountsDb = require("./db/accounts");
const settingsDb = require("./db/settings");
const { ensureSchema } = require("./db/init");
const { sanitizeTemplateHtml } = require("./lib/sanitizeConfig");

const app    = express();
const upload = multer({ storage: multer.memoryStorage() });

const POSTER_IMAGE_MAX_BYTES = 2 * 1024 * 1024; // 2MB — re-sent inline to every recipient
const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: POSTER_IMAGE_MAX_BYTES, files: 1 },
  fileFilter: (req, file, cb) => {
    if (/^image\/(png|jpeg|gif|webp)$/.test(file.mimetype)) return cb(null, true);
    cb(new Error("Only PNG, JPEG, GIF, or WEBP images are allowed"));
  },
});

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

// ── OAuth2 app credentials ────────────────────────────────────────────────
const CLIENT_ID     = (process.env.GOOGLE_CLIENT_ID     || "").trim();
const CLIENT_SECRET = (process.env.GOOGLE_CLIENT_SECRET || "").trim();
const REDIRECT_URI  = (process.env.GOOGLE_OAUTH_REDIRECT_URI || "").trim();
const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";
const USERINFO_EMAIL_SCOPE = "https://www.googleapis.com/auth/userinfo.email";

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

const LOGO_URL = "https://rys-email-blaster.onrender.com/logo.png";

// Google Drive share links ("/file/d/<ID>/view?...") aren't direct file
// bytes — convert to the direct-download endpoint and fetch the binary so it
// can be embedded as a real Gmail attachment instead of just a link.
function driveFileIdFromUrl(url) {
  const m = url.match(/\/d\/([a-zA-Z0-9_-]+)/) || url.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  return m ? m[1] : null;
}

const driveDownloadCache = new Map();
const DRIVE_FETCH_TIMEOUT_MS = 15000;
const DRIVE_FETCH_ATTEMPTS = 3;

async function downloadDriveFile(url, { requireImage = false } = {}) {
  if (!url) return null;
  if (driveDownloadCache.has(url)) return driveDownloadCache.get(url);

  const fileId = driveFileIdFromUrl(url);
  if (!fileId) {
    console.log(`[WARN] Could not extract Drive file ID from: ${url}`);
    return null;
  }

  const downloadUrl = `https://drive.google.com/uc?export=download&id=${fileId}`;

  let lastError = null;
  for (let attempt = 1; attempt <= DRIVE_FETCH_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(downloadUrl, {
        signal: AbortSignal.timeout(DRIVE_FETCH_TIMEOUT_MS),
        headers: { "User-Agent": "Mozilla/5.0 (compatible; RysEmailBlaster/1.0)" },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const contentType = res.headers.get("content-type") || "application/octet-stream";
      // Drive serves an HTML interstitial (virus-scan warning, permission
      // prompt) instead of the file itself when it doesn't like the request —
      // catch that instead of silently embedding a broken "image".
      if (requireImage && !contentType.startsWith("image/")) {
        throw new Error(`Expected an image but Drive returned "${contentType}" (link may not be publicly shared, or points to an HTML page)`);
      }

      const disposition = res.headers.get("content-disposition") || "";
      const nameMatch = disposition.match(/filename="?([^";]+)"?/);
      const extFromType = contentType.split("/")[1]?.split(";")[0] || "pdf";
      const filename = nameMatch ? nameMatch[1] : `${fileId}.${extFromType}`;

      const buffer = Buffer.from(await res.arrayBuffer());
      const file = { filename, mimeType: contentType, data: buffer.toString("base64") };
      driveDownloadCache.set(url, file);
      return file;
    } catch (err) {
      lastError = err;
      console.log(`[WARN] Drive download attempt ${attempt}/${DRIVE_FETCH_ATTEMPTS} failed for ${url}: ${err.message}`);
    }
  }
  throw new Error(`Failed to download from Google Drive after ${DRIVE_FETCH_ATTEMPTS} attempts: ${lastError?.message}`);
}

function makeLinkButton(href, label) {
  return `<a href="${href}"
             style="display:inline-block;background:#000;color:#fff;padding:12px 28px;
                    text-decoration:none;border:1px solid #000;font-family:Georgia,'Times New Roman',serif;
                    font-size:13px;letter-spacing:0.06em;text-transform:uppercase;">
            View Brochure
          </a>`;
}

// posterImage (if provided) is embedded inline via a cid: reference so it
// renders directly in the email body when opened, not as a click-to-open
// attachment. attachmentLink (the brochure, often large) stays a button —
// re-uploading a multi-MB PDF to every recipient doesn't scale.
// bodyHtml is pre-sanitized HTML (see lib/sanitizeConfig.js); callers are
// responsible for HTML-escaping any values interpolated into it beforehand.
function buildRawMessage({ from, to, subject, bodyHtml, attachmentLink, posterImage }) {
  const posterHtml = posterImage
    ? `<div style="text-align:center;margin:24px 0;">
         <img src="cid:poster" alt="Conference Poster" style="max-width:100%;height:auto;border:1px solid #000;" />
       </div>`
    : "";

  const buttonHtml = attachmentLink
    ? `<div style="text-align:center;margin:20px 0 8px;">${makeLinkButton(attachmentLink)}</div>`
    : "";

  const html = `
    <div style="background:#ffffff;padding:32px 12px;">
      <div style="max-width:600px;margin:0 auto;font-family:Georgia,'Times New Roman',serif;color:#000;">

        <div style="text-align:center;padding-bottom:20px;">
          <img src="${LOGO_URL}" width="72" height="72" alt="Rajdhani Yuva Sansad" style="display:block;margin:0 auto 10px;" />
          <div style="font-size:15px;font-weight:bold;letter-spacing:0.18em;text-transform:uppercase;color:#000;">
            Rajdhani Yuva Sansad
          </div>
        </div>
        <hr style="border:none;border-top:2px solid #000;margin:0 0 28px;" />

        <div style="font-size:14px;line-height:1.7;color:#111;">
          ${bodyHtml}
        </div>

        ${posterHtml}
        ${buttonHtml}

        <hr style="border:none;border-top:1px solid #000;margin:32px 0 16px;" />
        <div style="text-align:center;font-size:11px;letter-spacing:0.04em;color:#000;">
          <div style="margin-bottom:6px;">RAJDHANI YUVA SANSAD</div>
          <div>
            <a href="https://www.rajdhaniyuvasansad.com" style="color:#000;text-decoration:underline;">Website</a>
            &nbsp;·&nbsp;
            <a href="https://www.instagram.com/rajdhaaniyuvaasansad" style="color:#000;text-decoration:underline;">Instagram</a>
            &nbsp;·&nbsp;
            <a href="https://www.facebook.com/Rajdhaniyuvasansad2017" style="color:#000;text-decoration:underline;">Facebook</a>
            &nbsp;·&nbsp;
            <a href="https://youtube.com/@rajdhaniyuvasansad" style="color:#000;text-decoration:underline;">YouTube</a>
          </div>
        </div>

      </div>
    </div>`;

  let msg;
  if (!posterImage) {
    msg = [
      `From: ${from}`,
      `To: ${to}`,
      `Subject: ${subject}`,
      `MIME-Version: 1.0`,
      `Content-Type: text/html; charset=UTF-8`,
      ``,
      html,
    ].join("\r\n");
  } else {
    const boundary = `----=_Boundary_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const parts = [
      `--${boundary}`,
      `Content-Type: text/html; charset=UTF-8`,
      ``,
      html,
      `--${boundary}`,
      `Content-Type: ${posterImage.mimeType}`,
      `Content-Transfer-Encoding: base64`,
      `Content-ID: <poster>`,
      `Content-Disposition: inline; filename="${posterImage.filename}"`,
      ``,
      posterImage.data,
      `--${boundary}--`,
    ];

    msg = [
      `From: ${from}`,
      `To: ${to}`,
      `Subject: ${subject}`,
      `MIME-Version: 1.0`,
      `Content-Type: multipart/related; boundary="${boundary}"`,
      ``,
      parts.join("\r\n"),
    ].join("\r\n");
  }

  return Buffer.from(msg).toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function escapeHtml(v) {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// The template is now rich HTML, so a naive replaceAll(`{{key}}`) misses
// placeholders that got partially formatted (e.g. only half of {{name}}
// bolded splits it into "{{<b>name</b>}}"). This strips any tags that
// leaked inside the braces before matching, and HTML-escapes the
// substituted value since it's now landing directly inside markup.
// Unknown/unmatched keys are left literal, matching the old behavior.
function fillTemplate(html, row) {
  return html.replace(/\{\{\s*((?:<[^>]*>|[^{}<>])*?)\s*\}\}/g, (match, inner) => {
    const key = inner.replace(/<[^>]*>/g, "").trim();
    if (key && Object.prototype.hasOwnProperty.call(row, key)) {
      return escapeHtml(row[key]);
    }
    return match;
  });
}

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

// ── Settings (message template + global poster fallback) ──────────────────
app.get("/api/settings", async (req, res) => {
  try {
    const settings = await settingsDb.getSettings();
    res.json(settings || { messageTemplate: "", posterLink: "", hasPosterImage: false });
  } catch (err) {
    res.status(500).json({ error: "Failed to load settings: " + err.message });
  }
});

app.put("/api/settings", async (req, res) => {
  try {
    const { messageTemplate, posterLink } = req.body;
    const cleanLink = (posterLink || "").trim();
    if (cleanLink && !driveFileIdFromUrl(cleanLink)) {
      return res.status(400).json({ error: "That doesn't look like a valid Google Drive share link" });
    }
    const cleanTemplate = sanitizeTemplateHtml(messageTemplate || "");
    await settingsDb.saveSettings({ messageTemplate: cleanTemplate, posterLink: cleanLink });
    if (cleanLink) await settingsDb.clearPosterImage(); // link and uploaded image are mutually exclusive
    res.json({ ok: true, messageTemplate: cleanTemplate });
  } catch (err) {
    res.status(500).json({ error: "Failed to save settings: " + err.message });
  }
});

app.post("/api/settings/poster-image", imageUpload.single("image"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No image file provided" });
    await settingsDb.setPosterImage({
      base64: req.file.buffer.toString("base64"),
      mimeType: req.file.mimetype,
      filename: req.file.originalname,
      size: req.file.size,
    });
    res.json({ ok: true, posterImageName: req.file.originalname, posterImageMime: req.file.mimetype, posterImageSize: req.file.size });
  } catch (err) {
    res.status(500).json({ error: "Failed to save poster image: " + err.message });
  }
});

app.delete("/api/settings/poster-image", async (req, res) => {
  try {
    await settingsDb.clearPosterImage();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to remove poster image: " + err.message });
  }
});

app.get("/api/settings/poster-image", async (req, res) => {
  try {
    const image = await settingsDb.getPosterImage();
    if (!image) return res.status(404).end();
    res.setHeader("Content-Type", image.mimeType || "application/octet-stream");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Disposition", "inline");
    res.end(Buffer.from(image.base64, "base64"));
  } catch (err) {
    res.status(500).json({ error: "Failed to load poster image: " + err.message });
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
    scope: [GMAIL_SEND_SCOPE, USERINFO_EMAIL_SCOPE],
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

    const oauth2Info = google.oauth2({ version: "v2", auth: oauth2 });
    const { data: userinfo } = await oauth2Info.userinfo.get();
    const email = userinfo.email;
    const displayName = email.split("@")[0];

    await accountsDb.upsertAccount({ email, displayName, refreshToken: tokens.refresh_token });
    res.redirect(`/?oauth=success&email=${encodeURIComponent(email)}`);
  } catch (err) {
    res.redirect(`/?oauth=error&reason=${encodeURIComponent(err.message)}`);
  }
});

// ── Parse CSV ─────────────────────────────────────────────────────────────
// Real-world sheets spell the same column many ways ("S. NO", "NAME (SAME AS
// YOUR IDENTITY PROOF)", "School / Institution Name", "Email Address"...).
// Recognize the columns the app actually depends on (sno for range
// selection, email for the send address, name/institution for template
// placeholders) regardless of punctuation/wording, falling back to a
// generic slug for everything else.
function canonicalizeHeader(raw) {
  const clean = raw.trim().toLowerCase();
  if (/^s\.?\s*no\.?$/.test(clean)) return "sno";
  if (/email/.test(clean)) return "email";
  if (/(institution|school)/.test(clean) && /name/.test(clean)) return "institution";
  if (/^institution$/.test(clean)) return "institution";
  if (/name/.test(clean)) return "name";
  return clean.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

// Real spreadsheet exports quote fields containing commas (e.g. institution
// names like "Maharaja Agrasen College, University of Delhi") — a naive
// line.split(",") shifts every later column over for those rows. This is a
// minimal RFC 4180-style parser: handles quoted fields, embedded commas,
// escaped "" quotes, and quoted fields spanning multiple lines.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  let i = 0;

  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '"') { inQuotes = true; i++; continue; }
    if (ch === ",") { row.push(field); field = ""; i++; continue; }
    if (ch === "\r") { i++; continue; }
    if (ch === "\n") {
      row.push(field); field = "";
      rows.push(row); row = [];
      i++; continue;
    }
    field += ch; i++;
  }
  if (field !== "" || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter((r) => !(r.length === 1 && r[0].trim() === ""));
}

app.post("/api/parse-csv", upload.single("csv"), (req, res) => {
  try {
    const text  = req.file.buffer.toString("utf-8");
    const table = parseCsv(text.trim());
    if (table.length === 0) return res.status(400).json({ error: "CSV appears empty" });

    const headers = table[0].map(canonicalizeHeader);
    const rows    = table.slice(1).map((vals) => {
      const obj = {};
      headers.forEach((h, i) => (obj[h] = (vals[i] || "").trim()));
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

  const settings = await settingsDb.getSettings();
  let template = settings?.messageTemplate || "";
  if (!template) {
    // Degrade gracefully to the legacy file if the settings row is somehow
    // empty, rather than sending a blank email body.
    const templatePath = path.join(__dirname, "template.txt");
    if (fs.existsSync(templatePath)) {
      template = fs.readFileSync(templatePath, "utf-8")
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>");
    }
  }
  template = sanitizeTemplateHtml(template);

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

  // Pre-fetch each distinct poster link once (not per-row) — a CSV of 200
  // rows sharing one poster link would otherwise retry the same failing
  // download hundreds of times and risk Google rate-limiting the server.
  const posterImages = new Map();
  const uniquePosterLinks = [...new Set(rows.map((r) => r.poster_link).filter(Boolean))];
  for (const link of uniquePosterLinks) {
    try {
      posterImages.set(link, await downloadDriveFile(link, { requireImage: true }));
      res.write(JSON.stringify({ info: `Poster fetched for embedding: ${link}` }) + "\n");
    } catch (err) {
      posterImages.set(link, null);
      res.write(JSON.stringify({ info: `⚠ Could not fetch poster (will send without it): ${err.message}` }) + "\n");
    }
  }

  // Resolve one global poster (used only for rows that don't supply their
  // own poster_link) — skip entirely if every row already has its own link,
  // to avoid paying for a Drive fetch nobody needs.
  let globalPoster = null;
  if (rows.some((r) => !r.poster_link)) {
    const storedImage = await settingsDb.getPosterImage();
    if (storedImage) {
      globalPoster = { filename: storedImage.filename, mimeType: storedImage.mimeType, data: storedImage.base64 };
    } else if (settings?.posterLink) {
      try {
        globalPoster = await downloadDriveFile(settings.posterLink, { requireImage: true });
        res.write(JSON.stringify({ info: `Default poster fetched for embedding: ${settings.posterLink}` }) + "\n");
      } catch (err) {
        res.write(JSON.stringify({ info: `⚠ Could not fetch default poster (will send without it): ${err.message}` }) + "\n");
      }
    }
  }

  for (let i = 0; i < rows.length; i++) {
    if (jobId && ACTIVE_JOBS[jobId].aborted) {
      console.log(`[INFO] Job ${jobId} aborted by client. Stopping at SNO ${rows[i].sno}`);
      break;
    }

    const row = rows[i];

    const bodyHtml = fillTemplate(template, row);

    const posterImage = (row.poster_link && posterImages.get(row.poster_link)) || globalPoster || null;

    const raw = buildRawMessage({
      from:           `"${acc.displayName}" <${acc.email}>`,
      to:             row.email,
      subject:        subject || `Hello from ${acc.displayName}`,
      bodyHtml,
      attachmentLink: row.attachment_link || "",
      posterImage,
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

// Multer errors (oversize/invalid upload) should come back as JSON, not
// Express's default HTML error page, so the frontend's res.json() doesn't
// choke on an unexpected content type. Must be registered after all routes.
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError || (err && /image/i.test(err.message || ""))) {
    return res.status(400).json({ error: err.message });
  }
  next(err);
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
