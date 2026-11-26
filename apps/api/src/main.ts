import { buildApp } from "./app.js";
import { createPool } from "./db.js";
import { startEInvoiceWorker } from "./einvoice/queue.js";
import { migrate } from "./migrate.js";
import { startReportWorker } from "./reports/deliver.js";
import { startWebhookWorker } from "./webhooks/deliver.js";
import { startCampaignWorker } from "./crm/campaigns.js";

const db = createPool();
await migrate(db);
const app = await buildApp(db, { logger: true });
// Sends queued e-invoices to the provider in the background.
const stopEInvoices = startEInvoiceWorker(db, app.log);
app.addHook("onClose", stopEInvoices);
// Emails yesterday's summary to owners at their chosen hour.
const stopReports = startReportWorker(db, app.mailer, app.log, { appUrl: process.env.OWNER_APP_URL });
app.addHook("onClose", stopReports);
// Sends webhooks to the businesses' own URLs, with retries.
const stopWebhooks = startWebhookWorker(db, app.log, app.webhookOptions);
app.addHook("onClose", stopWebhooks);
// Sends marketing campaigns and birthday offers during the day, in the shop's time.
const stopCampaigns = startCampaignWorker(db, app.senders, app.log, { publicUrl: process.env.PUBLIC_URL });
app.addHook("onClose", stopCampaigns);
await app.listen({ port: Number(process.env.PORT ?? 3000), host: process.env.HOST ?? "0.0.0.0" });
