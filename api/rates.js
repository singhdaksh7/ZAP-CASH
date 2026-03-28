/**
 * api/rates.js → /api/rates
 * GET  /api/rates  → fetch live rate + selling rate
 * POST /api/rates  → admin update rate
 */

const { db, admin } = require("../lib/firebase");
const { sendEmail } = require("../lib/email");
const { verifyToken, verifyAdmin, handle } = require("../lib/middleware");
const { DEFAULT_RATE, DEFAULT_FEE_PCT, DEFAULT_SELLING_RATE } = require("../lib/constants");

async function sendRateChangeEmails(newRate, oldRate) {
  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  const OWNER_EMAIL    = process.env.OWNER_EMAIL || "manavdaksh7@gmail.com";
  const DOMAIN_VERIFIED = process.env.EMAIL_DOMAIN_VERIFIED === "true";
  const SITE_URL       = "https://zipinnovate.com";

  if (!RESEND_API_KEY) return;

  const usersSnap = await db.collection("users").get();
  const direction = newRate > oldRate ? "📈 Increased" : "📉 Decreased";
  const color     = newRate > oldRate ? "#00f0a0" : "#ef4444";
  const change    = Math.abs(newRate - oldRate).toFixed(2);

  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
body{margin:0;padding:0;background:#070b12;font-family:'Segoe UI',Arial,sans-serif;color:#e2eaf6;}
.wrap{max-width:560px;margin:0 auto;padding:32px 16px;}
.card{background:#0d1220;border:1px solid #1e2d47;border-radius:18px;padding:32px;}
.logo{font-size:26px;font-weight:800;color:#00f0a0;margin-bottom:4px;}
.divider{height:1px;background:#1e2d47;margin:20px 0;}
.rate-big{font-size:48px;font-weight:800;font-family:monospace;color:${color};text-align:center;padding:20px 0;}
table{width:100%;border-collapse:collapse;}
td{padding:10px 0;font-size:14px;border-bottom:1px solid #1e2d47;}
td:first-child{color:#8fa3c0;}
td:last-child{font-family:monospace;font-weight:600;text-align:right;}
.btn{display:inline-block;padding:13px 28px;background:linear-gradient(135deg,#00f0a0,#00c87a);color:#000;font-weight:700;font-size:15px;border-radius:11px;text-decoration:none;margin-top:20px;}
.footer{text-align:center;font-size:12px;color:#4d6282;margin-top:20px;line-height:1.8;}
</style></head><body><div class="wrap"><div class="card">
<div class="logo">ZAP-CASH</div>
<div style="font-size:12px;color:#4d6282;margin-bottom:20px">USDT → INR · Instant Exchange</div>
<div class="divider"></div>
<h2 style="margin:0 0 6px;font-size:20px">${direction} Exchange Rate!</h2>
<p style="color:#8fa3c0;font-size:14px;margin:0 0 16px">The USDT/INR exchange rate on ZAP-CASH has been updated.</p>
<div class="rate-big">₹${newRate.toFixed(2)}</div>
<table>
  <tr><td>New Rate</td><td style="color:${color}">₹${newRate.toFixed(2)} / USDT</td></tr>
  <tr><td>Previous Rate</td><td>₹${oldRate.toFixed(2)} / USDT</td></tr>
  <tr><td>Change</td><td style="color:${color}">${newRate > oldRate ? "+" : "-"}₹${change}</td></tr>
</table>
<p style="font-size:13px;color:#8fa3c0;margin-top:16px">Now is a great time to ${newRate > oldRate ? "withdraw your USDT at a higher rate!" : "deposit more USDT while rates are lower!"}</p>
<a href="${SITE_URL}" class="btn">View ZAP-CASH →</a>
<div class="divider"></div>
<div class="footer">You're receiving this because you have rate change notifications enabled.<br>
<a href="${SITE_URL}" style="color:#00f0a0">${SITE_URL}</a></div>
</div></div></body></html>`;

  let sent = 0, skipped = 0;

  for (const doc of usersSnap.docs) {
    const u = doc.data();
    if (!u.email) { skipped++; continue; }

    // Check notif prefs — skip if rate notifications disabled
    const notifPrefs = u.notifPrefs || {};
    if (notifPrefs["notif-rate"] === false) { skipped++; continue; }

    const recipient = DOMAIN_VERIFIED ? u.email : OWNER_EMAIL;
    const subject   = DOMAIN_VERIFIED
      ? `${direction}: ZAP-CASH Rate Now ₹${newRate.toFixed(2)}/USDT`
      : `[For: ${u.email}] ${direction}: Rate Now ₹${newRate.toFixed(2)}/USDT`;

    try {
      await fetch("https://api.resend.com/emails", {
        method:  "POST",
        headers: { "Authorization": `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
        body:    JSON.stringify({ from: "ZAP-CASH <noreply@zipinnovate.com>", to: recipient, subject, html }),
      });
      sent++;
      // Small delay to avoid rate limits
      await new Promise(r => setTimeout(r, 100));
    } catch(e) {
      console.error(`Rate email failed for ${u.email}:`, e.message);
    }
  }

  console.log(`Rate change emails: sent=${sent}, skipped=${skipped}`);
}

module.exports = handle(async (req, res) => {
  const rateSnap = await db.collection("config").doc("rate").get();
  const config = rateSnap.exists ? rateSnap.data() : {};

  if (req.method === "GET") {
    return res.json({
      inr:         config.inr         || DEFAULT_RATE,
      feePct:      config.feePct      ?? DEFAULT_FEE_PCT,
      sellingRate: config.sellingRate || DEFAULT_SELLING_RATE,
      minWithdraw: config.minWithdraw || 10,
    });
  }

  if (req.method === "POST") {
    await verifyAdmin(req);
    const { inr, sellingRate, feePct, minWithdraw } = req.body || {};
    const update = {};
    if (inr         !== undefined) update.inr         = parseFloat(inr);
    if (sellingRate !== undefined) update.sellingRate = parseFloat(sellingRate);
    if (feePct      !== undefined) update.feePct      = parseFloat(feePct);
    if (minWithdraw !== undefined) update.minWithdraw = parseFloat(minWithdraw);
    if (!Object.keys(update).length) throw { status: 400, message: "Nothing to update" };
    await db.collection("config").doc("rate").set(update, { merge: true });

    // Send rate change email to all users who have rate notifications enabled
    if (update.inr !== undefined) {
      const oldRate = config.inr || 0;
      const newRate = update.inr;
      // Only notify if rate actually changed
      if (Math.abs(newRate - oldRate) > 0.01) {
        // Non-blocking — send in background
        sendRateChangeEmails(newRate, oldRate).catch(e => console.error("Rate email error:", e));
      }
    }

    return res.json({ ok: true, ...update });
  }

  res.status(405).json({ error: "Method not allowed" });
});
