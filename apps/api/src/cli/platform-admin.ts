import { randomBytes } from "node:crypto";
import { createPool } from "../db.js";
import { migrate } from "../migrate.js";
import { ensurePlatformAdmin } from "../routes/platform.js";

/**
 * Creates the first platform admin, or resets an admin's password:
 *   pnpm --filter api platform-admin you@company.ae "Your Name"
 * Prints a random password unless PLATFORM_ADMIN_PASSWORD is set.
 */
const [email, name = "Platform admin"] = process.argv.slice(2);
if (!email) {
  console.error("Usage: platform-admin <email> [name]");
  process.exit(1);
}
const password = process.env.PLATFORM_ADMIN_PASSWORD ?? randomBytes(12).toString("base64url");
const db = createPool();
await migrate(db);
await ensurePlatformAdmin(db, email, name, password);
console.log(`Platform admin ${email} is ready. Password: ${password}`);
console.log("Sign in at the back office address with #/platform, then change it under Team.");
await db.end();
