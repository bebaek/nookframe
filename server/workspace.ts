import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RpcClient, JsonAgentSessionEvent } from '@earendil-works/pi-coding-agent';
import type { ChatMessage, Snapshot, ToolOperation } from '../shared/protocol.js';
import { saveModelSelection, type ModelSelection } from './models.js';
import type { ThreadStore } from './threads.js';
import { photoId, type PhotoContent } from './photos.js';

export type Agent = Pick<RpcClient, 'onEvent' | 'getState' | 'getEntries' | 'prompt' | 'clearQueue' | 'abort' | 'stop' | 'getAvailableModels' | 'setModel' | 'switchSession'>;
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
  return {
    id, role: String(m.role ?? 'message'),
    text: contentText(m.content) || String(m.summary ?? m.output ?? ''),
    details: '',
    error: typeof m.errorMessage === 'string' ? m.errorMessage : m.isError ? 'Tool failed' : undefined,
  };
}

// One controller owns one pi session. Browser connections never own the agent.
export class Workspace {
  state: Snapshot = { messages: [], liveText: '', tools: {}, busy: false, available: true, model: '', models: [], modelSource: 'pi', modelChanging: false, notice: '', threadId: '', threads: [], threadChanging: false };
  private listeners = new Set<() => void>();
  private nextId = 0;
  private blocks = new Map<number, string>();
  private marker: string;
  private photos = new Map<string, Buffer>();
  photo(id: string) { return this.photos.get(id); }
  private unsubscribe: () => void;
  private stopping = false;
  private heartbeat?: ReturnType<typeof setInterval>;

  constructor(private agent: Agent, private stateDir: string, private selection: ModelSelection = { source: 'pi' }, private threads?: ThreadStore) {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    this.marker = join(stateDir, 'run-active');
    if (existsSync(this.marker)) this.state.notice = 'The previous run was interrupted. Inspect files before retrying; nothing was automatically resubmitted.';
    this.unsubscribe = agent.onEvent(event => {
      try { this.event(event); } catch { this.fail(); }
    });
  }

  async initialize() {
    // RPC returns full models; Pi 1.3's ModelInfo declaration omits input.
    this.state.models = (await this.agent.getAvailableModels()).map(model => ({ provider: model.provider, id: model.id, images: 'input' in model && Array.isArray(model.input) && model.input.includes('image') }));
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
    if (this.threads) {
      if (!state.sessionFile) throw new Error('Pi has no persistent session');
      this.threads.remember(state.sessionFile);
      this.state.threadId = this.threads.id(state.sessionFile);
      this.state.threads = await this.threads.list();
    }
    await this.loadHistory();
    this.heartbeat = setInterval(() => {
      void this.agent.getState().catch(() => this.fail());
    }, 5000);
    this.heartbeat.unref();
  }

  private async loadHistory() {
    // Follow the active branch, retaining pre-compaction messages for display.
    const { entries, leafId } = await this.agent.getEntries();
    const byId = new Map(entries.map(e => [e.id, e]));
    const branch = [];
    let cursor = leafId;
    const visited = new Set<string>();
    while (cursor) {
      if (visited.has(cursor)) throw new Error('Invalid cyclic session history');
      visited.add(cursor);
      const entry = byId.get(cursor);
      if (!entry) break;
      branch.push(entry);
      cursor = entry.parentId;
    }
    this.state.messages = [];
    this.photos.clear();
    this.state.liveText = '';
    this.state.tools = {};
    this.blocks.clear();
    for (const entry of branch.reverse()) {
      if (entry.type === 'message') this.append(entry.message);
    }
    this.interruptTools();
  }

  assertThread(id: unknown) {
    if (this.threads && id !== this.state.threadId) throw new Error('The active thread changed. Review the selected thread before retrying.');
  }

