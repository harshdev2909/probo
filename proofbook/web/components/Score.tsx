"use client";

/** Live numerals. Mount = still; update = slot-roll (240ms settle). */
import { useEffect, useRef } from "react";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";

export function RollingNumber({
  value,
  className = "",
}: {
  value: number | string;
  className?: string;
}) {
  const reduced = useReducedMotion();
  const prev = useRef(value);
  const changed = prev.current !== value;
  useEffect(() => {
    prev.current = value;
  }, [value]);

  if (reduced) return <span className={`tnum ${className}`}>{value}</span>;
  return (
    <span className={`tnum relative inline-block overflow-hidden align-baseline ${className}`}>
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span
          key={String(value)}
          className="inline-block"
          initial={changed ? { y: "0.8em", opacity: 0 } : false}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: "-0.8em", opacity: 0 }}
          transition={{ type: "spring", stiffness: 420, damping: 38 }}
        >
          {value}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}

export function LiveBadge({ label = "LIVE" }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-2 font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-pitch-400">
      <span className="live-dot" aria-hidden />
      <span aria-live="polite">{label}</span>
    </span>
  );
}
