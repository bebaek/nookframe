import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import lockfile from 'proper-lockfile';
import type { ModelChoice } from '../shared/protocol.js';
import { resolveModelSelection, saveModelSelection, type ModelSelection } from './models.js';
import type { Workspace } from './workspace.js';

function atomic(path: string, value: unknown) {
  const temp = `${path}.${randomUUID()}.tmp`;
  try { writeFileSync(temp, JSON.stringify(value) + '\n', { mode: 0o600, flag: 'wx' }); renameSync(temp, path); }
  finally { rmSync(temp, { force: true }); }
}
function choice(value: unknown): ModelChoice {
  if (!value || typeof value !== 'object') throw new Error('Model requires provider and id');
  const { provider, id } = value as Record<string, unknown>;
  if (typeof provider !== 'string' || !provider.trim() || provider.length > 200 || typeof id !== 'string' || !id.trim() || id.length > 500) throw new Error('Invalid model choice');
  return { provider, id };
}

/** Only explicitly NEW threads consume this override; old unpinned sessions keep legacy selection. */
export function newThreadModel(stateDir: string, agentDir: string, env: NodeJS.ProcessEnv): ModelSelection {
  const legacy = resolveModelSelection(stateDir, agentDir, env);
  const path = join(stateDir, 'new-thread-model.json');
  if (legacy.source === 'environment' || !existsSync(path)) return legacy;
  return { source: 'saved', model: choice(JSON.parse(readFileSync(path, 'utf8')).model) };
}

export function selectThreadModel(stateDir: string, threadStateDir: string, agentDir: string, env: NodeJS.ProcessEnv, newlyCreated = false) {
  const selection = newlyCreated ? newThreadModel(stateDir, agentDir, env)
    : resolveModelSelection(existsSync(join(threadStateDir, 'model.json')) ? threadStateDir : stateDir, agentDir, env);
  // Freeze an explicit default at creation; old unpinned threads continue using
  // the legacy fallback, never the new-thread-only setting.
  if (newlyCreated && selection.model && selection.source !== 'environment') {
    mkdirSync(threadStateDir, { recursive: true, mode: 0o700 });
    saveModelSelection(threadStateDir, selection.model);
  }
  return selection;
}

type Status = 'proposed' | 'pending' | 'applying' | 'applied' | 'rejected' | 'uncertain';
export interface ModelPlan {
  id: string; scope: 'thread' | 'new-threads'; threadId: string;
  before: string | ModelChoice | null; after: ModelChoice; revision: string;
  deferUntilSettled: boolean; status: Status; createdAt: string; expiresAt: string;
  requester: 'browser' | 'token'; updatedAt?: string; result?: string;
}
type LivePlan = { plan: ModelPlan; target: Workspace; unsubscribe?: () => void; timer?: ReturnType<typeof setTimeout> };

