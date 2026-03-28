/**
 * api/support.js → /api/support
 * GET  /api/support           → user's tickets
 * GET  /api/support?admin=1   → all tickets (admin)
 * POST /api/support           → submit ticket
 * POST /api/support?action=reply&id=xxx  → admin reply
 * POST /api/support?action=close&id=xxx  → close ticket
 */

const { admin, db } = require("../lib/firebase");
const { verifyToken, verifyAdmin, handle } = require("../lib/middleware");

module.exports = handle(async (req, res) => {
  const user = await verifyToken(req);
  const { action, id } = req.query || {};

  // ── Admin: get all tickets ──
  if (req.method === "GET" && req.query?.admin === "1") {
    await verifyAdmin(req);
    const snap = await db.collection("tickets")
      .orderBy("createdAt", "desc")
      .limit(100)
      .get();
    return res.json(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  }

  // ── User: get own tickets ──
  if (req.method === "GET") {
    const snap = await db.collection("tickets")
      .where("uid", "==", user.uid)
      .limit(20)
      .get();
    const docs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    docs.sort((a,b) => (b.createdAt?._seconds||b.createdAt?.seconds||0) - (a.createdAt?._seconds||a.createdAt?.seconds||0));
    return res.json(docs);
  }

  // ── Admin: reply to ticket ──
  if (req.method === "POST" && action === "reply" && id) {
    await verifyAdmin(req);
    const { reply } = req.body || {};
    if (!reply) throw { status: 400, message: "Reply required" };
    await db.collection("tickets").doc(id).update({
      reply,
      status:    "replied",
      repliedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return res.json({ ok: true });
  }

  // ── Admin: close ticket ──
  if (req.method === "POST" && action === "close" && id) {
    await verifyAdmin(req);
    await db.collection("tickets").doc(id).update({
      status:   "closed",
      closedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return res.json({ ok: true });
  }

  // ── User: submit ticket ──
  if (req.method === "POST") {
    const { category, subject, message } = req.body || {};
    if (!subject?.trim()) throw { status: 400, message: "Subject required" };
    if (!message?.trim()) throw { status: 400, message: "Message required" };

    const userSnap = await db.collection("users").doc(user.uid).get();
    const u = userSnap.data() || {};

    const ref = db.collection("tickets").doc();
    await ref.set({
      id:        ref.id,
      uid:       user.uid,
      userEmail: u.email || "",
      userName:  u.name  || u.email || "User",
      category:  category || "other",
      subject:   subject.trim(),
      message:   message.trim(),
      status:    "open",
      reply:     null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return res.json({ ok: true, id: ref.id });
  }

  res.status(405).json({ error: "Method not allowed" });
}, { maxReqs: 30, windowMs: 60_000 });
