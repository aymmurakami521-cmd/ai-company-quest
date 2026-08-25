/**
 * Read-only localhost SSE + health server.
 *
 * Security posture:
 * - binds to 127.0.0.1 only (the host is not configurable)
 * - rejects any connection whose peer is not loopback
 * - rejects Host headers other than 127.0.0.1 / localhost (DNS-rebinding guard)
 * - GET only; there is no endpoint that mutates collector state
 * - no CORS headers, so a random web origin cannot read the stream
 * - every streamed field comes from the `toWireEvent` whitelist
 * - the UI is a fixed table of static files (see `ui/assets.ts`); a request path
 *   is looked up in that table and never turned into a filesystem path
 *
 * Memory posture: a subscriber that stops reading is bounded, not buffered. Once
 * its unflushed bytes exceed `maxClientBufferBytes` the connection is dropped
 * and unsubscribed, so a single slow local client cannot grow the process heap.
 */

import { createServer as createHttpServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Namespace } from '../domain/event.ts';
import { NAMESPACES } from '../domain/event.ts';
import { isUuidV4 } from '../domain/validate.ts';
import type { StateLimits } from '../domain/reducer.ts';
import type { WireEvent } from '../domain/wire.ts';
import type { NamespaceStore } from '../collector/store.ts';
import type { UiAsset } from '../ui/assets.ts';
import { CONTENT_SECURITY_POLICY, uiAsset } from '../ui/assets.ts';

export const LOOPBACK_HOST = '127.0.0.1';
export const DEFAULT_PORT = 4317;
/** Per-subscriber ceiling on bytes accepted by the socket but not yet flushed. */
export const DEFAULT_MAX_CLIENT_BUFFER_BYTES = 1024 * 1024;

const LOOPBACK_PEERS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const ALLOWED_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

export type QuestServerOptions = {
  stores: Record<Namespace, NamespaceStore>;
  heartbeatMs?: number;
  maxClientBufferBytes?: number;
  now?: () => number;
};

/** The part of `ServerResponse` the SSE writer uses. Kept narrow for testing. */
export type SseSink = {
  write: (chunk: string) => boolean;
  destroy: () => void;
  readonly writableLength: number;
};

/**
 * Bounded SSE writer.
 *
 * `res.write()` returning false means the socket is backpressured; Node keeps
 * queueing whatever is written after that. This writer instead watches the
 * unflushed byte count and, past the limit, drops the subscriber: the queued
 * bytes are released by `destroy()` and no further event is queued for it.
 * Dropping (rather than waiting for `drain`) keeps ingestion non-blocking and
 * gives an explicit, bounded worst case per client.
 */
export class BoundedSseWriter {
  readonly sink: SseSink;
  readonly maxBufferedBytes: number;
  readonly onDrop: (reason: 'slow_consumer') => void;
  dropped: boolean;

  constructor(sink: SseSink, maxBufferedBytes: number, onDrop: (reason: 'slow_consumer') => void) {
    this.sink = sink;
    this.maxBufferedBytes = maxBufferedBytes;
    this.onDrop = onDrop;
    this.dropped = false;
  }

  write(frame: string): boolean {
    if (this.dropped) return false;
    const flushed = this.sink.write(frame);
    if (!flushed && this.sink.writableLength > this.maxBufferedBytes) {
      this.drop();
      return false;
    }
    return flushed;
  }

  drop(): void {
    if (this.dropped) return;
    this.dropped = true;
    this.onDrop('slow_consumer');
    this.sink.destroy();
  }
}

export type NamespaceHealth = {
  halted: boolean;
  halt_reason: string | null;
  last_ingest_seq: number;
  subscribers: number;
  /** Subscribers disconnected for exceeding the per-client buffer ceiling. */
  dropped_slow_subscribers: number;
  sessions: number;
  actors: number;
  /** The ceilings that halt ingestion when the state would grow past them. */
  state_limits: StateLimits;
  replay: { capacity: number; size: number };
  ingest: {
    lines_seen: number;
    accepted: number;
    duplicates: number;
    blank: number;
    rejected: number;
    rejected_by_reason: Record<string, number>;
    dropped_producer_keys: number;
  };
};

export class QuestServer {
  readonly stores: Record<Namespace, NamespaceStore>;
  readonly heartbeatMs: number;
  readonly maxClientBufferBytes: number;
  readonly http: Server;
  readonly startedAt: number;
  readonly now: () => number;
  readonly droppedSubscribers: Record<Namespace, number>;

