/**
 * api/deposit.js  →  /api/deposit
 * GET /api/deposit            → deposit address
 * GET /api/deposit?history=1  → transaction history (server-sorted)
 */

const { db } = require("../lib/firebase");
const { verifyToken, handle } = require("../lib/middleware");

module.exports = handle(async (req, res) => {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const user = await verifyToken(req);

  // ?history=1 → return deposit + admin_debit transactions, newest first
  if (req.query?.history === "1") {
    // Single query ordered server-side; filter types in memory to avoid
    // needing a (uid, type, createdAt) composite index on every collection.
    const snap = await db.collection("transactions")
      .where("uid", "==", user.uid)
      .orderBy("createdAt", "desc")
      .limit(100)
      .get();

    const docs = snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .filter((d) => d.type === "deposit" || d.type === "admin_debit");

    return res.json(docs);
  }

  // default → return deposit address
  const snap = await db.collection("addresses").doc(user.uid).get();
  if (!snap.exists) return res.status(404).json({ error: "Address not found" });
  res.json(snap.data());
}, { maxReqs: 60, windowMs: 60_000 });
