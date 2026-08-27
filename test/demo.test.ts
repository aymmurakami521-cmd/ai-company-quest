/**
 * The read-only DEMO scenario.
 *
 * `test/isolation.test.ts` already proves DEMO and LIVE are separate stores.
 * This file is about the scenario itself: that it is reproducible without any
 * credential, LIVE input or network, that it is deterministic, that it shows
 * every state a viewer is meant to recognise, and that nothing unsafe ever gets
 * into the fixtures - no real person, customer or company, no raw prompt or
 * command, no absolute path and no credential shape.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { NamespaceStore } from '../src/collector/store.ts';
import { DEMO_EVENTS, seedDemoStore } from '../src/demo/fixtures.ts';
import { CONTRACT_KEYS } from '../src/domain/event.ts';
import { loadConfig } from '../src/config.ts';
import { QuestServer } from '../src/server/server.ts';
import { httpGet, openSse } from './helpers.ts';

import type { ActorDisplayState } from '../src/ui/public/quest-view.js';
import {
  ACTOR_LEGEND_STATES,
  applyEvent,
  createClientState,
  selectBanner,
  selectDesks,
  selectHeader,
  setConnectionPhase,
} from '../src/ui/public/quest-view.js';

const REPO_ROOT = new URL('..', import.meta.url);

function seededDemoStore(): NamespaceStore {
  const store = new NamespaceStore({ namespace: 'demo' });
  seedDemoStore(store);
  return store;
}

/** Folds a freshly seeded DEMO store through the client, as the browser would. */
function foldDemo(): ReturnType<typeof createClientState> {
  const store = new NamespaceStore({ namespace: 'demo' });
  let state = setConnectionPhase(createClientState('demo'), 'open', 1000);
  store.subscribe((wire) => {
    state = applyEvent(state, wire, 1000);
  });
  seedDemoStore(store);
  return state;
}

/** Every string that ends up anywhere in the fixtures. */
function fixtureStrings(): string[] {
  const found: string[] = [];
  for (const event of DEMO_EVENTS) {
    for (const value of Object.values(event as Record<string, unknown>)) {
      if (typeof value === 'string') found.push(value);
    }
  }
  return found;
}

// ------------------------------------------------------ reproducibility ---

test('the DEMO scenario needs no credential, no LIVE input and no network', () => {
  const manifest = JSON.parse(readFileSync(new URL('package.json', REPO_ROOT), 'utf8')) as {
    scripts: Record<string, string>;
  };
  // Two demos, and both have to be safe: `demo` plays the scripted mission,
  // `demo:static` folds in the fixed frame the legend is read against.
  const play = manifest.scripts['demo'] ?? '';
  const still = manifest.scripts['demo:static'] ?? '';

  assert.ok(play.includes('QUEST_DEMO_PLAY=1'), 'npm run demo opts into the scripted mission');
  assert.ok(still.includes('QUEST_DEMO=1'), 'npm run demo:static opts into the fixtures');
  assert.equal(play.includes('QUEST_DEMO=1'), false, 'the two demos are not both on at once');

  for (const [name, script] of [['demo', play], ['demo:static', still]] as const) {
    assert.ok(
      script.includes('QUEST_INPUT_PATH:-/dev/null'),
      `npm run ${name} falls back to /dev/null, so no LIVE file is required`,
    );
    // Nothing that could reach a secret, a personal path or the network.
    assert.equal(
      /https?:\/\/|curl|wget|token|key|secret|password/i.test(script),
      false,
      `npm run ${name} is offline`,
    );
    assert.equal(
      /\/(Users|home|root)\/|~\//.test(script),
      false,
      `npm run ${name} embeds no personal path`,
    );
  }

  // The env each script produces really does what its name says, and needs no
  // path beyond the one the script defaults in.
  const still_ = loadConfig({ QUEST_DEMO: '1', QUEST_INPUT_PATH: '/dev/null' });
  assert.equal(still_.seedDemo, true);
  assert.equal(still_.demoPlay, false, 'the still frame starts no timer');
  assert.equal(still_.inputPath, '/dev/null');

  const play_ = loadConfig({ QUEST_DEMO_PLAY: '1', QUEST_INPUT_PATH: '/dev/null' });
  assert.equal(play_.demoPlay, true);
  assert.equal(play_.seedDemo, false, 'the mission does not also fold in the still frame');
  assert.equal(play_.inputPath, '/dev/null');
});

