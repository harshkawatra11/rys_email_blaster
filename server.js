require("dotenv").config();
const express  = require("express");
const multer   = require("multer");
const fs       = require("fs");
const path     = require("path");
const { google } = require("googleapis");
const accountsDb = require("./db/accounts");
const settingsDb = require("./db/settings");
const globalPostersDb = require("./db/globalPosters");
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

const MAX_GLOBAL_POSTERS = 6; // bounds per-email size (see buildRawMessage)
const MAX_LINKS_PER_ROW = 10; // bounds a crafted client payload's outbound fetches

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
  return `<a href="${escapeHtml(href)}"
             style="display:inline-block;background:#000;color:#fff;padding:12px 28px;
                    text-decoration:none;border:1px solid #000;font-family:Georgia,'Times New Roman',serif;
                    font-size:13px;letter-spacing:0.06em;text-transform:uppercase;margin:4px;">
            ${escapeHtml(label || "View Brochure")}
          </a>`;
}

// Filenames land inside a MIME header (Content-Disposition), so CR/LF or a
// stray quote could break out of the header entirely — strip them.
function sanitizeFilename(name) {
  return String(name || "attachment").replace(/["\r\n]/g, "");
}

// RFC 2045 recommends wrapping base64 body lines at 76 chars — most mail
// servers tolerate an unwrapped multi-MB line, but this is cheap insurance
// once a message can carry several embedded images instead of one.
function wrapBase64(data) {
  return data.replace(/.{76}/g, "$&\r\n");
}

// posterImages (if provided) are embedded inline via cid: references so they
// render directly in the email body when opened, not as click-to-open
// attachments, stacked vertically in the order given. attachmentLinks (the
// brochures, often large) stay buttons — re-uploading a multi-MB PDF to
// every recipient doesn't scale. A single link/poster renders exactly as
// before (unnumbered label, cid "poster0") for backward compatibility.
// bodyHtml is pre-sanitized HTML (see lib/sanitizeConfig.js); callers are
// responsible for HTML-escaping any other values interpolated into it.
function buildRawMessage({ from, to, subject, bodyHtml, attachmentLinks = [], posterImages = [] }) {
  const posterHtml = posterImages
    .map((img, i) => `<div style="text-align:center;margin:24px 0;">
         <img src="cid:poster${i}" alt="${posterImages.length > 1 ? `Conference Poster ${i + 1}` : "Conference Poster"}" style="max-width:100%;height:auto;border:1px solid #000;" />
       </div>`)
    .join("");

  const buttonHtml = attachmentLinks.length
    ? `<div style="text-align:center;margin:20px 0 8px;">${attachmentLinks
        .map((link, i) => makeLinkButton(link, attachmentLinks.length > 1 ? `View Brochure ${i + 1}` : "View Brochure"))
        .join(attachmentLinks.length > 1 ? "<br/>" : "")}</div>`
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
  if (posterImages.length === 0) {
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
    const imageParts = posterImages.flatMap((img, i) => [
      `--${boundary}`,
      `Content-Type: ${img.mimeType}`,
      `Content-Transfer-Encoding: base64`,
      `Content-ID: <poster${i}>`,
      `Content-Disposition: inline; filename="${sanitizeFilename(img.filename)}"`,
      ``,
      wrapBase64(img.data),
    ]);
    const parts = [
      `--${boundary}`,
      `Content-Type: text/html; charset=UTF-8`,
      ``,
      html,
      ...imageParts,
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

// ── Settings (message template + global poster fallback list) ─────────────
app.get("/api/settings", async (req, res) => {
  try {
    const settings = (await settingsDb.getSettings()) || { messageTemplate: "" };
    const globalPosters = await globalPostersDb.listGlobalPosters();
    res.json({ ...settings, globalPosters });
  } catch (err) {
    res.status(500).json({ error: "Failed to load settings: " + err.message });
  }
});

app.put("/api/settings", async (req, res) => {
  try {
    const { messageTemplate } = req.body;
    const cleanTemplate = sanitizeTemplateHtml(messageTemplate || "");
    await settingsDb.saveSettings({ messageTemplate: cleanTemplate });
    res.json({ ok: true, messageTemplate: cleanTemplate });
  } catch (err) {
    res.status(500).json({ error: "Failed to save settings: " + err.message });
  }
});

app.post("/api/settings/posters/image", imageUpload.single("image"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No image file provided" });
    if ((await globalPostersDb.countGlobalPosters()) >= MAX_GLOBAL_POSTERS) {
      return res.status(400).json({ error: `You can only have up to ${MAX_GLOBAL_POSTERS} default posters` });
    }
    const item = await globalPostersDb.addGlobalPosterImage({
      base64: req.file.buffer.toString("base64"),
      mimeType: req.file.mimetype,
      filename: req.file.originalname,
      size: req.file.size,
    });
    res.status(201).json(item);
  } catch (err) {
    res.status(500).json({ error: "Failed to save poster image: " + err.message });
  }
});

app.post("/api/settings/posters/link", async (req, res) => {
  try {
    const link = (req.body.link || "").trim();
    if (!link || !driveFileIdFromUrl(link)) {
      return res.status(400).json({ error: "That doesn't look like a valid Google Drive share link" });
    }
    if ((await globalPostersDb.countGlobalPosters()) >= MAX_GLOBAL_POSTERS) {
      return res.status(400).json({ error: `You can only have up to ${MAX_GLOBAL_POSTERS} default posters` });
    }
    const item = await globalPostersDb.addGlobalPosterLink(link);
    res.status(201).json(item);
  } catch (err) {
    res.status(500).json({ error: "Failed to save poster link: " + err.message });
  }
});

app.put("/api/settings/posters/:id/link", async (req, res) => {
  try {
    const link = (req.body.link || "").trim();
    if (!link || !driveFileIdFromUrl(link)) {
      return res.status(400).json({ error: "That doesn't look like a valid Google Drive share link" });
    }
    await globalPostersDb.updateGlobalPosterLink(req.params.id, link);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to update poster link: " + err.message });
  }
});

app.delete("/api/settings/posters/:id", async (req, res) => {
  try {
    await globalPostersDb.removeGlobalPoster(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to remove poster: " + err.message });
  }
});

app.get("/api/settings/posters/:id/image", async (req, res) => {
  try {
    const image = await globalPostersDb.getGlobalPosterImage(req.params.id);
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
  if (/^(institution|school|college|university)$/.test(clean)) return "institution";
  if (/name/.test(clean)) return "name";
  return clean.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

// Any number of numbered attachment/poster columns are supported — a header
// like "ATTACHMENT LINK 2" already canonicalizes to a distinct key
// (attachment_link_2) via the generic slug rule above; this just collects
// all of them off a parsed row, in a stable order, for the send path.
const LINK_KEY_RE = /^(attachment_link|poster_link)_?(\d+)?$/;
function collectRowLinks(row, base) {
  return Object.keys(row)
    .map((k) => { const m = k.match(LINK_KEY_RE); return m && m[1] === base ? { key: k, n: m[2] ? +m[2] : 0 } : null; })
    .filter(Boolean)
    .sort((a, b) => a.n - b.n || a.key.localeCompare(b.key))
    .map(({ key }) => String(row[key] ?? "").trim())
    .filter(Boolean)
    .filter((v, i, arr) => arr.indexOf(v) === i) // dedupe, keep first occurrence
    .slice(0, MAX_LINKS_PER_ROW);
}
const rowAttachmentLinks = (row) => collectRowLinks(row, "attachment_link");
const rowPosterLinks = (row) => collectRowLinks(row, "poster_link");

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

    const rawHeaders = table[0].map(canonicalizeHeader);
    // Some sheets (e.g. ones focused on multiple attachments) have no
    // S.No./S. NO column at all — Step 3's range filter needs an sno on
    // every row, so number them by file order when one isn't present.
    const hasSno  = rawHeaders.includes("sno");
    const headers = hasSno ? rawHeaders : ["sno", ...rawHeaders];
    const rows    = table.slice(1).map((vals, idx) => {
      const obj = {};
      if (!hasSno) obj.sno = String(idx + 1);
      rawHeaders.forEach((h, i) => (obj[h] = (vals[i] || "").trim()));
      return obj;
    });
    res.json({ headers, rows, total: rows.length, snoAutoGenerated: !hasSno });
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

  // Pre-fetch each distinct poster link once (not per-row) across every
  // numbered poster_link* column — a CSV of 200 rows sharing one poster
  // link would otherwise retry the same failing download hundreds of times
  // and risk Google rate-limiting the server.
  const posterCache = new Map(); // url -> file | null
  const uniquePosterLinks = [...new Set(rows.flatMap(rowPosterLinks))].slice(0, 50);
  for (const link of uniquePosterLinks) {
    try {
      posterCache.set(link, await downloadDriveFile(link, { requireImage: true }));
      res.write(JSON.stringify({ info: `Poster fetched for embedding: ${link}` }) + "\n");
    } catch (err) {
      posterCache.set(link, null);
      res.write(JSON.stringify({ info: `⚠ Could not fetch poster (will send without it): ${err.message}` }) + "\n");
    }
  }

  // Resolve the global fallback poster list (used only for rows that supply
  // none of their own poster_link* columns) — skip entirely if every row
  // already has its own, to avoid paying for fetches nobody needs.
  let globalPosterList = [];
  if (rows.some((r) => rowPosterLinks(r).length === 0)) {
    for (const item of await globalPostersDb.getGlobalPosterPayload()) {
      if (item.kind === "image") {
        globalPosterList.push({ filename: item.imageName, mimeType: item.imageMime, data: item.imageBase64 });
      } else if (item.link) {
        if (!posterCache.has(item.link)) {
          try {
            posterCache.set(item.link, await downloadDriveFile(item.link, { requireImage: true }));
            res.write(JSON.stringify({ info: `Default poster fetched for embedding: ${item.link}` }) + "\n");
          } catch (err) {
            posterCache.set(item.link, null);
            res.write(JSON.stringify({ info: `⚠ Could not fetch default poster (will send without it): ${err.message}` }) + "\n");
          }
        }
        const file = posterCache.get(item.link);
        if (file) globalPosterList.push(file); // a failed global link is skipped, not fatal
      }
    }
    globalPosterList = globalPosterList.slice(0, MAX_GLOBAL_POSTERS);
  }

  for (let i = 0; i < rows.length; i++) {
    if (jobId && ACTIVE_JOBS[jobId].aborted) {
      console.log(`[INFO] Job ${jobId} aborted by client. Stopping at SNO ${rows[i].sno}`);
      break;
    }

    const row = rows[i];

    const bodyHtml = fillTemplate(template, row);

    // A row that supplies any of its own poster links uses only those —
    // even if a particular link's fetch failed — never silently falling
    // back to the global poster (which could be for an unrelated campaign).
    const rowLinks = rowPosterLinks(row);
    const postersToSend = rowLinks.length > 0
      ? rowLinks.map((l) => posterCache.get(l)).filter(Boolean).slice(0, MAX_GLOBAL_POSTERS)
      : globalPosterList;

    const raw = buildRawMessage({
      from:           `"${acc.displayName}" <${acc.email}>`,
      to:             row.email,
      subject:        subject || `Hello from ${acc.displayName}`,
      bodyHtml,
      attachmentLinks: rowAttachmentLinks(row),
      posterImages:    postersToSend,
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
