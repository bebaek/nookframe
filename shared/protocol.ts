export interface ChatMessage {
  id: number;
  role: string;
  text: string;
  details: string;
  error?: string;
}
export interface ModelChoice { provider: string; id: string }
export type ModelSource = 'environment' | 'saved' | 'pi';
export interface Snapshot {
  messages: ChatMessage[];
  liveText: string;
  tools: Record<string, { name: string; output: string }>;
  busy: boolean;
  available: boolean;
  model: string;
  models: ModelChoice[];
  modelSource: ModelSource;
  modelChanging: boolean;
  notice: string;
}
export type ClientCommand =
  | { type: 'auth'; token: string }
  | { type: 'prompt'; id: string; text: string }
  | { type: 'stop'; id: string }
  | { type: 'set_model'; id: string; provider: string; modelId: string };
export type ServerMessage =
  | { type: 'snapshot'; state: Snapshot }
  | { type: 'ack'; id: string }
  | { type: 'error'; id?: string; message: string };