test('the fixtures are a fixed, bounded, read-only list', () => {
  assert.ok(DEMO_EVENTS.length > 0, 'there is a scenario to show');
  assert.ok(DEMO_EVENTS.length <= 64, 'the scenario stays small enough to read in one screen');
  // Read-only in the sense that matters here: seeding cannot mutate the source.
  const before = JSON.stringify(DEMO_EVENTS);
  seededDemoStore();
  seededDemoStore();
  assert.equal(JSON.stringify(DEMO_EVENTS), before, 'seeding does not mutate the fixtures');
});

test('seeding is deterministic: no clock, no randomness, no I/O', () => {
  // Fixed timestamps, fixed ids - nothing here can differ between two runs.
  for (const event of DEMO_EVENTS) {
    assert.match(event.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, `${event.event_id}: literal ts`);
    assert.match(event.event_id, /^[0-9a-f-]{36}$/, `${event.event_id}: literal id`);
  }

  const first = seededDemoStore();
  const second = seededDemoStore();
  assert.deepEqual(JSON.parse(JSON.stringify(first.state)), JSON.parse(JSON.stringify(second.state)));
  assert.equal(first.stats.last_ingest_seq, second.stats.last_ingest_seq);

  // And the same holds for what the screen makes of it.
  assert.deepEqual(selectDesks(foldDemo()), selectDesks(foldDemo()));
});

test('the fixtures never halt the DEMO store or get rejected', () => {
  const store = seededDemoStore();
  assert.equal(store.stats.halted, false, 'the demo runs to the end');
  assert.equal(store.stats.accepted, DEMO_EVENTS.length, 'every fixture event is accepted');
  assert.equal(store.stats.rejected, 0, 'no fixture event is rejected');
});

// ---------------------------------------------------- every visual state ---

test('the DEMO scenario shows every visual state at once, deterministically', () => {
  const desks = selectDesks(foldDemo());
  const states = new Set<ActorDisplayState>(desks.map((desk) => desk.visual.state));

  for (const state of ACTOR_LEGEND_STATES) {
    assert.ok(states.has(state), `the DEMO office contains a desk in the ${state} state`);
  }
  assert.equal(states.size, ACTOR_LEGEND_STATES.length, 'and nothing outside the closed set');

  // Seat order is fixed too, so a demo always looks the same.
  assert.deepEqual(
    desks.map((desk) => `${desk.display_name}:${desk.visual.state}`),
    selectDesks(foldDemo()).map((desk) => `${desk.display_name}:${desk.visual.state}`),
  );
});

test('the DEMO header and banner report a healthy, non-empty DEMO office', () => {
  const header = selectHeader(foldDemo());
  assert.equal(header.mode, 'DEMO');
  assert.equal(header.namespace, 'demo');
  assert.equal(header.halted, false);
  assert.equal(header.empty, false);
  assert.equal(selectBanner(header).code, 'CONNECTED');
});

test('the DEMO scenario ends a session, so a completed team is visible', () => {
  const state = foldDemo();
  const ended = Object.keys(state.sessions).filter((id) => state.sessions[id]?.ended_at !== null);
  assert.equal(ended.length, 1, 'exactly one demo session has finished');
});

// ------------------------------------------------------- unsafe data ---

test('no fixture value can be a real person, customer or company', () => {
  const identifiers = new Set<string>();
  for (const event of DEMO_EVENTS) {
    identifiers.add(event.session_id);
    if (event.agent_id !== null) identifiers.add(event.agent_id);
  }
  for (const id of identifiers) {
    // A closed shape: demo sessions and structural agent names only.
    assert.match(id, /^(demo-session-\d{2}|main|worker-\d+)$/, `identifier '${id}' is structural, not a name`);
  }

  // Roles are never invented for the demo either: the collector resolves them or
  // they stay null, exactly as in LIVE.
  for (const event of DEMO_EVENTS) {
    assert.equal(event.agent_role, null, `${event.event_id}: no invented job title`);
  }
});

