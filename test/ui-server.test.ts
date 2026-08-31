/**
 * The UI routes.
 *
 * The screen is served from a fixed table of files, so these tests are about
 * the boundary: which paths exist, what headers they carry, what a request can
 * NOT reach, and what the shipped assets are allowed to contain.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { NamespaceStore } from '../src/collector/store.ts';
import type { StoreOptions } from '../src/collector/store.ts';
import { QuestServer } from '../src/server/server.ts';
import { UI_ASSET_PATHS, uiAsset } from '../src/ui/assets.ts';
import { httpGet, makeEvent, openSse } from './helpers.ts';

type Harness = {
  server: QuestServer;
  port: number;
  live: NamespaceStore;
  demo: NamespaceStore;
  close: () => Promise<void>;
};

async function startServer(liveOptions: Partial<StoreOptions> = {}): Promise<Harness> {
  const live = new NamespaceStore({ namespace: 'live', ...liveOptions });
  const demo = new NamespaceStore({ namespace: 'demo' });
  const server = new QuestServer({ stores: { live, demo }, heartbeatMs: 60_000 });
  const address = await server.listen(0);
  return {
    server,
    port: address.port,
    live,
    demo,
    close: async () => {
      await server.close();
    },
  };
}

/** Reads the payload of the last frame with the given event name. */
function lastFrame(text: string, eventName: string): Record<string, unknown> | null {
  const frames = text
    .split('\n\n')
    .slice(0, -1)
    .filter((frame) => frame.includes(`event: ${eventName}`));
  const frame = frames.at(-1);
  if (frame === undefined) return null;
  const line = frame.split('\n').find((part) => part.startsWith('data: '));
  return line === undefined ? null : (JSON.parse(line.slice('data: '.length)) as Record<string, unknown>);
}

function assetText(pathname: string): string {
  const asset = uiAsset(pathname);
  assert.ok(asset !== null, `${pathname} is served`);
  return asset.body.toString('utf8');
}

test('the office screen is served on loopback with the expected content types', async () => {
  const h = await startServer();
  try {
    const expected: Record<string, string> = {
      '/': 'text/html; charset=utf-8',
      '/ui/quest.css': 'text/css; charset=utf-8',
      '/ui/quest-app.js': 'text/javascript; charset=utf-8',
      '/ui/quest-view.js': 'text/javascript; charset=utf-8',
      '/ui/quest-world.js': 'text/javascript; charset=utf-8',
      '/ui/quest-canvas.js': 'text/javascript; charset=utf-8',
      '/ui/quest-value.js': 'text/javascript; charset=utf-8',
    };
    assert.deepEqual([...UI_ASSET_PATHS].sort(), Object.keys(expected).sort());

    for (const [pathname, contentType] of Object.entries(expected)) {
      const response = await httpGet(h.port, pathname);
      assert.equal(response.status, 200, pathname);
      assert.equal(response.headers['content-type'], contentType, pathname);
      assert.equal(response.headers['cache-control'], 'no-store', pathname);
      assert.equal(response.headers['x-content-type-options'], 'nosniff', pathname);
      assert.equal(response.headers['access-control-allow-origin'], undefined, pathname);
      assert.ok(response.body.length > 0, pathname);
    }
  } finally {
    await h.close();
  }
});

test('the served page is locked down by a same-origin CSP', async () => {
  const h = await startServer();
  try {
    const response = await httpGet(h.port, '/');
    const csp = response.headers['content-security-policy'];
    assert.equal(typeof csp, 'string');
    for (const directive of [
      "default-src 'none'",
      "script-src 'self'",
      "style-src 'self'",
      "connect-src 'self'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ]) {
      assert.ok(String(csp).includes(directive), `CSP contains ${directive}`);
    }
    assert.equal(response.headers['referrer-policy'], 'no-referrer');
  } finally {
    await h.close();
  }
});

test('the UI adds no writable route and no new namespace', async () => {
  const h = await startServer();
  try {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const response = await httpGet(h.port, '/', {}, method);
      assert.equal(response.status, 405, `${method} /`);
      assert.equal(response.headers['allow'], 'GET');
    }
    const upload = await httpGet(h.port, '/ui/quest-app.js', {}, 'POST');
    assert.equal(upload.status, 405);
    assert.equal((await httpGet(h.port, '/events/prod')).status, 404);
  } finally {
    await h.close();
  }
});

