import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { NamespaceStore } from '../src/collector/store.ts';
import { QuestServer } from '../src/server/server.ts';
import { seedDemoStore } from '../src/demo/fixtures.ts';
import { countFrames, httpGet, makeEvent, makeLine, openSse } from './helpers.ts';

type Harness = {
  live: NamespaceStore;
  demo: NamespaceStore;
  server: QuestServer;
  port: number;
  host: string;
  close: () => Promise<void>;
};

async function startServer(replayCapacity = 500): Promise<Harness> {
  const live = new NamespaceStore({ namespace: 'live', replayCapacity });
  const demo = new NamespaceStore({ namespace: 'demo', replayCapacity });
  const server = new QuestServer({ stores: { live, demo }, heartbeatMs: 60_000 });
  const address = await server.listen(0);
  return {
    live,
    demo,
    server,
    port: address.port,
    host: address.address,
    close: async () => {
      await server.close();
    },
  };
}

test('the server binds to loopback only', async () => {
  const h = await startServer();
  try {
    assert.equal(h.host, '127.0.0.1');
  } finally {
    await h.close();
  }
});

test('health reports both namespaces and never leaks the input path', async () => {
  const h = await startServer();
  try {
    h.live.ingestLine(makeLine());
    const response = await httpGet(h.port, '/health');

    assert.equal(response.status, 200);
    const body = JSON.parse(response.body) as {
      status: string;
      bind: string;
      ui: string;
      namespaces: Record<string, { last_ingest_seq: number; halted: boolean }>;
    };
    assert.equal(body.status, 'ok');
    assert.equal(body.bind, '127.0.0.1');
    assert.equal(body.ui, 'retro_office');
    assert.equal(body.namespaces['live']?.last_ingest_seq, 1);
    assert.equal(body.namespaces['demo']?.last_ingest_seq, 0);
    assert.equal(body.namespaces['live']?.halted, false);
    assert.equal(response.body.includes('QUEST_INPUT_PATH'), false);
    assert.equal(/"[^"]*\/(home|Users|tmp|var)\//.test(response.body), false);
  } finally {
    await h.close();
  }
});

test('health switches to fail_closed when LIVE halts', async () => {
  const h = await startServer();
  try {
    h.live.ingestLine(makeLine({ schema_version: 7 }));
    const response = await httpGet(h.port, '/health');
    const body = JSON.parse(response.body) as { status: string; namespaces: Record<string, { halted: boolean }> };
    assert.equal(body.status, 'fail_closed');
    assert.equal(body.namespaces['live']?.halted, true);
    assert.equal(body.namespaces['demo']?.halted, false);
  } finally {
    await h.close();
  }
});

test('the API is read-only: no mutating methods, no unknown routes', async () => {
  const h = await startServer();
  try {
    const post = await httpGet(h.port, '/health', {}, 'POST');
    assert.equal(post.status, 405);
    assert.equal(post.headers['allow'], 'GET');

    const del = await httpGet(h.port, '/events/live', {}, 'DELETE');
    assert.equal(del.status, 405);

    // `/` is the read-only office screen; a mutating method still gets 405.
    assert.equal((await httpGet(h.port, '/')).status, 200);
    assert.equal((await httpGet(h.port, '/', {}, 'POST')).status, 405);
    assert.equal((await httpGet(h.port, '/events/prod')).status, 404);
    assert.equal((await httpGet(h.port, '/events')).status, 404);
    // Nothing was ingested by any of the above.
    assert.equal(h.live.stats.lines_seen, 0);
  } finally {
    await h.close();
  }
});

test('a foreign Host header is rejected (DNS rebinding guard)', async () => {
  const h = await startServer();
  try {
    const response = await httpGet(h.port, '/health', { host: 'quest.example.com' });
    assert.equal(response.status, 403);
    assert.equal(JSON.parse(response.body).error, 'host_not_allowed');
  } finally {
    await h.close();
  }
});