test('no fixture value carries a raw prompt, command, path or credential', () => {
  for (const value of fixtureStrings()) {
    assert.equal(/\/(Users|home|root|etc|var|private|tmp|Volumes)\//.test(value), false, `absolute path: ${value}`);
    assert.equal(value.includes('~/'), false, `home path: ${value}`);
    assert.equal(/[A-Za-z]:\\/.test(value), false, `windows path: ${value}`);
    assert.equal(/sk-ant-|AKIA[0-9A-Z]{16}|-----BEGIN |Bearer /.test(value), false, `credential shape: ${value}`);
    assert.equal(/https?:\/\/|@[a-z0-9.-]+\.[a-z]{2,}/i.test(value), false, `external destination: ${value}`);
    // Shell and prompt shapes: a summary is a sentence, never something to run.
    assert.equal(/[|&;`$><]|\$\(|\brm -|\bsudo\b|\bnpm run\b/.test(value), false, `command shape: ${value}`);
    assert.ok(value.length <= 120, `summary stays a short label: ${value}`);
  }
});

test('the fixtures only ever use whitelisted, sanitized event fields', () => {
  // Derived from the model itself, so a new contract key cannot leave this
  // check silently pinned to a stale list.
  const allowed = new Set<string>(CONTRACT_KEYS);
  for (const event of DEMO_EVENTS) {
    for (const key of Object.keys(event)) {
      assert.ok(allowed.has(key), `unexpected fixture field '${key}'`);
    }
    assert.equal(event.schema_version, 2, 'the demo uses the internal normalized model, version 2');
  }
});

// ------------------------------------------------------------- end to end ---

test('the whole DEMO path works over HTTP, and leaves LIVE empty', async () => {
  // Exactly what `npm run demo` builds: a seeded DEMO store next to an empty
  // LIVE one, behind the loopback server.
  const live = new NamespaceStore({ namespace: 'live' });
  const demo = new NamespaceStore({ namespace: 'demo' });
  seedDemoStore(demo);
  const server = new QuestServer({ stores: { live, demo }, heartbeatMs: 60_000 });
  const address = await server.listen(0);

  try {
    const page = await httpGet(address.port, '/');
    assert.equal(page.status, 200, 'the office screen is served');

    const stream = await openSse(address.port, '/events/demo');
    await stream.waitFor((text) => text.includes('event: snapshot'));
    const frame = stream
      .text()
      .split('\n\n')
      .find((part) => part.includes('event: snapshot')) as string;
    const payload = JSON.parse(
      (frame.split('\n').find((line) => line.startsWith('data: ')) as string).slice('data: '.length),
    ) as { namespace: string; halted: boolean; state: { actors: Record<string, unknown> } };

    assert.equal(payload.namespace, 'demo');
    assert.equal(payload.halted, false, 'the demo does not fail closed');
    // Derived from the fixtures, not hard-coded: adding a state to the scenario
    // must not silently start under-asserting what the snapshot carries.
    const expectedActors = new Set(
      DEMO_EVENTS.map((event) => `${event.session_id}\u0000${String(event.agent_id)}`),
    ).size;
    assert.equal(
      Object.keys(payload.state.actors).length,
      expectedActors,
      'every demo actor is in the snapshot',
    );
    stream.close();

    // The LIVE side of the same process never saw any of it.
    const liveStream = await openSse(address.port, '/events/live');
    await liveStream.waitFor((text) => text.includes('event: snapshot'));
    assert.ok(liveStream.text().includes('"namespace":"live"'));
    assert.equal(liveStream.text().includes('demo-session'), false, 'no DEMO data on the LIVE stream');
    liveStream.close();

    const health = JSON.parse((await httpGet(address.port, '/health')).body) as {
      status: string;
      namespaces: Record<string, { actors: number; ingest: { accepted: number } }>;
    };
    assert.equal(health.status, 'ok');
    assert.equal(health.namespaces['live']?.ingest.accepted, 0, 'LIVE ingested nothing');
    assert.equal(health.namespaces['live']?.actors, 0, 'and seated nobody');
    assert.equal(health.namespaces['demo']?.ingest.accepted, DEMO_EVENTS.length, 'DEMO ingested the fixtures');
  } finally {
    await server.close();
  }
});

test('the DEMO scenario never advances on its own', () => {
  const source = readFileSync(new URL('src/demo/fixtures.ts', REPO_ROOT), 'utf8');
  assert.equal(/setTimeout|setInterval|Date\.now|new Date|Math\.random/.test(source), false);
  // And it cannot be pointed at anything but the DEMO namespace.
  assert.throws(() => seedDemoStore(new NamespaceStore({ namespace: 'live' })), /demo/);
});
