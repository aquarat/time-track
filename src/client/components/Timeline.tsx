import { useMemo } from 'react';
import type { DayBucket } from '../pages/TimerPage';
import { MONTH_NAMES, formatClock, formatCompact, pad2, toZonedParts } from '../../shared/time';

const HOUR_MS = 3600_000;

interface Props {
  days: DayBucket[];
  tz: string;
  now: number;
  onPickDay: (ms: number) => void;
}

/**
 * Vertical hour axis with one column per day.
 *
 * The visible hour window is derived from the data but never narrower than
 * 08:00–18:00, so a normal working day keeps a stable shape and an early start
 * or a late night simply extends it.
 */
export function Timeline({ days, tz, now, onPickDay }: Props) {
  const ordered = useMemo(() => [...days].sort((a, b) => a.key.localeCompare(b.key)), [days]);

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

  if (ordered.length === 0) {
    return <div className="timeline empty">No time tracked in this range.</div>;
  }

  return (
    <div className="timeline" style={{ '--rows': span } as React.CSSProperties}>
      <div className="timeline-axis">
        {hours.map((h) => (
          <div key={h} className="axis-label" style={{ top: `${((h - window.start) / span) * 100}%` }}>
            {pad2(h % 24)}:00
          </div>
        ))}
      </div>

      <div className="timeline-body">
        {hours.map((h) => (
          <div key={h} className="hour-line" style={{ top: `${((h - window.start) / span) * 100}%` }} />
        ))}

        <div className="timeline-columns">
          {ordered.map((day) => {
            const lanes = assignLanes(day.items);
            return (
            <div className="timeline-column" key={day.key}>
              {day.items.map((item, i) => {
                const top = ((item.from - day.start) / HOUR_MS - window.start) / span;
                const height = (item.to - item.from) / HOUR_MS / span;
                const isRunning = item.entry.endedAt === null;
                const lane = lanes[i];
                return (
                  <div
                    key={`${item.entry.id}-${i}`}
                    className={`block${isRunning ? ' running' : ''}`}
                    style={{
                      top: `${top * 100}%`,
                      // Keep very short entries clickable and visible.
                      height: `max(${height * 100}%, 4px)`,
                      left: `${(lane.index / lane.total) * 100}%`,
                      width: `${(1 / lane.total) * 100}%`,
                    }}
                    title={`${item.entry.description || 'No description'}\n${formatClock(item.from, tz)}–${
                      isRunning ? 'now' : formatClock(item.to, tz)
                    } (${formatCompact((item.to - item.from) / 1000)})`}
                  >
                    <span className="block-label">{item.entry.description || 'No description'}</span>
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
