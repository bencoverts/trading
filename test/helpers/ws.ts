import { WebSocket } from 'ws';

export class WsTestClient {
  readonly messages: any[] = [];
  private closed = false;

  private constructor(private readonly ws: WebSocket) {
    ws.on('message', (data) => {
      try {
        this.messages.push(JSON.parse(String(data)));
      } catch {
        /* ignore */
      }
    });
    ws.on('close', () => {
      this.closed = true;
    });
  }

  static connect(url: string): Promise<WsTestClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const timer = setTimeout(() => reject(new Error('ws connect timeout')), 5_000);
      ws.once('open', () => {
        clearTimeout(timer);
        resolve(new WsTestClient(ws));
      });
      ws.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  send(message: unknown): void {
    this.ws.send(JSON.stringify(message));
  }

  /** Waits for a message matching `predicate` (checks already received ones first). */
  async waitFor<T = any>(predicate: (m: any) => boolean, timeoutMs = 3_000): Promise<T> {
    const started = Date.now();
    for (;;) {
      const found = this.messages.find(predicate);
      if (found) return found as T;
      if (this.closed) throw new Error('socket closed while waiting');
      if (Date.now() - started > timeoutMs) {
        throw new Error(
          `ws message timeout; received: ${JSON.stringify(this.messages.map((m) => m.type))}`,
        );
      }
      await new Promise((r) => setTimeout(r, 15));
    }
  }

  /** Waits for a message that arrives after the current position in the log. */
  mark(): number {
    return this.messages.length;
  }

  async waitAfter<T = any>(index: number, predicate: (m: any) => boolean, timeoutMs = 3_000): Promise<T> {
    const started = Date.now();
    for (;;) {
      const found = this.messages.slice(index).find(predicate);
      if (found) return found as T;
      if (Date.now() - started > timeoutMs) {
        throw new Error(
          `ws message timeout after index ${index}; received: ${JSON.stringify(this.messages.map((m) => m.type))}`,
        );
      }
      await new Promise((r) => setTimeout(r, 15));
    }
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (this.ws.readyState === WebSocket.CLOSED) return resolve();
      this.ws.once('close', () => resolve());
      this.ws.close();
    });
  }
}

export const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
