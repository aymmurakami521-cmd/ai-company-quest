/**
 * The one way a person approves the scripted DEMO mission.
 *
 * `DemoPlayer` stops dead when a beat reports `awaiting_approval` and only
 * `approve()` moves it on. Something has to call that, and this is it: a single
 * word typed into the terminal that is already running `npm run demo`.
 *
 * Why stdin and not a button or an endpoint:
 * - the HTTP server is GET-only and has no route that changes collector state.
 *   An approval endpoint would be the first one, and it would be reachable by
 *   every process on the machine and by any page that can reach loopback;
 * - the office screen opens exactly two requests, both of them documented
 *   read-only SSE GETs, and asserts that it can open no others. A button would
 *   turn "the UI cannot write" into "the UI can write this one thing", which is
 *   a boundary worth more than the convenience;
 * - stdin of an already-running process is narrower than loopback: reaching it
 *   means already controlling the terminal that started the demo.
 *
 * What this therefore is NOT:
 * - not a command channel. The only accepted input is the fixed word `approve`;
 *   every other line is counted as unrecognized and does nothing.
 * - not reachable from LIVE. The callback handed in here closes over the DEMO
 *   player; there is no LIVE player and no namespace argument to point at one.
 * - not unbounded. A line longer than `MAX_SIGNAL_CHARS` is discarded rather
 *   than buffered, so a process writing endlessly without a newline cannot grow
 *   this reader's memory, and the discarded line can never partially match. The
 *   limit is the line's, not the leftover buffer's: a line that arrives whole,
 *   newline and all, in one write is measured exactly like one that arrives in
 *   pieces, so padding a command out to hide it behind the limit does nothing.
 */

import type { ApprovalOutcome } from './timeline.ts';

/** The only word this reader acts on. Compared after trimming and lowercasing. */
export const APPROVAL_COMMAND = 'approve';

/** Longest line this reader will read at all. Anything longer is refused. */
export const MAX_SIGNAL_CHARS = 64;

/**
 * What one complete input line was.
 *
 * `blank` exists so a stray Enter is silent rather than being answered with a
 * "that is not a command" line the person did not ask for.
 */
export type ApprovalSignal = 'approve' | 'blank' | 'unrecognized';

/**
 * Turns a stream of chunks into complete lines, and complete lines into signals.
 *
 * Kept as a pure object with no stream, no timer and no I/O, so the parsing -
 * including the overlong-line case - is testable by calling one method.
 */
export class ApprovalSignalReader {
  /** The current partial line: everything since the last newline. */
  #partial = '';

  /** Set when the partial line was dropped for length; cleared by its newline. */
  #discarding = false;

  /** Signals read so far, by kind. Used by tests and by nothing else. */
  readonly counts: { approve: number; blank: number; unrecognized: number } = {
    approve: 0,
    blank: 0,
    unrecognized: 0,
  };

  /**
   * Feeds one chunk in and returns one signal per line completed by it.
   *
   * A chunk that completes no line returns nothing; a chunk that completes
   * several returns several, in order.
   */
  read(chunk: string): ApprovalSignal[] {
    const signals: ApprovalSignal[] = [];
    let rest = chunk;
    for (;;) {
      const newline = rest.indexOf('\n');
      if (newline === -1) break;
      // The limit is applied to the whole line, before the line is assembled or
      // classified. Measuring only the leftover after the last newline would let
      // a line that arrived complete - padding, command and newline in one write
      // - be classified unmeasured, and `<64 spaces>approve` trims to `approve`.
      // The length is read off the newline's index so an over-long line is never
      // copied out of the chunk either.
      const tooLong = this.#discarding || this.#partial.length + newline > MAX_SIGNAL_CHARS;
      const signal = tooLong ? 'unrecognized' : classify(this.#partial + rest.slice(0, newline));
      rest = rest.slice(newline + 1);
      this.#partial = '';
      this.#discarding = false;
      this.counts[signal] += 1;
      signals.push(signal);
    }

    if (this.#discarding) return signals;
    if (this.#partial.length + rest.length > MAX_SIGNAL_CHARS) {
      // Dropped, not truncated: a truncated line could end in `approve` and be
      // acted on, which is exactly what an over-long line must not be able to do.
      // Dropped before the append, so the over-long text is never held at all.
      this.#partial = '';
      this.#discarding = true;
      return signals;
    }
    this.#partial += rest;
    return signals;
  }
}

/** `approve` on its own line, in any case, with surrounding whitespace. */
function classify(line: string): ApprovalSignal {
  const normalized = line.trim().toLowerCase();
  if (normalized === '') return 'blank';
  return normalized === APPROVAL_COMMAND ? 'approve' : 'unrecognized';
}

/**
 * The part of a readable stream this console uses. Narrow on purpose: it is the
 * whole surface a test has to stand in for, and it makes it plain that nothing
 * here reads a file, opens a socket or writes to the stream.
 */
export type ApprovalDataListener = (chunk: string | Buffer) => void;

export type ApprovalInput = {
  setEncoding: (encoding: 'utf8') => unknown;
  on: (event: 'data', listener: ApprovalDataListener) => unknown;
  removeListener: (event: 'data', listener: ApprovalDataListener) => unknown;
  pause?: () => unknown;
  unref?: () => unknown;
};

export type ApprovalConsoleOptions = {
  input: ApprovalInput;
  /** Called once per recognized approval. The only effect this console has. */
  approve: () => ApprovalOutcome;
  /** Where the reply to the operator goes. One line, already terminated. */
  write: (line: string) => void;
};

/**
 * Wires one input stream to one player's `approve()`.
 *
 * Returns the detach function. Calling it removes the listener and pauses the
 * stream, so shutdown leaves no reader attached and no later chunk can produce
 * a transition after the mission was stopped.
 */
export function attachApprovalConsole(options: ApprovalConsoleOptions): () => void {
  const reader = new ApprovalSignalReader();

  const listener: ApprovalDataListener = (chunk) => {
    // `String` rather than a cast: the encoding is set below, but a stream that
    // ignored it would hand over a Buffer, and decoding it is still the right
    // reading of a line somebody typed.
    for (const signal of reader.read(String(chunk))) {
      if (signal === 'blank') continue;
      if (signal === 'unrecognized') {
        options.write(`quest: 認識できない入力です。承認するには '${APPROVAL_COMMAND}' とだけ入力してください\n`);
        continue;
      }
      options.write(describe(options.approve()));
    }
  };

  options.input.setEncoding('utf8');
  options.input.on('data', listener);
  // Never a reason to keep the process alive on its own; the server does that.
  if (typeof options.input.unref === 'function') options.input.unref();

  let detached = false;
  return (): void => {
    if (detached) return;
    detached = true;
    options.input.removeListener('data', listener);
    if (typeof options.input.pause === 'function') options.input.pause();
  };
}

/** Says what the signal did, including when the honest answer is "nothing". */
function describe(outcome: ApprovalOutcome): string {
  switch (outcome) {
    case 'resumed':
      return 'quest: 承認を受け付けました。ミッションを再開します\n';
    case 'not_awaiting':
      return 'quest: いま承認待ちのものはありません（何も進めていません）\n';
    case 'stopped':
      return 'quest: ミッションは終了済みです（何も進めていません）\n';
  }
}