  constructor(options: QuestServerOptions) {
    this.stores = options.stores;
    this.heartbeatMs = options.heartbeatMs ?? 15_000;
    this.maxClientBufferBytes = options.maxClientBufferBytes ?? DEFAULT_MAX_CLIENT_BUFFER_BYTES;
    this.now = options.now ?? (() => Date.now());
    this.startedAt = this.now();
    this.droppedSubscribers = {} as Record<Namespace, number>;
    for (const namespace of NAMESPACES) this.droppedSubscribers[namespace] = 0;
    this.http = createHttpServer((req, res) => {
      this.route(req, res);
    });
  }

  listen(port: number = DEFAULT_PORT): Promise<AddressInfo> {
    return new Promise((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      this.http.once('error', onError);
      this.http.listen(port, LOOPBACK_HOST, () => {
        this.http.removeListener('error', onError);
        const address = this.http.address();
        if (address === null || typeof address === 'string') {
          reject(new Error('server did not bind to a TCP address'));
          return;
        }
        resolve(address);
      });
    });
  }

  async close(): Promise<void> {
    this.http.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      this.http.close((error) => {
        if (error !== undefined && error !== null) reject(error);
        else resolve();
      });
    });
  }

  route(req: IncomingMessage, res: ServerResponse): void {
    if (!isLoopbackPeer(req)) {
      sendJson(res, 403, { error: 'loopback_only' });
      return;
    }
    if (!isAllowedHost(req)) {
      sendJson(res, 403, { error: 'host_not_allowed' });
      return;
    }
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      sendJson(res, 405, { error: 'method_not_allowed' });
      return;
    }

    const url = new URL(req.url ?? '/', `http://${LOOPBACK_HOST}`);
    if (url.pathname === '/health') {
      sendJson(res, 200, this.health());
      return;
    }

    // Exact-match lookup in a fixed table. The path is not a filesystem path.
    const asset = uiAsset(url.pathname);
    if (asset !== null) {
      sendAsset(res, asset);
      return;
    }

    const streamMatch = /^\/events\/([a-z]+)$/.exec(url.pathname);
    if (streamMatch !== null) {
      const candidate = streamMatch[1] ?? '';
      const namespace = NAMESPACES.find((value) => value === candidate);
      if (namespace === undefined) {
        sendJson(res, 404, { error: 'unknown_namespace' });
        return;
      }
      this.stream(req, res, namespace, url);
      return;
    }

    sendJson(res, 404, { error: 'not_found' });
  }

  health(): {
    status: 'ok' | 'fail_closed';
    uptime_ms: number;
    bind: string;
    ui: 'retro_office';
    namespaces: Record<Namespace, NamespaceHealth>;
  } {
    const namespaces = {} as Record<Namespace, NamespaceHealth>;
    let halted = false;
    for (const namespace of NAMESPACES) {
      const store = this.stores[namespace];
      const stats = store.stats;
      if (stats.halted) halted = true;
      namespaces[namespace] = {
        halted: stats.halted,
        halt_reason: stats.halt_reason,
        last_ingest_seq: stats.last_ingest_seq,
        subscribers: store.listeners.size,
        dropped_slow_subscribers: this.droppedSubscribers[namespace],
        sessions: Object.keys(store.state.sessions).length,
        actors: Object.keys(store.state.actors).length,
        state_limits: { ...store.stateLimits },
        replay: { capacity: store.replay.capacity, size: store.replay.size },
        ingest: {
          lines_seen: stats.lines_seen,
          accepted: stats.accepted,
          duplicates: stats.duplicates,
          blank: stats.blank,
          rejected: stats.rejected,
          rejected_by_reason: { ...stats.rejected_by_reason },
          dropped_producer_keys: stats.dropped_producer_keys,
        },
      };
    }
    return {
      status: halted ? 'fail_closed' : 'ok',
      uptime_ms: this.now() - this.startedAt,
      bind: LOOPBACK_HOST,
      ui: 'retro_office',
      namespaces,
    };
  }

  snapshot(namespace: Namespace): unknown {
    const store = this.stores[namespace];
    const oldest = store.replay.oldest();
    const newest = store.replay.newest();
    return {
      namespace,
      halted: store.stats.halted,
      halt_reason: store.stats.halt_reason,
      last_ingest_seq: store.stats.last_ingest_seq,
      replay: {
        capacity: store.replay.capacity,
        size: store.replay.size,
        oldest_event_id: oldest === null ? null : oldest.event_id,
        newest_event_id: newest === null ? null : newest.event_id,
      },
      state: store.state,
    };
  }

  stream(req: IncomingMessage, res: ServerResponse, namespace: Namespace, url: URL): void {
    const store = this.stores[namespace];

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'X-Content-Type-Options': 'nosniff',
    });
    let cleanup = (): void => {};
    const writer = new BoundedSseWriter(res, this.maxClientBufferBytes, () => {
      this.droppedSubscribers[namespace] += 1;
      cleanup();
    });

    // Subscribe before replaying: ingestion is synchronous, so no event can slip
    // between the replay slice and the live subscription.
    const unsubscribe = store.subscribe((wire) => {
      writeEvent(writer, wire);
    });

    // A halt produces no wire event, so it gets its own control frame: without
    // it an already-connected client would keep receiving heartbeats and would
    // report a healthy stream forever after ingestion stopped.
    const unsubscribeHalt = store.subscribeHalt((notice) => {
      writeControl(writer, 'fail_closed', {
        namespace: notice.namespace,
        halted: true,
        reason: notice.reason,
        detail: notice.detail,
      });
    });

    const heartbeat = setInterval(() => {
      writer.write(': keep-alive\n\n');
    }, this.heartbeatMs);
    heartbeat.unref();

    cleanup = (): void => {
      clearInterval(heartbeat);
      unsubscribe();
      unsubscribeHalt();
    };
    req.on('close', cleanup);
    res.on('close', cleanup);
    res.on('error', cleanup);

    // Written only once the teardown path exists, so a drop can never strand a
    // subscription on the store.
    writer.write(`: quest ${namespace} stream\n\n`);

    const requested = readLastEventId(req, url);
    if (requested === null) {
      writeControl(writer, 'snapshot', this.snapshot(namespace));
    } else if (!isUuidV4(requested)) {
      writeControl(writer, 'stream_gap', { reason: 'invalid_last_event_id' });
      writeControl(writer, 'snapshot', this.snapshot(namespace));
    } else {
      const lookup = store.replayFrom(requested);
      if (lookup.status === 'replay') {
        writeControl(writer, 'replay_start', {
          last_event_id: requested,
          count: lookup.events.length,
          buffer_capacity: store.replay.capacity,
        });
        for (const event of lookup.events) writeEvent(writer, event);
        writeControl(writer, 'replay_end', { count: lookup.events.length });
      } else if (lookup.status === 'gap') {
        writeControl(writer, 'stream_gap', {
          reason: 'evicted',
          last_event_id: requested,
          oldest_event_id: lookup.oldest_event_id,
          oldest_ingest_seq: lookup.oldest_ingest_seq,
          buffer_capacity: store.replay.capacity,
        });
        writeControl(writer, 'snapshot', this.snapshot(namespace));
      } else {
        writeControl(writer, 'stream_gap', { reason: 'unknown_event_id', last_event_id: requested });
        writeControl(writer, 'snapshot', this.snapshot(namespace));
      }
    }
  }
}