/** Plans are process-bound and never replayed after restart. Files are an audit trail, not a work queue. */
export class ModelOperations {
  private plans = new Map<string, LivePlan>();
  private closed = false;
  private directory: string;
  constructor(private stateDir: string, private agentDir: string, private env: NodeJS.ProcessEnv,
    private workspace: (id: string) => Workspace) {
    this.directory = join(stateDir, 'model-operations');
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
  }
  private persist(plan: ModelPlan) { atomic(join(this.directory, `${plan.id}.json`), plan); }
  defaults() {
    const selection = newThreadModel(this.stateDir, this.agentDir, this.env);
    const path = join(this.stateDir, 'new-thread-model.json');
    const stored = existsSync(path) ? readFileSync(path, 'utf8') : '';
    return { scope: 'new-threads', selection: selection.model ?? null, source: selection.source,
      environmentLocked: selection.source === 'environment',
      revision: createHash('sha256').update(JSON.stringify(selection)).update(stored).digest('hex') };
  }
  catalog(id: string) {
    const target = this.workspace(id);
    return { threadId: id, revision: target.modelRevision, current: target.state.model,
      environmentLocked: target.state.modelSource === 'environment', models: target.state.models,
      defaults: this.defaults() };
  }
  propose(value: unknown, requester: ModelPlan['requester']) {
    if (this.closed) throw new Error('Operations are shutting down');
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid proposal');
    const input = value as Record<string, unknown>;
    if (Object.keys(input).some(key => !['scope', 'threadId', 'model', 'deferUntilSettled'].includes(key))) throw new Error('Unknown proposal field');
    if (input.scope !== 'thread' && input.scope !== 'new-threads') throw new Error('Explicit scope required');
    if (typeof input.threadId !== 'string') throw new Error('Loaded threadId required for model discovery');
    if (input.deferUntilSettled !== undefined && typeof input.deferUntilSettled !== 'boolean') throw new Error('Invalid deferred flag');
    const target = this.workspace(input.threadId);
    const after = choice(input.model);
    this.validate(target, after);
    if (this.plans.size >= 200) throw new Error('Plan capacity reached; restart before proposing further changes');
    const defaults = this.defaults();
    if (defaults.environmentLocked || (input.scope === 'thread' && target.state.modelSource === 'environment')) throw new Error('Model is environment-locked');
    if (input.scope === 'new-threads' && input.deferUntilSettled) throw new Error('Deferral only applies to thread changes');
    const plan: ModelPlan = { id: randomUUID(), scope: input.scope, threadId: input.threadId,
      before: input.scope === 'thread' ? target.state.model : defaults.selection, after,
      revision: input.scope === 'thread' ? target.modelRevision : defaults.revision,
      deferUntilSettled: input.deferUntilSettled === true, status: 'proposed', requester,
      createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 30 * 60_000).toISOString() };
    this.persist(plan);
    this.plans.set(plan.id, { plan, target });
    return structuredClone(plan);
  }
  private validate(target: Workspace, model: ModelChoice) {
    if (!target.state.available || target.state.backgroundRun) throw new Error('Target is unavailable or background-only');
    if (!target.state.models.some(m => m.provider === model.provider && m.id === model.id)) throw new Error('Model is not in the available catalog');
  }
  get(id: string) {
    const live = this.plans.get(id);
    if (!live) throw new Error('Plan is absent or belongs to a previous server process; it will not be replayed');
    return structuredClone(live.plan);
  }
  private check(live: LivePlan) {
    if (this.closed) throw new Error('Operations are shutting down');
    const { plan, target } = live;
    if (Date.now() >= Date.parse(plan.expiresAt)) throw new Error('Plan expired');
    if (this.workspace(plan.threadId) !== target) throw new Error('Target agent was replaced');
    this.validate(target, plan.after);
    const defaults = this.defaults();
    if (defaults.environmentLocked || target.state.modelSource === 'environment') throw new Error('Model is environment-locked');
    if ((plan.scope === 'thread' ? target.modelRevision : defaults.revision) !== plan.revision) throw new Error('Plan is stale');
  }
  private finish(live: LivePlan, status: Status, result: string) {
    live.unsubscribe?.(); live.unsubscribe = undefined;
    if (live.timer) clearTimeout(live.timer);
    live.plan.status = status; live.plan.result = result; live.plan.updatedAt = new Date().toISOString();
    try { this.persist(live.plan); }
    catch { live.plan.status = 'uncertain'; live.plan.result = 'Audit persistence failed; inspect state, do not retry blindly'; }
  }
  cancel(id: string) {
    const live = this.plans.get(id);
    if (!live) throw new Error('Plan not found');
    if (live.plan.status === 'applying') throw new Error('Change already dispatched; inspect its outcome');
    if (live.plan.status === 'proposed' || live.plan.status === 'pending') this.finish(live, 'rejected', 'Cancelled before dispatch');
    return this.get(id);
  }
  async apply(id: string) {
    const live = this.plans.get(id);
    if (!live) throw new Error('Plan is absent or belongs to a previous server process');
    if (live.plan.status !== 'proposed') return this.get(id);
    try {
      this.check(live);
      if (live.plan.scope === 'thread' && !live.target.idle) {
        if (!live.plan.deferUntilSettled || !live.target.state.busy || live.target.state.modelChanging || live.target.state.threadChanging) throw new Error('Thread is busy; explicitly propose after-settlement deferral');
        live.plan.status = 'pending'; this.persist(live.plan);
        live.unsubscribe = live.target.subscribe(() => {
          if (live.plan.status !== 'pending') return;
          if (!live.target.state.available) { this.finish(live, 'rejected', 'Target became unavailable'); return; }
          if (live.target.idle) void this.execute(live);
        });
        live.timer = setTimeout(() => { if (live.plan.status === 'pending') this.finish(live, 'rejected', 'Pending plan expired'); }, Math.max(1, Date.parse(live.plan.expiresAt) - Date.now()));
        live.timer.unref();
      } else await this.execute(live);
    } catch { this.finish(live, 'rejected', 'Plan expired, stale, locked, busy, or unavailable; inspect and propose again'); }
    return this.get(id);
  }
  private async execute(live: LivePlan) {
    // No awaits before the thread setter takes its synchronous modelChanging guard.
    let release: (() => void) | undefined;
    let dispatched = false;
    try {
      if (live.plan.scope === 'new-threads') release = lockfile.lockSync(this.directory, { retries: 0 });
      this.check(live);
      live.unsubscribe?.(); live.unsubscribe = undefined;
      live.plan.status = 'applying'; this.persist(live.plan);
      dispatched = true;
      if (live.plan.scope === 'thread') await live.target.setModel(live.plan.after.provider, live.plan.after.id);
      else {
        atomic(join(this.stateDir, 'new-thread-model.json'), { model: live.plan.after, revision: randomUUID() });
        const actual = this.defaults().selection;
        if (actual?.provider !== live.plan.after.provider || actual.id !== live.plan.after.id) throw new Error('Default verification failed');
      }
      this.finish(live, 'applied', live.plan.scope === 'thread' ? 'Thread model activated, verified and saved' : 'Default saved for newly created threads only; existing threads unchanged');
    } catch { this.finish(live, dispatched ? 'uncertain' : 'rejected', dispatched ? 'Change outcome uncertain; inspect state, do not retry blindly' : 'Plan expired, stale, locked, busy, or unavailable; inspect and propose again'); }
    finally { release?.(); }
  }
  close() {
    this.closed = true;
    for (const live of this.plans.values()) if (live.plan.status === 'pending' || live.plan.status === 'proposed') this.finish(live, 'rejected', 'Server shutdown; change not replayed');
  }
}
