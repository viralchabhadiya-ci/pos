import { DisplayRelay, DisplayStateSchema } from "@pos/core";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { HttpError } from "../errors.js";

const GetSchema = z.object({
  after: z.coerce.number().int().min(0).default(0),
  wait: z.coerce.number().int().min(0).max(25_000).default(20_000),
});

/**
 * Customer display relay for stores without a hub: the till publishes, displays paired to
 * the same register long-poll. With a hub the same routes are answered inside the store.
 */
export async function displayRoutes(app: FastifyInstance) {
  const relay = new DisplayRelay();
  app.addHook("onClose", async () => relay.close());

  app.put("/display/state", async (req) => {
    const device = await app.authenticate(req);
    if (device.role !== "till") throw new HttpError(403, "forbidden", "Only a till can update the customer display");
    const state = DisplayStateSchema.parse((req.body as { state?: unknown })?.state);
    return { version: relay.put(device.registerId, state) };
  });

  app.get("/display/state", async (req) => {
    const device = await app.authenticate(req);
    const { after, wait } = GetSchema.parse(req.query);
    return relay.get(device.registerId, after, wait);
  });
}
