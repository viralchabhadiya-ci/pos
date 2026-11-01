import { buildHub } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const hub = await buildHub(config, { logger: true });
hub.start();
await hub.app.listen({ port: config.port, host: config.host });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void hub.close().then(() => process.exit(0));
  });
}
