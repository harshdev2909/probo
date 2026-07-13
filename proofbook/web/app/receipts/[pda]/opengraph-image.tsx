/**
 * The shareable artifact: a per-receipt OG card, generated on the fly.
 *
 * A receipt is the thing worth screenshotting, so it should BE the screenshot.
 * Rendered in the ink/brass system, with the proven scoreline, the outcome, and
 * the proof reference — the same facts the on-chain receipt carries.
 *
 * Data comes from the read API here (an edge renderer cannot do a CPI), which is
 * fine: this is a picture, not a proof. The card links to /verify, where the
 * claim is actually checked against the chain and nothing we say is taken on
 * faith.
 */
import { ImageResponse } from "next/og";

export const alt = "ProofBook — a settlement proven, not trusted";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";

const INK_950 = "#0f0d0a";
const INK_200 = "#e6e0d4";
const INK_400 = "#a29a8b";
const INK_600 = "#6b6355";
const BRASS = "#c2a05a";
const HAIRLINE = "#2a2620";

export default async function Image({
  params,
}: {
  params: Promise<{ pda: string }>;
}) {
  const { pda } = await params;

  let r: any = null;
  try {
    const res = await fetch(`${API_URL}/receipts/${pda}`, {
      next: { revalidate: 300 },
    });
    if (res.ok) r = await res.json();
  } catch {
    /* fall through to the "no receipt" card — never invent one */
  }

  // No receipt is a legitimate state, and the card says so plainly rather than
  // rendering a blank or a fake.
  if (!r) {
    return new ImageResponse(
      (
        <div
          style={{
            width: "100%",
            height: "100%",
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            alignItems: "center",
            background: INK_950,
            color: INK_400,
            fontSize: 34,
          }}
        >
          <div style={{ color: BRASS, fontSize: 22, letterSpacing: 4 }}>
            PROOFBOOK
          </div>
          <div style={{ marginTop: 20 }}>No receipt for this market.</div>
          <div style={{ marginTop: 10, fontSize: 24, color: INK_600 }}>
            We could not prove it, so we do not claim it.
          </div>
        </div>
      ),
      size
    );
  }

  const score =
    r.provenScore && r.provenScore.p1 !== null
      ? `${r.provenScore.p1} – ${r.provenScore.p2}`
      : null;
  const home = r.home?.name ?? "Home";
  const away = r.away?.name ?? "Away";
  const proofRef: string = r.proofRef ?? "";

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          background: INK_950,
          padding: 64,
          fontFamily: "monospace",
        }}
      >
        {/* header */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <div
            style={{
              color: BRASS,
              fontSize: 22,
              letterSpacing: 6,
              fontWeight: 700,
            }}
          >
            PROOFBOOK
          </div>
          <div style={{ color: INK_600, fontSize: 20, letterSpacing: 2 }}>
            PROOF RECEIPT
          </div>
        </div>

        <div
          style={{
            height: 1,
            background: HAIRLINE,
            marginTop: 28,
            marginBottom: 40,
          }}
        />

        {/* the match + the proven score */}
        <div style={{ display: "flex", flexDirection: "column", flex: 1 }}>
          <div style={{ color: INK_600, fontSize: 22, letterSpacing: 2 }}>
            {r.stage ?? "WORLD CUP"} · FIXTURE {r.fixtureId}
          </div>

          <div
            style={{
              display: "flex",
              alignItems: "center",
              marginTop: 22,
              gap: 28,
            }}
          >
            <div
              style={{
                color: INK_200,
                fontSize: 60,
                fontWeight: 700,
                letterSpacing: -1,
              }}
            >
              {home}
            </div>
            {score && (
              <div
                style={{
                  color: BRASS,
                  fontSize: 60,
                  fontWeight: 700,
                }}
              >
                {score}
              </div>
            )}
            <div
              style={{
                color: INK_200,
                fontSize: 60,
                fontWeight: 700,
                letterSpacing: -1,
              }}
            >
              {away}
            </div>
          </div>

          <div style={{ display: "flex", marginTop: 30, gap: 60 }}>
            <div style={{ display: "flex", flexDirection: "column" }}>
              <span style={{ color: INK_600, fontSize: 18, letterSpacing: 2 }}>
                SETTLED
              </span>
              <span style={{ color: INK_200, fontSize: 34, marginTop: 6 }}>
                {r.outcomeLabel}
              </span>
            </div>
            <div style={{ display: "flex", flexDirection: "column" }}>
              <span style={{ color: INK_600, fontSize: 18, letterSpacing: 2 }}>
                ORACLE
              </span>
              <span style={{ color: INK_200, fontSize: 34, marginTop: 6 }}>
                TxLINE merkle proof
              </span>
            </div>
          </div>

          {proofRef && (
            <div style={{ display: "flex", flexDirection: "column", marginTop: 30 }}>
              <span style={{ color: INK_600, fontSize: 18, letterSpacing: 2 }}>
                PROOF REF
              </span>
              <span
                style={{
                  color: INK_400,
                  fontSize: 21,
                  marginTop: 6,
                }}
              >
                {proofRef.slice(0, 32)}…{proofRef.slice(-16)}
              </span>
            </div>
          )}
        </div>

        {/* the invitation */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-end",
          }}
        >
          <div
            style={{
              color: BRASS,
              fontSize: 26,
              borderBottom: `2px solid ${BRASS}`,
              paddingBottom: 4,
            }}
          >
            Verify this yourself →
          </div>
          {/* the quarter-circle: the brand's second primitive */}
          <div
            style={{
              width: 72,
              height: 72,
              background: BRASS,
              borderRadius: "0 0 0 72px",
            }}
          />
        </div>
      </div>
    ),
    size
  );
}
