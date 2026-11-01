import { db } from "./db.js";

export interface DeviceAuth { apiUrl: string; token: string; deviceId: string }

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Thrown when the server could not be reached at all; callers keep working offline. */
export class OfflineError extends Error {}

export async function getAuth(): Promise<DeviceAuth | undefined> {
  return db.getMeta<DeviceAuth>("auth");
}

export async function request<T>(path: string, init: { method?: string; body?: unknown; auth?: DeviceAuth } = {}): Promise<T> {
  const auth = init.auth ?? (await getAuth());
  if (!auth) throw new ApiError(401, "not_paired", "This device is not paired");
  let res: Response;
  try {
    res = await fetch(`${auth.apiUrl.replace(/\/$/, "")}${path}`, {
      method: init.method ?? (init.body ? "POST" : "GET"),
      headers: {
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...(auth.token ? { authorization: `Bearer ${auth.token}` } : {}),
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new OfflineError("Server not reachable");
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new ApiError(res.status, data.error ?? "error", data.message ?? res.statusText);
  return data as T;
}
