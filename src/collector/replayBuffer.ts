/**
 * Bounded in-memory structures backing SSE replay and de-duplication.
 *
 * Both are deliberately bounded: an always-on local collector must have a fixed
 * memory ceiling. The consequences of those bounds (replay gaps, very old
 * duplicates) are surfaced explicitly rather than hidden.
 */

import type { WireEvent } from '../domain/wire.ts';

export class ReplayBuffer {
  readonly capacity: number;
  items: WireEvent[];

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error('ReplayBuffer capacity must be a positive integer');
    }
    this.capacity = capacity;
    this.items = [];
  }

  get size(): number {
    return this.items.length;
  }

  push(event: WireEvent): void {
    this.items.push(event);
    if (this.items.length > this.capacity) {
      this.items.splice(0, this.items.length - this.capacity);
    }
  }

  oldest(): WireEvent | null {
    return this.items[0] ?? null;
  }

  newest(): WireEvent | null {
    return this.items[this.items.length - 1] ?? null;
  }

  /** Events strictly after `eventId`, or null when `eventId` is not buffered. */
  after(eventId: string): WireEvent[] | null {
    const index = this.items.findIndex((item) => item.event_id === eventId);
    if (index < 0) return null;
    return this.items.slice(index + 1);
  }

  snapshot(): WireEvent[] {
    return [...this.items];
  }
}

/**
 * FIFO-bounded set of event ids used for de-duplication.
 *
 * Known limitation: once an id is evicted, a duplicate of that very old event
 * would be accepted again. The bound is far larger than any realistic replay
 * window and keeps memory constant.
 */
export class BoundedIdSet {
  readonly capacity: number;
  ids: Set<string>;
  order: string[];

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error('BoundedIdSet capacity must be a positive integer');
    }
    this.capacity = capacity;
    this.ids = new Set();
    this.order = [];
  }

  get size(): number {
    return this.ids.size;
  }

  has(id: string): boolean {
    return this.ids.has(id);
  }

  /** Returns false when the id was already present. */
  add(id: string): boolean {
    if (this.ids.has(id)) return false;
    this.ids.add(id);
    this.order.push(id);
    if (this.order.length > this.capacity) {
      const evicted = this.order.splice(0, this.order.length - this.capacity);
      for (const old of evicted) this.ids.delete(old);
    }
    return true;
  }
}
