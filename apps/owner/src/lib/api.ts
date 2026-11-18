const BASE = (import.meta.env.VITE_API_URL ?? "").replace(/\/$/, "");
const TOKEN_KEY = "owner.token";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Private windows may refuse storage; the session then lasts until reload.
  }
}

let onSignedOut: () => void = () => {};
export const whenSignedOut = (fn: () => void) => {
  onSignedOut = fn;
};

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const token = getToken();
  let res: Response;
  try {
    res = await fetch(`${BASE}/admin${path}`, {
      method: init.method ?? (init.body ? "POST" : "GET"),
      headers: {
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new ApiError(0, "offline", "No connection. Showing the last numbers we had.");
  }
  const text = await res.text();
  let data: Record<string, unknown> = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new ApiError(res.status, "bad_response", "The server sent something unexpected. Try again.");
  }
  if (!res.ok) {
    if (res.status === 401 && path !== "/login") {
      setToken(null);
      onSignedOut();
    }
    throw new ApiError(res.status, String(data.error ?? "error"), String(data.message ?? "Something went wrong"));
  }
  return data as T;
}

/** The daily summary email as HTML, for the in-app preview. */
export async function fetchHtml(path: string): Promise<string> {
  const token = getToken();
  const res = await fetch(`${BASE}/admin${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  if (!res.ok) throw new ApiError(res.status, "error", "Could not load the preview");
  return res.text();
}

export const errorText = (err: unknown) => (err instanceof Error ? err.message : "Something went wrong");
