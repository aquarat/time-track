import { useMemo, useRef, useState } from 'react';
import type { Entry } from '../../shared/types';
import type { DayBucket } from '../pages/TimerPage';
import {
  MONTH_NAMES,
  formatClock,
  formatCompact,
  pad2,
  snapToMinutes,
  toZonedParts,
} from '../../shared/time';

const HOUR_MS = 3600_000;
/** Boundaries snap to this grid while dragging. */
export const SNAP_MINUTES = 15;
/** An entry may not be dragged shorter than one snap step. */
const MIN_DURATION_MS = SNAP_MINUTES * 60_000;

interface DragState {
  entryId: string;
  edge: 'start' | 'end';
  from: number;
  to: number;
}

interface Props {
  days: DayBucket[];
  tz: string;
  now: number;
  /** Enables the resize handles. Off outside the single-day view. */
  resizable?: boolean;
  onPickDay: (ms: number) => void;
  onSelectEntry?: (entry: Entry) => void;
  onResize?: (entry: Entry, startedAt: number, endedAt: number) => void;
}

/**
 * Vertical hour axis with one column per day.
 *
 * The visible hour window is derived from the data but never narrower than
 * 08:00–18:00, so a normal working day keeps a stable shape and an early start
 * or a late night simply extends it.
 */