test('only the exact asset paths resolve: nothing else is readable', async () => {
  const h = await startServer();
  try {
    const denied = [
      '/ui/',
      '/ui',
      '/ui/index.html',
      '/index.html',
      '/package.json',
      '/ui/quest-view.d.ts',
      '/ui/quest-app.js.map',
      '/ui/%2e%2e/package.json',
      '/ui/..%2fpackage.json',
      '/ui/quest-app.js/../../package.json',
      '/../package.json',
      '/ui/QUEST-APP.JS',
    ];
    for (const pathname of denied) {
      const response = await httpGet(h.port, pathname);
      assert.equal(response.status, 404, `${pathname} must not resolve`);
      assert.equal(JSON.parse(response.body).error, 'not_found', pathname);
    }
  } finally {
    await h.close();
  }
});

test('a foreign Host cannot fetch the UI either (DNS rebinding guard)', async () => {
  const h = await startServer();
  try {
    for (const pathname of UI_ASSET_PATHS) {
      const response = await httpGet(h.port, pathname, { host: 'quest.example.com' });
      assert.equal(response.status, 403, pathname);
      assert.equal(JSON.parse(response.body).error, 'host_not_allowed');
    }
  } finally {
    await h.close();
  }
});

test('health reports that the UI now exists', async () => {
  const h = await startServer();
  try {
    const body = JSON.parse((await httpGet(h.port, '/health')).body) as { ui: string };
    assert.equal(body.ui, 'retro_office');
  } finally {
    await h.close();
  }
});

// ------------------------------------------------------- fail-closed halt ---

test('a halt after connect reaches the already-connected client (unsupported schema)', async () => {
  const h = await startServer({ failClosedOnUnsupportedSchema: true });
  const client = await openSse(h.port, '/events/live');
  try {
    await client.waitFor((text) => text.includes('event: snapshot'));
    assert.equal(lastFrame(client.text(), 'snapshot')?.halted, false);

    // The halting line is refused, so it produces no wire event at all: without
    // its own frame this client would keep reporting a healthy stream forever.
    assert.equal(h.live.ingestObject(makeEvent({ schema_version: 7 })).status, 'halt');

    await client.waitFor((text) => text.includes('event: fail_closed'));
    assert.deepEqual(lastFrame(client.text(), 'fail_closed'), {
      namespace: 'live',
      halted: true,
      reason: 'unsupported_schema',
      detail: 'schema_version:7',
    });
    // The halt frame carries no `id:`, so it cannot move Last-Event-ID.
    assert.equal(/event: fail_closed/.test(client.text()) && /id: .*\nevent: fail_closed/.test(client.text()), false);
  } finally {
    client.close();
    await h.close();
  }
});

test('a halt after connect reaches the already-connected client (state limit)', async () => {
  const h = await startServer({ stateLimits: { max_actors: 1 } });
  const client = await openSse(h.port, '/events/live');
  try {
    await client.waitFor((text) => text.includes('event: snapshot'));
    assert.equal(h.live.ingestObject(makeEvent({ agent_id: 'main' })).status, 'accepted');
    await client.waitFor((text) => text.includes('event: quest_event'));

    assert.equal(h.live.ingestObject(makeEvent({ agent_id: 'second' })).status, 'halt');
    await client.waitFor((text) => text.includes('event: fail_closed'));
    assert.deepEqual(lastFrame(client.text(), 'fail_closed'), {
      namespace: 'live',
      halted: true,
      reason: 'state_limit',
      detail: 'actors:1',
    });

    // Fail closed stays closed, and says so only once.
    assert.equal(h.live.ingestObject(makeEvent({ agent_id: 'third' })).status, 'rejected');
    assert.equal(client.text().split('event: fail_closed').length - 1, 1);
  } finally {
    client.close();
    await h.close();
  }
});

