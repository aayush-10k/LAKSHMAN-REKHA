/**
 * B10 — SSE Event Bus
 *
 * In-memory broadcast bus. The Core API emits events here; the SSE endpoint
 * fans them out to all connected clients (C's frontend). Fail-open for
 * individual clients — a slow consumer never blocks the bus.
 */

import type { RekhaEvent } from '../types.js';

type Subscriber = (event: RekhaEvent) => void;

class EventBus {
  private subscribers = new Set<Subscriber>();

  subscribe(fn: Subscriber): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  emit(event: RekhaEvent): void {
    for (const fn of this.subscribers) {
      try {
        fn(event);
      } catch {
        // Slow/erroring subscriber does not block others
      }
    }
  }

  subscriberCount(): number {
    return this.subscribers.size;
  }
}

// Singleton — shared across the whole process
export const bus = new EventBus();

// Convenience: emit with current wall time.
// We cast to RekhaEvent because discriminated union inference doesn't work through Omit<>.
export const emit = (event: Record<string, unknown> & { t: string; atMs?: number }): void => {
  bus.emit({ ...event, atMs: event.atMs ?? Date.now() } as RekhaEvent);
};
