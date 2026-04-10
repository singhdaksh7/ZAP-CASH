/**
 * lib/firebase.js
 * Firebase Admin SDK singleton.
 * Vercel serverless functions are stateless — this pattern ensures
 * we only initialise the app once per warm instance.
 *
 * Required environment variables (set in Vercel Dashboard):
 *   FIREBASE_PROJECT_ID
 *   FIREBASE_CLIENT_EMAIL
 *   FIREBASE_PRIVATE_KEY      ← paste the full key, Vercel handles newlines
 */

const admin = require("firebase-admin");

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId:   process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      // Handle all .env formats: escaped \n, real newlines, Windows CRLF, stray quotes
      privateKey: (process.env.FIREBASE_PRIVATE_KEY || "")
        .replace(/\\n/g, "\n")       // escaped \n  → real newline
        .replace(/\r\n/g, "\n")      // Windows CRLF → real newline
        .replace(/\r/g, "\n")        // lone \r      → real newline
        .replace(/^["']|["']$/g, ""), // strip surrounding quotes
    }),
  });
}

const db   = admin.firestore();
const auth = admin.auth();

module.exports = { admin, db, auth };
