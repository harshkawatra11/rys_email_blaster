require("dotenv").config();
const express  = require("express");
const multer   = require("multer");
const fs       = require("fs");
const path     = require("path");
const { google } = require("googleapis");

const app    = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ── Account registry ──────────────────────────────────────────────────────
const ACCOUNTS = {
  harsh111: {
    label:        "harsh111",
    email:        (process.env.HARSH111_EMAIL || "").trim(),
    refreshToken: (process.env.HARSH111_REFRESH_TOKEN || "").trim(),
    name:         (process.env.HARSH111_NAME || "harsh111").trim(),
  },
  harshgdrive: {
    label:        "harshgdrive",
    email:        (process.env.HARSHGDRIVE_EMAIL || "").trim(),
    refreshToken: (process.env.HARSHGDRIVE_REFRESH_TOKEN || "").trim(),
    name:         (process.env.HARSHGDRIVE_NAME || "harshgdrive").trim(),
  },
};

const CLIENT_ID     = (process.env.GOOGLE_CLIENT_ID     || "").trim();
const CLIENT_SECRET = (process.env.GOOGLE_CLIENT_SECRET || "").trim();

function makeGmailClient(acc) {
  const oauth2 = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, "https://developers.google.com/oauthplayground");
  oauth2.setCredentials({ refresh_token: acc.refreshToken });
  return google.gmail({ version: "v1", auth: oauth2 });
}

function buildRawMessage({ from, to, subject, body }) {
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
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

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
app.post("/api/send", async (req, res) => {
  const { accountId, rows, subject } = req.body;
  if (!ACCOUNTS[accountId]) return res.status(400).json({ error: "Unknown account" });

  const acc = ACCOUNTS[accountId];
  if (!acc.email || !acc.refreshToken)
    return res.status(500).json({ error: `Credentials for "${acc.label}" missing in .env` });
  if (!CLIENT_ID || !CLIENT_SECRET)
    return res.status(500).json({ error: "GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET missing in .env" });

  const templatePath = path.join(__dirname, "template.txt");
  if (!fs.existsSync(templatePath))
    return res.status(500).json({ error: "template.txt not found" });

  const template   = fs.readFileSync(templatePath, "utf-8");
  const gmail      = makeGmailClient(acc);
  const CHUNK_SIZE = 10;   // emails per batch
  const CHUNK_WAIT = 1000; // ms between batches — tune up if you hit rate limits
  const results    = { sent: [], failed: [] };

  for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
    const chunk = rows.slice(i, i + CHUNK_SIZE);

    const settled = await Promise.allSettled(
      chunk.map((row) => {
        let body = template;
        Object.entries(row).forEach(([k, v]) => { body = body.replaceAll(`{{${k}}}`, v); });

        const raw = buildRawMessage({
          from:    `"${acc.name}" <${acc.email}>`,
          to:      row.email,
          subject: subject || `Hello from ${acc.name}`,
          body,
        });

        return gmail.users.messages.send({ userId: "me", requestBody: { raw } })
          .then(() => ({ ok: true,  sno: row.sno, email: row.email }))
          .catch((err) => ({ ok: false, sno: row.sno, email: row.email, reason: err.message }));
      })
    );

    settled.forEach(({ value }) => {
      if (value.ok) results.sent.push({ sno: value.sno, email: value.email });
      else          results.failed.push({ sno: value.sno, email: value.email, reason: value.reason });
    });

    // Wait between chunks — skip delay after the last one
    if (i + CHUNK_SIZE < rows.length) await delay(CHUNK_WAIT);
  }

  res.json(results);
});

// ── Start ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n✉  Email Blaster → http://localhost:${PORT}`);
  console.log(`   harsh111    → ${ACCOUNTS.harsh111.email    || "⚠ NOT SET"}`);
  console.log(`   harshgdrive → ${ACCOUNTS.harshgdrive.email || "⚠ NOT SET"}\n`);
});
