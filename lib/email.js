/**
 * lib/email.js — Email notifications via Resend
 */

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL     = "ZAP-CASH <noreply@zipinnovate.com>";
const SITE_URL       = "https://zipinnovate.com";

async function sendEmail(to, subject, html) {
  if (!RESEND_API_KEY) { console.warn("RESEND_API_KEY not set"); return; }
  if (!to) { console.warn("No email address"); return; }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: FROM_EMAIL, to, subject, html }),
    });
    const data = await res.json();
    if (!res.ok) console.error("Resend error:", data);
    return data;
  } catch(e) { console.error("Email error:", e.message); }
}

function base(content) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
body{margin:0;padding:0;background:#070b12;font-family:'Segoe UI',Arial,sans-serif;color:#e2eaf6;}
.wrap{max-width:560px;margin:0 auto;padding:32px 16px;}
.card{background:#0d1220;border:1px solid #1e2d47;border-radius:18px;padding:32px;}
.logo{font-size:26px;font-weight:800;color:#00f0a0;margin-bottom:4px;}
.sub{font-size:12px;color:#4d6282;margin-bottom:20px;}
.divider{height:1px;background:#1e2d47;margin:20px 0;}
table{width:100%;border-collapse:collapse;}
td{padding:10px 0;font-size:14px;border-bottom:1px solid #1e2d47;}
td:first-child{color:#8fa3c0;}
td:last-child{font-family:monospace;font-weight:600;text-align:right;}
.g{color:#00f0a0;} .r{color:#ef4444;} .gold{color:#fbbf24;}
.btn{display:inline-block;padding:13px 28px;background:linear-gradient(135deg,#00f0a0,#00c87a);color:#000;font-weight:700;font-size:15px;border-radius:11px;text-decoration:none;margin-top:20px;}
.footer{text-align:center;font-size:12px;color:#4d6282;margin-top:20px;line-height:1.8;}
</style></head><body><div class="wrap"><div class="card">
<div class="logo">ZAP-CASH</div>
<div class="sub">USDT → INR · Instant Exchange</div>
<div class="divider"></div>
${content}
<div class="divider"></div>
<div class="footer">Automated notification · <a href="${SITE_URL}" style="color:#00f0a0">${SITE_URL}</a></div>
</div></div></body></html>`;
}

function fmt(n) { return parseFloat(n||0).toLocaleString("en-IN",{minimumFractionDigits:2,maximumFractionDigits:2}); }

// ── 1. Deposit Confirmed ────────────────────────────────────────────────────
async function sendDepositConfirmed({ to, name, amountUSDT, txHash, newBalance, paymentId, date }) {
  return sendEmail(to, `✅ ${amountUSDT} USDT Deposit Confirmed — ZAP-CASH`, base(`
    <h2 style="margin:0 0 6px;font-size:20px">💰 Deposit Confirmed!</h2>
    <p style="color:#8fa3c0;font-size:14px;margin:0 0 20px">Hi ${name}, your USDT has been credited to your wallet.</p>
    <table>
      <tr><td>Amount Credited</td><td class="g">+${amountUSDT} USDT</td></tr>
      <tr><td>New Balance</td><td>${newBalance} USDT</td></tr>
      <tr><td>Payment ID</td><td>${paymentId || "—"}</td></tr>
      <tr><td>Tx Hash</td><td style="font-size:11px">${txHash ? txHash.slice(0,20)+"..." : "—"}</td></tr>
      <tr><td>Date & Time</td><td>${date}</td></tr>
    </table>
    <a href="${SITE_URL}" class="btn">View Wallet →</a>
  `));
}

// ── 2. Withdrawal Approved ──────────────────────────────────────────────────
async function sendWithdrawalApproved({ to, name, amountUSDT, netINR, utr, bank, date }) {
  return sendEmail(to, `✅ ₹${fmt(netINR)} Withdrawal Approved — ZAP-CASH`, base(`
    <h2 style="margin:0 0 6px;font-size:20px">🎉 Withdrawal Approved!</h2>
    <p style="color:#8fa3c0;font-size:14px;margin:0 0 20px">Hi ${name}, your INR withdrawal has been processed.</p>
    <table>
      <tr><td>USDT Deducted</td><td class="r">−${amountUSDT} USDT</td></tr>
      <tr><td>INR Sent</td><td class="g">₹${fmt(netINR)}</td></tr>
      <tr><td>UTR Number</td><td class="gold">${utr}</td></tr>
      <tr><td>Bank</td><td>${bank?.bankName || "—"}</td></tr>
      <tr><td>Account</td><td>${bank?.masked || "—"}</td></tr>
      <tr><td>Date & Time</td><td>${date}</td></tr>
    </table>
    <p style="font-size:13px;color:#8fa3c0;margin-top:16px">Track your payment using UTR: <strong style="color:#fbbf24">${utr}</strong></p>
    <a href="${SITE_URL}" class="btn">View History →</a>
  `));
}

// ── 3. Withdrawal Rejected ──────────────────────────────────────────────────
async function sendWithdrawalRejected({ to, name, amountUSDT, reason, refundedBalance }) {
  return sendEmail(to, `❌ Withdrawal Rejected — ZAP-CASH`, base(`
    <h2 style="margin:0 0 6px;font-size:20px">❌ Withdrawal Rejected</h2>
    <p style="color:#8fa3c0;font-size:14px;margin:0 0 20px">Hi ${name}, your withdrawal request was rejected.</p>
    <table>
      <tr><td>USDT Amount</td><td>${amountUSDT} USDT</td></tr>
      <tr><td>Rejection Reason</td><td class="r">${reason}</td></tr>
      <tr><td>Refund Status</td><td class="g">✓ Refunded to wallet</td></tr>
      <tr><td>Current Balance</td><td>${refundedBalance} USDT</td></tr>
    </table>
    <p style="font-size:13px;color:#8fa3c0;margin-top:16px">Your ${amountUSDT} USDT has been returned. Please fix the issue and try again.</p>
    <a href="${SITE_URL}" class="btn">Try Again →</a>
  `));
}

// ── 4. KYC Verified ────────────────────────────────────────────────────────
async function sendKYCVerified({ to, name }) {
  return sendEmail(to, `✅ KYC Verified — Start Withdrawing on ZAP-CASH`, base(`
    <h2 style="margin:0 0 6px;font-size:20px">🎉 KYC Verified!</h2>
    <p style="color:#8fa3c0;font-size:14px;margin:0 0 20px">Hi ${name}, your KYC has been approved. You now have full access!</p>
    <table>
      <tr><td>KYC Status</td><td class="g">✓ Verified</td></tr>
      <tr><td>Withdrawals</td><td class="g">✓ Enabled</td></tr>
      <tr><td>Daily Limit</td><td class="g">Unlimited</td></tr>
      <tr><td>Monthly Limit</td><td class="g">Unlimited</td></tr>
    </table>
    <a href="${SITE_URL}" class="btn">Start Withdrawing →</a>
  `));
}

// ── 5. KYC Rejected ────────────────────────────────────────────────────────
async function sendKYCRejected({ to, name, reason }) {
  return sendEmail(to, `❌ KYC Rejected — Action Required on ZAP-CASH`, base(`
    <h2 style="margin:0 0 6px;font-size:20px">❌ KYC Rejected</h2>
    <p style="color:#8fa3c0;font-size:14px;margin:0 0 20px">Hi ${name}, your KYC submission needs attention.</p>
    <table>
      <tr><td>Status</td><td class="r">✕ Rejected</td></tr>
      <tr><td>Reason</td><td class="r">${reason}</td></tr>
    </table>
    <p style="font-size:13px;color:#8fa3c0;margin-top:16px">Please fix the issue and resubmit your KYC from the app.</p>
    <a href="${SITE_URL}" class="btn">Resubmit KYC →</a>
  `));
}

module.exports = { sendDepositConfirmed, sendWithdrawalApproved, sendWithdrawalRejected, sendKYCVerified, sendKYCRejected };
