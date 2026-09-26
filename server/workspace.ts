import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RpcClient, JsonAgentSessionEvent } from '@earendil-works/pi-coding-agent';
import type { ChatMessage, Snapshot } from '../shared/protocol.js';
import { saveModelSelection, type ModelSelection } from './models.js';

export type Agent = Pick<RpcClient, 'onEvent' | 'getState' | 'getEntries' | 'prompt' | 'clearQueue' | 'abort' | 'stop' | 'getAvailableModels' | 'setModel'>;
const clip = (text: string) => text.length > 24000 ? text.slice(0, 24000) + '\n[display truncated]' : text;
function contentText(content: unknown): string {
  if (typeof content === 'string') return clip(content);
  if (!Array.isArray(content)) return '';
  return clip(content.filter(b => b.type === 'text').map(b => b.text).join('\n'));
}
export function displayMessage(message: unknown, id: number): ChatMessage | undefined {
  if (!message || typeof message !== 'object') return;
  const m = message as Record<string, unknown>;
  if (m.role === 'system' || m.display === false) return;
  const calls = Array.isArray(m.content) ? m.content.filter(b => b.type === 'toolCall') : [];
  return {
    id, role: String(m.role ?? 'message'),
    text: contentText(m.content) || String(m.summary ?? m.output ?? ''),
    details: clip(calls.map(b => `${b.name}\n${JSON.stringify(b.arguments, null, 2)}`).join('\n\n')),
    error: typeof m.errorMessage === 'string' ? m.errorMessage : m.isError ? 'Tool failed' : undefined,
  };
}

// One controller owns one pi session. Browser connections never own the agent.
export class Workspace {
  state: Snapshot = { messages: [], liveText: '', tools: {}, busy: false, available: true, model: '', models: [], modelSource: 'pi', modelChanging: false, notice: '' };
  private listeners = new Set<() => void>();
  private nextId = 0;
  private blocks = new Map<number, string>();
  private marker: string;
  private unsubscribe: () => void;
  private stopping = false;
  private heartbeat?: ReturnType<typeof setInterval>;

  constructor(private agent: Agent, private stateDir: string, private selection: ModelSelection = { source: 'pi' }) {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    this.marker = join(stateDir, 'run-active');
    if (existsSync(this.marker)) this.state.notice = 'The previous run was interrupted. Inspect files before retrying; nothing was automatically resubmitted.';
    this.unsubscribe = agent.onEvent(event => {
      try { this.event(event); } catch { this.fail(); }
    });
  }

  async initialize() {
    this.state.models = (await this.agent.getAvailableModels()).map(({ provider, id }) => ({ provider, id }));
    this.state.modelSource = this.selection.source;
    let state = await this.agent.getState();
    const desired = this.selection.model;
    if (desired) {
      if (!this.state.models.some(m => m.provider === desired.provider && m.id === desired.id)) {
        throw new Error(`Selected model is unavailable: ${desired.provider}/${desired.id}. Check provider login or model configuration.`);
      }
      if (state.model?.provider !== desired.provider || state.model?.id !== desired.id) {
        await this.agent.setModel(desired.provider, desired.id);
        state = await this.agent.getState();
      }
      if (state.model?.provider !== desired.provider || state.model?.id !== desired.id) throw new Error('Pi did not activate the selected model');
    }
    this.state.model = state.model ? `${state.model.provider}/${state.model.id}` : 'No model configured';
    // Follow the active branch, retaining pre-compaction messages for display.
    const { entries, leafId } = await this.agent.getEntries();
    const byId = new Map(entries.map(e => [e.id, e]));
    const branch = [];
    let cursor = leafId;
    while (cursor) {
      const entry = byId.get(cursor);
      if (!entry) break;
      branch.push(entry);
      cursor = entry.parentId;
    }
    for (const entry of branch.reverse()) {
      if (entry.type === 'message') this.append(entry.message);
    }
    this.heartbeat = setInterval(() => {
      void this.agent.getState().catch(() => this.fail());
    }, 5000);
    this.heartbeat.unref();
  }

  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private changed() { for (const listener of this.listeners) listener(); }
  private append(message: unknown) {
    const display = displayMessage(message, ++this.nextId);
    if (display) this.state.messages = [...this.state.messages, display].slice(-200);
  }
  private fail() {
    this.state.available = false;
    this.state.busy = false;
    this.state.notice = 'Pi is unavailable. The run may be interrupted; restart the service and inspect files before retrying.';
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.changed();
  }
  private event(event: JsonAgentSessionEvent) {
    switch (event.type) {
      case 'agent_start': this.state.busy = true; break;
      case 'message_start':
        if (event.message.role === 'assistant') { this.blocks.clear(); this.state.liveText = ''; }
        break;
      case 'message_update': {
        const e = event.assistantMessageEvent;
        if (e.type === 'text_delta') this.blocks.set(e.contentIndex, clip((this.blocks.get(e.contentIndex) ?? '') + e.delta));
        if (e.type === 'text_end') this.blocks.set(e.contentIndex, clip(e.content));
        this.state.liveText = [...this.blocks.entries()].sort(([a], [b]) => a - b).map(([, text]) => text).join('\n');
        break;
      }
      case 'message_end':
        this.append(event.message);
        if (event.message.role === 'assistant') { this.state.liveText = ''; this.blocks.clear(); }
        break;
      case 'tool_execution_start':
        this.state.tools[event.toolCallId] = { name: event.toolName, output: clip(JSON.stringify(event.args, null, 2)) };
        break;
      case 'tool_execution_update':
        this.state.tools[event.toolCallId] = { name: event.toolName, output: contentText(event.partialResult.content) };
        break;
      case 'tool_execution_end': delete this.state.tools[event.toolCallId]; break;
      case 'agent_settled':
        this.state.busy = false;
        this.state.liveText = '';
        this.blocks.clear();
        this.state.tools = {};
        if (existsSync(this.marker)) unlinkSync(this.marker);
        break;
    }
    this.changed();
  }

