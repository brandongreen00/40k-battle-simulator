import { useState } from 'react';
import type { Datasheet, Enhancement } from '../../core/types';
import { parseArmyText } from '../../core/importer';
import type { ArmyList } from '../../core/army';

interface Props {
  datasheets: Datasheet[];
  enhancements: Enhancement[];
  onImport: (list: ArmyList) => void;
}

/** Paste-the-app-export importer. Parses the text into a list and surfaces any warnings. */
export function ImportPanel({ datasheets, enhancements, onImport }: Props) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [warnings, setWarnings] = useState<string[] | null>(null);

  function doImport() {
    const { list, warnings } = parseArmyText(text, { datasheets, enhancements });
    setWarnings(warnings);
    if (list.units.length > 0) onImport(list);
  }

  return (
    <section className="actions">
      <h2>
        <button className="link" onClick={() => setOpen((o) => !o)}>
          {open ? '▾' : '▸'} Import from app export
        </button>
      </h2>
      {open && (
        <div className="import-panel">
          <p className="muted">
            Paste the text from the Warhammer 40,000 app's team builder (Share → Text). Units,
            model counts, wargear, Warlord and enhancements are parsed automatically.
          </p>
          <textarea
            className="import-text"
            rows={8}
            placeholder={"Rogue Trader's Army (985 Points)\n\nImperial Agents\nImperialis Fleet\nIncursion (1,000 Points)\n…"}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <div className="btn-row">
            <button className="primary" onClick={doImport} disabled={!text.trim()}>
              Import list
            </button>
            <button onClick={() => { setText(''); setWarnings(null); }}>Clear</button>
          </div>
          {warnings && warnings.length === 0 && <p className="ok">✓ Imported with no warnings.</p>}
          {warnings?.map((w, i) => (
            <p key={i} className="v-warn">
              ⚠ {w}
            </p>
          ))}
        </div>
      )}
    </section>
  );
}
