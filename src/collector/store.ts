/**
 * Per-namespace ingest store.
 *
 * One store == one namespace == one reduced state, one `ingest_seq` counter,
 * one de-duplication index, one replay buffer and one subscriber list. LIVE and
 * DEMO are separate instances and share no mutable structure, so a DEMO event
 * cannot reach a LIVE consumer.
 *
 * Every structure that grows with the stream is bounded: the replay buffer and
 * the de-duplication index evict their oldest entries, and the reduced state is
 * capped by `StateLimits`. Reaching a state limit halts ingestion (fail closed)
 * rather than evicting actors or sessions, because dropping an actor would make
 * the served state a silent lie about what the stream contained.
 */

import type { Namespace, SanitizedEvent } from '../domain/event.ts';
import type { ActorDirectory } from '../domain/actor.ts';
import { resolveActorFromEvent } from '../domain/actor.ts';
import type { IngestedEvent, PlayerEntity, QuestState, StateLimits } from '../domain/reducer.ts';
import { DEFAULT_STATE_LIMITS, checkStateLimits, createInitialState, reduce } from '../domain/reducer.ts';
import { emptyRecord, ownProperty } from '../domain/record.ts';
import type { RejectReason, ValidationResult } from '../domain/validate.ts';
import { DEFAULT_MAX_LINE_BYTES, validateEventObject, validateLine } from '../domain/validate.ts';
import type { WireEvent } from '../domain/wire.ts';
import { toWireEvent } from '../domain/wire.ts';
import { BoundedIdSet, ReplayBuffer } from './replayBuffer.ts';

/** Why ingestion stopped for good. Details are sanitized, never stream content. */
export type HaltReason = 'unsupported_schema' | 'state_limit';

/**
 * What a halt tells subscribers.
 *
 * `reason` is a closed vocabulary and `detail` is the same sanitized fragment
 * `/health` already publishes (`schema_version:<n>` or `<limit>:<max>`): a
 * bounded fact about the boundary that was crossed, never stream content.
 */
export type HaltNotice = { namespace: Namespace; reason: HaltReason; detail: string };

export type IngestOutcome =
  | { status: 'accepted'; wire: WireEvent; ingested: IngestedEvent }
  | { status: 'duplicate'; event_id: string }
  | { status: 'blank' }
  | { status: 'rejected'; reason: RejectReason | 'halted'; detail: string }
  | { status: 'halt'; reason: HaltReason; detail: string };

export type IngestStats = {
  lines_seen: number;
  accepted: number;
  duplicates: number;
  blank: number;
  rejected: number;
  rejected_by_reason: Record<string, number>;
  dropped_producer_keys: number;
  last_ingest_seq: number;
  halted: boolean;
  halt_reason: string | null;
};

export type ReplayLookup =
  | { status: 'replay'; events: WireEvent[] }
  | { status: 'gap'; reason: 'evicted'; oldest_event_id: string | null; oldest_ingest_seq: number | null }
  | { status: 'unknown'; reason: 'unknown_event_id' };

export type StoreOptions = {
  namespace: Namespace;
  /** LIVE sets this: an unsupported schema halts ingestion instead of skipping lines. */
  failClosedOnUnsupportedSchema?: boolean;
  replayCapacity?: number;
  dedupeCapacity?: number;
  maxLineBytes?: number;
  directory?: ActorDirectory;
  player?: PlayerEntity;
  /** Per-limit overrides; anything omitted keeps `DEFAULT_STATE_LIMITS`. */
  stateLimits?: Partial<StateLimits>;
};

export const DEFAULT_REPLAY_CAPACITY = 500;
export const DEFAULT_DEDUPE_CAPACITY = 100_000;

export type WireListener = (wire: WireEvent) => void;
export type HaltListener = (notice: HaltNotice) => void;

export class NamespaceStore {
  readonly namespace: Namespace;
  readonly failClosedOnUnsupportedSchema: boolean;
  readonly maxLineBytes: number;
  readonly replay: ReplayBuffer;
  readonly seenIds: BoundedIdSet;
  readonly directory: ActorDirectory | undefined;
  readonly stateLimits: StateLimits;

  state: QuestState;
  stats: IngestStats;
  nextIngestSeq: number;
  listeners: Set<WireListener>;
  haltListeners: Set<HaltListener>;
  /**
   * The halt that stopped this store, kept so a client that was not connected
   * when it happened can still be told the same fact on the same frame shape.
   */
  haltNotice: HaltNotice | null;

  constructor(options: StoreOptions) {
    this.namespace = options.namespace;
    this.failClosedOnUnsupportedSchema = options.failClosedOnUnsupportedSchema ?? options.namespace === 'live';
    this.maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
    this.replay = new ReplayBuffer(options.replayCapacity ?? DEFAULT_REPLAY_CAPACITY);
    this.seenIds = new BoundedIdSet(options.dedupeCapacity ?? DEFAULT_DEDUPE_CAPACITY);
    this.directory = options.directory;
    this.stateLimits = { ...DEFAULT_STATE_LIMITS, ...options.stateLimits };
    this.state = createInitialState(options.namespace, options.player, this.stateLimits);
    this.nextIngestSeq = 1;
    this.listeners = new Set();
    this.haltListeners = new Set();
    this.haltNotice = null;
    this.stats = {
      lines_seen: 0,
      accepted: 0,
      duplicates: 0,
      blank: 0,
      rejected: 0,
      // Prototype-less like every other keyed map here, even though the reasons
      // themselves are a closed internal set.
      rejected_by_reason: emptyRecord<number>(),
      dropped_producer_keys: 0,
      last_ingest_seq: 0,
      halted: false,
      halt_reason: null,
    };
  }

