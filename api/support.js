/**
 * api/support.js → /api/support
 */

const { admin, db } = require("../lib/firebase");
const { verifyToken, verifyAdmin, handle } = require("../lib/middleware");

module.exports = handle(async (req, res) => {
  const user = await verifyToken(req);
  const { action, id } = req.query || {};

  // ── Get messages for a ticket ──
  if (req.method === "GET" && req.query?.messages === "1" && id) {
    const ticketSnap = await db.collection("tickets").doc(id).get();
    if (!ticketSnap.exists) throw { status: 404, message: "Ticket not found" };
    const ticket = ticketSnap.data();
    // Allow ticket owner or admin
    const tokenResult = await admin.auth().verifyIdToken(req.headers.authorization?.replace("Bearer ", ""));
    if (ticket.uid !== user.uid && !tokenResult.admin) throw { status: 403, message: "Forbidden" };
    const snap = await db.collection("tickets").doc(id).collection("messages")
      .orderBy("createdAt", "asc").limit(100).get();
    return res.json(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  }

  // ── Admin: get all tickets ──
  if (req.method === "GET" && req.query?.admin === "1") {
    await verifyAdmin(req);
    const snap = await db.collection("tickets").orderBy("createdAt", "desc").limit(100).get();
    return res.json(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  }

  // ── User: get own tickets ──
  if (req.method === "GET") {
    const snap = await db.collection("tickets").where("uid", "==", user.uid).limit(20).get();
    const docs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    docs.sort((a,b) => (b.createdAt?._seconds||0) - (a.createdAt?._seconds||0));
    return res.json(docs);
  }

  // ── Send message ──
  if (req.method === "POST" && action === "message" && id) {
    const { message } = req.body || {};
    if (!message?.trim()) throw { status: 400, message: "Message required" };

    const ticketSnap = await db.collection("tickets").doc(id).get();
    if (!ticketSnap.exists) throw { status: 404, message: "Ticket not found" };
    const ticket = ticketSnap.data();

    const tokenResult = await admin.auth().verifyIdToken(req.headers.authorization?.replace("Bearer ", ""));
    const isAdminUser = tokenResult.admin === true;

    if (!isAdminUser && ticket.uid !== user.uid) throw { status: 403, message: "Forbidden" };

    const senderRole = isAdminUser ? "admin" : "user";
    const senderName = isAdminUser ? "Support Team" : (ticket.userName || "User");

    const msgRef = db.collection("tickets").doc(id).collection("messages").doc();
    const batch  = db.batch();

    batch.set(msgRef, {
      id: msgRef.id, message: message.trim(),
      senderRole, senderName, uid: user.uid,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    batch.update(db.collection("tickets").doc(id), {
      status:        isAdminUser ? "replied" : "open",
      lastMessage:   message.trim().slice(0, 100),
      lastMessageAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt:     admin.firestore.FieldValue.serverTimestamp(),
    });

    await batch.commit();
    return res.json({ ok: true, id: msgRef.id });
  }

  // ── Close ticket ──
  if (req.method === "POST" && action === "close" && id) {
    await verifyAdmin(req);
    await db.collection("tickets").doc(id).update({
      status: "closed",
      closedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return res.json({ ok: true });
  }

  // ── Submit new ticket ──
  if (req.method === "POST") {
    const { category, subject, message } = req.body || {};
    if (!subject?.trim()) throw { status: 400, message: "Subject required" };
    if (!message?.trim()) throw { status: 400, message: "Message required" };

    const userSnap = await db.collection("users").doc(user.uid).get();
    const u = userSnap.data() || {};

    const ref   = db.collection("tickets").doc();
    const batch = db.batch();

    batch.set(ref, {
      id: ref.id, uid: user.uid,
      userEmail:    u.email || "",
      userName:     u.name  || u.email || "User",
      category:     category || "other",
      subject:      subject.trim(),
      status:       "open",
      lastMessage:  message.trim().slice(0, 100),
      lastMessageAt: admin.firestore.FieldValue.serverTimestamp(),
      createdAt:    admin.firestore.FieldValue.serverTimestamp(),
      updatedAt:    admin.firestore.FieldValue.serverTimestamp(),
    });

    const msgRef = ref.collection("messages").doc();
    batch.set(msgRef, {
      id: msgRef.id, message: message.trim(),
      senderRole: "user", senderName: u.name || u.email || "User",
      uid: user.uid,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    await batch.commit();
    return res.json({ ok: true, id: ref.id });
  }

  res.status(405).json({ error: "Method not allowed" });
}, { maxReqs: 60, windowMs: 60_000 });
