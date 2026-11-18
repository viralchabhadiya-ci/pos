import type { Db } from "../db.js";
import { buildPintXml, validatePint, type Emirate, type PintDocument, type PintLine, type TaxCategory } from "./pint.js";
import {
  HttpProvider,
  SimulatorProvider,
  TransientError,
  type EInvoiceProvider,
  type SimulatorMode,
} from "./providers.js";

export interface EInvoiceSettings {
  enabled: boolean;
  scope: "b2b" | "all";
  provider: "simulator" | "http";
  simulatorMode: SimulatorMode;
  endpointUrl: string | null;
  apiKey: string | null;
  legalName: string | null;
  street: string | null;
  city: string | null;
  emirate: Emirate | null;
  maxAttempts: number;
}

export const DEFAULT_SETTINGS: EInvoiceSettings = {
  enabled: false,
  scope: "b2b",
  provider: "simulator",
  simulatorMode: "accept",
  endpointUrl: null,
  apiKey: null,
  legalName: null,
  street: null,
  city: null,
  emirate: null,
  maxAttempts: 8,
};

export const SETTINGS_SELECT = `SELECT enabled, scope, provider, simulator_mode AS "simulatorMode", endpoint_url AS "endpointUrl",
  api_key AS "apiKey", legal_name AS "legalName", street, city, emirate, max_attempts AS "maxAttempts"
  FROM einvoice_settings WHERE tenant_id = $1`;

export async function loadSettings(db: Db, tenantId: string): Promise<EInvoiceSettings> {
  const { rows } = await db.query(SETTINGS_SELECT, [tenantId]);
  return rows[0] ?? DEFAULT_SETTINGS;
}

export function providerFor(s: EInvoiceSettings): EInvoiceProvider {
  if (s.provider === "http") {
    if (!s.endpointUrl) throw new Error("No provider address is set");
    return new HttpProvider(s.endpointUrl, s.apiKey);
  }
  return new SimulatorProvider(s.simulatorMode);
}

export interface QueueOptions {
  /** Tests swap in their own provider. */
  provider?: (s: EInvoiceSettings) => EInvoiceProvider;
}

/** Wait before try n+1: 30 s, 1 min, 2 min … up to 6 hours. */
export function backoffSeconds(attempts: number): number {
  return Math.min(30 * 2 ** Math.max(0, attempts - 1), 6 * 3600);
}

/** A credit note waits this long while its invoice is still on its way. */
const WAIT_FOR_ORIGINAL_SECONDS = 60;
/** A worker that dies mid-send frees its documents after this long. */
const LOCK_SECONDS = 300;

const CATEGORY: Record<string, TaxCategory> = { standard: "S", zero: "Z", exempt: "E" };

interface Loaded {
  doc: PintDocument;
  inScope: boolean;
  scopeReason: string;
  /** For credit notes: the invoice's own e-invoice status, if it has one. */
  originalStatus: string | null;
}

