import type { Standing } from "../lib/benchmarks";

function money(n: number): string {
  return `$${n.toLocaleString("es-AR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function Race({ standings }: { standings: Standing[] }) {
  if (standings.length === 0) return null;
  return (
    <ol className="race">
      {standings.map((st, i) => {
        const up = (st.returnPct ?? 0) >= 0;
        return (
          <li key={st.series.key} className={`standing${st.series.emphasis ? " me" : ""}`}>
            <span className="rank">{st.noData ? "·" : i + 1}</span>
            <span className="who">
              <span className="name">
                <span className="swatch" style={{ background: st.series.color }} />
                {st.series.name}
                {st.series.emphasis && <span className="tag real">el experimento</span>}
              </span>
              {st.series.sub && <span className="subname">{st.series.sub}</span>}
            </span>
            <span className="result mono">
              {st.noData || st.returnPct === null || st.value === null ? (
                <span className="waiting">todavia sin data</span>
              ) : (
                <>
                  <span className={up ? "up" : "down"}>
                    {st.returnPct >= 0 ? "+" : ""}
                    {st.returnPct.toFixed(2)}%
                  </span>
                  <span className="val">{money(st.value)}</span>
                </>
              )}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
