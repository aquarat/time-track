import { useCallback, useEffect, useRef, useState } from 'react';
import type { Client, Entry } from '../../shared/types';
import { formatClock, formatCompact, formatLongDate, fromZonedParts, toZonedParts } from '../../shared/time';

interface Props {
  entry: Entry;
  clients: Client[];
  tz: string;
  now: number;
  /** Persist the edit. Rejecting leaves the modal open with the error shown. */
  onSave: (patch: {
    clientId: string;
    description: string;
    startedAt: number;
    endedAt: number | null;
  }) => Promise<void>;
  /** Called once the modal is finished with, whether or not anything was saved. */
  onClose: (saved: boolean) => void;
}

/**
 * Editor for a single entry, opened by clicking it in the calendar.
 *
 * Dismissing without pressing Save commits the edit rather than discarding it —
 * losing a correction because the backdrop was clicked is the worse failure. The
 * one exception is invalid input: that keeps the modal open with the error
 * visible, since neither saving nor silently dropping it would be right.
 */
export function EntryModal({ entry, clients, tz, now, onSave, onClose }: Props) {
  const running = entry.endedAt === null;

  const [description, setDescription] = useState(entry.description);
  const [clientId, setClientId] = useState(entry.clientId);
  const [startText, setStartText] = useState(() => formatClock(entry.startedAt, tz));
  const [endText, setEndText] = useState(() => (running ? '' : formatClock(entry.endedAt as number, tz)));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const dialogRef = useRef<HTMLDivElement>(null);
  // Guards against the auto-save firing twice if a dismiss races the Save button.
  const closing = useRef(false);

  const parse = useCallback((): {
    clientId: string;
    description: string;
    startedAt: number;
    endedAt: number | null;
  } => {
    const startedAt = applyClock(entry.startedAt, startText, tz);
    if (startedAt === null) throw new Error('Start time must look like 09:30');

    if (running) return { clientId, description, startedAt, endedAt: null };

    let endedAt = applyClock(entry.endedAt as number, endText, tz);
    if (endedAt === null) throw new Error('End time must look like 17:00');
    // An end before the start almost always means the work ran past midnight.
    if (endedAt < startedAt) endedAt += 24 * 3600_000;
    return { clientId, description, startedAt, endedAt };
  }, [clientId, description, endText, entry.endedAt, entry.startedAt, running, startText, tz]);

  const isDirty = useCallback((): boolean => {
    try {
      const next = parse();
      return (
        next.clientId !== entry.clientId ||
        next.description !== entry.description ||
        next.startedAt !== entry.startedAt ||
        next.endedAt !== entry.endedAt
      );
    } catch {
      // Unparseable input counts as dirty so dismissal surfaces the error.
      return true;
    }
  }, [entry.clientId, entry.description, entry.endedAt, entry.startedAt, parse]);

  const commit = useCallback(
    async (viaDismiss: boolean) => {
      if (closing.current) return;

      if (!isDirty()) {
        closing.current = true;
        onClose(false);
        return;
      }

      let patch;
      try {
        patch = parse();
      } catch (e) {
        setError((e as Error).message);
        return; // Stay open; nothing is discarded.
      }

      setBusy(true);
      try {
        await onSave(patch);
        closing.current = true;
        onClose(viaDismiss);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [isDirty, onClose, onSave, parse],
  );

  // Escape dismisses, which auto-saves like any other dismissal.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        void commit(true);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [commit]);

  useEffect(() => {
    dialogRef.current?.querySelector('input')?.focus();
  }, []);

  const preview = (() => {
    try {
      const p = parse();
      const end = p.endedAt ?? now;
      return `${formatCompact(Math.max(0, (end - p.startedAt) / 1000))}`;
    } catch {
      return '—';
    }
  })();

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        // Only a press that both starts and ends on the backdrop counts, so a
        // drag that finishes outside the dialog does not dismiss it.
        if (event.target === event.currentTarget) void commit(true);
      }}
    >
      <div
        className="modal"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Edit time entry"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="modal-head">
          <h2>Edit entry</h2>
          <span className="modal-date">{formatLongDate(entry.startedAt, tz)}</span>
        </header>

        {clients.length > 1 && (
          <label className="modal-field">
            <span>Client</span>
            <select
              value={clientId}
              onChange={(e) => {
                setClientId(e.target.value);
                setError(null);
              }}
            >
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
        )}

        <label className="modal-field">
          <span>Description</span>
          <input
            type="text"
            value={description}
            onChange={(e) => {
              setDescription(e.target.value);
              setError(null);
            }}
            placeholder="No description"
            onKeyDown={(e) => {
              if (e.key === 'Enter') void commit(false);
            }}
          />
        </label>

        <div className="modal-times">
          <label className="modal-field">
            <span>Start</span>
            <input
              type="text"
              value={startText}
              onChange={(e) => {
                setStartText(e.target.value);
                setError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void commit(false);
              }}
            />
          </label>
          <label className="modal-field">
            <span>End</span>
            <input
              type="text"
              value={endText}
              disabled={running}
              placeholder={running ? 'running' : ''}
              onChange={(e) => {
                setEndText(e.target.value);
                setError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void commit(false);
              }}
            />
          </label>
          <div className="modal-field duration">
            <span>Duration</span>
            <div className="modal-duration">{preview}</div>
          </div>
        </div>

        {error && <div className="modal-error">{error}</div>}

        <footer className="modal-foot">
          <span className="modal-hint">Closing this saves your changes.</span>
          <button type="button" className="primary" onClick={() => void commit(false)} disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </footer>
      </div>
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