/** Gathers one bill, its store, customer and lines into a PINT AE document. */
export async function loadDocument(db: Db, einvoiceId: string, settings: EInvoiceSettings): Promise<Loaded> {
  const { rows } = await db.query(
    `SELECT e.id, e.kind, o.id AS "orderId", o.number, o.created_at AS "createdAt", o.cash_rounding AS "cashRounding",
            o.refund_of_order_id AS "refundOf", s.name AS "storeName", s.trn AS "storeTrn", s.timezone,
            t.name AS "tenantName",
            COALESCE(c.name, oc.name) AS "customerName", COALESCE(c.trn, oc.trn) AS "customerTrn",
            ro.number AS "originalNumber", ro.created_at AS "originalAt", re.status AS "originalStatus"
       FROM einvoices e
       JOIN orders o ON o.id = e.order_id
       JOIN stores s ON s.id = o.store_id
       JOIN tenants t ON t.id = o.tenant_id
       LEFT JOIN customers c ON c.id = o.customer_id
       LEFT JOIN orders ro ON ro.id = o.refund_of_order_id
       LEFT JOIN customers oc ON oc.id = ro.customer_id
       LEFT JOIN einvoices re ON re.order_id = ro.id
      WHERE e.id = $1`,
    [einvoiceId],
  );
  const r = rows[0];
  if (!r) throw new Error(`E-invoice ${einvoiceId} not found`);
  const credit = r.kind === "credit_note";
  const sign = credit ? -1 : 1;

  const lines = await db.query(
    `SELECT l.line_no AS "lineNo", l.name, l.qty, l.net, l.tax, l.gross, l.tax_rate_bp AS "rateBp",
            tx.kind AS "taxKind", v.sku, v.barcode, p.uom
       FROM order_lines l
       JOIN variants v ON v.id = l.variant_id
       JOIN products p ON p.id = v.product_id
       LEFT JOIN taxes tx ON tx.id = l.tax_id
      WHERE l.order_id = $1 AND l.gift_card_code IS NULL ORDER BY l.line_no`,
    [r.orderId],
  );
  const payments = await db.query("SELECT DISTINCT kind FROM payments WHERE order_id = $1 ORDER BY kind", [r.orderId]);

  const docLines: PintLine[] = lines.rows.map((l) => ({
    lineNo: l.lineNo,
    name: l.name,
    qty: sign * l.qty,
    uom: l.uom,
    net: sign * l.net,
    tax: sign * l.tax,
    gross: sign * l.gross,
    category: l.taxKind ? CATEGORY[l.taxKind]! : null,
    rateBp: l.rateBp ?? 0,
    sku: l.sku,
    barcode: l.barcode,
  }));

  const b2b = !!r.customerTrn;
  let inScope = settings.scope === "all" || b2b;
  let scopeReason = b2b ? "" : "Walk-in bill. Only bills for customers with a TRN are sent.";
  // Selling a gift card is not a supply for VAT (the goods are taxed when the card is spent), so
  // gift card lines stay off the invoice, and a bill of only gift cards has no invoice at all.
  // A refund of an invoice that was sent must be sent too, so the FTA sees both.
  if (credit && !inScope && r.originalStatus && r.originalStatus !== "skipped") {
    inScope = true;
    scopeReason = "";
  }
  if (!docLines.length) {
    inScope = false;
    scopeReason = "Only gift cards on this bill. Selling a gift card is not a supply for VAT.";
  }

  const doc: PintDocument = {
    kind: credit ? "credit_note" : "invoice",
    number: r.number,
    uuid: r.orderId,
    issuedAt: r.createdAt,
    timezone: r.timezone,
    seller: {
      name: settings.legalName?.trim() || r.tenantName,
      trn: r.storeTrn,
      street: settings.street,
      city: settings.city,
      emirate: settings.emirate,
    },
    buyer: { name: r.customerName ?? "Walk-in customer", trn: r.customerTrn },
    lines: docLines,
    cashRounding: sign * r.cashRounding,
    paymentKinds: payments.rows.map((p) => p.kind),
    billingReference: credit && r.originalNumber ? { number: r.originalNumber, issuedAt: r.originalAt } : null,
    note: credit ? "Goods returned" : null,
  };
  return { doc, inScope, scopeReason, originalStatus: r.originalStatus };
}