  get halted(): boolean {
    return this.stats.halted;
  }

  subscribe(listener: WireListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Subscribes to the halt itself. A halt produces no wire event, so without
   * this a client that is already connected would keep seeing a healthy stream
   * (heartbeats, no error) after ingestion stopped for good.
   */
  subscribeHalt(listener: HaltListener): () => void {
    this.haltListeners.add(listener);
    return () => {
      this.haltListeners.delete(listener);
    };
  }

  countRejection(reason: string): void {
    this.stats.rejected += 1;
    this.stats.rejected_by_reason[reason] = (ownProperty(this.stats.rejected_by_reason, reason) ?? 0) + 1;
  }

  /**
   * Stops ingestion for good and tells every current subscriber, once. The
   * notification is emitted only on the transition into the halted state, so a
   * second halt attempt cannot replay it.
   *
   * The notice is also retained, because subscribers present at the transition
   * are not the only ones who need it: a client that was disconnected when the
   * halt happened reads it back when it reconnects.
   */
  halt(reason: HaltReason, detail: string): IngestOutcome {
    if (this.stats.halted) return { status: 'halt', reason, detail };
    this.stats.halted = true;
    this.stats.halt_reason = `${reason}:${detail}`;
    const notice: HaltNotice = { namespace: this.namespace, reason, detail };
    this.haltNotice = notice;
    for (const listener of this.haltListeners) listener(notice);
    return { status: 'halt', reason, detail };
  }

  /** Ingests one raw JSONL line. */
  ingestLine(line: string): IngestOutcome {
    this.stats.lines_seen += 1;
    if (this.stats.halted) {
      this.countRejection('halted');
      return { status: 'rejected', reason: 'halted', detail: 'store:halted' };
    }
    const result = validateLine(line, { maxLineBytes: this.maxLineBytes });
    return this.applyValidation(result);
  }

  /** Ingests an already-parsed object (demo fixtures, tests, replay tooling). */
  ingestObject(raw: unknown): IngestOutcome {
    this.stats.lines_seen += 1;
    if (this.stats.halted) {
      this.countRejection('halted');
      return { status: 'rejected', reason: 'halted', detail: 'store:halted' };
    }
    return this.applyValidation(validateEventObject(raw));
  }

  applyValidation(result: ValidationResult): IngestOutcome {
    if (!result.ok) {
      if (result.reason === 'blank') {
        this.stats.blank += 1;
        return { status: 'blank' };
      }
      if (result.reason === 'unsupported_schema' && this.failClosedOnUnsupportedSchema) {
        this.countRejection('unsupported_schema');
        return this.halt('unsupported_schema', result.detail);
      }
      this.countRejection(result.reason);
      return { status: 'rejected', reason: result.reason, detail: result.detail };
    }

    this.stats.dropped_producer_keys += result.dropped_keys.length;
    return this.accept(result.event);
  }

  /**
   * Assigns `ingest_seq` and folds the event. Only accepted, unique events get a
   * sequence number, so the sequence is deterministic for a given accepted
   * stream regardless of producer-side numbering.
   */
  accept(event: SanitizedEvent): IngestOutcome {
    const ingested: IngestedEvent = {
      namespace: this.namespace,
      ingest_seq: this.nextIngestSeq,
      event,
      actor: resolveActorFromEvent(event, this.directory),
    };

    // Checked before the de-duplication slot and the sequence number are spent,
    // so a halted store never records the event that halted it. A duplicate or
    // an event for a known actor can never trigger this: only new keys count.
    const violation = checkStateLimits(this.state, ingested);
    if (violation !== null) {
      this.countRejection('state_limit');
      return this.halt('state_limit', `${violation.limit}:${violation.max}`);
    }

    if (!this.seenIds.add(event.event_id)) {
      this.stats.duplicates += 1;
      return { status: 'duplicate', event_id: event.event_id };
    }
    this.nextIngestSeq += 1;

    this.state = reduce(this.state, ingested);
    this.stats.accepted += 1;
    this.stats.last_ingest_seq = ingested.ingest_seq;

    const wire = toWireEvent(ingested);
    this.replay.push(wire);
    for (const listener of this.listeners) listener(wire);

    return { status: 'accepted', wire, ingested };
  }

  /**
   * Resolves a `Last-Event-ID` into either a replay slice or an explicit gap.
   *
   * - `replay`: the id is still buffered; the caller gets everything after it.
   * - `gap`: the id was ingested but has been evicted from the bounded buffer.
   * - `unknown`: this store has never seen the id (wrong namespace, or restart).
   */
  replayFrom(lastEventId: string): ReplayLookup {
    const after = this.replay.after(lastEventId);
    if (after !== null) return { status: 'replay', events: after };
    const oldest = this.replay.oldest();
    if (this.seenIds.has(lastEventId)) {
      return {
        status: 'gap',
        reason: 'evicted',
        oldest_event_id: oldest === null ? null : oldest.event_id,
        oldest_ingest_seq: oldest === null ? null : oldest.ingest_seq,
      };
    }
    return { status: 'unknown', reason: 'unknown_event_id' };
  }
}
