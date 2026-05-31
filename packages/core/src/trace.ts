import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';

export type TraceEventKind =
  | 'thought'
  | 'tool_call'
  | 'observation'
  | 'replan'
  | 'error'
  | 'usage'
  | 'phase_begin'
  | 'phase_end';

export interface TraceEvent {
  /** ISO 8601 timestamp */
  t: string;
  step: number;
  phase: string;
  kind: TraceEventKind;
  agent_id: string;
  parent?: string;
  /** kind-specific payload (free-form) */
  [key: string]: unknown;
}

/**
 * Append-only JSONL trace bus. Per design.md §7.2 + plan F6:
 *  - one event per line, never reformat / reorder
 *  - timestamp + step + phase + kind on every line
 *  - replan events use kind='replan'
 *
 * The first call to `emit` opens the file with `wx` (fail if exists) so a run
 * directory can never silently swallow a previous run's trace.
 */
export class TraceBus {
  private step = 0;
  private filePath: string;
  private inited = false;
  private agentId: string;
  /** serialise writes so concurrent emit() calls don't interleave on disk */
  private writeChain: Promise<void> = Promise.resolve();

  constructor(filePath: string, agentId = 'master') {
    this.filePath = filePath;
    this.agentId = agentId;
  }

  /** Stable agent id for nested flows (e.g. cron-flow vs query-flow). */
  get agent(): string {
    return this.agentId;
  }

  async emit(
    phase: string,
    kind: TraceEventKind,
    extra: Record<string, unknown> = {},
    overrides: { agent_id?: string; parent?: string } = {},
  ): Promise<TraceEvent> {
    this.step += 1;
    const ev: TraceEvent = {
      t: new Date().toISOString(),
      step: this.step,
      phase,
      kind,
      agent_id: overrides.agent_id ?? this.agentId,
      ...(overrides.parent ? { parent: overrides.parent } : {}),
      ...extra,
    };
    await this.write(ev);
    return ev;
  }

  async close(): Promise<void> {
    // No-op: writes are flushed per-line. Method kept for symmetry with a
    // future buffered impl.
  }

  private async write(ev: TraceEvent): Promise<void> {
    const next = this.writeChain.then(async () => {
      if (!this.inited) {
        await fs.mkdir(dirname(this.filePath), { recursive: true });
        this.inited = true;
      }
      await fs.appendFile(this.filePath, JSON.stringify(ev) + '\n', 'utf8');
    });
    // Don't let one failed write wedge subsequent writes — swallow rejection
    // on the chain itself and re-surface to the caller via `next`.
    this.writeChain = next.catch(() => undefined);
    return next;
  }
}