test('the halt frame stays inside its namespace and reconnects still see it', async () => {
  const h = await startServer({ failClosedOnUnsupportedSchema: true });
  const liveClient = await openSse(h.port, '/events/live');
  const demoClient = await openSse(h.port, '/events/demo');
  try {
    await liveClient.waitFor((text) => text.includes('event: snapshot'));
    await demoClient.waitFor((text) => text.includes('event: snapshot'));

    h.live.ingestObject(makeEvent({ schema_version: 7 }));
    await liveClient.waitFor((text) => text.includes('event: fail_closed'));
    assert.equal(demoClient.text().includes('fail_closed'), false, 'DEMO is untouched by a LIVE halt');

    // A client that connects after the halt learns it from the snapshot.
    const late = await openSse(h.port, '/events/live');
    await late.waitFor((text) => text.includes('event: snapshot'));
    const snapshot = lastFrame(late.text(), 'snapshot');
    assert.equal(snapshot?.halted, true);
    assert.equal(snapshot?.halt_reason, 'unsupported_schema:schema_version:7');
    late.close();
  } finally {
    liveClient.close();
    demoClient.close();
    await h.close();
  }
});

test('a reconnect with a valid Last-Event-ID learns about a halt it missed (unsupported schema)', async () => {
  const h = await startServer({ failClosedOnUnsupportedSchema: true });
  try {
    // Connect, receive one event, then disconnect - exactly what an EventSource
    // does before it retries with the id of the last event it saw.
    const first = await openSse(h.port, '/events/live');
    const accepted = h.live.ingestObject(makeEvent({ agent_id: 'main' }));
    assert.equal(accepted.status, 'accepted');
    const lastEventId = accepted.status === 'accepted' ? accepted.wire.event_id : '';
    await first.waitFor((text) => text.includes('event: quest_event'));
    first.close();

    // The store halts while nobody is listening, so no live halt frame is sent.
    assert.equal(h.live.ingestObject(makeEvent({ schema_version: 7 })).status, 'halt');

    const again = await openSse(h.port, '/events/live', { 'last-event-id': lastEventId });
    try {
      await again.waitFor((text) => text.includes('event: replay_end'));
      // The replay path serves no snapshot, so the halt has to arrive on its own
      // frame or this client reports a healthy stream forever.
      await again.waitFor((text) => text.includes('event: fail_closed'));
      assert.deepEqual(lastFrame(again.text(), 'fail_closed'), {
        namespace: 'live',
        halted: true,
        reason: 'unsupported_schema',
        detail: 'schema_version:7',
      });
      // Order is preserved and the replay contract is untouched.
      const text = again.text();
      assert.ok(text.indexOf('event: replay_start') < text.indexOf('event: replay_end'));
      assert.ok(text.indexOf('event: replay_end') < text.indexOf('event: fail_closed'));
      assert.equal(text.includes('event: snapshot'), false, 'a valid replay still serves no snapshot');
      assert.equal(/id: [^\n]*\nevent: fail_closed/.test(text), false, 'the halt frame carries no id:');
    } finally {
      again.close();
    }
  } finally {
    await h.close();
  }
});

test('a reconnect with a valid Last-Event-ID learns about a halt it missed (state limit)', async () => {
  const h = await startServer({ stateLimits: { max_actors: 1 } });
  try {
    const first = await openSse(h.port, '/events/live');
    const accepted = h.live.ingestObject(makeEvent({ agent_id: 'main' }));
    assert.equal(accepted.status, 'accepted');
    const lastEventId = accepted.status === 'accepted' ? accepted.wire.event_id : '';
    await first.waitFor((text) => text.includes('event: quest_event'));
    first.close();

    assert.equal(h.live.ingestObject(makeEvent({ agent_id: 'second' })).status, 'halt');

    const again = await openSse(h.port, '/events/live', { 'last-event-id': lastEventId });
    try {
      await again.waitFor((text) => text.includes('event: fail_closed'));
      assert.deepEqual(lastFrame(again.text(), 'fail_closed'), {
        namespace: 'live',
        halted: true,
        reason: 'state_limit',
        detail: 'actors:1',
      });
      // Said once per connection: the missed halt does not repeat on heartbeats.
      assert.equal(again.text().split('event: fail_closed').length - 1, 1);
    } finally {
      again.close();
    }
  } finally {
    await h.close();
  }
});

