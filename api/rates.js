/**
 * api/rates.js  →  /api/rates
 * GET  /api/rates           → current rate (public)
 * GET  /api/rates?history=1 → rate history (public)
 * POST /api/rates           → update rate (admin only)
 */

const { admin, db } = require("../lib/firebase");
const { verifyAdmin, handle } = require("../lib/middleware");
const { DEFAULT_RATE, DEFAULT_FEE_PCT, MIN_AMOUNT_USDT } = require("../lib/constants");
const Joi = require("joi");

const rateSchema = Joi.object({
  inr:             Joi.number().positive().required()
                     .messages({ "number.base": "Valid inr rate required" }),
  feePct:          Joi.number().min(0).max(0.1).optional(),
  minWithdrawUSDT: Joi.number().positive().optional(),
});

module.exports = handle(async (req, res) => {

  // ── GET rate or history (no auth needed) ──
  if (req.method === "GET") {
    if (req.query?.history === "1") {
      const snap = await db.collection("rateHistory")
        .orderBy("loggedAt", "desc")
        .limit(30)
        .get();
      return res.json(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    }
    const snap = await db.collection("config").doc("rate").get();
    return res.json(
      snap.exists
        ? snap.data()
        : { inr: DEFAULT_RATE, feePct: DEFAULT_FEE_PCT, minWithdrawUSDT: MIN_AMOUNT_USDT }
    );
  }

  // ── POST rate update (admin only) ──
  if (req.method === "POST") {
    await verifyAdmin(req);

    const { error, value } = rateSchema.validate(req.body, { stripUnknown: true });
    if (error) throw { status: 400, message: error.details[0].message };

    const update = {
      inr:             +value.inr.toFixed(4),
      feePct:          value.feePct !== undefined ? +value.feePct.toFixed(4) : DEFAULT_FEE_PCT,
      minWithdrawUSDT: value.minWithdrawUSDT || MIN_AMOUNT_USDT,
      updatedAt:       admin.firestore.FieldValue.serverTimestamp(),
    };

    await db.collection("config").doc("rate").set(update, { merge: true });
    await db.collection("rateHistory").add({
      ...update,
      loggedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return res.json({ ok: true, ...update });
  }

  res.status(405).json({ error: "Method not allowed" });
}, { maxReqs: 30, windowMs: 60_000 });
