/**
 * api/withdraw.js  →  /api/withdraw
 *
 * GET    /api/withdraw           → withdrawal history
 * POST   /api/withdraw           → submit withdrawal request
 * GET    /api/withdraw?bank=1    → fetch saved bank account
 * POST   /api/withdraw?bank=1    → save bank account
 * DELETE /api/withdraw?id=xxx    → cancel pending request
 */

const { admin, db } = require("../lib/firebase");
const { verifyToken, handle } = require("../lib/middleware");
const { DEFAULT_RATE, DEFAULT_FEE_PCT, DEFAULT_SELLING_RATE, MIN_AMOUNT_USDT, SHEET_WEBHOOK } = require("../lib/constants");
const Joi = require("joi");

const bankSchema = Joi.object({
  holderName:  Joi.string().min(2).max(80).required(),
  bankName:    Joi.string().min(2).max(80).required(),
  accountNo:   Joi.string().pattern(/^\d{9,18}$/).required(),
  ifsc:        Joi.string().pattern(/^[A-Z]{4}0[A-Z0-9]{6}$/).required(),
  accountType: Joi.string().valid("savings", "current").default("savings"),
});

const withdrawSchema = Joi.object({
  amountUSDT: Joi.number().positive().min(MIN_AMOUNT_USDT).required()
    .messages({ "number.min": `Minimum withdrawal is ${MIN_AMOUNT_USDT} USDT` }),
});

/**
 * Calculate payout using selling app mechanism:
 * grossINR = amountUSDT × zapcashRate
 * wholeUSDT = floor(grossINR / sellingRate)  ← whole units only
 * netINR = wholeUSDT × sellingRate            ← what selling app pays
 * tax = grossINR - netINR                     ← shown to user as "tax"
 */
function calcPayout(amountUSDT, zapcashRate, sellingRate) {
  const grossINR   = amountUSDT * zapcashRate;
  const wholeUSDT  = Math.floor(grossINR / sellingRate);
  const netINR     = wholeUSDT * sellingRate;
  const tax        = grossINR - netINR;
  return {
    grossINR:   +grossINR.toFixed(2),
    netINR:     +netINR.toFixed(2),
    tax:        +tax.toFixed(2),
    wholeUSDT,
    feeINR:     +tax.toFixed(2),  // tax acts as the fee
  };
}

