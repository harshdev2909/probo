"use client";

/**
 * Full-screen background art layer. Fixed, non-interactive, heavily masked so
 * text keeps AA contrast. All images are original generated art (no real
 * player likeness, no logos), color-graded to the ink/brass system.
 *
 * Three hard-won rules, each a fix for something that actually rendered wrong:
 *
 *   1. PORTALED TO <body>. `position: fixed` silently anchors to the nearest
 *      transformed ancestor instead of the viewport, and framer-motion adds
 *      transforms liberally — the art once sized itself to the content column,
 *      leaving bare strips around it. A portal cannot be re-parented by anyone's
 *      transform.
 *   2. `inset: 0`, not 100dvw/100dvh. Viewport units include the scrollbar
 *      gutter on some platforms; inset pins to the true viewport edges.
 *   3. The mask never reaches full opacity. A gradient ending at solid ink made
 *      the artwork die into a black band mid-page — read as a "gap" under the
 *      fold. It now bottoms out at 85%, so the texture carries the whole page.
 */
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

export function PageArt({
  src,
  position = "center",
  opacity = 0.3,
}: {
  src: string;
  position?: string;
  opacity?: number;
}) {
  // Portals need a client document; render nothing during SSR/hydration.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return null;

  return createPortal(
    <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
      <div
        className="absolute inset-0"
        style={{
          backgroundImage: `url(${src})`,
          backgroundSize: "cover",
          backgroundPosition: position,
          backgroundRepeat: "no-repeat",
          opacity,
        }}
      />
      <div
        className="absolute inset-0"
        style={{
          background:
            "linear-gradient(to bottom, rgba(15,13,10,0.78) 0%, rgba(15,13,10,0.38) 40%, rgba(15,13,10,0.85) 100%)",
        }}
      />
    </div>,
    document.body
  );
}
