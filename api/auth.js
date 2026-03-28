/**
 * api/auth.js  →  /api/auth
 */

const { admin, db } = require("../lib/firebase");
const { verifyToken, handle } = require("../lib/middleware");
const Joi = require("joi");

const profileSchema = Joi.object({
  name:         Joi.string().min(2).max(80).optional(),
  email:        Joi.string().email({ tlds: { allow: false } }).optional(),
  dob:          Joi.string().pattern(/^\d{2}\/\d{2}\/\d{4}$/).optional()
                  .messages({ "string.pattern.base": "dob must be DD/MM/YYYY" }),
  avatar:       Joi.string().max(10).optional(),
  phone:        Joi.string().max(20).optional(),
  pendingEmail: Joi.string().email({ tlds: { allow: false } }).optional(),
  emailOtp:     Joi.string().max(10).optional(),
}).min(1).messages({ "object.min": "Nothing to update" });

async function generatePaymentId() {
  const counterRef = db.collection("config").doc("paymentIdCounter");
  const newId = await db.runTransaction(async (t) => {
    const snap = await t.get(counterRef);
    const current = snap.exists ? (snap.data().count || 0) : 0;
    const next = current + 1;
    t.set(counterRef, { count: next }, { merge: true });
    return next;
  });
  return "ZAP-" + String(newId).padStart(5, "0");
}

module.exports = handle(async (req, res) => {
  const user = await verifyToken(req);

  if (req.method === "GET") {
    const snap = await db.collection("users").doc(user.uid).get();
    if (!snap.exists) return res.status(404).json({ error: "User not found" });
    return res.json(snap.data());
  }

  if (req.method === "POST") {
    const userRef   = db.collection("users").doc(user.uid);
    const walletRef = db.collection("wallets").doc(user.uid);
    const userSnap  = await userRef.get();

    if (!userSnap.exists) {
      const paymentId = await generatePaymentId();
      const batch = db.batch();
      batch.set(userRef, {
        uid: user.uid, phone: user.phone_number || "", email: user.email || "",
        name: req.body?.name || user.name || user.email || "",
        pan: "", aadhaar: "", dob: "", kycStatus: "pending", paymentId,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      batch.set(walletRef, {
        uid: user.uid, balance: 0, totalDeposited: 0, totalWithdrawn: 0, paymentId,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      await batch.commit();
      return res.json({ isNew: true, uid: user.uid, phone: user.phone_number || "", email: user.email || "", paymentId });
    }

    const walletSnap = await walletRef.get();
    let paymentId = userSnap.data().paymentId;

    if (!paymentId) {
      paymentId = await generatePaymentId();
      const batch = db.batch();
      batch.update(userRef,   { paymentId, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
      batch.update(walletRef, { paymentId, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
      await batch.commit();
    }

    return res.json({
      isNew: false, ...userSnap.data(), paymentId,
      balance: walletSnap.exists ? walletSnap.data().balance : 0,
    });
  }

  if (req.method === "PATCH") {
    const { error, value } = profileSchema.validate(req.body, { stripUnknown: true });
    if (error) throw { status: 400, message: error.details[0].message };
    await db.collection("users").doc(user.uid).update({ ...value, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    return res.json({ ok: true });
  }

  res.status(405).json({ error: "Method not allowed" });
}, { maxReqs: 30, windowMs: 60_000 });
