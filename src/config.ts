/**
 * Environment-driven configuration.
 *
 * The input path is always supplied by the operator through `QUEST_INPUT_PATH`;
 * no personal or absolute path is committed to this repository. The bind host
 * is intentionally NOT configurable - see `server.ts`.
 */

import { DEFAULT_MAX_LINE_BYTES } from './domain/validate.ts';
import { VALUE_DISCLOSURES, type ValueDisclosure } from './domain/valueDashboard.ts';
import { DEFAULT_DEDUPE_CAPACITY, DEFAULT_REPLAY_CAPACITY } from './collector/store.ts';
import { DEFAULT_PORT } from './server/server.ts';

export type QuestConfig = {
  inputPath: string | null;
  /**
   * Path to the verified organisation snapshot (`company/org.snapshot.json`,
   * produced by the `ai-company` repository). Supplied by the operator through
   * `QUEST_ORG_SNAPSHOT_PATH`, on exactly the same terms as `inputPath`: no
   * cross-repository path is committed here, and no path is ever derived from
   * event content. `null` means "no organisation input", which is a supported
   * mode, not an error (`docs/org-snapshot-design.md` §4.5).
   */
  orgSnapshotPath: string | null;
  /**
   * Path to the operator-supplied value ledger (hourly-rate policy plus
   * business-value records), on exactly the same terms as `orgSnapshotPath`:
   * configuration only, never derived from event content, and `null` - no
   * ledger - is a supported mode rather than an error.
   *
   * A file rather than an endpoint is the deliberate boundary. Quest answers
   * GET only and holds no identity, so an Owner/Admin editing surface would
   * need an authenticated Control API this process does not have
   * (`docs/value-rate-design.md` §6).
   */
  valueLedgerPath: string | null;
  /**
   * How much of the money the local screen may show. `restricted` is the
   * default: it withholds every amount while still showing what exists, which
   * scope won and in what currency. Raising it is an explicit operator act on
   * a loopback-only surface, never something a request can ask for.
   */
  valueDisclosure: ValueDisclosure;
  port: number;
  replayCapacity: number;
  dedupeCapacity: number;
  pollIntervalMs: number;
  maxLineBytes: number;
  startFrom: 'beginning' | 'end';
  /** `QUEST_DEMO=1`: fold the fixed fixtures in at startup, in one go. */
  seedDemo: boolean;
  /**
   * `QUEST_DEMO_PLAY=1`: play the scripted mission instead, starting when the
   * first DEMO subscriber connects. The two are independent - the still frame
   * and the moving picture are different demos, not two settings of one.
   */
  demoPlay: boolean;
  /** Gap between beats of the scripted mission. */
  demoPlayIntervalMs: number;
  /** Gap before its first beat; see `DemoPlayerOptions.firstDelayMs`. */
  demoPlayFirstDelayMs: number;
  playerName: string;
};

export type EnvLike = Record<string, string | undefined>;

function readInt(env: EnvLike, key: string, fallback: number, min: number, max: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${key} must be an integer between ${min} and ${max}`);
  }
  return value;
}

export function loadConfig(env: EnvLike): QuestConfig {
  const rawInput = env['QUEST_INPUT_PATH'];
  const inputPath = rawInput === undefined || rawInput.trim() === '' ? null : rawInput.trim();

  const rawOrg = env['QUEST_ORG_SNAPSHOT_PATH'];
  const orgSnapshotPath = rawOrg === undefined || rawOrg.trim() === '' ? null : rawOrg.trim();

  const rawLedger = env['QUEST_VALUE_LEDGER_PATH'];
  const valueLedgerPath = rawLedger === undefined || rawLedger.trim() === '' ? null : rawLedger.trim();

  // Fail closed on an unrecognised value rather than falling back to the
  // permissive end: a typo in this variable must not silently publish money.
  const rawDisclosure = env['QUEST_VALUE_DISCLOSURE'];
  const disclosure =
    rawDisclosure === undefined || rawDisclosure.trim() === '' ? 'restricted' : rawDisclosure.trim();
  if (!(VALUE_DISCLOSURES as readonly string[]).includes(disclosure)) {
    throw new Error(`QUEST_VALUE_DISCLOSURE must be one of ${VALUE_DISCLOSURES.join(' | ')}`);
  }

  const rawStartFrom = env['QUEST_START_FROM'] ?? 'beginning';
  if (rawStartFrom !== 'beginning' && rawStartFrom !== 'end') {
    throw new Error("QUEST_START_FROM must be 'beginning' or 'end'");
  }

  const rawPlayer = env['QUEST_PLAYER_NAME'];
  const playerName = rawPlayer === undefined || rawPlayer.trim() === '' ? 'Player' : rawPlayer.trim().slice(0, 64);

  return {
    inputPath,
    orgSnapshotPath,
    valueLedgerPath,
    valueDisclosure: disclosure as ValueDisclosure,
    port: readInt(env, 'QUEST_PORT', DEFAULT_PORT, 1024, 65535),
    replayCapacity: readInt(env, 'QUEST_REPLAY_CAPACITY', DEFAULT_REPLAY_CAPACITY, 1, 100_000),
    dedupeCapacity: readInt(env, 'QUEST_DEDUPE_CAPACITY', DEFAULT_DEDUPE_CAPACITY, 1, 5_000_000),
    pollIntervalMs: readInt(env, 'QUEST_POLL_INTERVAL_MS', 100, 10, 60_000),
    maxLineBytes: readInt(env, 'QUEST_MAX_LINE_BYTES', DEFAULT_MAX_LINE_BYTES, 256, 8 * 1024 * 1024),
    startFrom: rawStartFrom,
    seedDemo: env['QUEST_DEMO'] === '1',
    demoPlay: env['QUEST_DEMO_PLAY'] === '1',
    demoPlayIntervalMs: readInt(env, 'QUEST_DEMO_PLAY_INTERVAL_MS', 1500, 100, 60_000),
    demoPlayFirstDelayMs: readInt(env, 'QUEST_DEMO_PLAY_FIRST_DELAY_MS', 1200, 0, 60_000),
    playerName,
  };
}
