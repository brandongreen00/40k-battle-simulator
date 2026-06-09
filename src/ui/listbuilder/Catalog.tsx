import { useMemo, useState } from 'react';
import type { Datasheet } from '../../core/types';
import { datasheets } from '../../data/loaders';

interface Props {
  faction: string;
  onAdd: (ds: Datasheet) => void;
}

const ROLE_ORDER = ['Characters', 'Battleline', 'Dedicated Transports', 'Other', 'Fortifications'];

function cheapest(ds: Datasheet): number | undefined {
  if (!ds.points || ds.points.length === 0) return undefined;
  return Math.min(...ds.points.map((t) => t.cost));
}

/** Browsable, searchable list of a faction's datasheets, grouped by role. */
export function Catalog({ faction, onAdd }: Props) {
  const [query, setQuery] = useState('');

  const grouped = useMemo(() => {
    const q = query.trim().toLowerCase();
    const pool = datasheets
      .filter((d) => d.faction === faction)
      .filter((d) => (q ? d.name.toLowerCase().includes(q) : true));
    const byRole = new Map<string, Datasheet[]>();
    for (const d of pool) {
      const role = d.role && d.role.trim() ? d.role : 'Other';
      (byRole.get(role) ?? byRole.set(role, []).get(role)!).push(d);
    }
    const roles = [...byRole.keys()].sort(
      (a, b) => (ROLE_ORDER.indexOf(a) + 1 || 99) - (ROLE_ORDER.indexOf(b) + 1 || 99) || a.localeCompare(b),
    );
    return roles.map((role) => ({
      role,
      units: byRole.get(role)!.sort((a, b) => a.name.localeCompare(b.name)),
    }));
  }, [faction, query]);

  return (
    <div className="catalog">
      <div className="catalog-head">
        <h2>Datasheets</h2>
        <input
          className="search"
          placeholder="Search units…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div className="catalog-body">
        {grouped.map(({ role, units }) => (
          <div key={role} className="catalog-group">
            <div className="catalog-role">{role}</div>
            {units.map((d) => {
              const from = cheapest(d);
              return (
                <button key={d.id} className="catalog-item" onClick={() => onAdd(d)} title="Add to list">
                  <span className="ci-add">+</span>
                  <span className="ci-name">{d.name}</span>
                  <span className="ci-pts">{from != null ? `${from} pts` : '—'}</span>
                </button>
              );
            })}
          </div>
        ))}
        {grouped.length === 0 && <p className="muted">No matching units.</p>}
      </div>
    </div>
  );
}
