/**
 * api/auth.js  →  /api/auth
 * POST  /api/auth  → create user on first login
 * GET   /api/auth  → fetch profile
 * PATCH /api/auth  → update profile (name, email, dob)
 */

const { admin, db } = require("../lib/firebase");
const { verifyToken, handle } = require("../lib/middleware");
const Joi = require("joi");
const crypto = require("crypto");

const profileSchema = Joi.object({
  name:  Joi.string().min(2).max(80).optional(),
  email: Joi.string().email({ tlds: { allow: false } }).optional(),
  dob:   Joi.string().pattern(/^\d{2}\/\d{2}\/\d{4}$/).optional()
           .messages({ "string.pattern.base": "dob must be DD/MM/YYYY" }),
}).min(1).messages({ "object.min": "Nothing to update" });

module.exports = handle(async (req, res) => {
  const user = await verifyToken(req);

  // ── GET profile ──
  if (req.method === "GET") {
    const snap = await db.collection("users").doc(user.uid).get();
    if (!snap.exists) return res.status(404).json({ error: "User not found" });
    return res.json(snap.data());
  }

  // ── POST → first login, create user + wallet + address ──
  if (req.method === "POST") {
    const userRef   = db.collection("users").doc(user.uid);
    const walletRef = db.collection("wallets").doc(user.uid);
    const addrRef   = db.collection("addresses").doc(user.uid);
    const userSnap  = await userRef.get();

    if (!userSnap.exists) {
      const depositAddress = generateDepositAddress(user.uid);
      const batch = db.batch();

      batch.set(userRef, {
        uid:       user.uid,
        phone:     user.phone_number || "",
        email:     user.email || "",
        name:      user.name || user.email || "",
        pan: "", aadhaar: "", dob: "",
        kycStatus: "pending",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      batch.set(walletRef, {
        uid:            user.uid,
        balance:        0,
        totalDeposited: 0,
        totalWithdrawn: 0,
        updatedAt:      admin.firestore.FieldValue.serverTimestamp(),
      });

      batch.set(addrRef, {
        uid:       user.uid,
        address:   depositAddress,
        network:   "TRC-20",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      await batch.commit();
      return res.json({
        isNew: true, uid: user.uid,
        phone: user.phone_number || "",
        email: user.email || "",
        depositAddress,
      });
    }

    const [addrSnap, walletSnap] = await Promise.all([
      addrRef.get(),
      walletRef.get(),
    ]);
    return res.json({
      isNew: false,
      ...userSnap.data(),
      depositAddress: addrSnap.exists ? addrSnap.data().address : null,
      balance:        walletSnap.exists ? walletSnap.data().balance : 0,
    });
  }

  // ── PATCH → update profile ──
  if (req.method === "PATCH") {
    const { error, value } = profileSchema.validate(req.body, { stripUnknown: true });
    if (error) throw { status: 400, message: error.details[0].message };

    await db.collection("users").doc(user.uid).update({
      ...value,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return res.json({ ok: true });
  }

  res.status(405).json({ error: "Method not allowed" });
}, { maxReqs: 30, windowMs: 60_000 });

function generateDepositAddress(uid) {
  // ⚠️ Replace with real HD wallet derivation in production (see README)
  const hash = crypto.createHash("sha256").update("zapcash-" + uid).digest("hex");
  return "T" + hash.slice(0, 33).toUpperCase();
}