test('a healthy reconnect with a valid Last-Event-ID is unchanged', async () => {
  const h = await startServer({ failClosedOnUnsupportedSchema: true });
  try {
    const first = await openSse(h.port, '/events/live');
    const accepted = h.live.ingestObject(makeEvent({ agent_id: 'main' }));
    assert.equal(accepted.status, 'accepted');
    const lastEventId = accepted.status === 'accepted' ? accepted.wire.event_id : '';
    await first.waitFor((text) => text.includes('event: quest_event'));
    first.close();

    const again = await openSse(h.port, '/events/live', { 'last-event-id': lastEventId });
    try {
      await again.waitFor((text) => text.includes('event: replay_end'));
      const text = again.text();
      assert.equal(text.includes('event: fail_closed'), false, 'no halt frame while ingestion is healthy');
      assert.equal(text.includes('event: snapshot'), false);
      assert.equal(text.includes('event: stream_gap'), false);
      assert.equal(lastFrame(text, 'replay_end')?.count, 0);
    } finally {
      again.close();
    }
  } finally {
    await h.close();
  }
});

test('a disconnected client is unsubscribed from halts too', async () => {
  const h = await startServer({ failClosedOnUnsupportedSchema: true });
  try {
    const client = await openSse(h.port, '/events/live');
    await client.waitFor((text) => text.includes('event: snapshot'));
    assert.equal(h.live.haltListeners.size, 1);
    client.close();
    // Wait for the server to observe the close before asserting the teardown.
    for (let attempt = 0; attempt < 50 && h.live.haltListeners.size > 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(h.live.haltListeners.size, 0, 'the halt subscription is released with the stream');
    assert.equal(h.live.listeners.size, 0);
  } finally {
    await h.close();
  }
});

test('the app subscribes to the fail_closed frame it is sent', () => {
  const app = assetText('/ui/quest-app.js');
  assert.ok(app.includes("'fail_closed'"), 'the browser listens for the halt frame');
  const view = assetText('/ui/quest-view.js');
  assert.ok(view.includes("case 'fail_closed'"), 'the view model folds the halt frame');
});

test('the shipped assets contain no path, secret or external destination', () => {
  for (const pathname of UI_ASSET_PATHS) {
    const text = assetText(pathname);
    // No absolute filesystem path, no home directory, no credential shape.
    assert.equal(/\/(Users|home|root|etc|var|private|tmp|Volumes)\//.test(text), false, `${pathname}: absolute path`);
    assert.equal(text.includes('~/'), false, `${pathname}: home path`);
    assert.equal(/sk-ant-|AKIA[0-9A-Z]{16}|-----BEGIN /.test(text), false, `${pathname}: credential shape`);
    // No off-origin destination: the page only ever talks to 127.0.0.1.
    assert.equal(/https?:\/\//.test(text), false, `${pathname}: external URL`);
    assert.equal(
      /XMLHttpRequest|navigator\.sendBeacon|WebSocket/.test(text),
      false,
      `${pathname}: transport`,
    );
    // `fetch` is allowed for exactly one same-origin read-model path and
    // nothing else. The literal must be the complete first argument, so a
    // concatenated or interpolated target fails here, and no shipped asset may
    // declare a request method - the one call stays a GET.
    const fetched = [...text.matchAll(/fetch\(\s*'([^']*)'\s*[,)]/g)].map((match) => match[1] as string);
    for (const target of fetched) {
      assert.equal(target, '/value/summary', `${pathname}: unexpected fetch target`);
    }
    assert.equal(
      (text.match(/\bfetch\(/g) ?? []).length,
      fetched.length,
      `${pathname}: every fetch call site is a complete literal same-origin path`,
    );
    assert.equal(/method\s*:/.test(text), false, `${pathname}: a request method is declared`);
  }
});

test('the page renders stream content as text, never as markup or code', () => {
  const app = assetText('/ui/quest-app.js');
  const view = assetText('/ui/quest-view.js');
  const html = assetText('/');

  for (const [name, source] of [
    ['quest-app.js', app],
    ['quest-view.js', view],
  ] as const) {
    assert.equal(source.includes('innerHTML'), false, `${name}: innerHTML`);
    assert.equal(source.includes('outerHTML'), false, `${name}: outerHTML`);
    assert.equal(source.includes('insertAdjacentHTML'), false, `${name}: insertAdjacentHTML`);
    assert.equal(source.includes('document.write'), false, `${name}: document.write`);
    assert.equal(/\beval\(|new Function\(/.test(source), false, `${name}: dynamic code`);
  }

  // Nothing is logged, so stream content cannot leak into the browser console.
  assert.equal(/console\.(log|info|warn|error|debug)/.test(app), false, 'no console output');
  assert.equal(/console\.(log|info|warn|error|debug)/.test(view), false, 'no console output');

  // The CSP forbids inline code; the page must not rely on any.
  assert.equal(/<script(?![^>]*\bsrc=)/.test(html), false, 'no inline <script>');
  assert.equal(html.includes('<style'), false, 'no inline <style>');
  assert.equal(/\son[a-z]+=/.test(html), false, 'no inline event handler attributes');
});

test('the page only ever opens the two documented read-only streams', () => {
  const app = assetText('/ui/quest-app.js');
  const sources = app.match(/new EventSource\([^)]*\)/g) ?? [];
  assert.deepEqual(sources, ['new EventSource(`/events/${namespace}`)']);
  assert.ok(app.includes("const NAMESPACES = ['live', 'demo']"), 'namespaces are a fixed pair');
});

test('every element the app looks up exists in the page it is served with', () => {
  const app = assetText('/ui/quest-app.js');
  const html = assetText('/');

  const ids = [...app.matchAll(/getElementById\('([^']+)'\)/g)].map((match) => match[1]);
  assert.ok(ids.length > 0, 'the app looks elements up by id');
  for (const id of ids) assert.ok(html.includes(`id="${String(id)}"`), `page has #${String(id)}`);

  // Class selectors, including the ones passed to the `text()` helper.
  const selectors = [
    ...[...app.matchAll(/querySelector(?:All)?\('([^']+)'\)/g)].map((match) => match[1]),
    ...[...app.matchAll(/text\([a-z]+, '([^']+)'/g)].map((match) => match[1]),
  ];
  for (const selector of selectors) {
    const name = String(selector).replace(/^\./, '');
    if (name.startsWith('[')) {
      assert.ok(html.includes(name.slice(1, -1).split('=')[0] ?? ''), `page has ${name}`);
      continue;
    }
    assert.ok(html.includes(name), `page has .${name}`);
  }

  // The three templates the app clones must all be present.
  for (const template of ['desk-template', 'log-template', 'legend-template']) {
    assert.ok(html.includes(`id="${template}"`), `page has the ${template}`);
  }
});

test('every visual state has a style, and all motion is opt-in', () => {
  const css = assetText('/ui/quest.css');

  for (const state of ['working', 'awaiting_approval', 'error', 'ended', 'idle']) {
    assert.ok(css.includes(`--state-${state}:`), `${state} has a colour token`);
    assert.ok(css.includes(`.desk[data-state='${state}']`), `${state} has a desk rule`);
  }

  const marker = '@media (prefers-reduced-motion: no-preference)';
  const split = css.indexOf(marker);
  assert.ok(split > 0, 'motion is behind a reduced-motion guard');
  assert.equal(
    /animation:/.test(css.slice(0, split)),
    false,
    'no animation is declared outside the reduced-motion guard',
  );
  assert.ok(css.includes('@media (max-width: 720px)'), 'the layout has a narrow-viewport breakpoint');
});

test('the view model the browser loads is the one the tests exercise', () => {
  const app = assetText('/ui/quest-app.js');
  assert.ok(app.includes("from './quest-view.js'"), 'the app imports the tested module');
  const view = assetText('/ui/quest-view.js');
  assert.equal(/\bdocument\b|\bwindow\b|EventSource|setTimeout|setInterval|Date\.now/.test(view), false);
});
