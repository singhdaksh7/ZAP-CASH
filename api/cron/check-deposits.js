/**
 * api/cron/check-deposits.js
 * Vercel Cron Job — runs every 2 minutes (set in vercel.json).
 *
 * Scans every user's TRC-20 deposit address for new USDT transfers
 * using the TronGrid REST API, then atomically credits confirmed
 * deposits to each user's Firestore wallet.
 *
 * Required env vars:
 *   TRONGRID_API_KEY  → free key from https://www.trongrid.io
 *   CRON_SECRET       → a random string you set, keeps endpoint private
 */

const { admin, db } = require("../../lib/firebase");
const { USDT_CONTRACT, TRONGRID_BASE, DEFAULT_RATE } = require("../../lib/constants");
const axios = require("axios");

module.exports = async function handler(req, res) {
  // Security: Vercel calls crons with Authorization: Bearer <CRON_SECRET>
  const secret = req.headers.authorization?.replace("Bearer ", "");
  if (secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  console.log("[cron] Starting deposit check at", new Date().toISOString());

  try {
    const addrSnap = await db.collection("addresses").get();
    if (addrSnap.empty) return res.json({ ok: true, checked: 0, credited: 0 });

    const apiKey  = process.env.TRONGRID_API_KEY || "";
    const headers = apiKey ? { "TRON-PRO-API-KEY": apiKey } : {};
    let credited  = 0;
    let errors    = 0;

    for (const doc of addrSnap.docs) {
      const { uid, address } = doc.data();
      if (!address) continue;

      try {
        credited += await processAddress(uid, address, headers);
      } catch (err) {
        errors++;
        console.error(`[cron] Error for uid=${uid} addr=${address}:`, err.message);
      }

      await sleep(300); // be polite to TronGrid rate limits
    }

    console.log(`[cron] Done. Checked ${addrSnap.size}, credited ${credited} deposit(s), errors ${errors}.`);
    res.json({ ok: true, checked: addrSnap.size, credited, errors });

  } catch (err) {
    console.error("[cron] Fatal error:", err);
    res.status(500).json({ error: err.message });
  }
};

async function processAddress(uid, address, headers) {
  const stateRef  = db.collection("depositState").doc(uid);
  const stateSnap = await stateRef.get();
  const lastTs    = stateSnap.exists ? stateSnap.data().lastTxTimestamp : 0;

  const url  = `${TRONGRID_BASE}/v1/accounts/${address}/transactions/trc20`;
  const resp = await axios.get(url, {
    headers,
    params: {
      contract_address: USDT_CONTRACT,
      only_to:          true,
      limit:            20,
      min_timestamp:    lastTs + 1,
    },
    timeout: 10_000,
  });

  const transfers = resp.data?.data || [];
  if (!transfers.length) return 0;

  let latestTs = lastTs;
  let credited = 0;

  for (const tx of transfers) {
    const txHash     = tx.transaction_id;
    const amountUSDT = parseInt(tx.value || "0", 10) / 1_000_000; // 6 decimals
    const ts         = tx.block_timestamp;

    if (ts > latestTs) latestTs = ts;
    if (amountUSDT < 1) continue; // ignore dust

    // Idempotency check
    const existing = await db.collection("transactions")
      .where("txHash", "==", txHash)
      .limit(1)
      .get();
    if (!existing.empty) continue;

    await creditDeposit(uid, txHash, amountUSDT, ts);
    credited++;
  }

  await stateRef.set({ lastTxTimestamp: latestTs }, { merge: true });
  return credited;
}

async function creditDeposit(uid, txHash, amountUSDT, blockTimestamp) {
  const rateSnap = await db.collection("config").doc("rate").get();
  const rate     = rateSnap.exists ? rateSnap.data().inr : DEFAULT_RATE;

  await db.runTransaction(async (t) => {
    const walletRef = db.collection("wallets").doc(uid);
    const txRef     = db.collection("transactions").doc();

    t.update(walletRef, {
      balance:        admin.firestore.FieldValue.increment(amountUSDT),
      totalDeposited: admin.firestore.FieldValue.increment(amountUSDT),
      updatedAt:      admin.firestore.FieldValue.serverTimestamp(),
    });

    t.set(txRef, {
      id:             txRef.id,
      uid,
      type:           "deposit",
      amountUSDT,
      inrValue:       +(amountUSDT * rate).toFixed(2),
      txHash,
      blockTimestamp,
      status:         "confirmed",
      network:        "TRC-20",
      createdAt:      admin.firestore.FieldValue.serverTimestamp(),
    });
  });

  console.log(`[cron] Credited ${amountUSDT} USDT to uid=${uid} tx=${txHash}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
