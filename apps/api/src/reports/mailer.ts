import nodemailer from "nodemailer";

export interface MailMessage {
  to: string[];
  subject: string;
  html: string;
  text: string;
}

export interface Mailer {
  /** "smtp", or "log" when no mail server is set and emails only go to the server log. */
  readonly transport: string;
  send(msg: MailMessage): Promise<void>;
}

/** Sends through any SMTP server (Amazon SES, Microsoft 365, Zoho, Mailgun…) given as SMTP_URL. */
export class SmtpMailer implements Mailer {
  readonly transport = "smtp";
  private t: nodemailer.Transporter;
  constructor(
    url: string,
    private from: string,
  ) {
    this.t = nodemailer.createTransport(url);
  }
  async send(msg: MailMessage) {
    // Each person gets their own copy, so recipients do not see each other's addresses.
    for (const to of msg.to) {
      await this.t.sendMail({ from: this.from, to, subject: msg.subject, html: msg.html, text: msg.text });
    }
  }
}

/** Without a mail server, summaries are written to the log so a developer can see them. */
export class LogMailer implements Mailer {
  readonly transport = "log";
  constructor(private log: (line: string) => void = (l) => console.log(l)) {}
  async send(msg: MailMessage) {
    this.log(`[email] to=${msg.to.join(",")} subject=${JSON.stringify(msg.subject)}`);
  }
}

/** Tests read what would have been sent. */
export class MemoryMailer implements Mailer {
  readonly transport = "memory";
  sent: MailMessage[] = [];
  /** Set to make the next sends fail, e.g. to test retries. */
  failWith: string | null = null;
  async send(msg: MailMessage) {
    if (this.failWith) throw new Error(this.failWith);
    this.sent.push(msg);
  }
}

export function createMailer(env = process.env): Mailer {
  if (env.SMTP_URL) return new SmtpMailer(env.SMTP_URL, env.MAIL_FROM ?? "POS reports <reports@localhost>");
  return new LogMailer();
}