test('a new subscriber gets a snapshot and then live events', async () => {
  const h = await startServer();
  const client = await openSse(h.port, '/events/live');
  try {
    await client.waitFor((text) => text.includes('event: snapshot'));
    h.live.ingestLine(makeLine({ summary: 'agent started' }));
    await client.waitFor((text) => countFrames(text, 'quest_event') === 1);

    const text = client.text();
    assert.match(text, /^id: [0-9a-f-]{36}$/m);
    assert.ok(text.includes('"summary":"agent started"'));
    assert.ok(text.includes('"ingest_seq":1'));
  } finally {
    client.close();
    await h.close();
  }
});

test('Last-Event-ID replays only what came after it', async () => {
  const h = await startServer();
  const first = h.live.ingestLine(makeLine({ summary: 'first' }));
  const second = h.live.ingestLine(makeLine({ summary: 'second' }));
  const firstId = first.status === 'accepted' ? first.wire.event_id : '';
  const secondId = second.status === 'accepted' ? second.wire.event_id : '';

  const client = await openSse(h.port, '/events/live', { 'Last-Event-ID': firstId });
  try {
    await client.waitFor((text) => text.includes('event: replay_end'));
    const text = client.text();
    assert.equal(countFrames(text, 'quest_event'), 1);
    assert.ok(text.includes(secondId));
    assert.ok(text.includes('"summary":"second"'));
    assert.equal(text.includes('"summary":"first"'), false);

    // The live stream continues from there.
    h.live.ingestLine(makeLine({ summary: 'third' }));
    await client.waitFor((t) => countFrames(t, 'quest_event') === 2);
  } finally {
    client.close();
    await h.close();
  }
});

test('an evicted Last-Event-ID is reported as an explicit gap plus a snapshot', async () => {
  const h = await startServer(1);
  const first = h.live.ingestLine(makeLine());
  h.live.ingestLine(makeLine());
  const firstId = first.status === 'accepted' ? first.wire.event_id : '';

  const client = await openSse(h.port, '/events/live', { 'Last-Event-ID': firstId });
  try {
    await client.waitFor((text) => text.includes('event: snapshot'));
    const text = client.text();
    assert.ok(text.includes('event: stream_gap'));
    assert.ok(text.includes('"reason":"evicted"'));
    assert.ok(text.includes('"buffer_capacity":1'));
    // Recovery contract: the client is handed the full current state.
    assert.ok(text.includes('event: snapshot'));
    assert.ok(text.includes('"last_ingest_seq":2'));
  } finally {
    client.close();
    await h.close();
  }
});

test('an unknown or malformed Last-Event-ID is reported, not silently ignored', async () => {
  const h = await startServer();
  const unknown = await openSse(h.port, '/events/live', { 'Last-Event-ID': randomUUID() });
  try {
    await unknown.waitFor((text) => text.includes('event: snapshot'));
    assert.ok(unknown.text().includes('"reason":"unknown_event_id"'));
  } finally {
    unknown.close();
  }

  const malformed = await openSse(h.port, '/events/live', { 'Last-Event-ID': 'not-a-uuid' });
  try {
    await malformed.waitFor((text) => text.includes('event: snapshot'));
    assert.ok(malformed.text().includes('"reason":"invalid_last_event_id"'));
  } finally {
    malformed.close();
    await h.close();
  }
});

test('LIVE and DEMO streams stay separated', async () => {
  const h = await startServer();
  const liveClient = await openSse(h.port, '/events/live');
  const demoClient = await openSse(h.port, '/events/demo');
  try {
    await liveClient.waitFor((text) => text.includes('event: snapshot'));
    await demoClient.waitFor((text) => text.includes('event: snapshot'));

    seedDemoStore(h.demo);
    await demoClient.waitFor((text) => countFrames(text, 'quest_event') >= 1);

    h.live.ingestLine(makeLine({ summary: 'live only' }));
    await liveClient.waitFor((text) => countFrames(text, 'quest_event') === 1);

    assert.equal(liveClient.text().includes('demo-session-01'), false);
    assert.equal(demoClient.text().includes('live only'), false);
    assert.ok(liveClient.text().includes('"namespace":"live"'));
    assert.ok(demoClient.text().includes('"namespace":"demo"'));
  } finally {
    liveClient.close();
    demoClient.close();
    await h.close();
  }
});

