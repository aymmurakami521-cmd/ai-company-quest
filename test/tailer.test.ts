import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
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
