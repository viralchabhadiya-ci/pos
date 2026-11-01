import { createPool } from "../db.js";
import { migrate } from "../migrate.js";
import { createPairingCode, seed } from "../seed.js";

const db = createPool();
await migrate(db);
const result = await seed(db);
const code = await createPairingCode(db, result.registerId);
console.log(`Seeded demo store. Register ${result.registerId}`);
console.log("Cashier PIN 1234, manager PIN 9999");
console.log(`Pairing code for the till (valid 15 minutes): ${code}`);
await db.end();
