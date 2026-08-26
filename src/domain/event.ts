/**
 * Internal normalized event model (schema_version = 2).
 *
 * This is the shape the reducer, the store, the SSE projection and the UI all
 * speak. It is NOT the external LIVE wire contract: a Claude Code hook emits the
 * rich/nested shape described in `hookWire.ts`, which `hookAdapter.ts` maps onto
 * this model at the ingest boundary.
 *
 * Both shapes carry `schema_version: 2` and they are not interchangeable. Which
 * one applies is decided by the store's `inputContract` at construction time and
 * is never inferred from a payload, so the two can never be confused.
 *
 * This module contains no I/O and no secrets.
 *
 * Design rules that must not be relaxed without a schema bump:
 * - `schema_version` is the ONLY compatibility gate. Unsupported values are
 *   fail-closed for LIVE ingestion.
 * - `sanitizer_version` is observational metadata. It is recorded and exposed,
 *   but never used to accept or reject an event.
 * - Every REQUIRED_KEYS key is always present. Optional information is expressed
 *   as an explicit `null`, never as a missing key. `OPTIONAL_KEYS` holds fields
 *   added after the model was frozen; they are modelled and validated, and an
 *   absent one normalizes to `null` rather than rejecting the event.
 * - No field may carry raw prompts, raw commands, absolute file paths or
 *   credentials. See `validate.ts` for the enforced checks.
 */

export const SUPPORTED_SCHEMA_VERSION = 2;

/** Namespaces are hard-isolated stores. DEMO data must never reach LIVE. */
export type Namespace = 'live' | 'demo';

export const NAMESPACES: readonly Namespace[] = ['live', 'demo'];

/**
 * Event types the reducer understands. Unknown-but-well-formed event types are
 * accepted (forward compatibility within schema_version 2) and ignored by the
 * reducer instead of being rejected at the collector boundary.
 */
export const KNOWN_EVENT_TYPES = [
  'session_start',
  'session_end',
  'agent_start',
  'agent_stop',
  'agent_status',
  'tool_use',
  'handoff',
  'heartbeat',
] as const;

export type KnownEventType = (typeof KNOWN_EVENT_TYPES)[number];

export type SanitizedEvent = {
  /** Compatibility gate. Must equal SUPPORTED_SCHEMA_VERSION. */
  schema_version: number;
  /** Observational only. Never used for accept/reject decisions. */
  sanitizer_version: number;
  /** UUIDv4, used for de-duplication and as the SSE `id:` field. */
  event_id: string;
  /** Opaque local session identifier. */
  session_id: string;
  /** ISO-8601 timestamp produced by the sanitizer. */
  ts: string;
  /** Lowercase slug. Known values are listed in KNOWN_EVENT_TYPES. */
  event_type: string;
  /** Agent slug within the session, or null when the producer cannot attribute it. */
  agent_id: string | null;
  /** Sanitized org role label, or null. Never inferred by this codebase. */
  agent_role: string | null;
  /**
   * Runtime agent type reported by the producer (e.g. a subagent type slug).
   *
   * This is NOT `agent_role`: it describes which runtime configuration Claude
   * Code started, not an organisational role in the company view. It is kept so
   * a future directory lookup can match on it explicitly; nothing infers a role
   * from it today.
   */
  runtime_agent_type: string | null;
  /** Producer-side sequence. Recorded for diagnostics, never trusted for ordering. */
  producer_seq: number | null;
  /** Short status label, or null. */
  status: string | null;
  /** Tool label (not a command line), or null. */
  tool_name: string | null;
  duration_ms: number | null;
  token_count: number | null;
  /** Short sanitized display label. Never a raw prompt or command. */
  summary: string | null;
};

/** Frozen contract keys. Presence of every key is mandatory (null is allowed). */
export const REQUIRED_KEYS = [
  'schema_version',
  'sanitizer_version',
  'event_id',
  'session_id',
  'ts',
  'event_type',
  'agent_id',
  'agent_role',
  'producer_seq',
  'status',
  'tool_name',
  'duration_ms',
  'token_count',
  'summary',
] as const;

export type RequiredKey = (typeof REQUIRED_KEYS)[number];

/**
 * Modelled keys added after the model was frozen. An absent one normalizes to
 * `null`, so an internal producer written against the frozen key set stays
 * valid; a present one is validated exactly like a required key.
 */
export const OPTIONAL_KEYS = ['runtime_agent_type'] as const;

export type OptionalKey = (typeof OPTIONAL_KEYS)[number];

/** Every key the internal model knows. Anything else is dropped, never forwarded. */
export const CONTRACT_KEYS: readonly string[] = [...REQUIRED_KEYS, ...OPTIONAL_KEYS];

export function isKnownEventType(value: string): value is KnownEventType {
  return (KNOWN_EVENT_TYPES as readonly string[]).includes(value);
}
