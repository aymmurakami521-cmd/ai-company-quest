/**
 * Actor resolution boundary.
 *
 * The collector must never invent organisational meaning. An actor is resolved
 * from (a) the `session_id`, (b) the `agent_id` carried by the sanitized event
 * and (c) an explicitly supplied directory of allowed agent metadata.
 *
 * Rules:
 * - When no directory entry and no sanitized `agent_role` exist, the role is
 *   `null` and `resolved` is false. No fallback, no inference, no job titles.
 * - `{session_id}:main` is the main orchestrator of that session. That is a
 *   structural fact only; it does NOT imply "CEO" or any other human role.
 *
 * Identity is a *tuple*, not a string. `session_id` and `agent_id` both accept
 * `:`, so plain concatenation is ambiguous: (`a:b`, `c`) and (`a`, `b:c`) would
 * collapse into one state key. `actorKeyOf` therefore escapes each component
 * before joining, and encodes "no agent_id" with a marker no component can ever
 * produce - so a real agent literally named `unknown` stays distinct from null.
 */

import type { SanitizedEvent } from './event.ts';
import { ownProperty } from './record.ts';

export const MAIN_AGENT_ID = 'main';

/**
 * Marker for a null `agent_id`. `%` is escaped inside every component, so no
 * real identifier - including the literal string `unknown` - can encode to it.
 */
export const NULL_AGENT_MARKER = '%00';

const ACTOR_KEY_SEPARATOR = ':';

/**
 * Explicitly allowed agent metadata. Keys are either the encoded actor key
 * produced by `actorKeyOf` (session-scoped, higher precedence) or a bare
 * `${agent_id}` (global). For identifiers without `:` or `%` - the normal case -
 * the encoded key is exactly `${session_id}:${agent_id}`.
 */
export type ActorDirectory = {
  roles: Record<string, string>;
};

export type ResolvedActor = {
  /** Stable identity used by the reducer. Collision-free, see `actorKeyOf`. */
  actor_key: string;
  session_id: string;
  agent_id: string | null;
  /** Role label from the directory or from the sanitized event. Never inferred. */
  role: string | null;
  /** True only when a role came from an allowed source. */
  resolved: boolean;
  /** Structural marker for `${session_id}:main`. Not a human job title. */
  is_main_orchestrator: boolean;
  /** Where the role came from, for auditability. */
  role_source: 'directory' | 'event' | 'none';
};

/**
 * Escapes one tuple component so the joined key can be split back unambiguously:
 * `%` first (so the escape marker itself cannot be forged), then the separator.
 * The result contains no `:`, so the key holds exactly one separator.
 */
function encodeComponent(value: string): string {
  return value.replaceAll('%', '%25').replaceAll(ACTOR_KEY_SEPARATOR, '%3A');
}

/**
 * Injective encoding of the `(session_id, agent_id)` tuple. Distinct tuples
 * always produce distinct keys, including when a component contains `:` or when
 * `agent_id` is null versus the literal string `unknown`.
 */
export function actorKeyOf(sessionId: string, agentId: string | null): string {
  const agentPart = agentId === null ? NULL_AGENT_MARKER : encodeComponent(agentId);
  return `${encodeComponent(sessionId)}${ACTOR_KEY_SEPARATOR}${agentPart}`;
}

export function resolveActor(
  sessionId: string,
  agentId: string | null,
  eventRole: string | null,
  directory?: ActorDirectory,
): ResolvedActor {
  const key = actorKeyOf(sessionId, agentId);

  let role: string | null = null;
  let roleSource: ResolvedActor['role_source'] = 'none';

  if (directory !== undefined && agentId !== null) {
    // Own-property lookups: an `agent_id` of `toString` must miss the directory,
    // not answer with a function inherited from `Object.prototype`.
    const scoped = ownProperty(directory.roles, key);
    const unscoped = ownProperty(directory.roles, agentId);
    if (typeof scoped === 'string' && scoped.length > 0) {
      role = scoped;
      roleSource = 'directory';
    } else if (typeof unscoped === 'string' && unscoped.length > 0) {
      role = unscoped;
      roleSource = 'directory';
    }
  }

  if (role === null && eventRole !== null && eventRole.length > 0) {
    role = eventRole;
    roleSource = 'event';
  }

  return {
    actor_key: key,
    session_id: sessionId,
    agent_id: agentId,
    role,
    resolved: role !== null,
    is_main_orchestrator: agentId === MAIN_AGENT_ID,
    role_source: roleSource,
  };
}

export function resolveActorFromEvent(event: SanitizedEvent, directory?: ActorDirectory): ResolvedActor {
  return resolveActor(event.session_id, event.agent_id, event.agent_role, directory);
}
