import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

// Offline RPC fixture: checks the actual extension loader, not a mocked factory.
export default function presenceProbe(pi: ExtensionAPI) {
  pi.registerCommand('presence-probe', {
    description: 'Test-only presence tool discovery',
    handler: async (_args, ctx) => {
      writeFileSync(join(ctx.cwd, 'presence-probe.json'), JSON.stringify({ registered: pi.getAllTools().some(tool => tool.name === 'agent_presence') }));
    },
  });
}
