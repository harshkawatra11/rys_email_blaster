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

// ── Email account registry ─────────────────────────────────────────────────
const ACCOUNTS = {
  harsh111: {
    label: "harsh111",
    user: (process.env.HARSH111_EMAIL || "").trim(),
    pass: (process.env.HARSH111_PASSWORD || "").replace(/\s+/g, ""),
    name: (process.env.HARSH111_NAME || "harsh111").trim(),
  },
  harshgdrive: {
    label: "harshgdrive",
    user: (process.env.HARSHGDRIVE_EMAIL || "").trim(),
    pass: (process.env.HARSHGDRIVE_PASSWORD || "").replace(/\s+/g, ""),
    name: (process.env.HARSHGDRIVE_NAME || "harshgdrive").trim(),
  },
};

// ── Parse CSV ─────────────────────────────────────────────────────────────
app.post("/api/parse-csv", upload.single("csv"), (req, res) => {
  try {
    const text = req.file.buffer.toString("utf-8");
    const lines = text.trim().split(/\r?\n/);
    const headers = lines[0].split(",").map((h) => h.trim().toLowerCase().replace(/\s+/g, "_"));
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

// ── Send emails (parallel) ────────────────────────────────────────────────
app.post("/api/send", async (req, res) => {
  const { accountId, rows, subject } = req.body;

  if (!ACCOUNTS[accountId]) return res.status(400).json({ error: "Unknown account" });

  const acc = ACCOUNTS[accountId];
  if (!acc.user || !acc.pass) {
    return res.status(500).json({
      error: `Credentials for "${acc.label}" missing. Check .env — remove spaces from App Password.`,
    });
  }

  const templatePath = path.join(__dirname, "template.txt");
  if (!fs.existsSync(templatePath)) {
    return res.status(500).json({ error: "template.txt not found in project root" });
  }
  const template = fs.readFileSync(templatePath, "utf-8");

  // Pool connection — reuses SMTP socket instead of reconnecting per email
  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: acc.user, pass: acc.pass },
    pool: true,
    maxConnections: 5,
    socketTimeout: 15000,
    connectionTimeout: 15000,
  });

  // Fire all emails in parallel
  const promises = rows.map((row) => {
    let body = template;
    Object.entries(row).forEach(([key, val]) => {
      body = body.replaceAll(`{{${key}}}`, val);
    });

    return transporter
      .sendMail({
        from: `"${acc.name}" <${acc.user}>`,
        to: row.email,
        subject: subject || "Hello from " + acc.name,
        text: body,
      })
      .then(() => ({ ok: true, sno: row.sno, email: row.email }))
      .catch((err) => ({ ok: false, sno: row.sno, email: row.email, reason: err.message }));
  });

  const settled = await Promise.allSettled(promises);
  transporter.close();

  const results = { sent: [], failed: [] };
  settled.forEach(({ value }) => {
    if (value.ok) results.sent.push({ sno: value.sno, email: value.email });
    else results.failed.push({ sno: value.sno, email: value.email, reason: value.reason });
  });

  res.json(results);
});

// ── Start ─────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n✉  Email Blaster running at http://localhost:${PORT}`);
  console.log(`   harsh111    → ${ACCOUNTS.harsh111.user || "⚠ NOT SET"}`);
  console.log(`   harshgdrive → ${ACCOUNTS.harshgdrive.user || "⚠ NOT SET"}\n`);
});
