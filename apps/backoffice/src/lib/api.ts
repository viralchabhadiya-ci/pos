const BASE = (import.meta.env.VITE_API_URL ?? "").replace(/\/$/, "");
const TOKEN_KEY = "bo.token";

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

/** Called when the server says the session is over, so the app can show sign-in. */
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
    throw new ApiError(0, "offline", "Cannot reach the server. Check the internet connection and try again.");
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    if (res.status === 401 && path !== "/login") {
      setToken(null);
      onSignedOut();
    }
    throw new ApiError(res.status, data.error ?? "error", data.message ?? "Something went wrong");
  }
  return data as T;
}

export const errorText = (err: unknown) => (err instanceof Error ? err.message : "Something went wrong");
