import { useState, type FormEvent } from "react";
import { ApiError, OfflineError, request } from "../lib/api.js";
import { whatsappNumber } from "../lib/format.js";
import { t } from "../lib/i18n.js";
import { Icon } from "./Icon.js";

/**
 * Sends the link to the digital receipt: by WhatsApp from this device (the customer's number is
 * filled in when they are on the sale), or by email from the server. The link works as soon as
 * the bill reaches the server, so it can be sent before the sale has synced.
 */
export function SendReceipt({
  link,
  orderId,
  storeName,
  number,
  phone,
  userId,
}: {
  link: string;
  orderId: string;
  storeName: string;
  number: string;
  phone: string | null;
  userId: string;
}) {
  const [tel, setTel] = useState(phone ?? "");
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const wa = whatsappNumber(tel);
  const message = `${storeName} · ${number}\nYour receipt / إيصالك: ${link}`;

  const sendEmail = async (e: FormEvent) => {
    e.preventDefault();
    const to = email.trim();
    if (!/^\S+@\S+\.\S+$/.test(to)) return setError(t("Enter an email address, e.g. name@example.com"));
    setBusy(true);
    setError(null);
    try {
      await request(`/receipts/${orderId}/email`, { body: { to, userId } });
      setSent(t("Receipt emailed to {to}", { to }));
      setEmail("");
    } catch (err) {
      if (err instanceof OfflineError || (err instanceof ApiError && err.status === 503)) setError(t("Emailing needs the internet. Send it by WhatsApp or print it."));
      else if (err instanceof ApiError && err.code === "too_many") setError(t("This receipt has already been emailed 3 times."));
      else setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <details className="send-receipt noprint">
      <summary>
        <Icon name="send" size={18} />
        {t("Send the receipt")}
      </summary>
      <div className="send-row">
        <label htmlFor="rcpt-tel">{t("WhatsApp number")}</label>
        <div className="inline-field">
          <input id="rcpt-tel" type="tel" inputMode="tel" value={tel} onChange={(e) => setTel(e.target.value)} placeholder="050 123 4567" autoComplete="off" />
          <a
            className={wa ? "btn outline" : "btn outline disabled"}
            aria-disabled={!wa}
            href={wa ? `https://wa.me/${wa}?text=${encodeURIComponent(message)}` : undefined}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => wa && setSent(t("WhatsApp opened with the receipt link"))}
          >
            <Icon name="phone" size={18} />
            {t("WhatsApp")}
          </a>
        </div>
      </div>
      <form className="send-row" onSubmit={(e) => void sendEmail(e)}>
        <label htmlFor="rcpt-email">{t("Email")}</label>
        <div className="inline-field">
          <input id="rcpt-email" type="email" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@example.com" autoComplete="off" />
          <button type="submit" className="btn outline" disabled={busy || !email.trim()}>
            <Icon name="mail" size={18} />
            {busy ? t("Sending…") : t("Send")}
          </button>
        </div>
      </form>
      {sent && (
        <p className="ok-text" role="status">
          <Icon name="check" size={18} />
          {sent}
        </p>
      )}
      {error && (
        <p className="error" role="alert">
          <Icon name="alert" size={18} />
          {error}
        </p>
      )}
    </details>
  );
}
