import { buildApp } from "./app.js";
import { createPool } from "./db.js";
import { migrate } from "./migrate.js";

const db = createPool();
await migrate(db);
const app = await buildApp(db, { logger: true });
await app.listen({ port: Number(process.env.PORT ?? 3000), host: process.env.HOST ?? "0.0.0.0" });
