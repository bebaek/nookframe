import { readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ModelChoice, ModelSource } from '../shared/protocol.js';

export interface ModelSelection { model?: ModelChoice; source: ModelSource }
function readJson(path: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an object');
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new Error(`Cannot read model configuration: ${path}`);
  }
}
function choice(provider: unknown, id: unknown): ModelChoice {
  if (typeof provider !== 'string' || !provider.trim() || typeof id !== 'string' || !id.trim()) {
    throw new Error('Model selection requires both a provider and an exact model ID');
  }
  return { provider, id };
}
export function resolveModelSelection(stateDir: string, agentDir: string, env: NodeJS.ProcessEnv): ModelSelection {
  if (env.AGENT_PROVIDER || env.AGENT_MODEL) {
    return { model: choice(env.AGENT_PROVIDER, env.AGENT_MODEL), source: 'environment' };
  }
  const saved = readJson(join(stateDir, 'model.json'));
  if (saved) return { model: choice(saved.provider, saved.id), source: 'saved' };
  const settings = readJson(join(agentDir, 'settings.json'));
  if (settings?.defaultProvider && settings?.defaultModel) {
    return { model: choice(settings.defaultProvider, settings.defaultModel), source: 'pi' };
  }
  return { source: 'pi' };
}
export function saveModelSelection(stateDir: string, model: ModelChoice) {
  const path = join(stateDir, 'model.json');
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(model) + '\n', { mode: 0o600, flag: 'wx' });
    renameSync(temporary, path);
  } finally { rmSync(temporary, { force: true }); }
}
