import { useEffect, useState } from 'react';
import type { ToolOperation } from '../shared/protocol';
import { ResponseImages } from './MessageContent';

function preview(tool: ToolOperation): string {
  const a = tool.args ?? {};
  if (tool.name === 'edit') {
    const edits = Array.isArray(a.edits) ? a.edits : [a];
    return edits.map(edit => {
      if (!edit || typeof edit !== 'object') return '';
      const e = edit as Record<string, unknown>;
      return [typeof e.oldText === 'string' ? e.oldText.split('\n').map(l => `- ${l}`).join('\n') : '',
        typeof e.newText === 'string' ? e.newText.split('\n').map(l => `+ ${l}`).join('\n') : ''].filter(Boolean).join('\n');
    }).join('\n⋯\n');
  }
  if (tool.name === 'write' && typeof a.content === 'string') return a.content;
  return tool.output || JSON.stringify(a, null, 2);
}

export function ToolCard({ tool }: { tool: ToolOperation }) {
  const [expanded, setExpanded] = useState(false);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (tool.status === 'failed') setExpanded(true);
  }, [tool.status]);
  useEffect(() => {
    if (tool.status !== 'running') return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [tool.status]);
  const a = tool.args ?? {};
  const path = typeof a.path === 'string' ? a.path : typeof a.file_path === 'string' ? a.file_path : '';
  const command = typeof a.command === 'string' ? a.command : '';
  const title = tool.name === 'bash' && command ? `$ ${command}` : `${tool.name.charAt(0).toUpperCase()}${tool.name.slice(1)}${path ? ` ${path}` : ''}`;
  const text = preview(tool);
  const lines = text.split('\n');
  const tail = tool.name === 'bash' && !!tool.output;
  const shown = expanded ? lines : tail ? lines.slice(-8) : lines.slice(0, 8);
  const elapsed = tool.startedAt ? Math.max(0, ((tool.endedAt ?? now) - tool.startedAt) / 1000).toFixed(1) : undefined;
  const symbol = { pending: '○', running: '◌', succeeded: '✓', failed: '✕', interrupted: '!' }[tool.status];
  return <article className={`message tool-card tool-${tool.status}`} aria-label={`${tool.name} ${tool.status}`}>
    <div className="tool-heading"><span aria-hidden="true">{symbol}</span><strong>{title}</strong><span className="tool-status">{tool.status}{elapsed !== undefined ? ` · ${elapsed}s` : ''}</span></div>
    {tool.name === 'read' && (a.offset !== undefined || a.limit !== undefined) && <small>From line {String(a.offset ?? 1)}{a.limit !== undefined ? ` · up to ${String(a.limit)} lines` : ''}</small>}
    {tool.name === 'edit' && <small>{tool.status === 'succeeded' ? 'Applied replacements' : 'Requested replacements (not confirmed applied)'}</small>}
    {tool.name === 'write' && <small>{tool.status === 'succeeded' ? 'Written content' : 'Requested content (not confirmed written)'}</small>}
    {text && <pre className="tool-preview">{shown.map((line, i) => <span key={i} className={tool.name === 'edit' ? line.startsWith('+ ') ? 'diff-add' : line.startsWith('- ') ? 'diff-remove' : undefined : undefined}>{line}{'\n'}</span>)}</pre>}
    {lines.length > 8 && <button type="button" className="secondary tool-expand" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? 'Show less' : `Show all ${lines.length} lines`}</button>}
    {(tool.name === 'edit' || tool.name === 'write') && tool.output && <details open={tool.status === 'failed' || undefined}><summary>Result</summary><pre>{tool.output}</pre></details>}
    <ResponseImages images={tool.images} />
    <details><summary>Arguments</summary><pre>{JSON.stringify(a, null, 2)}</pre></details>
  </article>;
}