export function Timeline({ days, tz, now, resizable, onPickDay, onSelectEntry, onResize }: Props) {
  const ordered = useMemo(() => [...days].sort((a, b) => a.key.localeCompare(b.key)), [days]);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  // Set on a completed drag so the click it also produces does not open the modal.
  const suppressClick = useRef(false);

  const window = useMemo(() => {
    let min = 8;
    let max = 18;
    for (const day of ordered) {
      for (const item of day.items) {
        min = Math.min(min, Math.floor((item.from - day.start) / HOUR_MS));
        max = Math.max(max, Math.ceil((item.to - day.start) / HOUR_MS));
      }
    }
    return { start: Math.max(0, min), end: Math.min(24, Math.max(max, min + 1)) };
  }, [ordered]);

  const span = window.end - window.start;
  const hours = Array.from({ length: span + 1 }, (_, i) => window.start + i);

  /**
   * Begin a boundary drag. Pointer capture keeps the gesture attached to the
   * handle even when the cursor leaves it, so a fast drag does not detach.
   */
  const beginDrag = (
    event: React.PointerEvent<HTMLElement>,
    entry: Entry,
    origin: { from: number; to: number },
    edge: 'start' | 'end',
  ) => {
    const body = bodyRef.current;
    if (!body || !onResize) return;
    event.preventDefault();
    event.stopPropagation();

    const msPerPixel = (span * HOUR_MS) / body.getBoundingClientRect().height;
    const startY = event.clientY;
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);

    let latest: DragState = { entryId: entry.id, edge, ...origin };

    const move = (moveEvent: PointerEvent) => {
      const shifted = snapToMinutes(
        (edge === 'start' ? origin.from : origin.to) + (moveEvent.clientY - startY) * msPerPixel,
        tz,
        SNAP_MINUTES,
      );
      latest =
        edge === 'start'
          ? { entryId: entry.id, edge, from: Math.min(shifted, origin.to - MIN_DURATION_MS), to: origin.to }
          : { entryId: entry.id, edge, from: origin.from, to: Math.max(shifted, origin.from + MIN_DURATION_MS) };
      setDrag(latest);
    };

    const finish = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', finish);
      handle.removeEventListener('pointercancel', cancel);
      setDrag(null);
      if (latest.from !== origin.from || latest.to !== origin.to) {
        suppressClick.current = true;
        onResize(entry, latest.from, latest.to);
      }
    };

    const cancel = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', finish);
      handle.removeEventListener('pointercancel', cancel);
      setDrag(null);
    };

    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', finish);
    handle.addEventListener('pointercancel', cancel);
  };

  if (ordered.length === 0) {
    return <div className="timeline empty">No time tracked in this range.</div>;
  }

  return (
    <div className={`timeline${drag ? ' dragging' : ''}`} style={{ '--rows': span } as React.CSSProperties}>
      <div className="timeline-axis">
        {hours.map((h) => (
          <div key={h} className="axis-label" style={{ top: `${((h - window.start) / span) * 100}%` }}>
            {pad2(h % 24)}:00
          </div>
        ))}
      </div>

      <div className="timeline-body" ref={bodyRef}>
        {hours.map((h) => (
          <div key={h} className="hour-line" style={{ top: `${((h - window.start) / span) * 100}%` }} />
        ))}

        <div className="timeline-columns">
          {ordered.map((day) => {
            const lanes = assignLanes(day.items);
            return (
              <div className="timeline-column" key={day.key}>
                {day.items.map((item, i) => {
                  const entry = item.entry;
                  const active = drag?.entryId === entry.id;
                  const from = active ? drag.from : item.from;
                  const to = active ? drag.to : item.to;

                  const top = ((from - day.start) / HOUR_MS - window.start) / span;
                  const height = (to - from) / HOUR_MS / span;
                  const isRunning = entry.endedAt === null;
                  const lane = lanes[i];

                  // Only an unclipped, finished entry may be resized: a slice of an
                  // overnight entry does not carry that entry's real boundaries, and a
                  // running timer has no end to drag.
                  const canDragStart = Boolean(resizable && onResize) && item.from === entry.startedAt;
                  const canDragEnd =
                    Boolean(resizable && onResize) && !isRunning && item.to === entry.endedAt;

                  return (
                    <div
                      key={`${entry.id}-${i}`}
                      className={`block${isRunning ? ' running' : ''}${active ? ' active' : ''}${
                        onSelectEntry ? ' clickable' : ''
                      }`}
                      style={{
                        top: `${top * 100}%`,
                        // Keep very short entries clickable and visible.
                        height: `max(${height * 100}%, 4px)`,
                        left: `${(lane.index / lane.total) * 100}%`,
                        width: `${(1 / lane.total) * 100}%`,
                      }}
                      title={`${entry.description || 'No description'}\n${formatClock(from, tz)}–${
                        isRunning ? 'now' : formatClock(to, tz)
                      } (${formatCompact((to - from) / 1000)})`}
                      onClick={() => {
                        if (suppressClick.current) {
                          suppressClick.current = false;
                          return;
                        }
                        onSelectEntry?.(entry);
                      }}
                    >
                      {canDragStart && (
                        <span
                          className="grip grip-top"
                          role="presentation"
                          onPointerDown={(e) => beginDrag(e, entry, { from: item.from, to: item.to }, 'start')}
                        />
                      )}
                      <span className="block-label">{entry.description || 'No description'}</span>
                      {active && (
                        <span className="block-times">
                          {formatClock(from, tz)}–{formatClock(to, tz)}
                        </span>
                      )}
                      {canDragEnd && (
                        <span
                          className="grip grip-bottom"
                          role="presentation"
                          onPointerDown={(e) => beginDrag(e, entry, { from: item.from, to: item.to }, 'end')}
                        />
                      )}
                    </div>
                  );
                })}

                {isToday(day, tz, now) && (
                  <div
                    className="now-line"
                    style={{ top: `${(((now - day.start) / HOUR_MS - window.start) / span) * 100}%` }}
                  />
                )}

                <button type="button" className="column-head" onClick={() => onPickDay(day.start)}>
                  <span className="column-day">{columnLabel(day.key)}</span>
                  <span className="column-total">{formatCompact(day.seconds)}</span>
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/**
 * Side-by-side placement for overlapping entries.
 *
 * Timer-tracked entries never overlap — starting one stops the last — but a
 * manual entry or an edited stop time can straddle another, and stacking those
 * at full width hides one behind the other. Entries are grouped into clusters of
 * transitively overlapping blocks; within a cluster each takes the first free
 * lane, and every block in that cluster is narrowed to the same fraction so the
 * column stays aligned.
 */
function assignLanes(items: DayBucket['items']): { index: number; total: number }[] {
  const lanes = items.map(() => ({ index: 0, total: 1 }));
  let cluster: number[] = [];
  let clusterEnd = -Infinity;
  let laneEnds: number[] = [];

  const closeCluster = () => {
    for (const i of cluster) lanes[i].total = laneEnds.length;
    cluster = [];
    laneEnds = [];
  };

  // `items` arrives sorted by start time, so a block starting at or after the
  // cluster's furthest end cannot overlap anything already in it.
  items.forEach((item, i) => {
    if (item.from >= clusterEnd && cluster.length > 0) closeCluster();

    let lane = laneEnds.findIndex((end) => end <= item.from);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(item.to);
    } else {
      laneEnds[lane] = item.to;
    }

    lanes[i].index = lane;
    cluster.push(i);
    clusterEnd = Math.max(clusterEnd, item.to);
  });
  if (cluster.length > 0) closeCluster();

  return lanes;
}

function isToday(day: DayBucket, tz: string, now: number): boolean {
  const p = toZonedParts(now, tz);
  return day.key === `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
}

function columnLabel(key: string): string {
  const [y, m, d] = key.split('-').map(Number);
  const weekday = new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-GB', {
    weekday: 'short',
    timeZone: 'UTC',
  });
  return `${weekday} ${d} ${MONTH_NAMES[m - 1].slice(0, 3)}`;
}
