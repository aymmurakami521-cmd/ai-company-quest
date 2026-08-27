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
 *
 * The byte ceiling is enforced *before* the document exists in memory. Reading
 * the whole file and measuring it afterwards would make the advertised bound a
 * report rather than a limit: a multi-gigabyte file at the configured path would
 * already have been loaded and decoded by the time it was refused.
 */

import { open } from 'node:fs/promises';

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
  /**
   * Test seam, and only that. Production callers leave it unset and get
   * `readSnapshotBytes`, which never holds more than `maxBytes + 1` bytes.
   *
   * It cannot widen what is accepted: the ceiling below is re-applied to
   * whatever this returns, so an injected reader can only spend its own memory,
   * never raise the limit. `loadOrgState` is not a trust boundary for it - the
   * caller supplying it is inside the process already.
   */
  readForTest?: (path: string, maxBytes: number) => Promise<Uint8Array>;
};

/**
 * Reads at most `maxBytes + 1` bytes from `path`.
 *
 * The extra byte is the whole trick: it is exactly enough to tell "fits" from
 * "does not fit" without learning how far past the ceiling the file goes, so
 * the peak allocation is bounded by configuration rather than by the file. The
 * handle is closed on every path, including a mid-read failure.
 */
export async function readSnapshotBytes(path: string, maxBytes: number): Promise<Uint8Array> {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(maxBytes + 1);
    let filled = 0;
    while (filled < buffer.length) {
      const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, filled);
      // A short read only means end of file here: the handle is opened once and
      // read sequentially from offset 0.
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    return buffer.subarray(0, filled);
  } finally {
    await handle.close().catch(() => {});
  }
}

/**
 * Strict UTF-8. A truncated or malformed sequence is a rejected document, not a
 * document silently repaired with U+FFFD: a replacement character inside a
 * display name would be accepted as a name nobody wrote. `ignoreBOM` keeps a
 * leading BOM in the text, so a BOM-prefixed file still fails at `JSON.parse`
 * exactly as it did before, rather than becoming newly acceptable here.
 */
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

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
  const read = options.readForTest ?? readSnapshotBytes;

  let bytes: Uint8Array;
  try {
    bytes = await read(options.path, maxBytes);
  } catch {
    // The path itself is operator input and may be an absolute local path, so
    // it is never echoed back into a status value.
    return { status: 'rejected', field: '(file)', rule: 'not_object' };
  }

  // One byte past the ceiling is proof enough that the file does not fit.
  if (bytes.length > maxBytes) {
    return { status: 'rejected', field: '(file)', rule: 'limit_exceeded' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(UTF8.decode(bytes));
  } catch {
    return { status: 'rejected', field: '(file)', rule: 'not_object' };
  }

  return orgStateFrom(validateOrgSnapshot(parsed, options.limits ?? DEFAULT_ORG_LIMITS));
}
