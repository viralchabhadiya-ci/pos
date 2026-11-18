import { createPool } from "../db.js";
import { migrate } from "../migrate.js";
import { ensurePlatformAdmin } from "../routes/platform.js";
import { createPairingCode, seed } from "../seed.js";

const db = createPool();
await migrate(db);
const result = await seed(db, { demoCustomers: true });
const code = await createPairingCode(db, result.registerId);
console.log(`Seeded demo store. Register ${result.registerId}`);
console.log("Cashier PIN 1234, manager PIN 9999, owner PIN 7777");
console.log("Demo loyalty customer: Fatima, phone 0501234567 (2,500 points). Demo gift card: GIFT-DEMO-100 (AED 100)");
console.log(`Back office sign-in: ${result.ownerEmail} / ${result.ownerPassword}`);
console.log(`Pairing code for the till (valid 15 minutes): ${code}`);
await ensurePlatformAdmin(db, "admin@platform.test", "Platform admin", "demo1234demo");
console.log("Platform console (#/platform): admin@platform.test / demo1234demo");
await db.end();