async function logAttempt(
  db: Db,
  id: string,
  provider: string,
  outcome: "accepted" | "rejected" | "error",
  message: string | null,
  ref: string | null,
  ms: number,
) {
  await db.query(
    `INSERT INTO einvoice_attempts (einvoice_id, provider, outcome, message, provider_ref, duration_ms)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, provider, outcome, message, ref, ms],
  );
}

/** Builds, checks and sends one document that this worker has claimed. */
export async function processOne(db: Db, id: string, opts: QueueOptions = {}): Promise<string> {
  const head = (await db.query("SELECT tenant_id, attempts, forced, kind FROM einvoices WHERE id = $1", [id])).rows[0];
  const settings = await loadSettings(db, head.tenant_id);
  const { doc, inScope, scopeReason, originalStatus } = await loadDocument(db, id, settings);

  if (!inScope && !head.forced) {
    await db.query(
      `UPDATE einvoices SET status = 'skipped', last_error = $2, locked_until = NULL, updated_at = now() WHERE id = $1`,
      [id, scopeReason],
    );
    return "skipped";
  }
  if (head.kind === "credit_note" && (originalStatus === "pending" || originalStatus === "sending")) {
    await db.query(
      `UPDATE einvoices SET status = 'pending', last_error = 'Waiting for the original invoice to be sent first',
              next_attempt_at = now() + make_interval(secs => $2), locked_until = NULL, updated_at = now() WHERE id = $1`,
      [id, WAIT_FOR_ORIGINAL_SECONDS],
    );
    return "waiting";
  }

  const problems = validatePint(doc);
  if (problems.length) {
    const message = problems.join(" ");
    await logAttempt(db, id, "check", "rejected", message, null, 0);
    await db.query(
      `UPDATE einvoices SET status = 'failed', last_error = $2, locked_until = NULL, updated_at = now() WHERE id = $1`,
      [id, message],
    );
    return "failed";
  }

  const xml = buildPintXml(doc);
  let provider: EInvoiceProvider;
  try {
    provider = (opts.provider ?? providerFor)(settings);
  } catch (err) {
    const message = (err as Error).message;
    await db.query(
      `UPDATE einvoices SET status = 'failed', xml = $2, last_error = $3, locked_until = NULL, updated_at = now() WHERE id = $1`,
      [id, xml, message],
    );
    return "failed";
  }

  const started = Date.now();
  const attempts = head.attempts + 1;
  try {
    const result = await provider.submit({ id, kind: doc.kind, number: doc.number, previousAttempts: head.attempts, xml });
    const ms = Date.now() - started;
    if (result.outcome === "accepted") {
      await logAttempt(db, id, provider.name, "accepted", result.message ?? null, result.reference, ms);
      await db.query(
        `UPDATE einvoices SET status = 'accepted', attempts = $2, xml = $3, provider = $4, provider_ref = $5,
                last_error = NULL, accepted_at = now(), locked_until = NULL, updated_at = now() WHERE id = $1`,
        [id, attempts, xml, provider.name, result.reference],
      );
      return "accepted";
    }
    await logAttempt(db, id, provider.name, "rejected", result.message, null, ms);
    await db.query(
      `UPDATE einvoices SET status = 'rejected', attempts = $2, xml = $3, provider = $4, last_error = $5,
              locked_until = NULL, updated_at = now() WHERE id = $1`,
      [id, attempts, xml, provider.name, result.message],
    );
    return "rejected";
  } catch (err) {
    // Anything unexpected is treated like a network problem: try again later.
    const message = err instanceof TransientError ? err.message : `Unexpected error: ${(err as Error).message}`;
    await logAttempt(db, id, provider.name, "error", message, null, Date.now() - started);
    const giveUp = attempts >= settings.maxAttempts;
    await db.query(
      `UPDATE einvoices SET status = $2, attempts = $3, xml = $4, provider = $5, last_error = $6,
              next_attempt_at = now() + make_interval(secs => $7), locked_until = NULL, updated_at = now() WHERE id = $1`,
      [id, giveUp ? "failed" : "pending", attempts, xml, provider.name, giveUp ? `Gave up after ${attempts} tries. ${message}` : message,
        backoffSeconds(attempts)],
    );
    return giveUp ? "failed" : "retrying";
  }
}

/**
 * Claims due documents so that two workers (or two API servers) never send the same
 * one at once. Documents of businesses that turned e-invoicing off stay where they are.
 */
async function claim(db: Db, limit: number, onlyId?: string): Promise<string[]> {
  const { rows } = await db.query(
    `UPDATE einvoices e SET status = 'sending', locked_until = now() + make_interval(secs => $2), updated_at = now()
      WHERE e.id IN (
        SELECT x.id FROM einvoices x JOIN einvoice_settings s ON s.tenant_id = x.tenant_id AND s.enabled
         WHERE ((x.status = 'pending' AND x.next_attempt_at <= now()) OR (x.status = 'sending' AND x.locked_until < now()))
           AND ($3::uuid IS NULL OR x.id = $3)
         -- Oldest first on ties, so an invoice goes before its credit note.
         ORDER BY x.next_attempt_at, x.created_at, x.id LIMIT $1 FOR UPDATE OF x SKIP LOCKED)
      RETURNING e.id, e.created_at`,
    [limit, LOCK_SECONDS, onlyId ?? null],
  );
  // RETURNING does not keep the subquery's order.
  return rows.sort((a, b) => a.created_at - b.created_at || String(a.id).localeCompare(b.id)).map((r) => r.id);
}

/** Sends everything that is due, in batches. Returns how many documents were handled. */
export async function processDue(db: Db, opts: QueueOptions & { batch?: number } = {}): Promise<number> {
  let handled = 0;
  for (;;) {
    const ids = await claim(db, opts.batch ?? 20);
    for (const id of ids) {
      try {
        await processOne(db, id, opts);
      } catch (err) {
        // Leave it for the lock to expire and try again, rather than lose it.
        await db.query(
          `UPDATE einvoices SET status = 'pending', last_error = $2, locked_until = NULL,
                  next_attempt_at = now() + interval '5 minutes', updated_at = now() WHERE id = $1`,
          [id, `Could not prepare the document: ${(err as Error).message}`],
        );
      }
    }
    handled += ids.length;
    if (ids.length < (opts.batch ?? 20)) return handled;
  }
}

/** Sends one document now, e.g. when someone presses Retry on a bill. */
export async function sendNow(db: Db, id: string, opts: QueueOptions = {}): Promise<string | null> {
  const [claimed] = await claim(db, 1, id);
  return claimed ? processOne(db, claimed, opts) : null;
}

/** Runs the queue in the background every few seconds. Returns a stop function. */
export function startEInvoiceWorker(
  db: Db,
  log: { error: (obj: unknown, msg?: string) => void },
  intervalMs = 5_000,
): () => Promise<void> {
  let stopped = false;
  let running: Promise<unknown> = Promise.resolve();
  const tick = () => {
    if (stopped) return;
    running = processDue(db)
      .catch((err) => log.error(err, "e-invoice worker failed"))
      .finally(() => {
        if (!stopped) timer = setTimeout(tick, intervalMs);
      });
  };
  let timer = setTimeout(tick, intervalMs);
  return async () => {
    stopped = true;
    clearTimeout(timer);
    await running;
  };
}
