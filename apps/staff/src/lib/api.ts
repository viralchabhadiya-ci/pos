const BASE = (import.meta.env.VITE_API_URL ?? "").replace(/\/$/, "");
const DEVICE_KEY = "staff.device";
const SESSION_KEY = "staff.session";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function write(key: string, value: string | null) {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    // Private windows may refuse storage; pairing then lasts until the page is closed.
  }
}

/** The phone's own token from pairing. Kept until the device is removed in the back office. */
export const getDeviceToken = () => read(DEVICE_KEY);
export const setDeviceToken = (t: string | null) => write(DEVICE_KEY, t);
/** The person signed in with their PIN. Kept in the session only: closing the app signs them out. */
let session: string | null = null;
try {
  session = sessionStorage.getItem(SESSION_KEY);
} catch {
  session = null;
}
export const getSession = () => session;
export function setSession(t: string | null) {
  session = t;
  try {
    if (t) sessionStorage.setItem(SESSION_KEY, t);
    else sessionStorage.removeItem(SESSION_KEY);
  } catch {
    // Same as above.
  }
}

let onSignedOut: (unpaired: boolean) => void = () => {};
export const whenSignedOut = (fn: (unpaired: boolean) => void) => {
  onSignedOut = fn;
};

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const device = getDeviceToken();
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method: init.method ?? (init.body ? "POST" : "GET"),
      headers: {
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...(device ? { authorization: `Bearer ${device}` } : {}),
        ...(session ? { "x-staff-session": session } : {}),
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new ApiError(0, "offline", "No connection. Check the shop Wi-Fi and try again.");
  }
  const text = await res.text();
  let data: Record<string, unknown> = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new ApiError(res.status, "bad_response", "The server sent something unexpected. Try again.");
  }
  if (!res.ok) {
    const code = String(data.error ?? "error");
    if (res.status === 401 && path !== "/staff/login" && path !== "/pairing/claim") {
      // "unauthorized" means the phone itself was removed; "signed_out" only the person.
      const unpaired = code === "unauthorized";
      if (unpaired) setDeviceToken(null);
      setSession(null);
      onSignedOut(unpaired);
    }
    throw new ApiError(res.status, code, String(data.message ?? "Something went wrong"));
  }
  return data as T;
}

export const errorText = (err: unknown) => (err instanceof Error ? err.message : "Something went wrong");
