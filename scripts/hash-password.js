// Usage: node scripts/hash-password.js "YourNewPassword123!"
// Prints a bcrypt hash you can paste into admin_users.password_hash.
const bcrypt = require("bcryptjs");
const pw = process.argv[2];
if (!pw || pw.length < 10) {
  console.error('Usage: node scripts/hash-password.js "a-password-of-10+-characters"');
  process.exit(1);
}
bcrypt.hash(pw, 12).then((h) => console.log(h));
