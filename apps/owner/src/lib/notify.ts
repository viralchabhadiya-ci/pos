/**
 * Phone notifications while the app is open or in the background: a new approval request
 * shows a system notification and the app icon gets a badge. (Push while the app is fully
 * closed needs a push server and is a later step.)
 */
export function notificationsSupported(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

export function notificationsOn(): boolean {
  return notificationsSupported() && Notification.permission === "granted";
}

export async function askForNotifications(): Promise<boolean> {
  if (!notificationsSupported()) return false;
  return (await Notification.requestPermission()) === "granted";
}

export async function notify(title: string, body: string, tag: string) {
  if (!notificationsOn()) return;
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg) await reg.showNotification(title, { body, tag, icon: "/icon.svg", badge: "/icon.svg", data: { url: "/#/approvals" } });
    else new Notification(title, { body, tag, icon: "/icon.svg" });
  } catch {
    // Some browsers only allow notifications from a service worker; nothing else to do.
  }
}

export function setBadge(count: number) {
  const nav = navigator as Navigator & { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
  try {
    if (count > 0) void nav.setAppBadge?.(count);
    else void nav.clearAppBadge?.();
  } catch {
    // Not supported here.
  }
  document.title = count > 0 ? `(${count}) Owner` : "Owner";
}
