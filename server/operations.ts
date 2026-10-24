import type { ModelSelection } from './models.js';

/** Allowlisted server facts only: never return environment, paths, prompts or logs. */
export interface OperationsReader {
  status(): unknown;
  config(): unknown;
  sessions(): unknown;
}

export function explainModel(selection: ModelSelection) {
  return {
    selection: selection.model ?? null,
    source: selection.source,
    environmentLocked: selection.source === 'environment',
    precedence: ['environment', 'saved', 'pi'],
    scope: 'instance-default',
    note: 'Existing threads may have their own saved model. Running agents are not changed by reading configuration.',
  };
}
