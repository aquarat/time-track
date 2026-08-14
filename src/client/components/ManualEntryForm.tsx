import { useState } from 'react';
import { fromZonedParts } from '../../shared/time';
import { api } from '../api';

interface Props {
  tz: string;
  /** "YYYY-MM-DD" the form opens on. */
  defaultDate: string;
  onCreated: () => Promise<void> | void;
}

/** Log a block of time after the fact, for the timer you forgot to start. */
export function ManualEntryForm({ tz, defaultDate, onCreated }: Props) {
  const [description, setDescription] = useState('');
  const [date, setDate] = useState(defaultDate);
  const [start, setStart] = useState('09:00');
  const [end, setEnd] = useState('17:00');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    const startedAt = parse(date, start, tz);
    const endedAtRaw = parse(date, end, tz);
    if (startedAt === null || endedAtRaw === null) {
      setError('Use a valid date and HH:MM times');
      return;
    }
    // An end before the start reads as an overnight block.
    const endedAt = endedAtRaw < startedAt ? endedAtRaw + 24 * 3600_000 : endedAtRaw;

    setBusy(true);
    try {
      await api.createEntry({ description, startedAt, endedAt });
      setDescription('');
      await onCreated();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="manual-form" onSubmit={submit}>
      <input
        className="entry-desc-input"
        placeholder="What did you work on?"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
      />
      <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      <input className="time-input" value={start} onChange={(e) => setStart(e.target.value)} aria-label="Start" />
      <span className="dash">–</span>
      <input className="time-input" value={end} onChange={(e) => setEnd(e.target.value)} aria-label="End" />
      <button type="submit" className="primary" disabled={busy}>
        Add
      </button>
      {error && <span className="inline-error">{error}</span>}
    </form>
  );
}

function parse(date: string, time: string, tz: string): number | null {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim());
  const t = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!d || !t) return null;
  const hour = Number(t[1]);
  const minute = Number(t[2]);
  if (hour > 23 || minute > 59) return null;
  return fromZonedParts(Number(d[1]), Number(d[2]), Number(d[3]), hour, minute, 0, tz);
}
