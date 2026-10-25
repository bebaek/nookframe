import { SessionManager } from '@earendil-works/pi-coding-agent';

// Let Pi persist fixture conversations, just as it does in production.
export function persistSession(file: string, cwd: string, text = 'Saved conversation') {
  const manager = SessionManager.open(file, undefined, cwd);
  manager.appendMessage({ role: 'user', content: text, timestamp: Date.now() });
  manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'Saved answer' }],
    api: 'openai-completions', provider: 'test', model: 'first', stopReason: 'stop', timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  return manager;
}
