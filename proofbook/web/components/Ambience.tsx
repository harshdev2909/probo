"use client";

/**
 * Opt-in stadium ambience. OFF by default, remembered in localStorage, loops at
 * low volume, and the control only renders if /ambience.mp3 actually exists
 * (drop any properly licensed CC0 crowd loop at web/public/ambience.mp3).
 * Autoplay is never attempted: sound starts only from a user click.
 */
import { useEffect, useRef, useState } from "react";

export function AmbienceToggle() {
  const [available, setAvailable] = useState(false);
  const [on, setOn] = useState(false);
  const audio = useRef<HTMLAudioElement | null>(null);

  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    (async () => {
      for (const f of ["/ambience.mp3", "/fifa.mp3"]) {
        try {
          const r = await fetch(f, { method: "HEAD" });
          if (r.ok) { setSrc(f); setAvailable(true); return; }
        } catch { /* try next */ }
      }
      setAvailable(false);
    })();
  }, []);

  useEffect(() => {
    if (!on) {
      audio.current?.pause();
      return;
    }
    if (!audio.current && src) {
      audio.current = new Audio(src);
      audio.current.loop = true;
      audio.current.volume = 0.22;
    }
    void audio.current?.play().catch(() => setOn(false));
  }, [on, src]);

  useEffect(() => {
    if (localStorage.getItem("pb-ambience") === "on") setOn(true);
  }, []);
  useEffect(() => {
    localStorage.setItem("pb-ambience", on ? "on" : "off");
  }, [on]);

  if (!available) return null;
  return (
    <button
      onClick={() => setOn(!on)}
      aria-pressed={on}
      aria-label={on ? "Turn stadium ambience off" : "Turn stadium ambience on"}
      title="Stadium ambience"
      className={`inline-flex h-9 w-9 items-center justify-center border transition-colors duration-150 ease-snap ${
        on ? "border-brass-600 text-brass-400" : "border-hairline-strong text-ink-400 hover:text-ink-200"
      }`}
      style={{ borderRadius: "0 0 0 10px" }}
    >
      <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden>
        <path d="M2 5.5 v4 h2.5 L8 12.5 v-10 L4.5 5.5 z" fill="currentColor" />
        {on ? (
          <path d="M10 4.5 a4 4 0 0 1 0 6 M10.5 6.5 a2 2 0 0 1 0 2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        ) : (
          <path d="M10 6 l3 3 M13 6 l-3 3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        )}
      </svg>
    </button>
  );
}
