/**
 * The one place that reads an org snapshot from disk.
 *
 * Boundaries this module holds:
 * - The path comes from configuration only, exactly like `QUEST_INPUT_PATH`.
 *   Nothing here derives a path from an event, and no cross-repository location
 *   is baked in: an unconfigured path is a normal, healthy "absent".
 * - The read happens once, at startup. There is no watcher, no re-read and no
 *   endpoint that could write the snapshot back.
 * - Failure is closed and *local*: it disables the org slot and nothing else.
 *   Event ingestion, the collector, the reducer and the LIVE stream are not
 *   involved and never halt because of it.
 * - No error text ever escapes. `fs` messages quote the path, so they are
 *   discarded and replaced by the closed `read_error` rule.
 */

import { readFileSync, statSync } from 'node:fs';

import type { OrgLimits, OrgState } from '../domain/orgSnapshot.ts';
import { DEFAULT_ORG_LIMITS, orgAbsent, orgAccepted, orgRejected, parseOrgSnapshot } from '../domain/orgSnapshot.ts';

/**
 * Resolves the configured path into an `OrgState`.
 *
 * `null` (unconfigured) is not a failure: it is the default deployment, and it
 * yields `absent` rather than `rejected`.
 */
export function loadOrgSnapshotFile(path: string | null, limits: OrgLimits = DEFAULT_ORG_LIMITS): OrgState {
  if (path === null) return orgAbsent(limits);

  let text: string;
  try {
    const stats = statSync(path);
    // A directory, a FIFO or a device would either throw later or block the
    // startup read; refusing them here keeps the failure bounded and closed.
    if (!stats.isFile()) return orgRejected({ rule: 'read_error', field: 'file' }, limits);
    // Checked before reading so an oversized file is never pulled into memory.
    if (stats.size > limits.max_bytes) return orgRejected({ rule: 'oversized', field: 'file' }, limits);
    text = readFileSync(path, 'utf8');
  } catch {
    return orgRejected({ rule: 'read_error', field: 'file' }, limits);
  }

  const result = parseOrgSnapshot(text, limits);
  if (!result.ok) return orgRejected(result.rejection, limits);
  return orgAccepted(result.snapshot, limits);
}