function isLoopbackPeer(req: IncomingMessage): boolean {
  const address = req.socket.remoteAddress;
  return typeof address === 'string' && LOOPBACK_PEERS.has(address);
}

function isAllowedHost(req: IncomingMessage): boolean {
  const host = req.headers.host;
  if (typeof host !== 'string' || host.length === 0) return false;
  const hostname = host.startsWith('[') ? (host.split(']')[0] ?? '') + ']' : (host.split(':')[0] ?? '');
  return ALLOWED_HOSTNAMES.has(hostname);
}

function readLastEventId(req: IncomingMessage, url: URL): string | null {
  const header = req.headers['last-event-id'];
  if (typeof header === 'string' && header.length > 0) return header;
  if (Array.isArray(header) && header.length > 0) return header[0] ?? null;
  const query = url.searchParams.get('last_event_id');
  if (query !== null && query.length > 0) return query;
  return null;
}

function writeEvent(writer: BoundedSseWriter, wire: WireEvent): void {
  writer.write(`id: ${wire.event_id}\nevent: quest_event\ndata: ${JSON.stringify(wire)}\n\n`);
}

/** Control frames deliberately carry no `id:` so they never move Last-Event-ID. */
function writeControl(writer: BoundedSseWriter, name: string, payload: unknown): void {
  writer.write(`event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`);
}

/** Serves one preloaded UI file. No CORS header, so only this origin may read it. */
function sendAsset(res: ServerResponse, asset: UiAsset): void {
  res.writeHead(200, {
    'Content-Type': asset.contentType,
    'Content-Length': asset.body.byteLength,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': CONTENT_SECURITY_POLICY,
  });
  res.end(asset.body);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text, 'utf8'),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(text);
}
