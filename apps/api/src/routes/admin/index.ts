import type { FastifyInstance } from "fastify";
import { accountingRoutes } from "./accounting.js";
import { authRoutes } from "./auth.js";
import { businessRoutes } from "./business.js";
import { catalogRoutes } from "./catalog.js";
import { deviceRoutes } from "./devices.js";
import { einvoicingRoutes } from "./einvoicing.js";
import { priceListRoutes } from "./priceLists.js";
import { productCsvRoutes } from "./products-csv.js";
import { ownerRoutes } from "./owner.js";
import { promotionRoutes } from "./promotions.js";
import { adminReportRoutes } from "./reports.js";
import { terminalRoutes } from "./terminals.js";
import { salesRoutes } from "./sales.js";
import { staffRoutes } from "./staff.js";
import { inventoryRoutes } from "./inventory/index.js";

/** The back office API for owners and managers, mounted under /admin. */
export async function adminRoutes(app: FastifyInstance) {
  await app.register(authRoutes);
  await app.register(catalogRoutes);
  await app.register(productCsvRoutes);
  await app.register(staffRoutes);
  await app.register(deviceRoutes);
  await app.register(terminalRoutes);
  await app.register(salesRoutes);
  await app.register(adminReportRoutes);
  await app.register(businessRoutes);
  await app.register(einvoicingRoutes);
  await app.register(inventoryRoutes);
  await app.register(ownerRoutes);
  await app.register(promotionRoutes);
  await app.register(priceListRoutes);
  await app.register(accountingRoutes);
}
