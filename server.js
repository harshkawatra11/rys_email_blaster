require("dotenv").config();
const express = require("express");
const nodemailer = require("nodemailer");
const multer = require("multer");
const fs = require("fs");
const path = require("path");

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ── Email account registry (loaded from .env) ─────────────────────────────
const ACCOUNTS = {
  harsh: {
    label: "Harsh",
    user: process.env.HARSH_EMAIL,
    pass: process.env.HARSH_PASSWORD,
    name: process.env.HARSH_NAME || "Harsh",
  },
  spotify: {
    label: "spotify",
    user: process.env.SPOTIFY_EMAIL,
    pass: process.env.SPOTIFY_PASSWORD,
    name: process.env.SPOTIFY_NAME || "Spotify",
  },
  harsh111: {
    label: "harsh111",
    user: process.env.HARSH111_EMAIL,
    pass: process.env.HARSH111_PASSWORD,
    name: process.env.HARSH111_NAME || "Harsh111",
  },
};

// ── Expose account list to the UI (no secrets) ────────────────────────────
app.get("/api/accounts", (req, res) => {
  const safe = Object.entries(ACCOUNTS).map(([id, acc]) => ({
    id,
    label: acc.label,
    email: acc.user,
  }));
  res.json(safe);
});

// ── Parse CSV uploaded by user ────────────────────────────────────────────
app.post("/api/parse-csv", upload.single("csv"), (req, res) => {
  try {
    const text = req.file.buffer.toString("utf-8");
    const lines = text.trim().split(/\r?\n/);
    const headers = lines[0].split(",").map((h) => h.trim().toLowerCase().replace(/\s+/g, "_"));

    // Expected: sno, name, phone_number (or phone), school, email
    const rows = lines.slice(1).map((line) => {
      const vals = line.split(",").map((v) => v.trim());
      const obj = {};
      headers.forEach((h, i) => (obj[h] = vals[i] || ""));
      return obj;
    });

    res.json({ headers, rows, total: rows.length });
  } catch (err) {
    res.status(400).json({ error: "Failed to parse CSV: " + err.message });
  }
});

// ── Send emails ────────────────────────────────────────────────────────────
app.post("/api/send", async (req, res) => {
  const { accountId, rows, subject } = req.body;

  if (!ACCOUNTS[accountId]) return res.status(400).json({ error: "Unknown account" });

  const acc = ACCOUNTS[accountId];
  if (!acc.user || !acc.pass) {
    return res.status(500).json({ error: `Credentials for "${acc.label}" not set in .env` });
  }

  // Load template fresh each send (so user can edit it between runs)
  let template = "";
  const templatePath = path.join(__dirname, "template.txt");
  if (!fs.existsSync(templatePath)) {
    return res.status(500).json({ error: "template.txt not found in project root" });
  }
  template = fs.readFileSync(templatePath, "utf-8");

  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: acc.user, pass: acc.pass },
  });

  const results = { sent: [], failed: [] };

  for (const row of rows) {
    // Replace all {{column_name}} placeholders
    let body = template;
    Object.entries(row).forEach(([key, val]) => {
      body = body.replaceAll(`{{${key}}}`, val);
    });

    try {
      await transporter.sendMail({
        from: `"${acc.name}" <${acc.user}>`,
        to: row.email,
        subject: subject || "Hello from " + acc.name,
        text: body,
      });
      results.sent.push({ sno: row.sno, email: row.email });
    } catch (err) {
      results.failed.push({ sno: row.sno, email: row.email, reason: err.message });
    }
  }

  res.json(results);
});

// ── Start ─────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n✉  Email Blaster running at http://localhost:${PORT}\n`);
});
