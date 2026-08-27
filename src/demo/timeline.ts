/**
 * The scripted DEMO mission.
 *
 * `fixtures.ts` is a still photograph: one desk in every visual state, folded in
 * one go, so the legend has something to be read against. This is the moving
 * picture - the same office, but delivered one event at a time so a person can
 * watch a piece of work travel from "mission accepted" to "finished", the way it
 * would if a real session were feeding the collector.
 *
 * What it is NOT:
 * - It is not a simulation of Claude Code. Every event here is an ordinary
 *   sanitized event and goes through the same validator as anything else.
 * - It never reaches LIVE. `DemoPlayer` refuses any store that is not DEMO, the
 *   same guard `seedDemoStore` has.
 * - It reports nothing it has not "done". The mission ends in a completion the
 *   preceding events actually build up to, and the two side stories below end in
 *   an error and in a status this screen openly cannot interpret.
 *
 * Timestamps are stamped at ingestion, not baked in: the point of the animated
 * demo is that "last update" means something, and a frame dated 2026-01-01 while
 * the office is visibly moving would be its own small lie. Event ids ARE fixed,
 * so replay and de-duplication behave exactly as they do for any other stream.
 */

import type { SanitizedEvent } from '../domain/event.ts';
import type { NamespaceStore } from '../collector/store.ts';

/** One scripted beat. `ts` is filled in when the beat is actually ingested. */
export type TimelineBeat = Omit<SanitizedEvent, 'ts'>;

const BASE: Omit<SanitizedEvent, 'event_id' | 'ts' | 'event_type'> = {
  schema_version: 2,
  sanitizer_version: 3,
  session_id: 'demo-mission-01',
  agent_id: 'main',
  agent_role: null,
  runtime_agent_type: null,
  producer_seq: null,
  status: null,
  tool_name: null,
  duration_ms: null,
  token_count: null,
  summary: null,
};

/**
 * The mission, beat by beat.
 *
 * `summary` is written so the next stage is readable from the current one -
 * that is the only thing standing in for a "what happens next" field, because
 * the event contract has none and this screen will not invent one. What a
 * summary says here is a scripted fact, not a prediction the UI derived.
 */
export const DEMO_TIMELINE: readonly TimelineBeat[] = [
  // --- the mission is accepted -------------------------------------------
  {
    ...BASE,
    event_id: '10000000-0000-4000-8000-000000000001',
    event_type: 'session_start',
    summary: 'ミッション開始: READMEの起動手順を修正する',
  },
  {
    ...BASE,
    event_id: '10000000-0000-4000-8000-000000000002',
    event_type: 'agent_start',
    status: 'active',
    runtime_agent_type: 'orchestrator',
    summary: '担当を決めています。次は計画を立てます',
  },

  // --- planning -----------------------------------------------------------
  {
    ...BASE,
    event_id: '10000000-0000-4000-8000-000000000003',
    event_type: 'agent_start',
    agent_id: 'dev-1',
    status: 'planning',
    runtime_agent_type: 'implementer',
    summary: '変更範囲を調べて計画中。次は実装に入ります',
  },
  {
    ...BASE,
    event_id: '10000000-0000-4000-8000-000000000004',
    event_type: 'agent_status',
    status: 'planning',
    summary: '計画を確認しています。次は実装を開始します',
  },

  // --- implementation -----------------------------------------------------
  {
    ...BASE,
    event_id: '10000000-0000-4000-8000-000000000005',
    event_type: 'tool_use',
    agent_id: 'dev-1',
    tool_name: 'read',
    status: 'running',
    duration_ms: 18,
    summary: 'READMEの該当箇所を読んでいます',
  },
  {
    ...BASE,
    event_id: '10000000-0000-4000-8000-000000000006',
    event_type: 'tool_use',
    agent_id: 'dev-1',
    tool_name: 'edit',
    status: 'running',
    duration_ms: 42,
    summary: '起動手順を書き換えています。次はテストを流します',
  },
  {
    ...BASE,
    event_id: '10000000-0000-4000-8000-000000000007',
    event_type: 'agent_status',
    status: 'working',
    summary: '実装の進捗を確認しています',
  },

  // --- testing ------------------------------------------------------------
  {
    ...BASE,
    event_id: '10000000-0000-4000-8000-000000000008',
    event_type: 'agent_start',
    agent_id: 'qa-1',
    status: 'testing',
    runtime_agent_type: 'verifier',
    summary: 'テストを実行しています。次はレビューに回します',
  },
  {
    ...BASE,
    event_id: '10000000-0000-4000-8000-000000000009',
    event_type: 'tool_use',
    agent_id: 'qa-1',
    tool_name: 'test',
    status: 'ok',
    duration_ms: 690,
    summary: 'テストは通りました',
  },

  // --- review -------------------------------------------------------------
  {
    ...BASE,
    event_id: '10000000-0000-4000-8000-00000000000a',
    event_type: 'agent_start',
    agent_id: 'review-1',
    status: 'reviewing',
    runtime_agent_type: 'reviewer',
    summary: '差分をレビューしています。次は人間の承認を求めます',
  },

  // --- the work stops for a human ----------------------------------------
  {
    ...BASE,
    event_id: '10000000-0000-4000-8000-00000000000b',
    event_type: 'agent_status',
    agent_id: 'dev-1',
    status: 'awaiting_approval',
    summary: '人間の承認を待っています。承認されるまで先へ進みません',
  },
  // ...and only moves again once it has been given. Nothing here advances on a
  // timer alone: this beat is the approval, not the passage of time.
  {
    ...BASE,
    event_id: '10000000-0000-4000-8000-00000000000c',
    event_type: 'agent_status',
    agent_id: 'dev-1',
    status: 'working',
    summary: '承認を受けて作業を再開しました。次は仕上げて完了します',
  },

  // --- completion ---------------------------------------------------------
  {
    ...BASE,
    event_id: '10000000-0000-4000-8000-00000000000d',
    event_type: 'agent_stop',
    agent_id: 'review-1',
    status: 'completed',
    summary: 'レビュー完了',
  },
  {
    ...BASE,
    event_id: '10000000-0000-4000-8000-00000000000e',
    event_type: 'agent_stop',
    agent_id: 'qa-1',
    status: 'completed',
    summary: 'テスト完了',
  },
  {
    ...BASE,
    event_id: '10000000-0000-4000-8000-00000000000f',
    event_type: 'agent_stop',
    agent_id: 'dev-1',
    status: 'completed',
    summary: 'READMEの起動手順を修正し、テストとレビューを通しました',
  },

  // --- side story 1: something fails --------------------------------------
  // A separate actor, so the mission above stays readable as a success while
  // this one is visibly not.
  {
    ...BASE,
    event_id: '10000000-0000-4000-8000-000000000010',
    event_type: 'agent_start',
    agent_id: 'sync-1',
    status: 'active',
    runtime_agent_type: 'implementer',
    summary: '別件: 外部の取り込みを開始しました',
  },
  {
    ...BASE,
    event_id: '10000000-0000-4000-8000-000000000011',
    event_type: 'agent_stop',
    agent_id: 'sync-1',
    status: 'error',
    summary: '別件: 取り込みに失敗して停止しました',
  },

  // --- side story 2: a status this screen cannot interpret ----------------
  // The honest case. The producer said something; the vocabulary has no entry
  // for it; the screen says 状態不明 rather than guessing from the active flag.
  {
    ...BASE,
    event_id: '10000000-0000-4000-8000-000000000012',
    event_type: 'agent_start',
    agent_id: 'ext-1',
    status: 'sync_pending',
    summary: '別件: この画面に語彙が無いstatusを報告しています',
  },
];

