import { ImageResponse } from "next/og";
import { buildSeries, DEFAULT_CAPITAL, experimentWindow, type Series, standings } from "./benchmarks";
import { makeScale } from "./chartScale";
import { getBtcSpot, getSnapshots, getSpyHistory, getStatus } from "./data";

export const ogSize = { width: 1200, height: 630 };
export const ogContentType = "image/png";
export const ogAlt = "Timberbot: mi bot de IA vs el S&P 500, Bitcoin y el Bot Cositorto";

// Inner SVG canvas for the chart (left side of the card).
const CW = 760;
const CH = 500;
const PAD = { top: 24, right: 18, bottom: 30, left: 18 };

function fmtPct(v: number, capital: number): string {
  const p = ((v - capital) / capital) * 100;
  if (Math.abs(p) >= 1000) return `+${Math.round(p).toLocaleString("es-AR")}%`;
  return `${p >= 0 ? "+" : ""}${p.toFixed(1)}%`;
}

export async function raceImage(): Promise<ImageResponse> {
  const [status, snapshots] = await Promise.all([getStatus(), getSnapshots()]);
  const capital = status?.initial_capital ?? DEFAULT_CAPITAL;
  const { day1Ts, nowTs } = experimentWindow(snapshots);
  const [spyHistory, btcSpot] = await Promise.all([getSpyHistory(day1Ts), getBtcSpot()]);
  const series = buildSeries({ snapshots, capital, day1Ts, nowTs, spyHistory, btcSpot });
  const board = standings(series, capital);

  const drawable = series.filter((s) => s.points.length >= 2);
  const allPoints = drawable.flatMap((s) => s.points);

  const plotW = CW - PAD.left - PAD.right;
  const plotH = CH - PAD.top - PAD.bottom;
  const minX = allPoints.length ? Math.min(...allPoints.map((p) => p.ts)) : day1Ts;
  const maxX = allPoints.length ? Math.max(...allPoints.map((p) => p.ts)) : nowTs;
  const scale = makeScale(drawable, capital, PAD.top, plotH);
  const x = (t: number) => PAD.left + ((t - minX) / Math.max(maxX - minX, 1)) * plotW;
  const y = scale.y;
  const baselineY = scale.baselineY;

  const gridYs = [0, 0.25, 0.5, 0.75, 1].map((f) => PAD.top + f * plotH);
  const gridXs = [0, 0.25, 0.5, 0.75, 1].map((f) => PAD.left + f * plotW);

  const polyline = (s: Series) =>
    s.points.map((p) => `${x(p.ts).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");

  return new ImageResponse(
    (
      <div
        style={{
          display: "flex",
          width: "100%",
          height: "100%",
          background: "#fbfaf7",
          padding: 40,
          fontFamily: "sans-serif",
        }}
      >
        {/* chart */}
        <div style={{ display: "flex", flexDirection: "column", flexGrow: 1 }}>
          <div style={{ display: "flex", fontSize: 22, color: "#6b6b73", marginBottom: 6 }}>
            mi bot de IA vs el mercado
          </div>
          <svg width={CW} height={CH} viewBox={`0 0 ${CW} ${CH}`}>
            <rect x={PAD.left} y={PAD.top} width={plotW} height={plotH} fill="#ffffff" stroke="#e7e5dd" strokeWidth={1} />
            {gridYs.map((gy, i) => (
              <line key={`h${i}`} x1={PAD.left} x2={PAD.left + plotW} y1={gy} y2={gy} stroke="#eeece4" strokeWidth={1} />
            ))}
            {gridXs.map((gx, i) => (
              <line key={`v${i}`} x1={gx} x2={gx} y1={PAD.top} y2={PAD.top + plotH} stroke="#eeece4" strokeWidth={1} />
            ))}
            <line
              x1={PAD.left}
              x2={PAD.left + plotW}
              y1={baselineY}
              y2={baselineY}
              stroke="#16161d"
              strokeOpacity={0.3}
              strokeWidth={1}
              strokeDasharray="2 4"
            />
            {drawable.map((s) => (
              <polyline
                key={s.key}
                points={polyline(s)}
                fill="none"
                stroke={s.color}
                strokeWidth={s.emphasis ? 4 : 2.4}
                strokeDasharray={s.dash}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            ))}
          </svg>
        </div>

        {/* legend */}
        <div style={{ display: "flex", flexDirection: "column", width: 320, paddingLeft: 28, justifyContent: "center" }}>
          <div style={{ display: "flex", fontSize: 40, fontWeight: 700, color: "#16161d", marginBottom: 20 }}>
            Timberbot
          </div>
          {board.map((st) => {
            const up = (st.returnPct ?? 0) >= 0;
            return (
              <div key={st.series.key} style={{ display: "flex", alignItems: "center", marginBottom: 18 }}>
                <div style={{ display: "flex", width: 16, height: 16, borderRadius: 4, background: st.series.color, marginRight: 12 }} />
                <div style={{ display: "flex", flexDirection: "column", flexGrow: 1 }}>
                  <div style={{ display: "flex", fontSize: 22, fontWeight: 600, color: "#16161d" }}>{st.series.name}</div>
                </div>
                <div style={{ display: "flex", fontSize: 22, fontWeight: 700, color: st.noData ? "#9a9a9f" : up ? "#1f8a4c" : "#cf3a2e" }}>
                  {st.noData || st.value === null ? "largando" : fmtPct(st.value, capital)}
                </div>
              </div>
            );
          })}
          <div style={{ display: "flex", fontSize: 18, color: "#9a9a9f", marginTop: 14 }}>
            plata real, en piloto automatico
          </div>
        </div>
      </div>
    ),
    { ...ogSize },
  );
}
