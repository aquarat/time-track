import { useState } from 'react';
import type { Entry } from '../../shared/types';
import { formatClock, formatCompact, fromZonedParts, toZonedParts } from '../../shared/time';
import { api } from '../api';
import { PencilIcon, PlayIcon, TrashIcon } from './Icons';

interface Props {
  entry: Entry;
  tz: string;
  now: number;
  onResume: (description: string) => void;
  onChanged: () => Promise<void> | void;
}

export function EntryRow({ entry, tz, now, onResume, onChanged }: Props) {
  const [editing, setEditing] = useState(false);
  const [description, setDescription] = useState(entry.description);
  const [startText, setStartText] = useState(() => formatClock(entry.startedAt, tz));
  const [endText, setEndText] = useState(() =>
    entry.endedAt === null ? '' : formatClock(entry.endedAt, tz),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const running = entry.endedAt === null;
  const seconds = ((entry.endedAt ?? now) - entry.startedAt) / 1000;

  const openEditor = () => {
    setDescription(entry.description);
    setStartText(formatClock(entry.startedAt, tz));
    setEndText(entry.endedAt === null ? '' : formatClock(entry.endedAt, tz));
    setError(null);
    setEditing(true);
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const startedAt = applyClock(entry.startedAt, startText, tz);
      if (startedAt === null) throw new Error('Start time must look like 09:30');

      let endedAt: number | null = entry.endedAt;
      if (!running) {
        // The end time is written onto the day the entry *ended*, so an overnight
        // session keeps its shape rather than collapsing to a negative duration.
        endedAt = applyClock(entry.endedAt as number, endText, tz);
        if (endedAt === null) throw new Error('End time must look like 17:00');
        // A stop time earlier than the start almost always means it rolled past
        // midnight; nudge it to the following day rather than rejecting it.
        if (endedAt < startedAt) endedAt += 24 * 3600_000;
      }

      await api.updateEntry(entry.id, { description, startedAt, endedAt });
      setEditing(false);
      await onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!window.confirm(`Delete "${entry.description || 'this entry'}"?`)) return;
    setBusy(true);
    try {
      await api.deleteEntry(entry.id);
      await onChanged();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  if (editing) {
    return (
      <div className="entry-row editing">
        <input
          className="entry-desc-input"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Description"
          autoFocus
          onKeyDown={(e) => {
            if (e.key === 'Enter') void save();
            if (e.key === 'Escape') setEditing(false);
          }}
        />
        <input
          className="time-input"
          value={startText}
          onChange={(e) => setStartText(e.target.value)}
          aria-label="Start time"
        />
        <span className="dash">–</span>
        <input
          className="time-input"
          value={endText}
          onChange={(e) => setEndText(e.target.value)}
          disabled={running}
          placeholder={running ? 'running' : ''}
          aria-label="End time"
        />
        <button type="button" className="primary" onClick={() => void save()} disabled={busy}>
          Save
        </button>
        <button type="button" onClick={() => setEditing(false)} disabled={busy}>
          Cancel
        </button>
        {error && <span className="inline-error">{error}</span>}
      </div>
    );
  }

  return (
    <div className={`entry-row${running ? ' running' : ''}`}>
      <button type="button" className="entry-desc" onClick={openEditor} title="Edit this entry">
        {entry.description || <span className="muted">No description</span>}
      </button>
      <span className="entry-times">
        {formatClock(entry.startedAt, tz)}–{running ? 'now' : formatClock(entry.endedAt as number, tz)}
      </span>
      <span className="entry-duration">{formatCompact(seconds)}</span>
      <div className="entry-actions">
        <button
          type="button"
          title="Start a new timer with this description"
          onClick={() => onResume(entry.description)}
          disabled={busy}
          aria-label="Resume this task"
        >
          <PlayIcon size={15} />
        </button>
        <button type="button" title="Edit" onClick={openEditor} disabled={busy} aria-label="Edit entry">
          <PencilIcon size={15} />
        </button>
        <button
          type="button"
          title="Delete"
          onClick={() => void remove()}
          disabled={busy}
          aria-label="Delete entry"
        >
          <TrashIcon size={15} />
        </button>
      </div>
      {error && <span className="inline-error">{error}</span>}
    </div>
  );
}

/**
 * Replace the wall-clock time of an instant while keeping its calendar date,
 * as observed in `tz`. Returns null when the text is not "HH:MM".
 */
function applyClock(instant: number, text: string, tz: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) return null;
  const p = toZonedParts(instant, tz);
  return fromZonedParts(p.year, p.month, p.day, hour, minute, 0, tz);
}
