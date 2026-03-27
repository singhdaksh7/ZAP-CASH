/**
 * api/cron/check-deposits.js
 * Runs every hour via Vercel Cron
 * Checks master TRC-20 wallet for incoming USDT, matches by Payment ID memo
 */

const { admin, db } = require("../../lib/firebase");

const MASTER_ADDRESS  = "TKndaoEv14h3h9m6LWKXhkDe37w54jfmEz";
const TRONGRID_KEY    = process.env.TRONGRID_API_KEY || "";
const CRON_SECRET     = process.env.CRON_SECRET || "";
const USDT_CONTRACT   = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t"; // TRC-20 USDT
const MIN_DEPOSIT     = 10;

module.exports = async (req, res) => {
  if (req.headers["x-cron-secret"] !== CRON_SECRET && req.query.secret !== CRON_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    // Fetch recent TRC-20 USDT transfers to master address
    const url = `https://api.trongrid.io/v1/accounts/${MASTER_ADDRESS}/transactions/trc20?limit=50&contract_address=${USDT_CONTRACT}&only_to=true`;
    const resp = await fetch(url, { headers: { "TRON-PRO-API-KEY": TRONGRID_KEY } });
    const data = await resp.json();

    if (!data.data || !Array.isArray(data.data)) {
      return res.json({ ok: true, processed: 0, message: "No transactions found" });
    }

    // Load all payment IDs from Firestore for matching
    const walletsSnap = await db.collection("wallets").get();
    const paymentMap = {}; // paymentId → uid
    walletsSnap.forEach(d => {
      const pid = d.data().paymentId;
      if (pid) paymentMap[pid.toUpperCase()] = d.id;
    });

    let processed = 0, credited = 0, errors = 0;

    for (const tx of data.data) {
      processed++;
      try {
        const txHash     = tx.transaction_id;
        const amountRaw  = parseInt(tx.value || "0");
        const amountUSDT = amountRaw / 1_000_000; // USDT has 6 decimals
        const memo       = (tx.data || "").toUpperCase().trim();

        // Skip if below minimum
        if (amountUSDT < MIN_DEPOSIT) continue;

        // Try to match Payment ID from memo
        // Memo format: ZAP-00001 or ZAP00001 or just 00001
        let matchedUid = null;
        let matchedPid = null;

        // Direct match
        if (paymentMap[memo]) {
          matchedUid = paymentMap[memo];
          matchedPid = memo;
        } else {
          // Try with ZAP- prefix
          const withPrefix = "ZAP-" + memo.replace(/[^0-9]/g, "").padStart(5, "0");
          if (paymentMap[withPrefix]) {
            matchedUid = paymentMap[withPrefix];
            matchedPid = withPrefix;
          }
        }

        if (!matchedUid) {
          // Unmatched deposit — log it for manual review
          await db.collection("unmatchedDeposits").add({
            txHash, amountUSDT, memo,
            toAddress: MASTER_ADDRESS,
            timestamp: admin.firestore.FieldValue.serverTimestamp(),
            status: "unmatched",
          });
          continue;
        }

        // Check if already processed
        const existingSnap = await db.collection("transactions")
          .where("txHash", "==", txHash).limit(1).get();
        if (!existingSnap.empty) continue;

        // Credit user wallet in a transaction
        await db.runTransaction(async (t) => {
          const walletRef = db.collection("wallets").doc(matchedUid);
          const walletSnap = await t.get(walletRef);
          if (!walletSnap.exists) throw new Error("Wallet not found");

          t.update(walletRef, {
            balance:        admin.firestore.FieldValue.increment(amountUSDT),
            totalDeposited: admin.firestore.FieldValue.increment(amountUSDT),
            updatedAt:      admin.firestore.FieldValue.serverTimestamp(),
          });

          const txRef = db.collection("transactions").doc();
          t.set(txRef, {
            id:         txRef.id,
            uid:        matchedUid,
            type:       "deposit",
            amountUSDT,
            txHash,
            paymentId:  matchedPid,
            status:     "confirmed",
            network:    "TRC-20",
            toAddress:  MASTER_ADDRESS,
            createdAt:  admin.firestore.FieldValue.serverTimestamp(),
          });
        });

        credited++;
        console.log(`✅ Credited ${amountUSDT} USDT to ${matchedUid} (${matchedPid}) tx: ${txHash}`);

      } catch(e) {
        errors++;
        console.error("Error processing tx:", e.message);
      }
    }

    return res.json({ ok: true, processed, credited, errors });

  } catch(e) {
    console.error("Cron error:", e);
    return res.status(500).json({ error: e.message });
  }
};
