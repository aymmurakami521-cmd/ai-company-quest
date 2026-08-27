/**
 * `npm run live` entrypoint: collector + SSE + the retro office screen.
 *
 * This process starts the LIVE collector, an empty (or fixture-seeded) DEMO
 * store and the localhost SSE/health/UI server. Everything it serves is
 * read-only and bound to 127.0.0.1.
 */

import { loadConfig } from './config.ts';
import type { PlayerEntity } from './domain/reducer.ts';
import { NamespaceStore } from './collector/store.ts';
import { Collector } from './collector/collector.ts';
import { seedDemoStore } from './demo/fixtures.ts';
import { DEMO_TIMELINE, DemoPlayer } from './demo/timeline.ts';
import { loadOrgState } from './collector/orgLoader.ts';
import { orgStatusDetail } from './domain/org.ts';
import { QuestServer } from './server/server.ts';

export async function main(): Promise<number> {
  const config = loadConfig(process.env);

  if (config.inputPath === null) {
    process.stderr.write(
      'quest: QUEST_INPUT_PATH is not set. Refusing to start LIVE ingestion (fail closed).\n' +
        'quest: set QUEST_INPUT_PATH to the sanitized JSONL file produced by the local session.\n',
    );
    return 1;
  }

  const player: PlayerEntity = { kind: 'player', id: 'player', display_name: config.playerName };

  // Read once at startup. A missing or invalid organisation disables the org
  // feature only; ingestion starts either way (`docs/org-snapshot-design.md` §4.5).
  const org = await loadOrgState({ path: config.orgSnapshotPath });

  const live = new NamespaceStore({
    namespace: 'live',
    // The external contract, stated once and never inferred from a payload.
    inputContract: 'claude_hook_v2',
    failClosedOnUnsupportedSchema: true,
    replayCapacity: config.replayCapacity,
    dedupeCapacity: config.dedupeCapacity,
    maxLineBytes: config.maxLineBytes,
    player,
    org,
  });

  /**
   * Declared before the DEMO store so the store can be given the hook that
   * starts it. Stays null unless `QUEST_DEMO_PLAY=1`: the scripted mission is
   * opt-in, and `npm run demo:static` must remain a still frame with no timer.
   */
  let demoPlayer: DemoPlayer | null = null;

  const demo = new NamespaceStore({
    namespace: 'demo',
    // DEMO fixtures are already normalized; they never pass through the external
    // LIVE validator, and the external wire never reaches this store.
    inputContract: 'internal_normalized',
    failClosedOnUnsupportedSchema: false,
    replayCapacity: config.replayCapacity,
    dedupeCapacity: config.dedupeCapacity,
    maxLineBytes: config.maxLineBytes,
    player,
    // Fires on the 0 -> 1 subscriber transition only, so the mission starts when
    // somebody is actually watching and a reconnect never restarts it. LIVE
    // never gets this hook: the callback closes over the DEMO store alone.
    onFirstSubscriber: config.demoPlay ? () => demoPlayer?.start() : undefined,
  });

  if (config.demoPlay) {
    demoPlayer = new DemoPlayer({
      store: demo,
      intervalMs: config.demoPlayIntervalMs,
      firstDelayMs: config.demoPlayFirstDelayMs,
      onFinished: () => {
        process.stdout.write(`quest: demo mission finished (${DEMO_TIMELINE.length} events)\n`);
      },
    });
  }

  process.stdout.write(`quest: org snapshot ${orgStatusDetail(org)}\n`);

  if (config.seedDemo) {
    const seeded = seedDemoStore(demo);
    process.stdout.write(`quest: demo store seeded with ${seeded} fixture events\n`);
  }

  const collector = new Collector({
    store: live,
    input: {
      path: config.inputPath,
      pollIntervalMs: config.pollIntervalMs,
      maxLineBytes: config.maxLineBytes,
      startFrom: config.startFrom,
    },
    onHalt: (reason, detail) => {
      // Fail closed: keep serving the frozen state and health, stop ingesting.
      process.stderr.write(`quest: LIVE ingestion halted (${reason}: ${detail})\n`);
    },
    onNotice: (notice) => {
      process.stdout.write(`quest: input ${notice.type}\n`);
    },
  });

  const server = new QuestServer({ stores: { live, demo } });
  const address = await server.listen(config.port);
  await collector.start();

  // Says which demo is actually loaded, so the line cannot claim a still frame
  // while the scripted mission is the thing about to play.
  const demoModeLabel = config.demoPlay
    ? 'DEMO mission - starts when you open it'
    : config.seedDemo
      ? 'deterministic DEMO view'
      : 'DEMO view (empty: no fixtures loaded)';

  process.stdout.write(
    `quest: collector + SSE + UI running on http://127.0.0.1:${address.port}\n` +
      `quest:   office  GET /                (open this in a browser)\n` +
      `quest:   office  GET /#demo           (${demoModeLabel})\n` +
      `quest:   health  GET /health\n` +
      `quest:   stream  GET /events/live     (SSE)\n` +
      `quest:   stream  GET /events/demo     (SSE)\n` +
      'quest: read-only, loopback only. Ctrl-C to stop.\n',
  );

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    // The demo timer first: it is the only thing left in this process that would
    // keep producing after the collector stopped.
    demoPlayer?.stop();
    void collector.stop().then(() => server.close());
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return 0;
}

const entrypoint = process.argv[1] ?? '';
if (entrypoint.endsWith('live.ts')) {
  const code = await main();
  if (code !== 0) process.exit(code);
}
