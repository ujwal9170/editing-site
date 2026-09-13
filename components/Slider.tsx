"use client";
import { useRef } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

// A light, accidental touch must never move a value slider -- only a
// deliberate drag should. A plain <input type="range"> can't do this: any
// tap anywhere on its track jumps the thumb straight there. This tracks the
// drag itself: nothing changes until the pointer has moved past a small
// threshold, and from then on the value follows the finger's own motion
// (relative to where it started), not the tapped position -- so even a full
// accidental brush across the track only moves the value as far as the
// finger actually travelled.
const THRESHOLD = 4;

export default function Slider({
  min,
  max,
  step = 1,
  value,
  onChange,
  ariaLabel,
}: {
  min: number;
  max: number;
  step?: number;
  value: number;
  onChange: (value: number) => void;
  ariaLabel?: string;
}) {
  const track = useRef<HTMLDivElement>(null);
  const drag = useRef<{
    startX: number;
    startValue: number;
    committed: boolean;
    width: number;
  } | null>(null);

  function snap(v: number) {
    const stepped = Math.round((v - min) / step) * step + min;
    return Math.min(max, Math.max(min, stepped));
  }
  function down(e: ReactPointerEvent<HTMLDivElement>) {
    e.currentTarget.setPointerCapture(e.pointerId);
    const rect = track.current?.getBoundingClientRect();
    if (!rect) return;
    drag.current = {
      startX: e.clientX,
      startValue: value,
      committed: false,
      width: rect.width,
    };
  }
  function move(e: ReactPointerEvent<HTMLDivElement>) {
    const d = drag.current;
    if (!d || max === min || d.width <= 0) return;
    const dx = e.clientX - d.startX;
    if (!d.committed) {
      if (Math.abs(dx) < THRESHOLD) return;
      d.committed = true;
    }
    onChange(snap(d.startValue + (dx / d.width) * (max - min)));
  }
  function up() {
    drag.current = null;
  }
  const percent = max === min ? 0 : ((value - min) / (max - min)) * 100;
  return (
    <div
      className="slider-track"
      ref={track}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      role="slider"
      aria-label={ariaLabel}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "ArrowRight" || e.key === "ArrowUp") {
          e.preventDefault();
          onChange(snap(value + step));
        } else if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
          e.preventDefault();
          onChange(snap(value - step));
        }
      }}
    >
      <div className="slider-fill" style={{ width: `${percent}%` }} />
      <div className="slider-thumb" style={{ left: `${percent}%` }} />
    </div>
  );
}
