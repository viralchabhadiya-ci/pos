import { createPool } from "../db.js";
import { createPairingCode } from "../seed.js";

const [registerId, role = "till"] = process.argv.slice(2);
const ROLES = ["till", "display", "staff", "kitchen"] as const;
if (!registerId || !ROLES.includes(role as (typeof ROLES)[number])) {
  console.error("Usage: pnpm pair <registerId> [till|display|staff|kitchen]");
  process.exit(1);
}
const db = createPool();
console.log(`Pairing code (valid 15 minutes): ${await createPairingCode(db, registerId, role as (typeof ROLES)[number])}`);
await db.end();
