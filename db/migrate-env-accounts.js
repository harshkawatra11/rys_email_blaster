require("dotenv").config();
const accountsDb = require("./accounts");

const LEGACY_ACCOUNTS = [
  ["TANISHA", "Tanisha"],
  ["AVNI", "Avni"],
  ["PARVV", "Parv"],
  ["SHREYA", "Shreya"],
  ["JATINK", "Jatink"],
  ["JATIN", "Jatin"],
  ["RAJDHANIYUVASANSAD", "RajdhaniYuvaSansad"],
  ["ZIGYASA", "Zigyasa"],
  ["KARTIK", "Kartik"],
];

async function main() {
  let migrated = 0;
  let skipped = 0;
  for (const [prefix, displayName] of LEGACY_ACCOUNTS) {
    const email = (process.env[`${prefix}_EMAIL`] || "").trim();
    const refreshToken = (process.env[`${prefix}_REFRESH_TOKEN`] || "").trim();
    if (!email || !refreshToken) {
      console.log(`  skip ${displayName} — no email/refresh token in .env`);
      skipped++;
      continue;
    }
    await accountsDb.upsertAccount({ email, displayName, refreshToken });
    console.log(`  migrated ${displayName} → ${email}`);
    migrated++;
  }
  console.log(`\nDone. ${migrated} migrated, ${skipped} skipped.`);
  process.exit(0);
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
