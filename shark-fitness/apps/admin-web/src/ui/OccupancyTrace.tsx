import { useEffect, useState } from 'react';
import { Label, Metric } from './console';

/**
 * THE SIGNATURE.
 *
 * A 24-hour readout of the building drawn as a stepped trace, with a cyan
 * "now" line sweeping it and arriving check-ins pinging onto it as they happen.
 * It is a literal sonar display of the floor, and it is the only animated
 * element on the Command Center — everything around it stays still so this
 * carries the page. See docs/DESIGN.md.
 */

export interface OccupancyTraceProps {
  hourly: number[];
  currentHour: number;
  inside: number;
  capacity: number;
  label: string;
  /** Bumped whenever a check-in event lands, to fire a ping. */
  pingKey?: number;
  opensHour?: number;
  closesHour?: number;
}

export function OccupancyTrace({
  hourly,
  currentHour,
  inside,
  capacity,
  label,
  pingKey = 0,
  opensHour = 5,
  closesHour = 23,
}: OccupancyTraceProps) {
  const [ping, setPing] = useState(false);

  useEffect(() => {
    if (pingKey === 0) return;
    setPing(true);
    const timer = setTimeout(() => setPing(false), 900);
    return () => clearTimeout(timer);
  }, [pingKey]);

  const width = 720;
  const height = 132;
  const padY = 14;
  const peak = Math.max(1, ...hourly);
  const step = width / 24;

  // A stepped trace, not a smooth curve: occupancy is counted per hour and a
  // spline would invent readings between the buckets that were never taken.
  const points: string[] = [];
  hourly.forEach((value, hour) => {
    const y = height - padY - ((height - padY * 2) * value) / peak;
    points.push(`${hour * step},${y}`, `${(hour + 1) * step},${y}`);
  });

  const nowX = (currentHour + 0.5) * step;
  const nowValue = hourly[currentHour] ?? 0;
  const nowY = height - padY - ((height - padY * 2) * nowValue) / peak;

  return (
    <div className="relative flex flex-col">
      <div className="flex items-end gap-4 px-3.5 pb-2 pt-3">
        <div>
          <Label>Inside now</Label>
          <div className="mt-1 flex items-baseline gap-1.5">
            <Metric value={inside} size="lg" />
            <span className="text-[12px] text-foam-45">/ {capacity}</span>
          </div>
        </div>
        <div className="pb-1">
          <Label>Floor</Label>
          <div className="mt-1 font-utility text-[13px] font-semibold uppercase tracking-[0.12em] text-sonar">
            {label}
          </div>
        </div>
        <div className="pb-1">
          <Label>Peak today</Label>
          <div className="mt-1 font-display text-[15px] leading-none tabular-nums">
            {peak} <span className="text-[11px] text-foam-45">at {hourly.indexOf(peak)}:00</span>
          </div>
        </div>
      </div>

      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full"
        preserveAspectRatio="none"
        role="img"
        aria-label={`Occupancy through the day. ${inside} of ${capacity} inside now, ${label}. Peak of ${peak} at ${hourly.indexOf(peak)}:00.`}
      >
        {/* Hours the branch is shut are dimmed rather than hidden, so a gap in
            the trace reads as "closed" and not as "no data". */}
        <rect x={0} y={0} width={opensHour * step} height={height} fill="var(--sf-line-10)" />
        <rect x={closesHour * step} y={0} width={width - closesHour * step} height={height} fill="var(--sf-line-10)" />

        {[0.25, 0.5, 0.75].map((f) => (
          <line
            key={f}
            x1={0}
            x2={width}
            y1={height - padY - (height - padY * 2) * f}
            y2={height - padY - (height - padY * 2) * f}
            stroke="var(--sf-line-10)"
            strokeWidth={1}
          />
        ))}

        <polyline
          points={`0,${height - padY} ${points.join(' ')} ${width},${height - padY}`}
          fill="var(--sf-wash-sonar)"
          stroke="none"
        />
        <polyline points={points.join(' ')} fill="none" stroke="var(--sf-sonar)" strokeWidth={1.5} />

        {/* The now line. */}
        <line x1={nowX} x2={nowX} y1={0} y2={height} stroke="var(--sf-sonar)" strokeWidth={1} strokeDasharray="3 3" opacity={0.7} />
        <circle cx={nowX} cy={nowY} r={3} fill="var(--sf-sonar)" />
        {ping ? (
          <circle
            cx={nowX}
            cy={nowY}
            r={3}
            fill="none"
            stroke="var(--sf-sonar)"
            strokeWidth={1.5}
            style={{ animation: 'sf-ping 900ms ease-out', transformOrigin: `${nowX}px ${nowY}px` }}
          />
        ) : null}
      </svg>

      <div className="flex justify-between px-3.5 pb-2.5 font-utility text-[9px] tracking-[0.1em] text-foam-35">
        {[0, 6, 12, 18, 23].map((h) => (
          <span key={h}>{String(h).padStart(2, '0')}:00</span>
        ))}
      </div>
    </div>
  );
}
