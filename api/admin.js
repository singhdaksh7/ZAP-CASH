/**
 * api/admin.js  →  /api/admin
 */

const { admin, db } = require("../lib/firebase");
const { sendWithdrawalApproved, sendWithdrawalRejected, sendKYCVerified, sendKYCRejected } = require("../lib/email");
const { verifyAdmin, handle } = require("../lib/middleware");
const { DEFAULT_RATE, SHEET_WEBHOOK } = require("../lib/constants");

const PAGE_SIZE = 50;
function parsePage(q) { const n = parseInt(q, 10); return Number.isFinite(n) && n > 0 ? n : 1; }

module.exports = handle(async (req, res) => {
  const adminUser = await verifyAdmin(req);
  const { action, id, uid } = req.query || {};

  if (action === "stats" && req.method === "GET") {
    const [usersSnap, pendingSnap, walletsSnap, rateSnap] = await Promise.all([
      db.collection("users").get(),
      db.collection("withdrawals").where("status","==","pending").get(),
      db.collection("wallets").get(),
      db.collection("config").doc("rate").get(),
    ]);
    let totalDeposited=0, totalWithdrawn=0;
    walletsSnap.forEach(d => { totalDeposited+=d.data().totalDeposited||0; totalWithdrawn+=d.data().totalWithdrawn||0; });
    const kycCounts={pending:0,submitted:0,verified:0,rejected:0};
    usersSnap.forEach(d => { const s=d.data().kycStatus||"pending"; if(kycCounts[s]!==undefined) kycCounts[s]++; });
    const rate=rateSnap.exists?rateSnap.data().inr:DEFAULT_RATE;
    return res.json({ totalUsers:usersSnap.size, pendingRequests:pendingSnap.size, totalUSDTDeposited:+totalDeposited.toFixed(6), totalINRPaid:+(totalWithdrawn*rate).toFixed(2), rate, kyc:kycCounts });
  }

  if (action === "withdrawals" && req.method === "GET") {
    const snap = await db.collection("withdrawals").where("status","==","pending").orderBy("createdAt","asc").get();
    const withdrawals = snap.docs.map(d => ({ id:d.id, ...d.data() }));
    const uids = [...new Set(withdrawals.map(w => w.uid))];
    const userDocs = await Promise.all(uids.map(u => db.collection("users").doc(u).get()));
    const userMap = {};
    userDocs.forEach(d => { if(d.exists) userMap[d.id]=d.data(); });
    return res.json(withdrawals.map(w => ({ ...w, email:userMap[w.uid]?.email||w.email||"", name:w.name||userMap[w.uid]?.name||userMap[w.uid]?.email||"Unknown" })));
  }

  if (action === "users" && req.method === "GET") {
    const page=parsePage(req.query.page), limit=PAGE_SIZE;
    let query=db.collection("users").orderBy("createdAt","desc").limit(limit);
    if(page>1){const os=await db.collection("users").orderBy("createdAt","desc").limit((page-1)*limit).get();if(!os.empty)query=query.startAfter(os.docs[os.docs.length-1]);}
    const snap=await query.get();
    return res.json({ page, pageSize:limit, items:snap.docs.map(d=>({id:d.id,...d.data()})) });
  }

  if (action === "users-with-wallets" && req.method === "GET") {
    const page=parsePage(req.query.page), limit=PAGE_SIZE;
    let uQuery=db.collection("users").orderBy("createdAt","desc").limit(limit);
    if(page>1){const os=await db.collection("users").orderBy("createdAt","desc").limit((page-1)*limit).get();if(!os.empty)uQuery=uQuery.startAfter(os.docs[os.docs.length-1]);}
    const [usersSnap,walletsSnap]=await Promise.all([uQuery.get(),db.collection("wallets").get()]);
    const walletMap={};
    walletsSnap.forEach(d=>{walletMap[d.id]=d.data();});
    return res.json({ page, pageSize:limit, items:usersSnap.docs.map(d=>{const u=d.data(),w=walletMap[d.id]||{};return{id:d.id,uid:d.id,...u,balance:w.balance||0,totalDeposited:w.totalDeposited||0,totalWithdrawn:w.totalWithdrawn||0};}) });
  }

  if (action === "user" && uid && req.method === "GET") {
    const [uSnap,wSnap,kycSnap]=await Promise.all([db.collection("users").doc(uid).get(),db.collection("wallets").doc(uid).get(),db.collection("kyc").doc(uid).get()]);
    if(!uSnap.exists) return res.status(404).json({error:"User not found"});
    return res.json({...uSnap.data(),wallet:wSnap.data()||null,kyc:kycSnap.data()||null});
  }

  // ── DELETE USER (all data + Firebase Auth) ──
  if (action === "delete-user" && uid && req.method === "DELETE") {
    if (uid === adminUser.uid) throw { status: 400, message: "Cannot delete your own account" };

    // Delete fixed collections
    await Promise.all(
      ["users","wallets","kyc","addresses"].map(col => db.collection(col).doc(uid).delete().catch(()=>{}))
    );

    // Delete transactions in batch
    const [txSnap, wSnap, dSnap] = await Promise.all([
      db.collection("transactions").where("uid","==",uid).get(),
      db.collection("withdrawals").where("uid","==",uid).get(),
      db.collection("deposits").where("uid","==",uid).get(),
    ]);

    const deleteBatch = db.batch();
    [...txSnap.docs, ...wSnap.docs, ...dSnap.docs].forEach(d => deleteBatch.delete(d.ref));
    await deleteBatch.commit();

    // Delete Firebase Auth account
    await admin.auth().deleteUser(uid).catch(() => {});

    return res.json({ ok: true, deleted: uid });
  }

  if (action === "approve" && id && req.method === "POST") {
    const { note="", utr="" } = req.body||{};
    if (!utr) throw { status:400, message:"UTR number required for approval" };
    let wData;
    await db.runTransaction(async t => {
      const wRef=db.collection("withdrawals").doc(id), wSnap=await t.get(wRef);
      if(!wSnap.exists) throw {status:404,message:"Not found"};
      if(wSnap.data().status!=="pending") throw {status:400,message:"Already processed"};
      wData=wSnap.data();
      t.update(wRef,{status:"approved",approvedBy:adminUser.uid,approvedAt:admin.firestore.FieldValue.serverTimestamp(),adminNote:note,utr,updatedAt:admin.firestore.FieldValue.serverTimestamp()});
      const txSnap=await db.collection("transactions").where("wid","==",id).limit(1).get();
      if(!txSnap.empty) t.update(txSnap.docs[0].ref,{status:"paid",utr});
    });
    const u=(await db.collection("users").doc(wData.uid).get()).data()||{};
    fetch(SHEET_WEBHOOK,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"approved",wid:id,name:u.name||u.email||"",email:u.email||"",phone:u.phone||"",amountUSDT:wData.amountUSDT,rate:wData.rate,grossINR:wData.grossINR,feeINR:wData.feeINR,netINR:wData.netINR,bank:wData.bank,utr,note,approvedAt:Date.now()})}).catch(e=>console.error("Sheet:",e));
    // Send approval email
    if (u.email) sendWithdrawalApproved({
      to: u.email, name: u.name||u.email||"User",
      amountUSDT: wData.amountUSDT, netINR: wData.netINR,
      utr, bank: wData.bank,
      date: new Date().toLocaleString("en-IN",{timeZone:"Asia/Kolkata"}),
    }).catch(e=>console.error("Email:",e));
    return res.json({ ok:true });
  }

  if (action === "reject" && id && req.method === "POST") {
    const { note="", reason="" } = req.body||{};
    if (!reason) throw { status:400, message:"Rejection reason required" };
    let wData;
    await db.runTransaction(async t => {
      const wRef=db.collection("withdrawals").doc(id), wSnap=await t.get(wRef);
      if(!wSnap.exists) throw {status:404,message:"Not found"};
      const w=wSnap.data();
      if(w.status!=="pending") throw {status:400,message:"Already processed"};
      wData=w;
      t.update(db.collection("wallets").doc(w.uid),{balance:admin.firestore.FieldValue.increment(w.amountUSDT),totalWithdrawn:admin.firestore.FieldValue.increment(-w.amountUSDT),updatedAt:admin.firestore.FieldValue.serverTimestamp()});
      t.update(wRef,{status:"rejected",rejectedBy:adminUser.uid,rejectedAt:admin.firestore.FieldValue.serverTimestamp(),adminNote:note,reason,updatedAt:admin.firestore.FieldValue.serverTimestamp()});
      const txSnap=await db.collection("transactions").where("wid","==",id).limit(1).get();
      if(!txSnap.empty) t.update(txSnap.docs[0].ref,{status:"failed"});
    });
    const u=(await db.collection("users").doc(wData.uid).get()).data()||{};
    fetch(SHEET_WEBHOOK,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"rejected",wid:id,name:u.name||u.email||"",email:u.email||"",phone:u.phone||"",amountUSDT:wData.amountUSDT,netINR:wData.netINR,bank:wData.bank,reason,note,rejectedAt:Date.now()})}).catch(e=>console.error("Sheet:",e));
    // Send rejection email + get updated balance
    if (u.email) {
      const wSnap = await db.collection("wallets").doc(wData.uid).get();
      const newBal = wSnap.exists ? (wSnap.data().balance||0).toFixed(2) : "—";
      sendWithdrawalRejected({
        to: u.email, name: u.name||u.email||"User",
        amountUSDT: wData.amountUSDT, reason, refundedBalance: newBal,
      }).catch(e=>console.error("Email:",e));
    }
    return res.json({ ok:true });
  }

  if (action === "kyc-approve" && uid && req.method === "POST") {
    const batch=db.batch();
    batch.update(db.collection("users").doc(uid),{kycStatus:"verified",kycVerifiedAt:admin.firestore.FieldValue.serverTimestamp(),updatedAt:admin.firestore.FieldValue.serverTimestamp()});
    batch.update(db.collection("kyc").doc(uid),{status:"verified",verifiedBy:adminUser.uid,verifiedAt:admin.firestore.FieldValue.serverTimestamp()});
    await batch.commit();
    return res.json({ ok:true });
  }

  if (action === "kyc-reject" && uid && req.method === "POST") {
    const reason=req.body?.reason||"";
    if(!reason) throw {status:400,message:"Rejection reason required"};
    const batch=db.batch();
    batch.update(db.collection("users").doc(uid),{kycStatus:"rejected",kycRejectedReason:reason,updatedAt:admin.firestore.FieldValue.serverTimestamp()});
    batch.update(db.collection("kyc").doc(uid),{status:"rejected",rejectedBy:adminUser.uid,rejectedAt:admin.firestore.FieldValue.serverTimestamp(),reason});
    await batch.commit();
    return res.json({ ok:true });
  }

  if (action === "set-admin" && req.method === "POST") {
    const { uid:targetUid } = req.body||{};
    if(!targetUid) throw {status:400,message:"uid required"};
    await admin.auth().setCustomUserClaims(targetUid,{admin:true});
    return res.json({ ok:true });
  }

  if (action === "add-balance" && uid && req.method === "POST") {
    const { amount, note } = req.body||{};
    const amt=parseFloat(amount);
    if(!amount||!Number.isFinite(amt)||amt<=0) throw {status:400,message:"Valid positive amount required"};
    const batch=db.batch(), txRef=db.collection("transactions").doc();
    batch.update(db.collection("wallets").doc(uid),{balance:admin.firestore.FieldValue.increment(amt),totalDeposited:admin.firestore.FieldValue.increment(amt),updatedAt:admin.firestore.FieldValue.serverTimestamp()});
    batch.set(txRef,{id:txRef.id,uid,type:"admin_credit",amountUSDT:amt,status:"confirmed",note:note||"Admin credit",adminAction:true,adminUid:adminUser.uid,createdAt:admin.firestore.FieldValue.serverTimestamp()});
    await batch.commit();
    return res.json({ ok:true, amount:amt });
  }

  if (action === "remove-balance" && uid && req.method === "POST") {
    const { amount, note } = req.body||{};
    const amt=parseFloat(amount);
    if(!amount||!Number.isFinite(amt)||amt<=0) throw {status:400,message:"Valid positive amount required"};
    const walletSnap=await db.collection("wallets").doc(uid).get();
    const currentBal=walletSnap.exists?(walletSnap.data().balance||0):0;
    if(amt>currentBal) throw {status:400,message:`Insufficient balance. Current: ${currentBal.toFixed(6)} USDT`};
    const batch=db.batch(), txRef=db.collection("transactions").doc();
    batch.update(db.collection("wallets").doc(uid),{balance:admin.firestore.FieldValue.increment(-amt),updatedAt:admin.firestore.FieldValue.serverTimestamp()});
    batch.set(txRef,{id:txRef.id,uid,type:"admin_debit",amountUSDT:amt,status:"confirmed",note:note||"Admin debit",adminAction:true,adminUid:adminUser.uid,createdAt:admin.firestore.FieldValue.serverTimestamp()});
    await batch.commit();
    return res.json({ ok:true, amount:amt });
  }

  if (action === "kyc-list" && req.method === "GET") {
    const page=parsePage(req.query.page), limit=PAGE_SIZE, status=req.query.status;
    let query=status?db.collection("kyc").where("status","==",status).orderBy("submittedAt","desc").limit(limit):db.collection("kyc").orderBy("submittedAt","desc").limit(limit);
    if(page>1){const base=status?db.collection("kyc").where("status","==",status).orderBy("submittedAt","desc"):db.collection("kyc").orderBy("submittedAt","desc");const os=await base.limit((page-1)*limit).get();if(!os.empty)query=query.startAfter(os.docs[os.docs.length-1]);}
    const snap=await query.get();
    return res.json({ page, pageSize:limit, items:snap.docs.map(d=>({id:d.id,...d.data()})) });
  }

  res.status(400).json({ error:"Unknown action" });
}, { maxReqs:120, windowMs:60_000 });
