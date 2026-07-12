/**
 * Full-screen background art layer. Fixed, non-interactive, heavily masked so
 * text keeps AA contrast. All images are original generated art (no real
 * player likeness, no logos), color-graded to the ink/brass system.
 */
export function PageArt({
  src,
  position = "center",
  opacity = 0.3,
}: {
  src: string;
  position?: string;
  opacity?: number;
}) {
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt=""
        className="h-full w-full object-cover"
        style={{ objectPosition: position, opacity }}
      />
      <div className="absolute inset-0 bg-gradient-to-b from-ink-950/80 via-ink-950/40 to-ink-950" />
    </div>
  );
}
