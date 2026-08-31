/**
 * Reads the value ledger from an operator-configured path.
 *
 * The only I/O in the value path, kept apart from the pure validator in
 * `domain/valueLedger.ts` so the contract can be tested without a filesystem.
 * It is deliberately not part of the collector's ingest loop: the ledger is
 * read once at startup, and a failure here never halts ingest - a malformed
 * rate table says nothing about the health of the event stream.
 *
 * Boundary rules, identical to `orgLoader.ts`:
 * - the path comes from configuration only, never from event content;
 * - a missing configuration is `absent`, which is a supported mode;
 * - anything unreadable, unparseable or invalid is `rejected`, and the reason
 *   names a field path and a rule - never file content, never a rate, never
 *   the path itself.
 *
 * The byte ceiling is enforced *before* the document exists in memory, for the
 * same reason it is in `orgLoader.ts`: a bound applied after reading is a
 * report, not a limit.
 */

import { open } from 'node:fs/promises';

import {
  DEFAULT_VALUE_LEDGER_LIMITS,
  VALUE_LEDGER_ABSENT,
  valueLedgerStateFrom,
  validateValueLedger,
  type ValueLedgerLimits,
  type ValueLedgerState,
} from '../domain/valueLedger.ts';

/**
 * Upper bound on the document, checked before parsing. A few thousand value
 * records with their evidence is a few hundred kilobytes; past that the file is
 * refused without reaching a parser.
 */
export const DEFAULT_MAX_VALUE_LEDGER_BYTES = 2 * 1024 * 1024;

export type LoadValueLedgerOptions = {
  path: string | null;
  maxBytes?: number;
  limits?: ValueLedgerLimits;
  /**
   * Test seam, and only that. It cannot widen what is accepted: the ceiling
   * below is re-applied to whatever this returns, so an injected reader can
   * only spend its own memory, never raise the limit.
   */
  readForTest?: (path: string, maxBytes: number) => Promise<Uint8Array>;
};

/**
 * Reads at most `maxBytes + 1` bytes from `path`. The extra byte is exactly
 * enough to tell "fits" from "does not fit" without learning how far past the
 * ceiling the file goes. The handle is closed on every path.
 */
export async function readLedgerBytes(path: string, maxBytes: number): Promise<Uint8Array> {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(maxBytes + 1);
    let filled = 0;
    while (filled < buffer.length) {
      const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    return buffer.subarray(0, filled);
  } finally {
    await handle.close().catch(() => {});
  }
}

/**
 * Strict UTF-8. A malformed sequence is a rejected document, not one silently
 * repaired with U+FFFD: a replacement character inside an identifier would be
 * accepted as an identifier nobody wrote.
 */
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/**
 * Loads and validates the value ledger.
 *
 * Never throws and never rejects: every failure is folded into the closed
 * three-state vocabulary, because a bad ledger must not prevent the collector
 * from starting.
 */
export async function loadValueLedgerState(options: LoadValueLedgerOptions): Promise<ValueLedgerState> {
  if (options.path === null) return VALUE_LEDGER_ABSENT;

  const maxBytes = options.maxBytes ?? DEFAULT_MAX_VALUE_LEDGER_BYTES;
  const read = options.readForTest ?? readLedgerBytes;

  let bytes: Uint8Array;
  try {
    bytes = await read(options.path, maxBytes);
  } catch {
    // The path is operator input and may be an absolute local path, so it is
    // never echoed back into a status value. The rule still separates "could
    // not read it" from "read it and it was not a ledger", so a typo'd path and
    // a malformed document do not produce the same startup line.
    return { status: 'rejected', field: '(file)', rule: 'unreadable' };
  }

  if (bytes.length > maxBytes) {
    return { status: 'rejected', field: '(file)', rule: 'limit_exceeded' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(UTF8.decode(bytes));
  } catch {
    return { status: 'rejected', field: '(file)', rule: 'not_object' };
  }

  return valueLedgerStateFrom(
    validateValueLedger(parsed, options.limits ?? DEFAULT_VALUE_LEDGER_LIMITS),
  );
}
