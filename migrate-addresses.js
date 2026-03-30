/**
 * migrate-addresses.js
 * Run once: node migrate-addresses.js
 * Generates real TRC-20 addresses for all existing users with fake addresses
 */

require("dotenv").config();
const admin = require("firebase-admin");
const crypto = require("crypto");
const sa = require("./service-account.json");

admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();

const ENCRYPT_KEY = Buffer.from(process.env.WALLET_ENCRYPT_KEY || "", "hex");

function encryptKey(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", ENCRYPT_KEY, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return iv.toString("hex") + ":" + enc.toString("hex") + ":" + tag.toString("hex");
}

async function generateTronWallet() {
  const { TronWeb } = require("tronweb");
  const tronWeb = new TronWeb({ fullHost: "https://api.trongrid.io" });
  const account = await tronWeb.createAccount();
  return { address: account.address.base58, privateKey: account.privateKey };
}

function isFakeAddress(addr) {
  if (!addr) return true;
  if (addr.length !== 34) return true;
  if (!addr.startsWith("T")) return true;
  // Our old fake format: T + 33 hex uppercase chars
  if (/^T[0-9A-F]{33}$/.test(addr)) return true;
  return false;
}

async function migrate() {
  if (ENCRYPT_KEY.length !== 32) {
    console.error("❌ WALLET_ENCRYPT_KEY must be 64 hex chars (32 bytes). Run:");
    console.error('   node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
    process.exit(1);
  }

  const usersSnap = await db.collection("users").get();
  console.log(`Found ${usersSnap.size} users`);

  let migrated = 0, skipped = 0, errors = 0;

  for (const userDoc of usersSnap.docs) {
    const uid = userDoc.id;
    try {
      const addrSnap = await db.collection("addresses").doc(uid).get();
      const currentAddr = addrSnap.exists ? addrSnap.data().address : null;

      if (!isFakeAddress(currentAddr)) {
        console.log(`✓ ${uid} — already has real address: ${currentAddr}`);
        skipped++;
        continue;
      }

      const { address, privateKey } = await generateTronWallet();
      const encryptedKey = encryptKey(privateKey);

      await db.collection("addresses").doc(uid).set({
        uid,
        address,
        encryptedKey,
        network:    "TRC-20",
        migratedAt: admin.firestore.FieldValue.serverTimestamp(),
        createdAt:  addrSnap.exists ? addrSnap.data().createdAt : admin.firestore.FieldValue.serverTimestamp(),
      });

      // Also update wallet with depositAddress for easy access
      await db.collection("wallets").doc(uid).update({
        depositAddress: address,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }).catch(() => {});

      console.log(`✅ ${uid} — migrated to: ${address}`);
      migrated++;

      // Small delay to avoid rate limiting
      await new Promise(r => setTimeout(r, 200));

    } catch(e) {
      console.error(`❌ ${uid} — error: ${e.message}`);
      errors++;
    }
  }

  console.log(`\n=== Migration Complete ===`);
  console.log(`✅ Migrated: ${migrated}`);
  console.log(`⏭  Skipped:  ${skipped}`);
  console.log(`❌ Errors:   ${errors}`);
  process.exit(0);
}

migrate();