  async setModel(provider: string, modelId: string) {
    if (!this.state.available) throw new Error('Pi is unavailable');
    if (this.state.modelSource === 'environment') throw new Error('Model is locked by AGENT_PROVIDER/AGENT_MODEL; remove the environment override to select it here');
    if (this.state.busy || this.stopping || this.state.modelChanging) throw new Error('Wait until the current operation finishes before switching models');
    if (!this.state.models.some(m => m.provider === provider && m.id === modelId)) throw new Error('Model is not in the available catalog');
    // Global guard covers all tabs: a prompt cannot race a model change.
    this.state.modelChanging = true;
    this.changed();
    try {
      await this.agent.setModel(provider, modelId);
      const state = await this.agent.getState();
      if (state.model?.provider !== provider || state.model?.id !== modelId) throw new Error('Model switch was not confirmed');
      saveModelSelection(this.stateDir, { provider, id: modelId });
      this.state.model = `${provider}/${modelId}`;
      this.state.modelSource = 'saved';
    } catch {
      // Switching may have succeeded even if RPC or the persistence write failed.
      // Do not allow a prompt under an uncertain model or silently lose the choice.
      this.fail();
      this.state.notice = 'Could not confirm and save the model choice. Restart the service before sending another prompt.';
      throw new Error(this.state.notice);
    } finally {
      this.state.modelChanging = false;
      this.changed();
    }
  }

  async prompt(text: string) {
    if (!this.state.available) throw new Error('Pi is unavailable');
    if (this.state.busy || this.stopping || this.state.modelChanging) throw new Error('A run or model change is already active');
    // Slash commands / extensions need additional UI semantics; not exposed in v1.
    if (text.trimStart().startsWith('/')) throw new Error('Slash commands are not supported in this first version');
    writeFileSync(this.marker, new Date().toISOString(), { mode: 0o600 });
    this.state.busy = true;
    this.state.notice = '';
    this.changed();
    try { await this.agent.prompt(text); }
    catch {
      // A timeout can mean pi accepted the prompt: fail closed, never auto-resend.
      this.fail();
      throw new Error('Prompt status is uncertain. Reconnect or restart, inspect history, and do not blindly resend.');
    }
  }

  async abort() {
    if (this.stopping) throw new Error('Stop is already pending');
    this.stopping = true;
    try { await this.agent.clearQueue(); await this.agent.abort(); }
    catch { this.fail(); throw new Error('Could not confirm cancellation'); }
    finally { this.stopping = false; }
  }

  async close() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.state.busy) {
      try { await this.abort(); } catch { /* Keep interruption marker. */ }
    }
    this.unsubscribe();
    await this.agent.stop();
  }
}
