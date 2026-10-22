/** Thrown when the cloud could not be reached (or answered from a gateway that cannot reach it). */
export class CloudOffline extends Error {}

export interface CloudResponse {
  status: number;
  data: any;
}

/** How long the hub trusts an "offline" result before trying the cloud again on a till's request. */
const RETRY_AFTER_MS = 15_000;

export class Cloud {
  online = true;
  private failedAt = 0;

  constructor(
    public baseUrl: string,
    private timeoutMs = 8_000,
  ) {}

  /** True when a request is worth trying now; otherwise work goes straight to the queue. */
  shouldTry(): boolean {
    return this.online || Date.now() - this.failedAt > RETRY_AFTER_MS;
  }

  async call(method: string, path: string, opts: { token?: string; body?: unknown } = {}): Promise<CloudResponse> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl.replace(/\/$/, "")}${path}`, {
        method,
        headers: {
          ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
          ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      this.markOffline();
      throw new CloudOffline((err as Error).message);
    }
    if (res.status === 502 || res.status === 503 || res.status === 504) {
      this.markOffline();
      throw new CloudOffline(`Cloud gateway answered ${res.status}`);
    }
    this.online = true;
    const text = await res.text();
    let data: unknown = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { error: "bad_response", message: text.slice(0, 200) };
    }
    return { status: res.status, data };
  }

  private markOffline() {
    this.online = false;
    this.failedAt = Date.now();
  }
}
