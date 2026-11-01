import type { FastifyInstance } from "fastify";
import { authRoutes } from "./auth.js";
import { catalogRoutes } from "./catalog.js";
import { deviceRoutes } from "./devices.js";
import { salesRoutes } from "./sales.js";
import { staffRoutes } from "./staff.js";

/** The back office API for owners and managers, mounted under /admin. */
export async function adminRoutes(app: FastifyInstance) {
  await app.register(authRoutes);
  await app.register(catalogRoutes);
  await app.register(staffRoutes);
  await app.register(deviceRoutes);
  await app.register(salesRoutes);
}
