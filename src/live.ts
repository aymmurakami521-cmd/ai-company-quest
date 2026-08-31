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
import { APPROVAL_COMMAND, attachApprovalConsole } from './demo/approval.ts';
import { DEMO_ORG } from './demo/orgFixture.ts';
import { loadOrgState } from './collector/orgLoader.ts';
import { orgStatusDetail } from './domain/org.ts';
import { loadValueLedgerState } from './collector/valueLedgerLoader.ts';
import { valueLedgerStatusDetail, VALUE_LEDGER_ABSENT } from './domain/valueLedger.ts';
import type { ValueLedgerSource } from './domain/valueDashboard.ts';
import { DEMO_VALUE_LEDGER } from './demo/valueFixture.ts';
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

  // Read once at startup too, and on the same terms: a missing or invalid
  // ledger disables the value read model only, never ingestion. The demo
  // fixture is used *only* when nothing is configured and a demo was asked
  // for, and it says so in the payload, so fabricated money can never be read
  // as a company's own figures.
  const useDemoLedger = config.valueLedgerPath === null && (config.seedDemo || config.demoPlay);
  const valueLedger = useDemoLedger
    ? DEMO_VALUE_LEDGER
    : config.valueLedgerPath === null
      ? VALUE_LEDGER_ABSENT
      : await loadValueLedgerState({ path: config.valueLedgerPath });
  const valueLedgerSource: ValueLedgerSource = useDemoLedger
    ? 'demo_fixture'
    : config.valueLedgerPath === null
      ? 'none'
      : 'operator';

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
    // Static data, never a file: DEMO does no external I/O, and the LIVE store
    // above keeps the operator-configured snapshot it was given
    // (`docs/org-snapshot-design.md` §4.6).
    org: DEMO_ORG,
    // Fires on the 0 -> 1 subscriber transition only, so the mission starts when
    // somebody is actually watching and a reconnect never restarts it. LIVE
    // never gets this hook: the callback closes over the DEMO store alone.
    onFirstSubscriber: config.demoPlay ? () => demoPlayer?.start() : undefined,
  });

  /** Removes the stdin listener again. Null unless the mission is being played. */
  let detachApprovalConsole: (() => void) | null = null;

  if (config.demoPlay) {
    demoPlayer = new DemoPlayer({
      store: demo,
      intervalMs: config.demoPlayIntervalMs,
      firstDelayMs: config.demoPlayFirstDelayMs,
      onFinished: () => {
        process.stdout.write(`quest: demo mission finished (${DEMO_TIMELINE.length} events)\n`);
      },
      // Playback is already suspended by the time this runs; the line only tells
      // the person that the mission is now waiting on them.
      onAwaitingApproval: () => {
        process.stdout.write(
          'quest: DEMO mission is waiting for a human approval.\n' +
            `quest:   type '${APPROVAL_COMMAND}' + Enter here to approve. Time alone will not resume it.\n`,
        );
      },
    });

    // The only input this process accepts. Scoped to the DEMO player by the
    // closure: there is no LIVE player, and no namespace reaches this call.
    const player = demoPlayer;
    detachApprovalConsole = attachApprovalConsole({
      input: process.stdin,
      approve: () => player.approve(),
      write: (line) => {
        process.stdout.write(line);
      },
    });
  }

  process.stdout.write(`quest: org snapshot ${orgStatusDetail(org)}\n`);
  process.stdout.write(
    `quest: value ledger ${valueLedgerStatusDetail(valueLedger)}` +
      ` (source=${valueLedgerSource}, amounts=${config.valueDisclosure})\n`,
  );

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

  const server = new QuestServer({
    stores: { live, demo },
    value: {
      ledger: valueLedger,
      disclosure: config.valueDisclosure,
      source: valueLedgerSource,
    },
  });
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
      `quest:   value   GET /value/summary   (ROI read model, amounts=${config.valueDisclosure})\n` +
      'quest: read-only, loopback only. Ctrl-C to stop.\n' +
      // Said only when there is a mission that can stop for a human. The HTTP
      // surface is unchanged by it: this is stdin of this process, not a route.
      (config.demoPlay
        ? `quest: the DEMO mission stops at 承認待ち. Type '${APPROVAL_COMMAND}' + Enter here to approve it.\n`
        : ''),
  );

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    // The demo timer first: it is the only thing left in this process that would
    // keep producing after the collector stopped. The approval console goes with
    // it, so a line typed during shutdown cannot produce one last transition.
    demoPlayer?.stop();
    detachApprovalConsole?.();
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