module.exports = handle(async (req, res) => {
  const user = await verifyToken(req);

  // ── Bank account ──
  if (req.query?.bank === "1") {
    if (req.method === "GET") {
      const snap = await db.collection("users").doc(user.uid).get();
      return res.json(snap.data()?.bank || null);
    }
    if (req.method === "POST") {
      // Handle banks array (multiple accounts)
      if (req.body?.banks !== undefined) {
        const banks = req.body.banks;
        if (!Array.isArray(banks)) throw { status: 400, message: "banks must be an array" };
        // Set first as default if none set
        if (banks.length > 0 && !banks.some(b => b.isDefault)) banks[0].isDefault = true;
        await db.collection("users").doc(user.uid).update({
          banks,
          bank: banks.find(b => b.isDefault) || banks[0] || null,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        return res.json({ ok: true, banks });
      }
      // Legacy single bank
      const { error, value } = bankSchema.validate(req.body, { stripUnknown: true });
      if (error) throw { status: 400, message: error.details[0].message };
      const masked = "•".repeat(value.accountNo.length - 4) + value.accountNo.slice(-4);
      await db.collection("users").doc(user.uid).update({
        bank:      { ...value, masked },
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      return res.json({ ok: true, bank: { ...value, masked } });
    }
  }

  // ── Cancel withdrawal ──
  if (req.method === "DELETE" && req.query?.id) {
    const wid = String(req.query.id).trim();
    await db.runTransaction(async (t) => {
      const wRef  = db.collection("withdrawals").doc(wid);
      const wSnap = await t.get(wRef);
      if (!wSnap.exists)          throw { status: 404, message: "Not found" };
      const w = wSnap.data();
      if (w.uid !== user.uid)     throw { status: 403, message: "Forbidden" };
      if (w.status !== "pending") throw { status: 400, message: "Cannot cancel a processed request" };
      t.update(db.collection("wallets").doc(user.uid), {
        balance:        admin.firestore.FieldValue.increment(w.amountUSDT),
        totalWithdrawn: admin.firestore.FieldValue.increment(-w.amountUSDT),
        updatedAt:      admin.firestore.FieldValue.serverTimestamp(),
      });
      t.update(wRef, { status: "cancelled", updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    });
    return res.json({ ok: true });
  }

  // ── Withdrawal history ──
  if (req.method === "GET") {
    const snap = await db.collection("withdrawals")
      .where("uid", "==", user.uid)
      .orderBy("createdAt", "desc")
      .limit(50)
      .get();
    return res.json(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
  }

  // ── Submit withdrawal ──
  if (req.method === "POST") {
    const { error, value } = withdrawSchema.validate(req.body, { stripUnknown: true });
    if (error) throw { status: 400, message: error.details[0].message };

    const result = await db.runTransaction(async (t) => {
      const walletRef = db.collection("wallets").doc(user.uid);
      const userRef   = db.collection("users").doc(user.uid);
      const [walletSnap, userSnap, rateSnap] = await Promise.all([
        t.get(walletRef),
        t.get(userRef),
        t.get(db.collection("config").doc("rate")),
      ]);

      if (!walletSnap.exists) throw { status: 404, message: "Wallet not found" };
      const wallet      = walletSnap.data();
      const u           = userSnap.data();
      const rateData    = rateSnap.exists ? rateSnap.data() : {};
      const zapcashRate = rateData.inr         || DEFAULT_RATE;
      const sellingRate = rateData.sellingRate  || DEFAULT_SELLING_RATE;

      const activeBank = (u?.banks?.find(b=>b.isDefault)) || u?.banks?.[0] || u?.bank;
      if (!activeBank)                             throw { status: 400, message: "Save bank account first" };
      u.bank = activeBank;  // use active/default bank
      if (wallet.balance < value.amountUSDT)     throw { status: 400, message: "Insufficient balance" };
      if (u.kycStatus !== "verified")            throw { status: 400, message: "KYC verification required before withdrawing" };

      const { grossINR, netINR, tax, feeINR, wholeUSDT } = calcPayout(value.amountUSDT, zapcashRate, sellingRate);

      t.update(walletRef, {
        balance:        admin.firestore.FieldValue.increment(-value.amountUSDT),
        totalWithdrawn: admin.firestore.FieldValue.increment(value.amountUSDT),
        updatedAt:      admin.firestore.FieldValue.serverTimestamp(),
      });

      const wRef = db.collection("withdrawals").doc();
      t.set(wRef, {
        id: wRef.id, uid: user.uid,
        phone:      u.phone  || "",
        email:      u.email  || "",
        name:       u.name   || u.email || "User",
        amountUSDT: value.amountUSDT,
        rate:       zapcashRate,
        sellingRate,
        grossINR, netINR, tax, feeINR, wholeUSDT,
        bank:       u.bank,
        status:     "pending",
        adminNote:  "",
        createdAt:  admin.firestore.FieldValue.serverTimestamp(),
        updatedAt:  admin.firestore.FieldValue.serverTimestamp(),
      });

      const txRef = db.collection("transactions").doc();
      t.set(txRef, {
        id: txRef.id, uid: user.uid,
        type:       "withdraw",
        amountUSDT: value.amountUSDT,
        netINR,
        status:     "pending",
        wid:        wRef.id,
        createdAt:  admin.firestore.FieldValue.serverTimestamp(),
      });

      return {
        wid: wRef.id, netINR, grossINR, feeINR, tax, wholeUSDT,
        uid: user.uid,
        name: u.name || u.email || "",
        email: u.email || "",
        phone: u.phone || "",
        bank:  u.bank,
        rate:  zapcashRate,
        sellingRate,
        amountUSDT: value.amountUSDT,
      };
    });

    // Google Sheets
    fetch(SHEET_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "pending",
        wid:        result.wid,
        name:       result.name,
        email:      result.email,
        phone:      result.phone,
        amountUSDT: result.amountUSDT,
        rate:       result.rate,
        grossINR:   result.grossINR,
        feeINR:     result.feeINR,
        netINR:     result.netINR,
        bank:       result.bank,
        createdAt:  Date.now(),
      }),
    }).catch((err) => console.error("Sheet webhook error:", err));

    return res.json({ ok: true, ...result });
  }

  res.status(405).json({ error: "Method not allowed" });
}, { maxReqs: 20, windowMs: 60_000 });
