"use client";

/**
 * Motion system. Storyboard (page entrance, times from mount):
 *   0ms      masthead label fades
 *   80ms     headline rises (settle spring)
 *   200ms+   content rows stagger in, 55ms apart
 *   on-view  editorial sections reveal once, rise 14px
 * Springs over durations; reduced-motion collapses to instant.
 */
import { motion, useReducedMotion, type Variants } from "framer-motion";

export const TIMING = {
  headline: 0.08,
  content: 0.2,
  stagger: 0.055,
};

export const SPRING = {
  settle: { type: "spring", stiffness: 320, damping: 34, mass: 0.9 } as const,
  hero: { type: "spring", stiffness: 190, damping: 26, mass: 1.1 } as const,
};

export const rise: Variants = {
  hidden: { opacity: 0, y: 16 },
  show: { opacity: 1, y: 0, transition: SPRING.settle },
};

/** Staggered list item. manual index delay (never staggerChildren+presence). */
export function StaggerItem({
  i,
  children,
  className = "",
  base = TIMING.content,
}: {
  i: number;
  children: React.ReactNode;
  className?: string;
  base?: number;
}) {
  const reduced = useReducedMotion();
  return (
    <motion.div
      className={className}
      initial={reduced ? false : { opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ ...SPRING.settle, delay: base + i * TIMING.stagger }}
    >
      {children}
    </motion.div>
  );
}

/** Scroll-linked reveal: rises once when it enters the viewport. */
export function Reveal({
  children,
  className = "",
  delay = 0,
}: {
  children: React.ReactNode;
  className?: string;
  delay?: number;
}) {
  const reduced = useReducedMotion();
  return (
    <motion.div
      className={className}
      initial={reduced ? false : { opacity: 0, y: 20 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-80px" }}
      transition={{ ...SPRING.hero, delay }}
    >
      {children}
    </motion.div>
  );
}
