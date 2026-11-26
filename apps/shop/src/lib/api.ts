const BASE = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, "") ?? "";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Calls the shop API; errors carry the server's own words, which are written for customers. */
export async function shopApi<T>(path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}/shop-api/${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError("No connection. Check your internet and try again.", "offline", 0);
  }
  const data = (await res.json().catch(() => ({}))) as { error?: string; message?: string; issues?: { message: string }[] };
  if (!res.ok) throw new ApiError(data.message ?? data.issues?.[0]?.message ?? "Something went wrong. Try again.", data.error ?? "error", res.status);
  return data as T;
}
