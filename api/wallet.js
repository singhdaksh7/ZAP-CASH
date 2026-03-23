/**
 * api/wallet.js  →  /api/wallet
 * GET /api/wallet  → balance, deposit address, INR equivalent
 */

const { db } = require("../lib/firebase");
const { verifyToken, handle } = require("../lib/middleware");

module.exports = handle(async (req, res) => {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const user = await verifyToken(req);

  const [walletSnap, addrSnap, rateSnap] = await Promise.all([
    db.collection("wallets").doc(user.uid).get(),
    db.collection("addresses").doc(user.uid).get(),
    db.collection("config").doc("rate").get(),
  ]);

  if (!walletSnap.exists) return res.status(404).json({ error: "Wallet not found" });

  const wallet = walletSnap.data();
  const rate   = rateSnap.exists ? rateSnap.data().inr : 87.42;

  res.json({
    balance:        wallet.balance,
    balanceINR:     +(wallet.balance * rate).toFixed(2),
    totalDeposited: wallet.totalDeposited,
    totalWithdrawn: wallet.totalWithdrawn,
    rate,
    depositAddress: addrSnap.exists ? addrSnap.data().address : null,
    network: "TRC-20",
  });
});