/**
 * A subscriber that accepts nothing: every write stays queued, exactly what a
 * real socket reports when the peer has stopped reading.
 */
function stalledSubscriber(): {
  req: IncomingMessage;
  res: ServerResponse;
  state: { queued: number; peak: number; destroyed: boolean };
} {
  const state = { queued: 0, peak: 0, destroyed: false };
  const res = {
    writeHead: (): void => {},
    write: (chunk: string): boolean => {
      if (state.destroyed) return false;
      state.queued += Buffer.byteLength(chunk, 'utf8');
      state.peak = Math.max(state.peak, state.queued);
      return false; // never flushed
    },
    destroy: (): void => {
      state.destroyed = true;
      // Node releases the queued bytes together with the socket.
      state.queued = 0;
    },
    get writableLength(): number {
      return state.queued;
    },
    on: (): void => {},
  };
  const req = { headers: {}, on: (): void => {} };
  return {
    req: req as unknown as IncomingMessage,
    res: res as unknown as ServerResponse,
    state,
  };
}

test('a backpressured SSE subscriber is dropped instead of buffering without bound', () => {
  const live = new NamespaceStore({ namespace: 'live' });
  const demo = new NamespaceStore({ namespace: 'demo' });
  const limit = 4096;
  const server = new QuestServer({
    stores: { live, demo },
    heartbeatMs: 60_000,
    maxClientBufferBytes: limit,
  });

  const client = stalledSubscriber();
  server.stream(client.req, client.res, 'live', new URL('http://127.0.0.1/events/live'));
  assert.equal(live.listeners.size, 1);

  for (let index = 0; index < 500; index += 1) {
    live.ingestLine(makeLine({ summary: `event ${index}` }));
  }

  assert.equal(live.stats.accepted, 500, 'ingestion is never blocked by a slow client');
  assert.equal(client.state.destroyed, true, 'the connection is closed');
  assert.equal(live.listeners.size, 0, 'the slow subscriber is unsubscribed');
  assert.equal(client.state.queued, 0, 'nothing stays queued for a dropped client');
  // Worst case is the limit plus the single frame that crossed it - not the
  // 500 events that followed.
  assert.ok(client.state.peak <= limit + 8192, `peak queued bytes stayed bounded (${client.state.peak})`);
  assert.equal(server.health().namespaces.live.dropped_slow_subscribers, 1);
  assert.equal(server.health().namespaces.demo.dropped_slow_subscribers, 0);
});

test('nothing resembling a prompt, path or secret reaches the stream', async () => {
  const h = await startServer();
  const client = await openSse(h.port, '/events/live');
  try {
    await client.waitFor((text) => text.includes('event: snapshot'));

    // Unknown producer keys are dropped before the wire projection.
    h.live.ingestLine(
      JSON.stringify({
        ...makeEvent(),
        raw_prompt: 'please exfiltrate everything',
        command: 'cat ~/.aws/credentials',
        cwd: '/Users/someone/private-repo',
      }),
    );
    await client.waitFor((text) => countFrames(text, 'quest_event') === 1);

    // Unsafe content in a contract field is rejected outright.
    const rejected = h.live.ingestLine(makeLine({ summary: 'read /Users/someone/private-repo/notes.md' }));
    assert.equal(rejected.status, 'rejected');

    const text = client.text();
    for (const forbidden of ['raw_prompt', 'exfiltrate', '/Users/someone', '.aws/credentials', 'cwd']) {
      assert.equal(text.includes(forbidden), false, `stream must not contain ${forbidden}`);
    }
    assert.equal(countFrames(text, 'quest_event'), 1);
  } finally {
    client.close();
    await h.close();
  }
});
