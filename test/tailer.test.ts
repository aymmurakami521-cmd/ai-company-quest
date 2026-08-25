import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { JsonlTailer } from '../src/collector/tailer.ts';
import type { TailerNotice } from '../src/collector/tailer.ts';
import { NamespaceStore } from '../src/collector/store.ts';
import { makeLine } from './helpers.ts';

type Harness = {
  dir: string;
  file: string;
  lines: string[];
  notices: TailerNotice[];
  tailer: JsonlTailer;
  cleanup: () => Promise<void>;
};

async function harness(options: { maxLineBytes?: number; startFrom?: 'beginning' | 'end' } = {}): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), 'quest-tail-'));
  const file = join(dir, 'events.jsonl');
  const lines: string[] = [];
  const notices: TailerNotice[] = [];
  const tailerOptions =
    options.maxLineBytes === undefined
      ? { path: file, startFrom: options.startFrom ?? ('beginning' as const) }
      : { path: file, maxLineBytes: options.maxLineBytes, startFrom: options.startFrom ?? ('beginning' as const) };
  const tailer = new JsonlTailer(tailerOptions, {
    onLine: (line) => {
      lines.push(line);
    },
    onNotice: (notice) => {
      notices.push(notice);
    },
  });
  return {
    dir,
    file,
    lines,
    notices,
    tailer,
    cleanup: async () => {
      await tailer.stop();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test('a missing input file is tolerated until it appears', async () => {
  const h = await harness();
  try {
    await h.tailer.pollOnce();
    assert.deepEqual(h.lines, []);
    assert.equal(h.tailer.stats.errors, 0);

    await writeFile(h.file, 'first\n');
    await h.tailer.pollOnce();
    assert.deepEqual(h.lines, ['first']);
  } finally {
    await h.cleanup();
  }
});

test('partial trailing lines are buffered until the newline arrives', async () => {
  const h = await harness();
  try {
    await writeFile(h.file, '{"a":1}\n{"b":');
    await h.tailer.pollOnce();
    assert.deepEqual(h.lines, ['{"a":1}']);

    await appendFile(h.file, '2}');
    await h.tailer.pollOnce();
    assert.deepEqual(h.lines, ['{"a":1}'], 'still incomplete');

    await appendFile(h.file, '\n{"c":3}\n');
    await h.tailer.pollOnce();
    assert.deepEqual(h.lines, ['{"a":1}', '{"b":2}', '{"c":3}']);
  } finally {
    await h.cleanup();
  }
});

test('multi-byte characters split across reads are not corrupted', async () => {
  const h = await harness();
  try {
    const text = JSON.stringify({ summary: 'エージェント' });
    const bytes = Buffer.from(`${text}\n`, 'utf8');
    // Lands in the middle of a 3-byte character: decoding must wait for the newline.
    const cut = 14;
    await writeFile(h.file, bytes.subarray(0, cut));
    await h.tailer.pollOnce();
    await appendFile(h.file, bytes.subarray(cut));
    await h.tailer.pollOnce();
    assert.deepEqual(h.lines, [text]);
  } finally {
    await h.cleanup();
  }
});

test('truncation resets the read offset without replaying stale bytes', async () => {
  const h = await harness();
  try {
    await writeFile(h.file, 'aaaa\nbbbb\ncccc\n');
    await h.tailer.pollOnce();
    assert.equal(h.lines.length, 3);

    await writeFile(h.file, 'zz\n');
    await h.tailer.pollOnce();

    assert.deepEqual(h.lines, ['aaaa', 'bbbb', 'cccc', 'zz']);
    assert.equal(h.tailer.stats.truncations, 1);
    assert.ok(h.notices.some((notice) => notice.type === 'truncated'));
  } finally {
    await h.cleanup();
  }
});

test('rotation is detected and the new file is read from the start', async () => {
  const h = await harness();
  try {
    await writeFile(h.file, 'old-1\nold-2\n');
    await h.tailer.pollOnce();
    assert.equal(h.lines.length, 2);

    const replacement = `${h.file}.new`;
    await writeFile(replacement, 'new-1\nnew-2\n');
    await rename(replacement, h.file);
    await h.tailer.pollOnce();

    assert.deepEqual(h.lines, ['old-1', 'old-2', 'new-1', 'new-2']);
    assert.equal(h.tailer.stats.rotations, 1);
  } finally {
    await h.cleanup();
  }
});

test('a partial line is discarded on rotation instead of being glued together', async () => {
  const h = await harness();
  try {
    await writeFile(h.file, 'complete\nhalf-');
    await h.tailer.pollOnce();
    assert.deepEqual(h.lines, ['complete']);

    const replacement = `${h.file}.new`;
    await writeFile(replacement, 'fresh\n');
    await rename(replacement, h.file);
    await h.tailer.pollOnce();

    assert.deepEqual(h.lines, ['complete', 'fresh']);
    assert.ok(h.tailer.stats.partial_bytes_discarded > 0);
  } finally {
    await h.cleanup();
  }
});

test('oversized lines are dropped and the stream resynchronises', async () => {
  const h = await harness({ maxLineBytes: 32 });
  try {
    await writeFile(h.file, `${'x'.repeat(200)}\nok\n`);
    await h.tailer.pollOnce();

    assert.deepEqual(h.lines, ['ok']);
    assert.equal(h.tailer.stats.oversized_lines, 1);
  } finally {
    await h.cleanup();
  }
});

test('an oversized line arriving without its newline is skipped safely', async () => {
  const h = await harness({ maxLineBytes: 32 });
  try {
    await writeFile(h.file, 'x'.repeat(100));
    await h.tailer.pollOnce();
    assert.deepEqual(h.lines, []);
    assert.equal(h.tailer.stats.oversized_lines, 1);

    await appendFile(h.file, 'still-the-same-line\nok\n');
    await h.tailer.pollOnce();
    assert.deepEqual(h.lines, ['ok']);
  } finally {
    await h.cleanup();
  }
});

test('copy-truncation that regrows past the old offset is detected by content', async () => {
  const h = await harness();
  try {
    await writeFile(h.file, 'aaaa\nbbbb\ncccc\n');
    await h.tailer.pollOnce();
    assert.deepEqual(h.lines, ['aaaa', 'bbbb', 'cccc']);

    // Copy-truncate: same inode, and by the next poll the file is already
    // LARGER than the offset we stopped at, so a size comparison sees nothing.
    await writeFile(h.file, 'new-1\nnew-2\nnew-3\nnew-4\n');
    assert.ok('new-1\nnew-2\nnew-3\nnew-4\n'.length > 'aaaa\nbbbb\ncccc\n'.length);
    await h.tailer.pollOnce();

    assert.deepEqual(h.lines, ['aaaa', 'bbbb', 'cccc', 'new-1', 'new-2', 'new-3', 'new-4']);
    assert.equal(h.tailer.stats.rotations, 0, 'the inode never changed');
    assert.equal(h.tailer.stats.truncations, 1);
    assert.ok(h.notices.some((notice) => notice.type === 'truncated'));
  } finally {
    await h.cleanup();
  }
});

test('copy-truncation that regrows to exactly the old offset is detected by content', async () => {
  const h = await harness();
  try {
    const original = 'aaaa\nbbbb\ncccc\n';
    await writeFile(h.file, original);
    await h.tailer.pollOnce();
    assert.deepEqual(h.lines, ['aaaa', 'bbbb', 'cccc']);
    assert.equal(h.tailer.offset, original.length);

    // Copy-truncate to exactly the length we stopped at: same inode, same size,
    // different content, and nothing is appended afterwards. Size alone says
    // "nothing happened" forever, so only the signature can catch this.
    const replacement = 'new-1\nnew-2\nnn\n';
    assert.equal(replacement.length, original.length, 'the replacement is byte-for-byte the same length');
    await writeFile(h.file, replacement);
    await h.tailer.pollOnce();

    assert.deepEqual(h.lines, ['aaaa', 'bbbb', 'cccc', 'new-1', 'new-2', 'nn'], 'the replacement is read whole');
    assert.equal(h.tailer.stats.rotations, 0, 'the inode never changed');
    assert.equal(h.tailer.stats.truncations, 1);
    assert.ok(h.notices.some((notice) => notice.type === 'truncated'));

    // Further idle polls must not replay it.
    await h.tailer.pollOnce();
    await h.tailer.pollOnce();
    assert.deepEqual(h.lines, ['aaaa', 'bbbb', 'cccc', 'new-1', 'new-2', 'nn'], 'no duplicate emission');
    assert.equal(h.tailer.stats.truncations, 1, 'no repeated truncation');
  } finally {
    await h.cleanup();
  }
});

test('an unchanged file of unchanged size is not mistaken for a copy-truncate', async () => {
  const h = await harness();
  try {
    const content = 'aaaa\nbbbb\ncccc\n';
    await writeFile(h.file, content);
    await h.tailer.pollOnce();
    assert.deepEqual(h.lines, ['aaaa', 'bbbb', 'cccc']);

    // Rewritten in place with identical bytes, then simply left alone.
    await writeFile(h.file, content);
    await h.tailer.pollOnce();
    await h.tailer.pollOnce();

    assert.deepEqual(h.lines, ['aaaa', 'bbbb', 'cccc'], 'no duplicate emission');
    assert.equal(h.tailer.stats.truncations, 0, 'identical content is not a truncation');
    assert.equal(h.tailer.stats.rotations, 0);
    assert.equal(h.tailer.stats.errors, 0);
    assert.ok(!h.notices.some((notice) => notice.type === 'truncated'));

    // And appends after the rewrite still arrive exactly once.
    await appendFile(h.file, 'dddd\n');
    await h.tailer.pollOnce();
    assert.deepEqual(h.lines, ['aaaa', 'bbbb', 'cccc', 'dddd']);
  } finally {
    await h.cleanup();
  }
});

test('a file removed between stat() and open() is reported, not thrown', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'quest-tail-'));
  const file = join(dir, 'events.jsonl');
  const lines: string[] = [];
  const notices: TailerNotice[] = [];

  // Stages the real race: stat() has already measured the file when it is
  // unlinked, so the following open() fails with a genuine ENOENT.
  class RacingTailer extends JsonlTailer {
    removeOnNextOpen = true;
    override async openInput(): Promise<FileHandle> {
      if (this.removeOnNextOpen) {
        this.removeOnNextOpen = false;
        await rm(this.path, { force: true });
      }
      return super.openInput();
    }
  }

  const tailer = new RacingTailer(
    { path: file },
    {
      onLine: (line) => {
        lines.push(line);
      },
      onNotice: (notice) => {
        notices.push(notice);
      },
    },
  );

  try {
    await writeFile(file, 'doomed\n');
    // Must resolve: an unhandled rejection here would take the process down.
    await tailer.pollOnce();
    assert.deepEqual(lines, []);
    assert.equal(tailer.stats.errors, 0, 'a rotation is not an error');
    assert.ok(notices.some((notice) => notice.type === 'missing'));

    // Polling continues and picks the replacement file up from its start.
    await writeFile(file, 'replacement-1\nreplacement-2\n');
    await tailer.pollOnce();
    assert.deepEqual(lines, ['replacement-1', 'replacement-2']);
  } finally {
    await tailer.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('copy-truncation right after a start-at-end initialisation is still detected', async () => {
  const h = await harness({ startFrom: 'end' });
  try {
    // The tailer joins an existing file and skips its history, so the offset it
    // adopts points at bytes it never read itself.
    await writeFile(h.file, 'old-1\nold-2\n');
    await h.tailer.pollOnce();
    assert.deepEqual(h.lines, [], 'pre-existing content is skipped');
    assert.equal(h.tailer.offset, 'old-1\nold-2\n'.length);

    // Copy-truncate, regrowing past that offset before the next poll: a size
    // comparison sees a larger file and would resume mid-record.
    await writeFile(h.file, 'new-1\nnew-2\nnew-3\nnew-4\n');
    assert.ok('new-1\nnew-2\nnew-3\nnew-4\n'.length > 'old-1\nold-2\n'.length);
    await h.tailer.pollOnce();

    assert.deepEqual(h.lines, ['new-1', 'new-2', 'new-3', 'new-4'], 'no record suffix, no lost head');
    assert.equal(h.tailer.stats.rotations, 0, 'the inode never changed');
    assert.equal(h.tailer.stats.truncations, 1);
    assert.ok(h.notices.some((notice) => notice.type === 'truncated'));
  } finally {
    await h.cleanup();
  }
});

test('a start-at-end tailer that shrinks before its next poll reads the new content whole', async () => {
  const h = await harness({ startFrom: 'end' });
  try {
    await writeFile(h.file, 'old-1\nold-2\nold-3\n');
    await h.tailer.pollOnce();
    assert.deepEqual(h.lines, []);

    await writeFile(h.file, 'short\n');
    await h.tailer.pollOnce();

    assert.deepEqual(h.lines, ['short']);
    assert.equal(h.tailer.stats.truncations, 1);
  } finally {
    await h.cleanup();
  }
});

test('a start-at-end tailer on an empty or absent file needs no seeding', async () => {
  const h = await harness({ startFrom: 'end' });
  try {
    await h.tailer.pollOnce();
    assert.equal(h.tailer.needsSignatureSeed, false, 'nothing to seed while the file is absent');

    await writeFile(h.file, '');
    await h.tailer.pollOnce();
    assert.equal(h.tailer.needsSignatureSeed, false, 'an empty file has no preceding bytes');

    await appendFile(h.file, 'live-1\n');
    await h.tailer.pollOnce();
    assert.deepEqual(h.lines, ['live-1']);
    assert.equal(h.tailer.stats.truncations, 0);
    assert.equal(h.tailer.stats.errors, 0);
  } finally {
    await h.cleanup();
  }
});

/**
 * Stages the `stat()`-then-`open()` race deterministically: the copy-truncate
 * happens after the poll's probe stat and before the file is opened, so the
 * probe's size and inode describe content that no longer exists.
 */
class ReplacingTailer extends JsonlTailer {
  replacement: string | null = null;
  override async openInput(): Promise<FileHandle> {
    const replacement = this.replacement;
    if (replacement !== null) {
      this.replacement = null;
      // Same inode, rewritten in place, and longer than the probe measured.
      await writeFile(this.path, replacement);
    }
    return super.openInput();
  }
}

test('a copy-truncate between the probe and the open cannot strand a start-at-end offset', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'quest-tail-'));
  const file = join(dir, 'events.jsonl');
  const lines: string[] = [];
  const notices: TailerNotice[] = [];
  const replacement = 'new-1\nnew-2\nnew-3\nnew-4\n';

  const tailer = new ReplacingTailer(
    { path: file, startFrom: 'end' },
    {
      onLine: (line) => {
        lines.push(line);
      },
      onNotice: (notice) => {
        notices.push(notice);
      },
    },
  );

  try {
    await writeFile(file, 'old-1\nold-2\n');
    assert.ok(replacement.length > 'old-1\nold-2\n'.length, 'the file regrows past the probed EOF');
    tailer.replacement = replacement;
    await tailer.pollOnce();

    // start-at-end skips the history it joins - but it must skip the history of
    // the file it actually opened, not the one the probe happened to measure.
    assert.deepEqual(lines, [], 'pre-existing content is skipped');
    assert.equal(tailer.offset, replacement.length, 'the EOF comes from the opened file');
    assert.equal(tailer.stats.errors, 0);

    await appendFile(file, 'live-1\n');
    await tailer.pollOnce();

    // With the offset taken from the probe, this poll resumed 12 bytes into the
    // replacement and re-emitted records that were already there at attach time.
    assert.deepEqual(lines, ['live-1'], 'only what was appended after attaching');
  } finally {
    await tailer.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a copy-truncate between the probe and the open is read at the length of the opened file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'quest-tail-'));
  const file = join(dir, 'events.jsonl');
  const lines: string[] = [];
  const notices: TailerNotice[] = [];
  const replacement = 'new-1\nnew-2\nnew-3\nnew-4\n';

  const tailer = new ReplacingTailer(
    { path: file },
    {
      onLine: (line) => {
        lines.push(line);
      },
      onNotice: (notice) => {
        notices.push(notice);
      },
    },
  );

  try {
    await writeFile(file, 'aaaa\nbbbb\ncccc\n');
    await tailer.pollOnce();
    assert.deepEqual(lines, ['aaaa', 'bbbb', 'cccc']);

    // Something is appended, so the poll opens the file; the copy-truncate then
    // lands between that probe and the open. The probe's 20 bytes are shorter
    // than the replacement, so a read bounded by it would cut `new-4` in half
    // and glue the halves together on the following poll.
    await appendFile(file, 'dddd\n');
    tailer.replacement = replacement;
    await tailer.pollOnce();

    assert.deepEqual(lines, ['aaaa', 'bbbb', 'cccc', 'new-1', 'new-2', 'new-3', 'new-4']);
    assert.equal(tailer.offset, replacement.length);
    assert.equal(tailer.stats.rotations, 0, 'the inode never changed');
    assert.equal(tailer.stats.truncations, 1);
    assert.ok(notices.some((notice) => notice.type === 'truncated'));
  } finally {
    await tailer.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('restarting the tailer re-reads the file but de-duplication keeps state stable', async () => {
  const h = await harness();
  const store = new NamespaceStore({ namespace: 'live' });
  try {
    const lines = [makeLine(), makeLine(), makeLine()];
    await writeFile(h.file, `${lines.join('\n')}\n`);

    const first = new JsonlTailer({ path: h.file }, { onLine: (line) => void store.ingestLine(line) });
    await first.pollOnce();
    await first.stop();
    assert.equal(store.stats.accepted, 3);

    const second = new JsonlTailer({ path: h.file }, { onLine: (line) => void store.ingestLine(line) });
    await second.pollOnce();
    await second.stop();

    assert.equal(store.stats.accepted, 3, 'restart must not duplicate state');
    assert.equal(store.stats.duplicates, 3);
    assert.equal(store.state.counters.applied, 3);
  } finally {
    await h.cleanup();
  }
});

test('start() polls immediately and stop() is idempotent', async () => {
  const h = await harness({ startFrom: 'end' });
  try {
    await writeFile(h.file, 'ignored-history\n');
    await h.tailer.start();
    assert.deepEqual(h.lines, [], 'startFrom=end skips pre-existing content');

    await appendFile(h.file, 'live-1\n');
    await h.tailer.pollOnce();
    assert.deepEqual(h.lines, ['live-1']);

    await h.tailer.stop();
    await h.tailer.stop();
  } finally {
    await h.cleanup();
  }
});
