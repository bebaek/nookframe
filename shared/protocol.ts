export interface ToolOperation {
  id: string;
  name: string;
  args: Record<string, unknown>;
  output: string;
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'interrupted';
  startedAt?: number;
  endedAt?: number;
}
export interface ChatMessage {
  tool?: ToolOperation;
  id: number;
  role: string;
  text: string;
  details: string;
  error?: string;
  photos?: { id: string; url: string }[];
}
export interface ThreadChoice { id: string; title: string; updatedAt: string }
export interface ModelChoice { provider: string; id: string; images?: boolean }
export type ModelSource = 'environment' | 'saved' | 'pi';
export interface Snapshot {
  messages: ChatMessage[];
  liveText: string;
  tools: Record<string, ToolOperation>;
  busy: boolean;
  available: boolean;
  model: string;
  models: ModelChoice[];
  modelSource: ModelSource;
  modelChanging: boolean;
  notice: string;
  threadId: string;
  threads: ThreadChoice[];
  threadChanging: boolean;
}
export type ClientCommand =
  | { type: 'auth'; token: string }
  | { type: 'prompt'; id: string; text: string; threadId: string; photos?: string[] }
  | { type: 'stop'; id: string; threadId: string }
  | { type: 'set_model'; id: string; provider: string; modelId: string; threadId: string }
  | { type: 'new_thread'; id: string; threadId: string }
  | { type: 'switch_thread'; id: string; threadId: string; targetId: string };
export type TerminalEvent =
  | { type: 'terminal_ready' }
  | { type: 'terminal_data'; data: string }
  | { type: 'terminal_exit'; code: number };
export type ServerMessage =
  | TerminalEvent
  | { type: 'snapshot'; state: Snapshot }
  | { type: 'ack'; id: string }
  | { type: 'error'; id?: string; message: string };
