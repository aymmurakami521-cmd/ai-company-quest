/**
 * `npm run live` entrypoint: collector + SSE only.
 *
 * There is no UI in this package yet. This process starts the LIVE collector,
 * an empty (or fixture-seeded) DEMO store and the localhost SSE/health server,
 * and says so on stdout instead of pretending a screen exists.
 */

import { loadConfig } from './config.ts';
import type { PlayerEntity } from './domain/reducer.ts';
import { NamespaceStore } from './collector/store.ts';
import { Collector } from './collector/collector.ts';
import { seedDemoStore } from './demo/fixtures.ts';
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

  const live = new NamespaceStore({
    namespace: 'live',
    failClosedOnUnsupportedSchema: true,
    replayCapacity: config.replayCapacity,
    dedupeCapacity: config.dedupeCapacity,
    maxLineBytes: config.maxLineBytes,
    player,
  });

  const demo = new NamespaceStore({
    namespace: 'demo',
    failClosedOnUnsupportedSchema: false,
    replayCapacity: config.replayCapacity,
    dedupeCapacity: config.dedupeCapacity,
    maxLineBytes: config.maxLineBytes,
    player,
  });

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

  process.stdout.write(
    `quest: collector + SSE running on http://127.0.0.1:${address.port}\n` +
      `quest:   health  GET /health\n` +
      `quest:   stream  GET /events/live   (SSE)\n` +
      `quest:   stream  GET /events/demo   (SSE)\n` +
      'quest: no UI is implemented in this package yet.\n',
  );

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
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