export type DemoPlayerOptions = {
  store: NamespaceStore;
  /** Gap between beats once playback has started. */
  intervalMs: number;
  /**
   * Gap before the FIRST beat.
   *
   * Two things depend on it. `server.ts` writes the opening snapshot after
   * `subscribe()` returns, so a beat ingested synchronously from the
   * first-subscriber hook would be overwritten by the snapshot that follows it.
   * And a person needs to have the page in front of them before the office
   * starts moving. Both want the same thing: do not start in the same tick.
   */
  firstDelayMs: number;
  /** Injected so tests never depend on the wall clock. */
  now?: () => Date;
  /** Called once the last beat has been ingested. */
  onFinished?: () => void;
};

/**
 * Feeds `DEMO_TIMELINE` into a DEMO store, one beat at a time.
 *
 * `step()` is the whole state machine; `start()` only decides when to call it.
 * Tests drive `step()` directly, so the scenario is verified without waiting on
 * a single timer.
 */
export class DemoPlayer {
  readonly store: NamespaceStore;
  readonly timeline: readonly TimelineBeat[];
  readonly intervalMs: number;
  readonly firstDelayMs: number;

  #now: () => Date;
  #onFinished: (() => void) | undefined;
  #index = 0;
  #started = false;
  #stopped = false;
  #timer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: DemoPlayerOptions, timeline: readonly TimelineBeat[] = DEMO_TIMELINE) {
    if (options.store.namespace !== 'demo') {
      throw new Error(`refusing to play the demo timeline into namespace '${options.store.namespace}'`);
    }
    this.store = options.store;
    this.timeline = timeline;
    this.intervalMs = options.intervalMs;
    this.firstDelayMs = options.firstDelayMs;
    this.#now = options.now ?? (() => new Date());
    this.#onFinished = options.onFinished;
  }

  /** How many beats have been ingested so far. */
  get progress(): number {
    return this.#index;
  }

  get finished(): boolean {
    return this.#index >= this.timeline.length;
  }

  get started(): boolean {
    return this.#started;
  }

  /**
   * Ingests the next beat. Returns false when there is nothing left, so a
   * caller can stop without knowing the length of the script.
   */
  step(): boolean {
    if (this.#stopped || this.finished) return false;
    const beat = this.timeline[this.#index];
    if (beat === undefined) return false;
    this.#index += 1;
    this.store.ingestObject({ ...beat, ts: this.#now().toISOString() });
    if (this.finished && this.#onFinished !== undefined) this.#onFinished();
    return true;
  }

  /**
   * Starts playback, once. A second call - a reconnect, a second tab, a second
   * subscriber - is deliberately a no-op rather than a restart.
   */
  start(): void {
    if (this.#started || this.#stopped) return;
    this.#started = true;
    this.#schedule(this.firstDelayMs);
  }

  /** Stops for good. Safe to call more than once, and from a signal handler. */
  stop(): void {
    this.#stopped = true;
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
  }

  #schedule(delayMs: number): void {
    if (this.#stopped || this.finished) return;
    const timer = setTimeout(() => {
      this.#timer = null;
      if (this.step() && !this.finished) this.#schedule(this.intervalMs);
    }, delayMs);
    // Never a reason to keep the process alive on its own.
    if (typeof timer.unref === 'function') timer.unref();
    this.#timer = timer;
  }
}
