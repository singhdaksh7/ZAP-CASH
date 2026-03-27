/**
 * api/wallet.js  →  /api/wallet
 */

const { db } = require("../lib/firebase");
const { verifyToken, handle } = require("../lib/middleware");

const MASTER_ADDRESS = "TKndaoEv14h3h9m6LWKXhkDe37w54jfmEz";

module.exports = handle(async (req, res) => {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const user = await verifyToken(req);

  const [walletSnap, userSnap, rateSnap] = await Promise.all([
    db.collection("wallets").doc(user.uid).get(),
    db.collection("users").doc(user.uid).get(),
    db.collection("config").doc("rate").get(),
  ]);

  if (!walletSnap.exists) return res.status(404).json({ error: "Wallet not found" });

  const wallet = walletSnap.data();
  const rate   = rateSnap.exists ? rateSnap.data().inr : 87.42;
  const paymentId = wallet.paymentId || userSnap.data()?.paymentId || "";

  res.json({
    balance:        wallet.balance,
    balanceINR:     +(wallet.balance * rate).toFixed(2),
    totalDeposited: wallet.totalDeposited,
    totalWithdrawn: wallet.totalWithdrawn,
    rate,
    depositAddress: MASTER_ADDRESS,
    paymentId,
    network: "TRC-20",
  });
});
