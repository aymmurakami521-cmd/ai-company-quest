/**
 * JSONL tailer.
 *
 * Reads newline-delimited records from a single configured file and hands
 * complete lines to a callback. It is intentionally a *tailer*, not a file
 * browser: the path comes from configuration, it is never derived from event
 * content, and there is no directory traversal or read API for other files.
 *
 * Handled conditions:
 * - partial trailing line (buffered until its newline arrives)
 * - appends between polls
 * - rotation (inode change) and truncation, including copy-truncate that regrows
 *   past the previous offset between two polls (detected by content, not size)
 * - oversized lines (dropped up to the next newline, counted)
 * - the file not existing yet, disappearing, or being replaced between the
 *   `stat()` and the `open()` of the same poll
 * - starting at the current EOF (`startFrom: 'end'`): the bytes before that EOF
 *   are seeded as the signature, so the first copy-truncate is still detected
 *
 * The path `stat()` is only a probe: it says whether the file exists and whether
 * anything can have changed. Every decision that positions a read - the inode we
 * compare, the EOF we adopt, the signature we seed or verify and the length we
 * read up to - is taken from `fstat` on the handle we are about to read, so a
 * rotation or a copy-truncate landing between the probe and the open can never
 * leave the offset pointing into a different file's bytes.
 *
 * A poll never rejects: every I/O failure becomes a sanitized notice and polling
 * continues, so a rotation racing the collector cannot terminate the process.
 *
 * Polling is used instead of fs.watch because watch semantics differ across
 * platforms; `pollOnce()` is exposed so tests are deterministic and timer-free.
 */

import { open, stat } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { DEFAULT_MAX_LINE_BYTES } from '../domain/validate.ts';

const NEWLINE = 0x0a;
const EMPTY = Buffer.alloc(0);
/**
 * Bytes kept from just before the read offset. Re-checked against the file on
 * every poll that has new data: if they changed, the file was rewritten under
 * the same inode (copy-truncate) even when it is now larger than before.
 */
const SIGNATURE_BYTES = 64;

export type TailerNotice =
  | { type: 'appeared' }
  | { type: 'missing' }
  | { type: 'rotated' }
  | { type: 'truncated' }
  | { type: 'oversized_line'; bytes: number }
  | { type: 'error'; code: string };

export type TailerStats = {
  polls: number;
  bytes_read: number;
  lines_emitted: number;
  rotations: number;
  truncations: number;
  oversized_lines: number;
  partial_bytes_discarded: number;
  errors: number;
};

export type TailerOptions = {
  path: string;
  pollIntervalMs?: number;
  maxLineBytes?: number;
  maxChunkBytes?: number;
  /** 'beginning' is the default: de-duplication makes re-reading safe. */
  startFrom?: 'beginning' | 'end';
};

export type TailerCallbacks = {
  onLine: (line: string) => void;
  onNotice?: (notice: TailerNotice) => void;
};

export class JsonlTailer {
  readonly path: string;
  readonly pollIntervalMs: number;
  readonly maxLineBytes: number;
  readonly maxChunkBytes: number;
  readonly startFrom: 'beginning' | 'end';
  readonly onLine: (line: string) => void;
  readonly onNotice: (notice: TailerNotice) => void;

  offset: number;
  inode: number | null;
  pending: Buffer;
  /** Last bytes read, ending exactly at `offset`. Empty when nothing was read. */
  signature: Buffer;
  /**
   * True while `offset` points at a position this tailer never read itself, so
   * there is no signature to compare yet. Only `startFrom: 'end'` produces it.
   */
  needsSignatureSeed: boolean;
  skippingOversized: boolean;
  hasObservedFile: boolean;
  running: boolean;
  polling: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  stats: TailerStats;

  constructor(options: TailerOptions, callbacks: TailerCallbacks) {
    this.path = options.path;
    this.pollIntervalMs = options.pollIntervalMs ?? 100;
    this.maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
    this.maxChunkBytes = options.maxChunkBytes ?? 1024 * 1024;
    this.startFrom = options.startFrom ?? 'beginning';
    this.onLine = callbacks.onLine;
    this.onNotice = callbacks.onNotice ?? (() => {});

    this.offset = 0;
    this.inode = null;
    this.pending = EMPTY;
    this.signature = EMPTY;
    this.needsSignatureSeed = false;
    this.skippingOversized = false;
    this.hasObservedFile = false;
    this.running = false;
    this.polling = false;
    this.timer = null;
    this.stats = {
      polls: 0,
      bytes_read: 0,
      lines_emitted: 0,
      rotations: 0,
      truncations: 0,
      oversized_lines: 0,
      partial_bytes_discarded: 0,
      errors: 0,
    };
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    await this.pollOnce();
    this.schedule();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    // Let an in-flight poll settle so callers can safely inspect stats.
    while (this.polling) await new Promise((resolve) => setImmediate(resolve));
  }

