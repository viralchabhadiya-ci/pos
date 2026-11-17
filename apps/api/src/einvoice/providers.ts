import { createHash } from "node:crypto";

/** What a provider needs to send one document. */
export interface Submission {
  /** Our e-invoice id; providers use it as the idempotency key, so a resend never duplicates. */
  id: string;
  kind: "invoice" | "credit_note";
  number: string;
  /** How many times this document has been tried before, starting at 0. */
  previousAttempts: number;
  xml: string;
}

export type SubmitResult =
  | { outcome: "accepted"; reference: string; message?: string }
  | { outcome: "rejected"; message: string };

/**
 * Thrown for problems that may pass on their own (network, timeouts, 5xx); the
 * queue tries again later. Anything else a provider returns is final.
 */
export class TransientError extends Error {}

/**
 * An accredited service provider (ASP) that passes documents on to the FTA. Each ASP
 * has its own API; adding one means writing one more adapter.
 */
export interface EInvoiceProvider {
  readonly name: string;
  submit(doc: Submission): Promise<SubmitResult>;
}

export type SimulatorMode = "accept" | "flaky" | "down" | "reject";

/**
 * Stands in for an ASP until a real one is signed up. It never leaves the server.
 * accept: takes everything · flaky: fails the first try of each document, then takes it
 * down: always unreachable · reject: refuses everything.
 */
export class SimulatorProvider implements EInvoiceProvider {
  readonly name = "simulator";
  constructor(private mode: SimulatorMode = "accept") {}

  async submit(doc: Submission): Promise<SubmitResult> {
    if (this.mode === "down" || (this.mode === "flaky" && doc.previousAttempts === 0)) {
      throw new TransientError("Simulator: the service is not reachable right now");
    }
    if (this.mode === "reject") {
      return { outcome: "rejected", message: "Simulator: rejected because the simulator is set to reject everything" };
    }
    const missing = ["cbc:CustomizationID", "cac:AccountingSupplierParty", "cac:TaxTotal", "cac:LegalMonetaryTotal"].filter(
      (tag) => !doc.xml.includes(`<${tag}`),
    );
    if (missing.length) return { outcome: "rejected", message: `Simulator: missing ${missing.join(", ")}` };
    const hash = createHash("sha256").update(doc.id).digest("hex").slice(0, 12).toUpperCase();
    return { outcome: "accepted", reference: `SIM-${hash}` };
  }
}

/**
 * A generic ASP API: POST the UBL XML, get JSON back. Most UAE ASPs offer something close
 * to this; a provider that differs gets its own adapter.
 * 2xx: accepted (reference from "reference", "id" or "uuid") · 4xx: rejected
 * 408, 429, 5xx, timeouts, network errors: tried again later.
 */
export class HttpProvider implements EInvoiceProvider {
  readonly name = "http";
  constructor(
    private url: string,
    private apiKey: string | null,
    private timeoutMs = 15_000,
  ) {}

  async submit(doc: Submission): Promise<SubmitResult> {
    let res: Response;
    try {
      res = await fetch(this.url, {
        method: "POST",
        headers: {
          "content-type": "application/xml",
          "idempotency-key": doc.id,
          "x-document-type": doc.kind,
          ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: doc.xml,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const timeout = (err as Error).name === "TimeoutError";
      throw new TransientError(timeout ? "The provider did not answer in time" : "Cannot reach the provider");
    }
    const text = await res.text();
    let body: Record<string, unknown> | null = null;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      // Some providers answer errors in plain text.
    }
    const message = String((body ? (body.message ?? body.error) : text) ?? "").slice(0, 500);
    if (res.ok) {
      const reference = String(body?.reference ?? body?.id ?? body?.uuid ?? "");
      return { outcome: "accepted", reference: reference || `HTTP-${res.status}`, message: message || undefined };
    }
    if (res.status === 408 || res.status === 429 || res.status >= 500) {
      throw new TransientError(`The provider answered ${res.status}${message ? `: ${message}` : ""}`);
    }
    return { outcome: "rejected", message: `The provider refused it (${res.status})${message ? `: ${message}` : ""}` };
  }
}
