import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Entry, Settings } from '../../shared/types';
import {
  MONTH_NAMES,
  addDaysUtc,
  dateKey,
  formatClock,
  formatCompact,
  formatDuration,
  fromZonedParts,
  startOfDay,
  startOfMonth,
  startOfWeek,
  toZonedParts,
} from '../../shared/time';
import { api } from '../api';
import { EntryRow } from '../components/EntryRow';
import { Timeline } from '../components/Timeline';
import { ManualEntryForm } from '../components/ManualEntryForm';
import { EntryModal } from '../components/EntryModal';
import { Toast } from '../components/Toast';
import { applyTimerFavicon } from '../favicon';

type View = 'day' | 'week' | 'month';

interface Props {
  settings: Settings;
}

export function TimerPage({ settings }: Props) {
  const tz = settings.timezone;

  const [description, setDescription] = useState('');
  const [running, setRunning] = useState<Entry | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [view, setView] = useState<View>('day');
  const [anchor, setAnchor] = useState<number>(() => Date.now());
  const [tick, setTick] = useState(() => Date.now());
  const [error, setError] = useState<string | null>(null);
  const [showManual, setShowManual] = useState(false);
  const [editing, setEditing] = useState<Entry | null>(null);
  // Carries an id so re-showing the same message remounts the toast and restarts
  // its timer, rather than reusing a component that is already fading.
  const [toast, setToast] = useState<{ id: number; message: string } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Which entry the box is currently showing, so a background refresh of the
  // same entry never overwrites what is being typed.
  const shownEntryId = useRef<string | null>(null);

  // One second is the coarsest interval that still makes the running clock look live.
  useEffect(() => {
    const id = window.setInterval(() => setTick(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  // While a timer runs the box *is* that entry's description; otherwise it is the
  // draft for the next one. Only a change of entry resets it.
  useEffect(() => {
    const id = running?.id ?? null;
    if (id !== shownEntryId.current) {
      shownEntryId.current = id;
      setDescription(running?.description ?? '');
    }
  }, [running]);

  // Start/stop happens here, so update the tab icon without waiting for the poll.
  useEffect(() => {
    applyTimerFavicon(running !== null);
  }, [running]);

  const range = useMemo(() => rangeFor(view, anchor, tz), [view, anchor, tz]);

  const reload = useCallback(async () => {
    try {
      const [state, page] = await Promise.all([api.state(), api.entries(range.from, range.to)]);
      setRunning(state.running);
      setEntries(page.entries);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [range.from, range.to]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Refresh when the tab regains focus — the timer may have been left running
  // on another device, or simply overnight.
  useEffect(() => {
    const onFocus = () => void reload();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [reload]);

  /** Write the box back to the running entry, if it has drifted from it. */
  const flushDescription = useCallback(async () => {
    if (!running || description === running.description) return;
    try {
      await api.updateEntry(running.id, { description });
      await reload();
    } catch (e) {
      setError((e as Error).message);
    }
  }, [description, reload, running]);

  // Save shortly after typing stops rather than per keystroke. Blur, Enter and
  // stopping the timer all flush immediately, so nothing depends on this firing.
  useEffect(() => {
    if (!running || description === running.description) return;
    const id = window.setTimeout(() => void flushDescription(), 700);
    return () => window.clearTimeout(id);
  }, [description, flushDescription, running]);

  const start = useCallback(async () => {
    try {
      const { entry } = await api.startTimer(description);
      setRunning(entry);
      await reload();
    } catch (e) {
      setError((e as Error).message);
    }
  }, [description, reload]);

  const stop = useCallback(async () => {
    try {
      // Commit a half-typed correction before the entry stops being "running".
      await flushDescription();
      await api.stopTimer();
      setRunning(null);
      await reload();
    } catch (e) {
      setError((e as Error).message);
    }
  }, [flushDescription, reload]);

  const toggle = useCallback(() => (running ? void stop() : void start()), [running, start, stop]);

  const resume = useCallback(
    async (text: string) => {
      try {
        const { entry } = await api.startTimer(text);
        setRunning(entry);
        setAnchor(Date.now());
        setView('day');
        await reload();
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [reload],
  );

  const saveEntry = useCallback(
    async (id: string, patch: { description?: string; startedAt?: number; endedAt?: number | null }) => {
      await api.updateEntry(id, patch);
      await reload();
    },
    [reload],
  );

  const resizeEntry = useCallback(
    async (entry: Entry, startedAt: number, endedAt: number) => {
      try {
        await saveEntry(entry.id, { startedAt, endedAt });
      } catch (e) {
        setError((e as Error).message);
        // Drop the optimistic position the drag left behind.
        await reload();
      }
    },
    [reload, saveEntry],
  );

  const dismissToast = useCallback(() => setToast(null), []);

  const days = useMemo(() => groupByDay(entries, range, tz, tick), [entries, range, tz, tick]);
  // The timeline shows every day in the range, including the empty ones — a week
  // with nothing logged on Thursday should show an empty Thursday, not omit it.
  const columns = useMemo(
    () => (view === 'month' ? days : fillDays(days, range, tz)),
    [days, range, tz, view],
  );
  const rangeSeconds = useMemo(
    () => days.reduce((sum, d) => sum + d.seconds, 0),
    [days],
  );
  const runningSeconds = running ? Math.max(0, (tick - running.startedAt) / 1000) : 0;

  return (
    <div className="page page-wide">
      <header className="timer-bar">
        <DescriptionInput
          value={description}
          onChange={setDescription}
          onSubmit={toggle}
          onFlush={() => void flushDescription()}
          running={running !== null}
          inputRef={inputRef}
        />
        <div className="timer-clock">{formatDuration(runningSeconds)}</div>
        <button
          type="button"
          className={running ? 'timer-button stop' : 'timer-button start'}
          onClick={toggle}
        >
          {running ? 'Stop' : 'Start'}
        </button>
      </header>

      {error && <div className="banner error">{error}</div>}

      <section className="calendar">
        <div className="calendar-head">
          <div className="nav-group">
            <button type="button" onClick={() => setAnchor(shift(anchor, view, -1, tz))} aria-label="Previous">
              ‹
            </button>
            <button type="button" onClick={() => setAnchor(Date.now())}>
              Today
            </button>
            <button type="button" onClick={() => setAnchor(shift(anchor, view, 1, tz))} aria-label="Next">
              ›
            </button>
          </div>

          <h1 className="range-label">{rangeLabel(view, range, tz)}</h1>

          <div className="range-total" title="Total tracked in this range">
            {formatCompact(rangeSeconds)}
          </div>

          <div className="view-toggle">
            {(['day', 'week', 'month'] as View[]).map((v) => (
              <button
                key={v}
                type="button"
                className={v === view ? 'active' : ''}
                onClick={() => setView(v)}
              >
                {v[0].toUpperCase() + v.slice(1)}
              </button>
            ))}
          </div>
        </div>

        {view === 'month' ? (
          <MonthGrid
            range={range}
            days={days}
            tz={tz}
            onPickDay={(ms) => {
              setAnchor(ms);
              setView('day');
            }}
          />
        ) : (
          <Timeline
            days={columns}
            tz={tz}
            now={tick}
            // Handles are only offered where blocks are wide enough to grab.
            resizable={view === 'day'}
            onPickDay={(ms) => {
              setAnchor(ms);
              setView('day');
            }}
            onSelectEntry={setEditing}
            onResize={(entry, startedAt, endedAt) => void resizeEntry(entry, startedAt, endedAt)}
          />
        )}
      </section>

      <section className="entries">
        <div className="entries-head">
          <h2>Entries</h2>
          <button type="button" className="link-button" onClick={() => setShowManual((s) => !s)}>
            {showManual ? 'Cancel' : '+ Add entry manually'}
          </button>
        </div>

        {showManual && (
          <ManualEntryForm
            tz={tz}
            defaultDate={dateKey(range.from, tz)}
            onCreated={async () => {
              setShowManual(false);
              await reload();
            }}
          />
        )}

        {days.length === 0 && <p className="muted">Nothing tracked in this range.</p>}

        {days.map((day) => (
          <div key={day.key} className="day-group">
            <div className="day-group-head">
              <span>{dayHeading(day.key, tz)}</span>
              <span className="muted">{formatCompact(day.seconds)}</span>
            </div>
            {day.items.map((item) => (
              <EntryRow
                key={item.entry.id}
                entry={item.entry}
                tz={tz}
                now={tick}
                onResume={resume}
                onChanged={reload}
              />
            ))}
            {day.gaps.map((gap) => (
              <div className="gap-row" key={`${day.key}-${gap.from}`}>
                <span className="gap-line" />
                {formatCompact((gap.to - gap.from) / 1000)} untracked · {formatClock(gap.from, tz)}–
                {formatClock(gap.to, tz)}
              </div>
            ))}
          </div>
        ))}
      </section>

      {editing && (
        <EntryModal
          entry={editing}
          tz={tz}
          now={tick}
          onSave={(patch) => saveEntry(editing.id, patch)}
          onClose={(savedByDismissal) => {
            setEditing(null);
            if (savedByDismissal) setToast({ id: Date.now(), message: 'Changes saved' });
          }}
        />
      )}

      {toast && <Toast key={toast.id} message={toast.message} onDismiss={dismissToast} />}
    </div>
  );
}

/* -------------------------------------------------------------------------- */

interface DescriptionInputProps {
  value: string;
  onChange: (v: string) => void;
  /** Start or stop the timer. */
  onSubmit: () => void;
  /** Persist the box to the running entry now. */
  onFlush: () => void;
  running: boolean;
  inputRef: React.RefObject<HTMLInputElement | null>;
}

function DescriptionInput({
  value,
  onChange,
  onSubmit,
  onFlush,
  running,
  inputRef,
}: DescriptionInputProps) {
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(-1);

  // Debounced so a fast typist does not fire a query per keystroke.
  useEffect(() => {
    const id = window.setTimeout(() => {
      api
        .suggestions(value)
        .then((r) => setSuggestions(r.suggestions))
        .catch(() => setSuggestions([]));
    }, 150);
    return () => window.clearTimeout(id);
  }, [value]);

  const visible = open && suggestions.length > 0;

  const choose = (text: string) => {
    onChange(text);
    setOpen(false);
    setHighlight(-1);
    inputRef.current?.focus();
  };

  return (
    <div className="description-field">
      <input
        ref={inputRef}
        type="text"
        placeholder="What are you working on?"
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
          setHighlight(-1);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => {
          window.setTimeout(() => setOpen(false), 120);
          onFlush();
        }}
        onKeyDown={(e) => {
          if (!visible) {
            // While running, Enter commits the edit. Stopping the timer on a
            // keystroke meant for the text would be a nasty surprise.
            if (e.key === 'Enter') {
              if (running) {
                onFlush();
                e.currentTarget.blur();
              } else {
                onSubmit();
              }
            }
            return;
          }
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setHighlight((h) => Math.min(suggestions.length - 1, h + 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setHighlight((h) => Math.max(-1, h - 1));
          } else if (e.key === 'Enter') {
            e.preventDefault();
            if (highlight >= 0) choose(suggestions[highlight]);
            else if (running) {
              onFlush();
              e.currentTarget.blur();
            } else {
              onSubmit();
            }
          } else if (e.key === 'Escape') {
            setOpen(false);
          }
        }}
      />
      {visible && (
        <ul className="suggestions">
          {suggestions.map((s, i) => (
            <li key={s}>
              <button
                type="button"
                className={i === highlight ? 'highlight' : ''}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(s)}
              >
                {s}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */

export interface DayBucket {
  key: string;
  start: number;
  items: { entry: Entry; from: number; to: number }[];
  gaps: { from: number; to: number }[];
  seconds: number;
}

export interface Range {
  from: number;
  to: number;
}

function rangeFor(view: View, anchor: number, tz: string): Range {
  if (view === 'day') {
    const from = startOfDay(anchor, tz);
    return { from, to: addDaysUtc(from, 1, tz) };
  }
  if (view === 'week') {
    const from = startOfWeek(anchor, tz);
    return { from, to: addDaysUtc(from, 7, tz) };
  }
  const from = startOfMonth(anchor, tz);
  const p = toZonedParts(from, tz);
  return { from, to: fromZonedParts(p.year, p.month + 1, 1, 0, 0, 0, tz) };
}

function shift(anchor: number, view: View, direction: number, tz: string): number {
  if (view === 'day') return addDaysUtc(anchor, direction, tz);
  if (view === 'week') return addDaysUtc(anchor, direction * 7, tz);
  const p = toZonedParts(anchor, tz);
  return fromZonedParts(p.year, p.month + direction, 1, 12, 0, 0, tz);
}

/**
 * Split entries into calendar days, clipping each to the visible range and to
 * the day boundary so an overnight session shows on both days it touches.
 */
function groupByDay(entries: Entry[], range: Range, tz: string, now: number): DayBucket[] {
  const buckets = new Map<string, DayBucket>();

  for (const entry of entries) {
    const end = Math.min(entry.endedAt ?? now, range.to);
    let cursor = Math.max(entry.startedAt, range.from);
    if (end <= cursor) {
      // A zero-length or fully-clipped entry still deserves a row on its own day.
      if (entry.startedAt < range.to && (entry.endedAt ?? now) >= range.from) {
        const key = dateKey(entry.startedAt, tz);
        bucketFor(buckets, key, tz).items.push({ entry, from: entry.startedAt, to: end });
      }
      continue;
    }

    while (cursor < end) {
      const dayStart = startOfDay(cursor, tz);
      const dayEnd = addDaysUtc(dayStart, 1, tz);
      const sliceEnd = Math.min(end, dayEnd);
      const bucket = bucketFor(buckets, dateKey(cursor, tz), tz);
      bucket.items.push({ entry, from: cursor, to: sliceEnd });
      bucket.seconds += (sliceEnd - cursor) / 1000;
      cursor = sliceEnd;
    }
  }

  const out = [...buckets.values()].sort((a, b) => b.key.localeCompare(a.key));
  for (const day of out) {
    day.items.sort((a, b) => a.from - b.from);
    day.gaps = findGaps(day.items);
  }
  return out;
}

/**
 * Pad a set of day buckets out to cover every calendar day in the range, so the
 * timeline keeps one column per day whether or not anything was tracked on it.
 */
function fillDays(days: DayBucket[], range: Range, tz: string): DayBucket[] {
  const byKey = new Map(days.map((d) => [d.key, d]));
  const out: DayBucket[] = [];
  for (let cursor = range.from; cursor < range.to; cursor = addDaysUtc(cursor, 1, tz)) {
    const key = dateKey(cursor, tz);
    out.push(byKey.get(key) ?? { key, start: startOfDay(cursor, tz), items: [], gaps: [], seconds: 0 });
  }
  return out;
}

function bucketFor(map: Map<string, DayBucket>, key: string, tz: string): DayBucket {
  let bucket = map.get(key);
  if (!bucket) {
    const [y, m, d] = key.split('-').map(Number);
    bucket = { key, start: fromZonedParts(y, m, d, 0, 0, 0, tz), items: [], gaps: [], seconds: 0 };
    map.set(key, bucket);
  }
  return bucket;
}

/**
 * Untracked stretches between the first and last entry of a day.
 *
 * Only gaps of five minutes or more are reported — shorter ones are the normal
 * seam between stopping one timer and starting the next, not lost work.
 */
function findGaps(items: { from: number; to: number }[]): { from: number; to: number }[] {
  const MIN_GAP_MS = 5 * 60 * 1000;
  const gaps: { from: number; to: number }[] = [];
  let watermark = items.length > 0 ? items[0].to : 0;
  for (const item of items.slice(1)) {
    if (item.from - watermark >= MIN_GAP_MS) gaps.push({ from: watermark, to: item.from });
    watermark = Math.max(watermark, item.to);
  }
  return gaps;
}

function rangeLabel(view: View, range: Range, tz: string): string {
  const from = toZonedParts(range.from, tz);
  if (view === 'month') return `${MONTH_NAMES[from.month - 1]} ${from.year}`;
  if (view === 'day') {
    const weekdayName = new Date(Date.UTC(from.year, from.month - 1, from.day)).toLocaleDateString('en-GB', {
      weekday: 'long',
      timeZone: 'UTC',
    });
    return `${weekdayName} ${from.day} ${MONTH_NAMES[from.month - 1]} ${from.year}`;
  }
  const last = toZonedParts(range.to - 1, tz);
  const sameMonth = last.month === from.month && last.year === from.year;
  return sameMonth
    ? `${from.day}–${last.day} ${MONTH_NAMES[from.month - 1]} ${from.year}`
    : `${from.day} ${MONTH_NAMES[from.month - 1]} – ${last.day} ${MONTH_NAMES[last.month - 1]} ${last.year}`;
}

function dayHeading(key: string, _tz: string): string {
  const [y, m, d] = key.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return `${date.toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'UTC' })} ${d} ${MONTH_NAMES[m - 1]}`;
}

/* -------------------------------------------------------------------------- */

function MonthGrid({
  range,
  days,
  tz,
  onPickDay,
}: {
  range: Range;
  days: DayBucket[];
  tz: string;
  onPickDay: (ms: number) => void;
}) {
  const totals = new Map(days.map((d) => [d.key, d.seconds]));
  const peak = Math.max(1, ...days.map((d) => d.seconds));
  const todayKey = dateKey(Date.now(), tz);

  const first = toZonedParts(range.from, tz);
  const gridStart = startOfWeek(range.from, tz);
  const cells: { ms: number; key: string; inMonth: boolean }[] = [];
  for (let i = 0; i < 42; i++) {
    const ms = addDaysUtc(gridStart, i, tz);
    if (ms >= range.to && i % 7 === 0) break;
    const parts = toZonedParts(ms, tz);
    cells.push({ ms, key: dateKey(ms, tz), inMonth: parts.month === first.month });
  }

  return (
    <div className="month-grid">
      {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => (
        <div key={d} className="month-weekday">
          {d}
        </div>
      ))}
      {cells.map((cell) => {
        const seconds = totals.get(cell.key) ?? 0;
        return (
          <button
            type="button"
            key={cell.key}
            className={`month-cell${cell.inMonth ? '' : ' outside'}${
              cell.key === todayKey ? ' today' : ''
            }`}
            onClick={() => onPickDay(cell.ms)}
            // Opacity carries the intensity so a light day still reads as tracked.
            style={{ '--intensity': seconds / peak } as React.CSSProperties}
          >
            <span className="month-daynum">{toZonedParts(cell.ms, tz).day}</span>
            {seconds > 0 && <span className="month-total">{formatCompact(seconds)}</span>}
          </button>
        );
      })}
    </div>
  );
}
