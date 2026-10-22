type Listener<A extends unknown[]> = (...args: A) => void;

/** Tiny typed event emitter (avoid `any` leaking from node:events typing). */
export class Emitter<Events extends { [K in keyof Events]: unknown[] }> {
  private listeners = new Map<keyof Events, Set<Listener<never[]>>>();

  on<K extends keyof Events>(event: K, fn: Listener<Events[K]>): () => void {
    const set = this.listeners.get(event) ?? new Set();
    set.add(fn as unknown as Listener<never[]>);
    this.listeners.set(event, set);
    return () => this.off(event, fn);
  }

  off<K extends keyof Events>(event: K, fn: Listener<Events[K]>): void {
    this.listeners.get(event)?.delete(fn as unknown as Listener<never[]>);
  }

  emit<K extends keyof Events>(event: K, ...args: Events[K]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        (fn as unknown as Listener<Events[K]>)(...args);
      } catch {
        /* a broken listener must not break the price loop */
      }
    }
  }

  removeAll(): void {
    this.listeners.clear();
  }
}
