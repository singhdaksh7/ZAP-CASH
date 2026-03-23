const admin = require("firebase-admin");
const serviceAccount = require("./service-account.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const UID = "jArogRVj5QW4rRz8gT0Eu2SLeAU2";

admin.auth().setCustomUserClaims(UID, { admin: true })
  .then(() => {
    console.log("✅ Admin granted to UID:", UID);
    process.exit(0);
  })
  .catch(err => {
    console.error("❌ Error:", err.message);
    process.exit(1);
  });
