"use client";

/**
 * The football cursor. Desktop fine-pointer only. A small SVG ball built from
 * the quarter-circle language trails the pointer with inertia; rotation is
 * proportional to horizontal velocity (it rolls). It never replaces the native
 * cursor. it accompanies it. and it fades out entirely over text, inputs,
 * and interactive elements so it can't get in the way. Disabled under
 * prefers-reduced-motion.
 */
import { useEffect, useRef } from "react";

const INTERACTIVE = "a, button, input, textarea, select, label, [role='button'], [role='radio']";

export function BallCursor() {
  const el = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const fine = window.matchMedia("(pointer: fine)").matches;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!fine || reduced || !el.current) return;

    const node = el.current;
    let raf = 0;
    let targetX = -100, targetY = -100;
    let x = -100, y = -100, rot = 0, visible = 0, targetVisible = 0;

    const onMove = (e: PointerEvent) => {
      targetX = e.clientX;
      targetY = e.clientY;
      const t = e.target as Element | null;
      targetVisible = t && (t.closest(INTERACTIVE) || t.closest("p, span, h1, h2, h3, pre, code")) ? 0 : 1;
    };
    const onLeave = () => (targetVisible = 0);

    const tick = () => {
      const dx = targetX - x;
      x += dx * 0.16; // inertia lag
      y += (targetY - y) * 0.16;
      rot += dx * 0.9; // roll ∝ horizontal velocity
      visible += (targetVisible - visible) * 0.2;
      node.style.transform = `translate3d(${x - 9}px, ${y + 14}px, 0) rotate(${rot}deg)`;
      node.style.opacity = String(visible * 0.9);
      raf = requestAnimationFrame(tick);
    };

    window.addEventListener("pointermove", onMove, { passive: true });
    document.documentElement.addEventListener("pointerleave", onLeave);
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("pointermove", onMove);
      document.documentElement.removeEventListener("pointerleave", onLeave);
    };
  }, []);

  return (
    <div
      ref={el}
      aria-hidden
      className="pointer-events-none fixed left-0 top-0 z-50 opacity-0"
      style={{ willChange: "transform, opacity" }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/ball.png"
        alt=""
        width={22}
        height={22}
        style={{
          borderRadius: "50%",
          // clip a hair inside the sphere so no square/black edge ever shows
          transform: "scale(1.02)",
          clipPath: "circle(44% at 50% 50%)",
        }}
      />
    </div>
  );
}
