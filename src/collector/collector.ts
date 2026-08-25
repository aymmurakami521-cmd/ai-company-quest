/**
 * Collector: binds one tailer to exactly one namespace store.
 *
 * The namespace is fixed at construction time. There is no API to move events
 * between namespaces, which is what makes LIVE/DEMO isolation structural rather
 * than a convention.
 */

import type { Namespace } from '../domain/event.ts';
import type { IngestOutcome, NamespaceStore } from './store.ts';
import type { TailerNotice, TailerOptions } from './tailer.ts';
import { JsonlTailer } from './tailer.ts';

export type CollectorHaltReason = 'unsupported_schema';

export type CollectorOptions = {
  store: NamespaceStore;
  input: TailerOptions;
  /** Called once when fail-closed halting triggers. */
  onHalt?: (reason: CollectorHaltReason, detail: string) => void;
  onNotice?: (notice: TailerNotice) => void;
};

export class Collector {
  readonly store: NamespaceStore;
  readonly tailer: JsonlTailer;
  readonly onHalt: (reason: CollectorHaltReason, detail: string) => void;
  halted: boolean;

  constructor(options: CollectorOptions) {
    this.store = options.store;
    this.onHalt = options.onHalt ?? (() => {});
    this.halted = false;
    this.tailer = new JsonlTailer(options.input, {
      onLine: (line) => {
        this.handle(this.store.ingestLine(line));
      },
      onNotice: options.onNotice ?? (() => {}),
    });
  }

  get namespace(): Namespace {
    return this.store.namespace;
  }

  handle(outcome: IngestOutcome): void {
    if (outcome.status === 'halt' && !this.halted) {
      this.halted = true;
      // Fail closed: stop reading immediately, keep the served state frozen.
      void this.tailer.stop();
      this.onHalt(outcome.reason, outcome.detail);
    }
  }

  async start(): Promise<void> {
    await this.tailer.start();
  }

  async stop(): Promise<void> {
    await this.tailer.stop();
  }
}
