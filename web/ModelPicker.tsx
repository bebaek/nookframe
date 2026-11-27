import { useState } from 'react';
import type { ModelChoice } from '../shared/protocol';

export function ModelPicker({ model, models, native, disabled, apply }: {
  model: string; models: ModelChoice[]; native: boolean; disabled: boolean;
  apply: (choice: ModelChoice, makeDefault: boolean) => void;
}) {
  const [draft, setDraft] = useState(model);
  const [makeDefault, setMakeDefault] = useState(false);
  const value = native ? draft : model;
  const key = (m: ModelChoice) => `${m.provider}/${m.id}`;
  const choice = models.find(m => key(m) === value);
  return <><select id="model" value={value} disabled={disabled} onChange={e => {
    if (native) setDraft(e.target.value);
    else { const next = models.find(m => key(m) === e.target.value); if (next) apply(next, false); }
  }}>
    {!models.some(m => key(m) === model) && <option value={model}>{model}</option>}
    {models.map(m => <option key={key(m)} value={key(m)}>{key(m)}</option>)}
  </select>{native && <div className="pi-default-controls">
    <label><input type="checkbox" checked={makeDefault} disabled={disabled} onChange={e => setMakeDefault(e.target.checked)} /> Also set as Pi default for new chats</label>
    <button type="button" disabled={disabled || !choice || (value === model && !makeDefault)} onClick={() => {
      if (choice) { apply(choice, makeDefault); setMakeDefault(false); }
    }}>Apply</button>
  </div>}</>;
}
