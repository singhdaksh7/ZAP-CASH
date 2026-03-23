/**
 * api/kyc.js  →  /api/kyc
 * GET  /api/kyc  → KYC status + limits
 * POST /api/kyc  → submit KYC details
 */

const { admin, db } = require("../lib/firebase");
const { verifyToken, handle } = require("../lib/middleware");
const Joi = require("joi");

const kycSchema = Joi.object({
  firstName: Joi.string().min(2).max(50).trim().required(),
  lastName:  Joi.string().min(2).max(50).trim().required(),
  email:     Joi.string().email({ tlds: { allow: false } }).required(),
  dob:       Joi.string().pattern(/^\d{2}\/\d{2}\/\d{4}$/).required()
               .messages({ "string.pattern.base": "dob must be DD/MM/YYYY" }),
  pan:       Joi.string().pattern(/^[A-Z]{5}[0-9]{4}[A-Z]{1}$/).uppercase().required()
               .messages({ "string.pattern.base": "Invalid PAN format (e.g. ABCDE1234F)" }),
  aadhaar:   Joi.string().pattern(/^\d{4}\s?\d{4}\s?\d{4}$/).required()
               .messages({ "string.pattern.base": "Aadhaar must be 12 digits" }),
});

const LIMITS = {
  pending:   { dailyWithdraw: 0,           monthlyWithdraw: 0 },
  submitted: { dailyWithdraw: 5000,        monthlyWithdraw: 50000 },
  verified:  { dailyWithdraw: "Unlimited", monthlyWithdraw: "Unlimited" },
  rejected:  { dailyWithdraw: 0,           monthlyWithdraw: 0 },
};

module.exports = handle(async (req, res) => {
  const user = await verifyToken(req);

  if (req.method === "GET") {
    const snap = await db.collection("users").doc(user.uid).get();
    if (!snap.exists) return res.status(404).json({ error: "User not found" });
    const { kycStatus, firstName, lastName, email, dob } = snap.data();
    return res.json({
      kycStatus,
      firstName,
      lastName,
      email,
      dob,
      limits: LIMITS[kycStatus] || LIMITS.pending,
    });
  }

  if (req.method === "POST") {
    const { error, value } = kycSchema.validate(req.body, { stripUnknown: true });
    if (error) throw { status: 400, message: error.details[0].message };

    const snap = await db.collection("users").doc(user.uid).get();
    if (snap.data()?.kycStatus === "verified") {
      throw { status: 400, message: "KYC already verified" };
    }

    // Normalise aadhaar: strip spaces
    value.aadhaar = value.aadhaar.replace(/\s/g, "");

    const batch = db.batch();
    batch.update(db.collection("users").doc(user.uid), {
      ...value,
      name:            `${value.firstName} ${value.lastName}`,
      kycStatus:       "submitted",
      kycSubmittedAt:  admin.firestore.FieldValue.serverTimestamp(),
      updatedAt:       admin.firestore.FieldValue.serverTimestamp(),
    });
    batch.set(db.collection("kyc").doc(user.uid), {
      uid:         user.uid,
      ...value,
      status:      "submitted",
      submittedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    await batch.commit();
    return res.json({ ok: true, kycStatus: "submitted" });
  }

  res.status(405).json({ error: "Method not allowed" });
}, { maxReqs: 10, windowMs: 60_000 });
