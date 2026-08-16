import { useState } from 'react';
import type { Roster } from '../core/types';
import { AutoPlayer } from './autoplayer/AutoPlayer';
import { ListBuilder } from './listbuilder/ListBuilder';
import { MeasuringBoard } from './MeasuringBoard';

type View = 'builder' | 'board' | 'autoplayer';

export function App() {
  const [view, setView] = useState<View>('builder');
  // A list built this session, handed to the board via "Open in board".
  const [builtRoster, setBuiltRoster] = useState<Roster | null>(null);

  return (
    <div className="app">
      <header className="topnav">
        <span className="brand">⚙ 40k Battle Simulator</span>
        <nav>
          <button className={view === 'builder' ? 'on' : ''} onClick={() => setView('builder')}>
            List Builder
          </button>
          <button className={view === 'board' ? 'on' : ''} onClick={() => setView('board')}>
            Measuring Board
          </button>
          <button
            className={view === 'autoplayer' ? 'on' : ''}
            onClick={() => setView('autoplayer')}
            title="v2 simulator: configure runs, read results, replay battles"
          >
            Auto Player
          </button>
        </nav>
      </header>

      {view === 'autoplayer' ? (
        <AutoPlayer />
      ) : view === 'builder' ? (
        <ListBuilder
          onOpenInBoard={(roster) => {
            setBuiltRoster(roster);
            setView('board');
          }}
        />
      ) : (
        <MeasuringBoard
          extraRosters={builtRoster ? [builtRoster] : []}
          initialRosterName={builtRoster?.name}
        />
      )}
    </div>
  );
}
