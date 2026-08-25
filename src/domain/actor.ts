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
 */

import type { SanitizedEvent } from './event.ts';

export const MAIN_AGENT_ID = 'main';
export const UNKNOWN_AGENT_ID = 'unknown';

/**
 * Explicitly allowed agent metadata. Keys are either `${session_id}:${agent_id}`
 * (session-scoped, higher precedence) or a bare `${agent_id}` (global).
 */
export type ActorDirectory = {
  roles: Record<string, string>;
};

export type ResolvedActor = {
  /** Stable identity used by the reducer: `${session_id}:${agent_id}`. */
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

export function actorKeyOf(sessionId: string, agentId: string | null): string {
  return `${sessionId}:${agentId ?? UNKNOWN_AGENT_ID}`;
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
    const scoped = directory.roles[key];
    const unscoped = directory.roles[agentId];
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
