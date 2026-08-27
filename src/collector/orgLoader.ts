/**
 * Reads the organisation snapshot from an operator-configured path.
 *
 * This is the only I/O in the organisation path, kept apart from the pure
 * validator in `domain/org.ts` so the contract can be tested without a
 * filesystem. It is deliberately *not* part of the collector's ingest loop: the
 * organisation is read once at startup, and a failure here never halts ingest.
 *
 * Boundary rules (`docs/org-snapshot-design.md` §4.5):
 * - the path comes from configuration only, never from event content;
 * - a missing configuration is `absent`, which is a supported mode;
 * - anything unreadable, unparseable or invalid is `rejected`, and the reason
 *   names a field path and a rule - never file content, and never the path.
 */

import { readFile } from 'node:fs/promises';

import {
  DEFAULT_ORG_LIMITS,
  ORG_ABSENT,
  orgStateFrom,
  validateOrgSnapshot,
  type OrgLimits,
  type OrgState,
} from '../domain/org.ts';

/**
 * Upper bound on the document itself, checked before parsing. An organisation
 * of a few hundred people is a few tens of kilobytes; anything far past that is
 * refused without being read into a parser.
 */
export const DEFAULT_MAX_ORG_BYTES = 1024 * 1024;

export type LoadOrgOptions = {
  path: string | null;
  maxBytes?: number;
  limits?: OrgLimits;
  /** Injectable for tests; defaults to reading the real filesystem. */
  read?: (path: string) => Promise<string>;
};

async function defaultRead(path: string): Promise<string> {
  return readFile(path, 'utf8');
}

/**
 * Loads and validates the organisation snapshot.
 *
 * Never throws and never rejects: every failure is folded into the closed
 * three-state vocabulary, because a bad organisation file must not be able to
 * prevent the collector from starting.
 */
export async function loadOrgState(options: LoadOrgOptions): Promise<OrgState> {
  if (options.path === null) return ORG_ABSENT;

  const maxBytes = options.maxBytes ?? DEFAULT_MAX_ORG_BYTES;
  const read = options.read ?? defaultRead;

  let text: string;
  try {
    text = await read(options.path);
  } catch {
    // The path itself is operator input and may be an absolute local path, so
    // it is never echoed back into a status value.
    return { status: 'rejected', field: '(file)', rule: 'not_object' };
  }

  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    return { status: 'rejected', field: '(file)', rule: 'limit_exceeded' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { status: 'rejected', field: '(file)', rule: 'not_object' };
  }

  return orgStateFrom(validateOrgSnapshot(parsed, options.limits ?? DEFAULT_ORG_LIMITS));
}
