/**
 * Records keyed by stream content.
 *
 * `session_id`, `agent_id` and `event_type` are producer-controlled, and their
 * accepted patterns admit `__proto__`, `constructor`, `toString` and friends. On
 * an ordinary object literal, looking such a key up answers with an inherited
 * `Object.prototype` member instead of `undefined`: the collector would then
 * treat a function as a `SessionState`, throw a `TypeError` inside the reducer,
 * and - because the tailer has already advanced its offset by then - silently
 * drop that record and every later record.
 *
 * So every map whose keys come from the stream is built here: prototype-less, so
 * a lookup can only ever return something we stored ourselves, and read through
 * `ownProperty`, so the guarantee also holds for a state that arrived from
 * somewhere else (a replay, a JSON round-trip, a caller-built fixture).
 */

/** A new prototype-less map. */
export function emptyRecord<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

/**
 * Copy-on-write clone that keeps the null prototype - object spread would not:
 * `{ ...nullProtoMap }` produces an ordinary object again.
 */
export function copyRecord<T>(source: Record<string, T>): Record<string, T> {
  return Object.assign(emptyRecord<T>(), source);
}

/** Own-property lookup: never resolves to an inherited member. */
export function ownProperty<T>(record: Record<string, T>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}