  async switchThread(targetId?: string) {
    if (!this.threads) throw new Error('Thread switching is unavailable');
    if (!this.state.available) throw new Error('Pi is unavailable');
    if (this.state.busy || this.stopping || this.state.modelChanging || this.state.threadChanging) throw new Error('Wait until the current operation finishes before switching threads');
    // Validate client filenames before issuing any RPC; never accept arbitrary paths.
    let target: string | undefined;
    try { target = targetId === undefined ? undefined : this.threads.path(targetId); }
    catch { throw new Error('Thread is unavailable'); }
    if (targetId === this.state.threadId) return;
    this.state.threadChanging = true;
    this.changed();
    try {
      target ??= this.threads.create();
      const result = await this.agent.switchSession(target);
      if (result.cancelled) throw new Error('Thread switch was cancelled');
      let state = await this.agent.getState();
      if (state.sessionFile !== target) throw new Error('Thread switch was not confirmed');
      // A saved/environment model is workspace-wide, not silently overridden by
      // the older model recorded inside a resumed session.
      if (this.selection.model) {
        const { provider, id } = this.selection.model;
        if (state.model?.provider !== provider || state.model?.id !== id) {
          await this.agent.setModel(provider, id);
          state = await this.agent.getState();
        }
        if (state.model?.provider !== provider || state.model?.id !== id) throw new Error('Model was not restored');
      }
      await this.loadHistory();
      const catalog = await this.threads.list();
      this.threads.remember(target);
      this.state.threadId = this.threads.id(target);
      this.state.threads = catalog;
      this.state.model = state.model ? `${state.model.provider}/${state.model.id}` : 'No model configured';
    } catch {
      this.fail();
      this.state.messages = [];
      this.state.liveText = '';
      this.state.tools = {};
      this.state.notice = 'Could not confirm and save the thread switch. Restart the service before sending another prompt.';
      throw new Error(this.state.notice);
    } finally { this.state.threadChanging = false; this.changed(); }
  }

  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private changed() { for (const listener of this.listeners) listener(); }
  private operation(id: string, name: string, args: unknown = {}): ToolOperation {
    const existing = this.state.messages.find(m => m.tool?.id === id)?.tool;
    if (existing) return existing;
    let budget = 48000;
    const bounded = (value: unknown, depth = 0): unknown => {
      if (budget <= 0) return '[display truncated]';
      if (typeof value === 'string') {
        const text = value.slice(0, Math.min(24000, budget));
        budget -= text.length;
        return text.length < value.length ? text + '\n[display truncated]' : text;
      }
      if (depth > 6) return '[display truncated]';
      if (Array.isArray(value)) return value.slice(0, 100).map(v => bounded(v, depth + 1));
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 100).map(([k, v]) => [k, bounded(v, depth + 1)]));
      return value;
    };
    const tool: ToolOperation = { id, name, args: bounded(args && typeof args === 'object' && !Array.isArray(args) ? args : {}) as Record<string, unknown>, output: '', status: 'pending' };
    this.state.messages = [...this.state.messages, { id: ++this.nextId, role: 'tool', text: '', details: '', tool }].slice(-200);
    return tool;
  }
  private interruptTools() {
    for (const message of this.state.messages) {
      if (message.tool && ['pending', 'running'].includes(message.tool.status)) {
        message.tool.status = 'interrupted';
        if (message.tool.startedAt) message.tool.endedAt = Date.now();
      }
    }
    this.state.tools = {};
  }
  private append(message: unknown) {
    const raw = message as { role?: string; toolCallId?: string; toolName?: string; isError?: boolean; content?: unknown };
    if (raw?.role === 'toolResult' && raw.toolCallId) {
      const tool = this.operation(raw.toolCallId, raw.toolName ?? 'Tool');
      tool.output = contentText(raw.content);
      tool.status = raw.isError ? 'failed' : 'succeeded';
      return;
    }
    const display = displayMessage(message, ++this.nextId);
    if (display) {
      const content = (message as { content?: unknown }).content;
      if (display.role === 'user' && Array.isArray(content)) {
        const photos: { id: string; url: string }[] = [];
        for (const block of content) {
          if (block.type !== 'image' || block.mimeType !== 'image/jpeg' || typeof block.data !== 'string' || block.data.length > 6 * 1024 * 1024) continue;
          const data = Buffer.from(block.data, 'base64');
          const id = photoId(data);
          this.photos.set(id, data);
          photos.push({ id, url: `/photos/${id}` });
        }
        if (photos.length) display.photos = photos;
      }
      if (display.text || display.photos?.length || display.error || display.role !== 'assistant') {
        this.state.messages = [...this.state.messages, display].slice(-200);
      }
      if (raw.role === 'assistant' && Array.isArray(raw.content)) {
        for (const block of raw.content) {
          if (block.type === 'toolCall') this.operation(block.id, block.name, block.arguments);
        }
      }
      const retained = new Set(this.state.messages.flatMap(m => m.photos?.map(p => p.id) ?? []));
      for (const id of this.photos.keys()) if (!retained.has(id)) this.photos.delete(id);
    }
  }
  private fail() {
    this.state.available = false;
    this.state.busy = false;
    this.interruptTools();
    this.state.notice = 'Pi is unavailable. The run may be interrupted; restart the service and inspect files before retrying.';
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.changed();
  }
  private event(event: JsonAgentSessionEvent) {
    if (this.state.threadChanging) return;
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
        if (event.message.role === 'user') {
          const title = contentText(event.message.content).replace(/\s+/g, ' ').slice(0, 100) || 'New thread';
          this.state.threads = this.state.threads.map(thread => thread.id !== this.state.threadId ? thread : {
            ...thread, updatedAt: new Date().toISOString(),
            title: thread.title === 'New thread' ? title : thread.title,
          });
        }
        this.append(event.message);
        if (event.message.role === 'assistant') { this.state.liveText = ''; this.blocks.clear(); }
        break;
      case 'tool_execution_start': {
        const tool = this.operation(event.toolCallId, event.toolName, event.args);
        tool.status = 'running';
        tool.startedAt = Date.now();
        this.state.tools[event.toolCallId] = tool;
        break;
      }
      case 'tool_execution_update': {
        const tool = this.state.tools[event.toolCallId];
        if (tool) tool.output = contentText(event.partialResult.content);
        break;
      }
      case 'tool_execution_end': {
        const tool = this.operation(event.toolCallId, event.toolName);
        tool.output = contentText(event.result.content);
        tool.status = event.isError ? 'failed' : 'succeeded';
        tool.endedAt = Date.now();
        delete this.state.tools[event.toolCallId];
        break;
      }
      case 'agent_settled':
        this.state.busy = false;
        this.state.liveText = '';
        this.blocks.clear();
        this.interruptTools();
        if (existsSync(this.marker)) unlinkSync(this.marker);
        break;
    }
    this.changed();
  }

  async setModel(provider: string, modelId: string) {
    if (!this.state.available) throw new Error('Pi is unavailable');
    if (this.state.modelSource === 'environment') throw new Error('Model is locked by AGENT_PROVIDER/AGENT_MODEL; remove the environment override to select it here');
    if (this.state.busy || this.stopping || this.state.modelChanging || this.state.threadChanging) throw new Error('Wait until the current operation finishes before switching models');
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
      this.selection = { source: 'saved', model: { provider, id: modelId } };
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

  async prompt(text: string, images: PhotoContent[] = []) {
    if (!this.state.available) throw new Error('Pi is unavailable');
    if (this.state.busy || this.stopping || this.state.modelChanging || this.state.threadChanging) throw new Error('A run, model change, or thread change is already active');
    if (images.length && !this.state.models.some(m => `${m.provider}/${m.id}` === this.state.model && m.images)) throw new Error('This model cannot accept photos. Choose an image-capable model.');
    // Slash commands / extensions need additional UI semantics; not exposed in v1.
    if (text.trimStart().startsWith('/')) throw new Error('Slash commands are not supported in this first version');
    writeFileSync(this.marker, new Date().toISOString(), { mode: 0o600 });
    this.state.busy = true;
    this.state.notice = '';
    this.changed();
    try { await this.agent.prompt(text, images.length ? images : undefined); }
    catch {
      // A timeout can mean pi accepted the prompt: fail closed, never auto-resend.
      this.fail();
      throw new Error('Prompt status is uncertain. Reconnect or restart, inspect history, and do not blindly resend.');
    }
  }

  async abort() {
    if (this.stopping) throw new Error('Stop is already pending');
    if (this.state.threadChanging || this.state.modelChanging) throw new Error('Wait until switching finishes');
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
