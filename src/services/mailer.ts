import type { Logger } from '../lib/logger.js';

export interface MailMessage {
  to: string;
  subject: string;
  body: string;
  link?: string;
}

export interface Mailer {
  send(message: MailMessage): void;
  /** last N messages, used by the dev endpoints and tests */
  recent(): MailMessage[];
  lastLinkFor(email: string): string | null;
}

/**
 * Development mailer: logs the message and keeps the last 50 in memory so the
 * verification / reset link can be exposed through a dev-only endpoint.
 * Replace with a real provider by implementing this interface.
 */
export class DevMailer implements Mailer {
  private readonly messages: MailMessage[] = [];

  constructor(private readonly logger: Logger) {}

  send(message: MailMessage): void {
    this.messages.push(message);
    if (this.messages.length > 50) this.messages.shift();
    this.logger.info(
      { to: message.to, subject: message.subject, link: message.link },
      `[mail] ${message.subject}\n${message.body}`,
    );
  }

  recent(): MailMessage[] {
    return [...this.messages];
  }

  lastLinkFor(email: string): string | null {
    const normalized = email.trim().toLowerCase();
    for (let i = this.messages.length - 1; i >= 0; i--) {
      if (this.messages[i].to.toLowerCase() === normalized) return this.messages[i].link ?? null;
    }
    return null;
  }
}

/** No-op mailer for tests (keeps last links like DevMailer but silent). */
export class MemoryMailer implements Mailer {
  private readonly messages: MailMessage[] = [];

  send(message: MailMessage): void {
    this.messages.push(message);
  }

  recent(): MailMessage[] {
    return [...this.messages];
  }

  lastLinkFor(email: string): string | null {
    const normalized = email.trim().toLowerCase();
    for (let i = this.messages.length - 1; i >= 0; i--) {
      if (this.messages[i].to.toLowerCase() === normalized) return this.messages[i].link ?? null;
    }
    return null;
  }
}