  schedule(): void {
    if (!this.running) return;
    const timer = setTimeout(() => {
      // `pollOnce` is written not to reject; the catch is a process-safety net so
      // a timer-driven poll can never become an unhandled rejection.
      void this.pollOnce()
        .catch(() => {})
        .then(() => this.schedule());
    }, this.pollIntervalMs);
    timer.unref();
    this.timer = timer;
  }

  discardPending(): void {
    if (this.pending.length > 0) {
      this.stats.partial_bytes_discarded += this.pending.length;
      this.pending = EMPTY;
    }
    this.signature = EMPTY;
    // The offset always returns to a position we will read ourselves, so there
    // is nothing left to seed.
    this.needsSignatureSeed = false;
    this.skippingOversized = false;
  }

  /** Remembers the bytes ending at `offset` so the next poll can verify them. */
  rememberSignature(chunk: Buffer): void {
    if (chunk.length >= SIGNATURE_BYTES) {
      this.signature = Buffer.from(chunk.subarray(chunk.length - SIGNATURE_BYTES));
      return;
    }
    const combined = Buffer.concat([this.signature, chunk]);
    this.signature =
      combined.length <= SIGNATURE_BYTES ? combined : combined.subarray(combined.length - SIGNATURE_BYTES);
  }

  /**
   * Sanitized handling for an I/O failure that happened after this poll's
   * `stat()`. ENOENT means the file we measured was rotated or deleted in the
   * meantime: forget it and keep polling for its replacement.
   */
  handleIoFailure(error: unknown): void {
    const code = (error as NodeJS.ErrnoException).code ?? 'UNKNOWN';
    if (code === 'ENOENT') {
      this.inode = null;
      this.offset = 0;
      this.discardPending();
      this.onNotice({ type: 'missing' });
      return;
    }
    this.stats.errors += 1;
    this.onNotice({ type: 'error', code });
  }

