import type { Series } from "../lib/benchmarks";
import { makeScale } from "../lib/chartScale";

const W = 800;
const H = 380;
const PAD = { top: 22, right: 168, bottom: 30, left: 12 };

interface XY {
  x: number;
  y: number;
}

function path(points: XY[]): string {
  return points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
}

function fmtPct(v: number, capital: number): string {
  const pct = ((v - capital) / capital) * 100;
  if (Math.abs(pct) >= 1000) return `+${Math.round(pct).toLocaleString("es-AR")}%`;
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`;
}

export function EquityChart({ series, capital }: { series: Series[]; capital: number }) {
  const withPoints = series.filter((s) => s.points.length > 0);
  const allPoints = withPoints.flatMap((s) => s.points);
  if (allPoints.length < 2 || capital <= 0) {
    return <div className="empty">Sin datos todavia. La carrera arranca cuando el agente publique su primer dia.</div>;
  }

  const minX = Math.min(...allPoints.map((p) => p.ts));
  const maxX = Math.max(...allPoints.map((p) => p.ts));

  const plot = { x: PAD.left, y: PAD.top, w: W - PAD.left - PAD.right, h: H - PAD.top - PAD.bottom };
  const scale = makeScale(withPoints, capital, plot.y, plot.h);

  const x = (t: number) => PAD.left + ((t - minX) / Math.max(maxX - minX, 1)) * plot.w;
  const y = scale.y;

  const labels = withPoints
    .map((s) => {
      const last = s.points[s.points.length - 1]!;
      return { s, px: x(last.ts), py: y(last.value), value: last.value, labelY: y(last.value) };
    })
    .sort((a, b) => a.py - b.py);
  for (let i = 0; i < labels.length; i++) {
    const minY = i === 0 ? PAD.top + 8 : labels[i - 1]!.labelY + 15;
    if (labels[i]!.labelY < minY) labels[i]!.labelY = minY;
  }

  const fmtDate = (ts: number) =>
    new Date(ts).toLocaleDateString("es-AR", { day: "numeric", month: "short", timeZone: "America/New_York" });

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="La carrera: agente vs benchmarks">
      <defs>
        <pattern id="gridS" width="10" height="10" patternUnits="userSpaceOnUse">
          <path d="M 10 0 L 0 0 0 10" fill="none" stroke="#16161d" strokeOpacity="0.05" strokeWidth="0.5" />
        </pattern>
        <pattern id="gridL" width="50" height="50" patternUnits="userSpaceOnUse">
          <path d="M 50 0 L 0 0 0 50" fill="none" stroke="#16161d" strokeOpacity="0.1" strokeWidth="0.6" />
        </pattern>
        <clipPath id="plot">
          <rect x={plot.x} y={plot.y} width={plot.w} height={plot.h} />
        </clipPath>
      </defs>

      {/* graph paper */}
      <rect x={plot.x} y={plot.y} width={plot.w} height={plot.h} fill="#ffffff" />
      <rect x={plot.x} y={plot.y} width={plot.w} height={plot.h} fill="url(#gridS)" />
      <rect x={plot.x} y={plot.y} width={plot.w} height={plot.h} fill="url(#gridL)" />
      <rect x={plot.x} y={plot.y} width={plot.w} height={plot.h} fill="none" stroke="#16161d" strokeOpacity="0.18" strokeWidth="0.8" />

      {/* split between the real race and the fantasy band up top */}
      {scale.splitY !== null && (
        <>
          <line x1={plot.x} x2={plot.x + plot.w} y1={scale.splitY} y2={scale.splitY} stroke="#d9831f" strokeOpacity="0.25" strokeWidth="0.8" strokeDasharray="1 5" />
          <text x={plot.x + plot.w - 6} y={scale.splitY - 5} fontSize="9.5" fill="#d9831f" fillOpacity="0.6" textAnchor="end" fontStyle="italic">
            de aca para arriba, otra galaxia
          </text>
        </>
      )}

      {/* baseline: starting capital */}
      <line x1={plot.x} x2={plot.x + plot.w} y1={scale.baselineY} y2={scale.baselineY} stroke="#16161d" strokeOpacity="0.3" strokeWidth="0.8" strokeDasharray="2 4" />
      <text x={plot.x + 6} y={scale.baselineY - 5} fontSize="10" fill="#16161d" fillOpacity="0.45">
        ${capital.toFixed(0)} iniciales
      </text>

      {/* series */}
      {withPoints.map((s) => (
        <path
          key={s.key}
          d={path(s.points.map((p) => ({ x: x(p.ts), y: y(p.value) })))}
          fill="none"
          stroke={s.color}
          strokeWidth={s.emphasis ? 2.4 : 1.4}
          strokeDasharray={s.dash}
          strokeLinejoin="round"
          strokeLinecap="round"
          clipPath="url(#plot)"
        />
      ))}

      {/* end dots + labels */}
      {labels.map(({ s, px, py, value, labelY }) => (
        <g key={s.key}>
          <circle cx={px} cy={py} r={s.emphasis ? 4 : 3} fill={s.color} />
          {Math.abs(labelY - py) > 8 && (
            <line x1={px + 4} y1={py} x2={W - PAD.right + 4} y2={labelY - 3} stroke={s.color} strokeOpacity="0.35" strokeWidth="0.6" />
          )}
          <text x={W - PAD.right + 8} y={labelY} fontSize="11" fontWeight={s.emphasis ? 700 : 500} fill={s.color}>
            {s.name} {fmtPct(value, capital)}
          </text>
        </g>
      ))}

      {/* x axis dates */}
      <text x={plot.x} y={H - 8} fontSize="10" fill="#16161d" fillOpacity="0.5">
        {fmtDate(minX)}
      </text>
      <text x={plot.x + plot.w} y={H - 8} fontSize="10" fill="#16161d" fillOpacity="0.5" textAnchor="end">
        {fmtDate(maxX)}
      </text>
    </svg>
  );
}
