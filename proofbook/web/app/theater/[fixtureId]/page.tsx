"use client";

/**
 * /theater/:fixtureId — replay one fixture's recorded settlement.
 *
 * Plays back the real event timeline from /archive, so the exact settlement can
 * be re-run and screen-recorded on demand. Auto-plays on load; a Replay button
 * runs it again from the top.
 */
import { use, useEffect } from "react";
import Link from "next/link";
import { useReplayFeed } from "@/components/theater/driver";
import { SettlementTheater } from "@/components/theater/SettlementTheater";
import { PageArt } from "@/components/PageArt";
import { QuarterLoader } from "@/components/primitives";

export default function ReplayPage({
  params,
}: {
  params: Promise<{ fixtureId: string }>;
}) {
  const { fixtureId } = use(params);
  const fid = Number(fixtureId);
  const feed = useReplayFeed(fid, { durationMs: 18_000 });

  // Auto-play once loaded.
  useEffect(() => {
    if (feed.ready && !feed.loading) feed.start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [feed.ready, feed.loading]);

  if (feed.loading) {
    return (
      <main className="flex min-h-[70vh] flex-col items-center justify-center gap-3">
        <QuarterLoader size={36} label="Loading" />
        <p className="label">Loading the recording</p>
      </main>
    );
  }

  if (feed.error) {
    return (
      <main className="flex min-h-[60vh] flex-col items-center justify-center gap-3 px-6 text-center">
        <p className="label text-oxide-400">No replay available</p>
        <p className="max-w-md text-[13px] text-ink-400">
          {feed.error} This fixture has no recorded settlement timeline to replay.
        </p>
        <Link href="/theater" className="label mt-2 border border-hairline-strong px-4 py-2 text-ink-300 hover:border-ink-400">
          ← Back to the theater
        </Link>
      </main>
    );
  }

  return (
    <main className="mx-auto w-full max-w-5xl px-4 pb-24 lg:px-8">
      <PageArt src="/art-keeper.jpg" opacity={0.16} />
      <SettlementTheater feed={feed} />
      <div className="mt-6 flex justify-center gap-3">
        <button
          onClick={() => feed.restart()}
          className="label border border-brass-600 px-6 py-2.5 text-brass-400 transition-colors hover:bg-brass-500 hover:text-ink-950"
        >
          ↻ Replay
        </button>
        <Link
          href="/theater"
          className="label border border-hairline-strong px-6 py-2.5 text-ink-300 transition-colors hover:border-ink-400"
        >
          Theater
        </Link>
      </div>
    </main>
  );
}
