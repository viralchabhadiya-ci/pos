import type { FastifyInstance } from "fastify";
import { countRoutes } from "./counts.js";
import { purchaseRoutes } from "./purchases.js";
import { stockRoutes } from "./stock.js";
import { supplierRoutes } from "./suppliers.js";
import { transferRoutes } from "./transfers.js";

/** Suppliers, purchase orders and receiving, transfers, stock counts, reorder and expiry. */
export async function inventoryRoutes(app: FastifyInstance) {
  await app.register(supplierRoutes);
  await app.register(purchaseRoutes);
  await app.register(transferRoutes);
  await app.register(countRoutes);
  await app.register(stockRoutes);
}
