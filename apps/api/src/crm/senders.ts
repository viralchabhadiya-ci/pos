import type { Mailer } from "../reports/mailer.js";

export interface OutgoingMessage {
  to: string;
  subject?: string | null;
  text: string;
  /** For email: a page where the customer can stop these messages. */
  unsubscribeUrl?: string | null;
}

export interface MessageSender {
  /** "log" when nothing is set up and messages only go to the server log. */
  readonly transport: string;
  send(msg: OutgoingMessage): Promise<{ ref?: string | null }>;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Email through the same mail server as the reports. */
export class EmailSender implements MessageSender {
  constructor(private mailer: Mailer) {}
  get transport() {
    return this.mailer.transport;
  }
  async send(msg: OutgoingMessage) {
    const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;font-size:16px;line-height:1.5;max-width:560px">${esc(msg.text).replace(/\n/g, "<br>")}${
      msg.unsubscribeUrl ? `<p style="margin-top:24px;font-size:13px;color:#4f5d5b"><a href="${esc(msg.unsubscribeUrl)}">Unsubscribe</a> · <a href="${esc(msg.unsubscribeUrl)}">إلغاء الاشتراك</a></p>` : ""
    }</div>`;
    await this.mailer.send({
      to: [msg.to],
      subject: msg.subject ?? "",
      html,
      text: msg.unsubscribeUrl ? `${msg.text}\n\nUnsubscribe: ${msg.unsubscribeUrl}` : msg.text,
      headers: msg.unsubscribeUrl ? { "List-Unsubscribe": `<${msg.unsubscribeUrl}>` } : undefined,
    });
    return {};
  }
}

/** SMS through Twilio's API (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, SMS_FROM: a registered sender ID). */
export class TwilioSms implements MessageSender {
  readonly transport = "twilio";
  constructor(
    private sid: string,
    private token: string,
    private from: string,
  ) {}
  async send(msg: OutgoingMessage) {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(this.sid)}/Messages.json`, {
      method: "POST",
      headers: { authorization: `Basic ${Buffer.from(`${this.sid}:${this.token}`).toString("base64")}`, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ To: msg.to, From: this.from, Body: msg.text }),
      signal: AbortSignal.timeout(15_000),
    });
    const data = (await res.json().catch(() => ({}))) as { sid?: string; message?: string };
    if (!res.ok) throw new Error(`SMS provider: ${data.message ?? res.status}`);
    return { ref: data.sid ?? null };
  }
}

/**
 * WhatsApp through Meta's Cloud API (WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID). Marketing
 * messages must use a template Meta has approved; WHATSAPP_TEMPLATE names one whose body is a
 * single {{1}} that takes the whole message.
 */
export class WhatsAppCloud implements MessageSender {
  readonly transport = "whatsapp_cloud";
  constructor(
    private token: string,
    private phoneNumberId: string,
    private template: string,
    private language = "en",
  ) {}
  async send(msg: OutgoingMessage) {
    const res = await fetch(`https://graph.facebook.com/v21.0/${encodeURIComponent(this.phoneNumberId)}/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: msg.to.replace(/^\+/, ""),
        type: "template",
        template: { name: this.template, language: { code: this.language }, components: [{ type: "body", parameters: [{ type: "text", text: msg.text }] }] },
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const data = (await res.json().catch(() => ({}))) as { messages?: { id: string }[]; error?: { message?: string } };
    if (!res.ok) throw new Error(`WhatsApp: ${data.error?.message ?? res.status}`);
    return { ref: data.messages?.[0]?.id ?? null };
  }
}

/** Without a provider, messages are written to the log so a developer can see them. */
export class LogSender implements MessageSender {
  readonly transport = "log";
  constructor(
    private channel: string,
    private log: (line: string) => void = (l) => console.log(l),
  ) {}
  async send(msg: OutgoingMessage) {
    this.log(`[${this.channel}] to=${msg.to} ${JSON.stringify(msg.text.slice(0, 80))}`);
    return {};
  }
}

/** Tests read what would have been sent. */
export class MemorySender implements MessageSender {
  readonly transport = "memory";
  sent: OutgoingMessage[] = [];
  failFor = new Set<string>();
  async send(msg: OutgoingMessage) {
    if (this.failFor.has(msg.to)) throw new Error("provider refused");
    this.sent.push(msg);
    return { ref: `mem-${this.sent.length}` };
  }
}

export interface Senders {
  email: MessageSender;
  sms: MessageSender;
  whatsapp: MessageSender;
}

export function createSenders(mailer: Mailer, env = process.env): Senders {
  return {
    email: new EmailSender(mailer),
    sms:
      env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.SMS_FROM
        ? new TwilioSms(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN, env.SMS_FROM)
        : new LogSender("sms"),
    whatsapp:
      env.WHATSAPP_TOKEN && env.WHATSAPP_PHONE_NUMBER_ID && env.WHATSAPP_TEMPLATE
        ? new WhatsAppCloud(env.WHATSAPP_TOKEN, env.WHATSAPP_PHONE_NUMBER_ID, env.WHATSAPP_TEMPLATE, env.WHATSAPP_TEMPLATE_LANG ?? "en")
        : new LogSender("whatsapp"),
  };
}