  async pollOnce(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      this.stats.polls += 1;

      // Probe only: existence, plus "can anything have changed?". Its `ino` and
      // `size` are deliberately not used to position a read - by the time we
      // open, the path may resolve to different content entirely.
      let probe: Stats;
      try {
        probe = await stat(this.path);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code ?? 'UNKNOWN';
        if (code === 'ENOENT') {
          if (this.inode !== null) {
            this.inode = null;
            this.offset = 0;
            this.discardPending();
            this.onNotice({ type: 'missing' });
          }
          return;
        }
        this.stats.errors += 1;
        this.onNotice({ type: 'error', code });
        return;
      }

      // Known file, unchanged length, nothing left to seed: there is provably
      // nothing to read, so do not pay for an open.
      if (
        this.inode !== null &&
        probe.ino === this.inode &&
        probe.size === this.offset &&
        !this.needsSignatureSeed
      ) {
        return;
      }

      // The path can be replaced or removed between the probe above and this
      // open. Every failure from here on is reported, never thrown.
      let handle: FileHandle;
      try {
        handle = await this.openInput();
      } catch (error) {
        this.handleIoFailure(error);
        return;
      }

      try {
        await this.readOpenFile(handle);
      } catch (error) {
        this.handleIoFailure(error);
      } finally {
        await handle.close().catch(() => {});
      }
    } catch (error) {
      // Defence in depth: a poll must never reject, whatever it was doing.
      this.stats.errors += 1;
      this.onNotice({ type: 'error', code: (error as NodeJS.ErrnoException).code ?? 'UNKNOWN' });
    } finally {
      this.polling = false;
    }
  }

  /**
   * The only place the input file is opened. A seam, so tests can stage the
   * `stat()`-then-`open()` race deterministically; it is never given a path
   * derived from event content.
   */
  openInput(): Promise<FileHandle> {
    return open(this.path, 'r');
  }

  /**
   * One poll's worth of work against a single open handle.
   *
   * `fstat` on that handle is the only snapshot used here, so identity (`ino`),
   * the EOF a `startFrom: 'end'` tailer adopts, the signature and the length we
   * read up to all describe the same file. Taking the size from the path stat
   * instead would let a replacement's prefix be skipped, or a record be cut at a
   * stale length and rejoined with the next poll's bytes.
   */
  async readOpenFile(handle: FileHandle): Promise<void> {
    const info = await handle.stat();

    if (this.inode === null) {
      this.inode = info.ino;
      const startAtEnd = this.startFrom === 'end' && !this.hasObservedFile;
      this.offset = startAtEnd ? info.size : 0;
      this.signature = EMPTY;
      // Starting mid-file leaves us with an offset whose preceding bytes we
      // never read. Seed them from this same handle, otherwise the first
      // copy-truncate would be invisible to the content check and we would
      // resume at a stale offset.
      this.needsSignatureSeed = startAtEnd && info.size > 0;
      this.hasObservedFile = true;
      this.onNotice({ type: 'appeared' });
    } else if (info.ino !== this.inode) {
      this.inode = info.ino;
      this.offset = 0;
      this.discardPending();
      this.stats.rotations += 1;
      this.onNotice({ type: 'rotated' });
    } else if (info.size < this.offset) {
      this.offset = 0;
      this.discardPending();
      this.stats.truncations += 1;
      this.onNotice({ type: 'truncated' });
    }

    const intact = this.needsSignatureSeed
      ? await this.seedSignature(handle)
      : await this.verifySignature(handle);
    if (!intact) {
      // Same inode, but the bytes under our offset changed: the file was
      // copy-truncated and regrown. Restart from the beginning of the new
      // content instead of reading the middle of a record.
      this.offset = 0;
      this.discardPending();
      this.stats.truncations += 1;
      this.onNotice({ type: 'truncated' });
    }

    while (info.size > this.offset) {
      const length = Math.min(info.size - this.offset, this.maxChunkBytes);
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, this.offset);
      if (bytesRead <= 0) break;
      this.offset += bytesRead;
      this.stats.bytes_read += bytesRead;
      const chunk = buffer.subarray(0, bytesRead);
      this.rememberSignature(chunk);
      this.consume(chunk);
    }
  }

  /**
   * Fills `signature` from the bytes immediately before an offset this tailer
   * adopted without reading (`startFrom: 'end'`). Returns false when the file is
   * already shorter than that offset, which the caller treats as a truncation.
   */
  async seedSignature(handle: FileHandle): Promise<boolean> {
    this.needsSignatureSeed = false;
    const length = Math.min(SIGNATURE_BYTES, this.offset);
    if (length === 0) return true;
    const probe = Buffer.alloc(length);
    const { bytesRead } = await handle.read(probe, 0, length, this.offset - length);
    if (bytesRead < length) return false;
    this.signature = probe;
    return true;
  }

  /**
   * Re-reads the bytes recorded just before `offset` from the *same* handle we
   * are about to read from. False means the file content moved under us.
   */
  async verifySignature(handle: FileHandle): Promise<boolean> {
    const expected = this.signature;
    if (expected.length === 0 || this.offset < expected.length) return true;
    const probe = Buffer.alloc(expected.length);
    const { bytesRead } = await handle.read(probe, 0, expected.length, this.offset - expected.length);
    return bytesRead === expected.length && probe.equals(expected);
  }

  consume(chunk: Buffer): void {
    const buffer = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk]);
    let start = 0;
    let index = buffer.indexOf(NEWLINE, start);

    while (index >= 0) {
      const raw = buffer.subarray(start, index);
      start = index + 1;
      if (this.skippingOversized) {
        // Remainder of an oversized line: drop it, resynchronise on the newline.
        this.skippingOversized = false;
      } else {
        this.emit(raw);
      }
      index = buffer.indexOf(NEWLINE, start);
    }

    const rest = buffer.subarray(start);
    this.pending = rest.length === 0 ? EMPTY : Buffer.from(rest);

    if (this.pending.length > this.maxLineBytes) {
      this.stats.oversized_lines += 1;
      this.onNotice({ type: 'oversized_line', bytes: this.pending.length });
      this.pending = EMPTY;
      this.skippingOversized = true;
    }
  }

  emit(raw: Buffer): void {
    let end = raw.length;
    if (end > 0 && raw[end - 1] === 0x0d) end -= 1;
    if (end > this.maxLineBytes) {
      // Complete but oversized: dropped here so downstream never allocates it.
      this.stats.oversized_lines += 1;
      this.onNotice({ type: 'oversized_line', bytes: end });
      return;
    }
    const line = raw.subarray(0, end).toString('utf8');
    this.stats.lines_emitted += 1;
    this.onLine(line);
  }
}
