export interface Takeover {
  id: string; threadId: string; ownerSlot: string; requesterSlot: string; requesterUrl?: string; deadline: number;
  status: 'pending' | 'expired' | 'approved' | 'stopping' | 'released' | 'completed' | 'rejected' | 'cancelled' | 'failed';
}
export interface ResponseImage { id: string; url: string; description?: string }
export interface ToolOperation {
  images?: ResponseImage[];
  id: string;
  name: string;
  args: Record<string, unknown>;
  output: string;
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'interrupted';
  startedAt?: number;
  endedAt?: number;
}
export interface ChatMessage {
  images?: ResponseImage[];
  tool?: ToolOperation;
  id: number;
  role: string;
  text: string;
  details: string;
  error?: string;
  photos?: { id: string; url: string }[];
}
export interface ThreadChoice { id: string; title: string; updatedAt: string; busy?: boolean }
export interface ModelChoice { provider: string; id: string; images?: boolean }
export type ModelSource = 'environment' | 'saved' | 'pi';
export interface Snapshot {
  movedTo?: { slot: string; url?: string };
  backgroundRun?: { id: string; stopping: boolean };
  promptExamples?: string[];
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
  // Empty threadId explicitly selects the chooser; omitted retains legacy default selection.
  | { type: 'auth'; token?: string; threadId?: string }
  | { type: 'prompt'; id: string; text: string; threadId: string; photos?: string[]; clientContext?: import('./client-context.js').ClientContext }
  | { type: 'stop'; id: string; threadId: string }
  | { type: 'set_model'; id: string; provider: string; modelId: string; threadId: string }
  | { type: 'new_thread'; id: string; threadId: string }
  | { type: 'release_thread'; id: string; threadId: string }
  | { type: 'takeover_request'; id: string; targetId: string }
  | { type: 'takeover_open'; id: string; targetId: string; requestId: string }
  | { type: 'takeover_decide'; id: string; targetId: string; requestId: string; decision: 'allow' | 'keep' | 'force' | 'cancel' }
  | { type: 'delete_thread'; id: string; threadId: string; targetId: string }
  | { type: 'switch_thread'; id: string; threadId: string; targetId: string };
export type TerminalEvent =
  | { type: 'terminal_ready' }
  | { type: 'terminal_data'; data: string }
  | { type: 'terminal_exit'; code: number };
export type ServerMessage =
  | TerminalEvent
  | { type: 'threads'; threads: ThreadChoice[] }
  | { type: 'snapshot'; state: Snapshot; selected?: boolean }
  | { type: 'ack'; id: string }
  | { type: 'takeovers'; incoming: Takeover[]; outgoing?: Takeover }
  | { type: 'error'; id?: string; message: string; lockedThreadId?: string };
