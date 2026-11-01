import { createPool } from "../db.js";
import { createPairingCode } from "../seed.js";

const [registerId, role = "till"] = process.argv.slice(2);
if (!registerId || (role !== "till" && role !== "display")) {
  console.error("Usage: pnpm pair <registerId> [till|display]");
  process.exit(1);
}
const db = createPool();
console.log(`Pairing code (valid 15 minutes): ${await createPairingCode(db, registerId, role)}`);
await db.end();
