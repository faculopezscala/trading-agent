import Link from "next/link";
import { EquityChart } from "../components/EquityChart";
import { Race } from "../components/Race";
import { buildSeries, DEFAULT_CAPITAL, experimentWindow, standings } from "../lib/benchmarks";
import {
  getBtcSpot,
  getJournal,
  getPositions,
  getSnapshots,
  getSpyHistory,
  getStatus,
  getTrades,
} from "../lib/data";

export const revalidate = 60;

function money(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined) return "-";
  return `$${n.toLocaleString("es-AR", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

function pct(n: number | null): string {
  if (n === null) return "-";
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
}

function cls(n: number | null): string {
  if (n === null) return "";
  return n >= 0 ? "up" : "down";
}

export default async function Page() {
  const [status, snapshots, positions, trades, journal] = await Promise.all([
    getStatus(),
    getSnapshots(),
    getPositions(),
    getTrades(),
    getJournal(),
  ]);

  const capital = status?.initial_capital ?? DEFAULT_CAPITAL;
  const equity = status?.equity_usd ?? null;
  const pnlUsd = equity !== null && capital > 0 ? equity - capital : null;
  const pnlPct = pnlUsd !== null && capital > 0 ? (pnlUsd / capital) * 100 : null;
  const apiCost = status?.api_cost_total_usd ?? null;

  const { day1Ts, nowTs } = experimentWindow(snapshots);
  const [spyHistory, btcSpot] = await Promise.all([getSpyHistory(day1Ts), getBtcSpot()]);
  const series = buildSeries({ snapshots, capital, day1Ts, nowTs, spyHistory, btcSpot });
  const board = standings(series, capital);
  const noDataYet = equity === null;

  return (
    <main className="wrap">
      <header className="top">
        <div className="brand">
          <span className="dot" />
          timberbot
        </div>
        <nav className="nav">
          {status?.kill_switch && <span className="badge frozen">congelado</span>}
          <span className={`badge ${status?.mode === "live" ? "live" : status?.mode === "notify" ? "notify" : "dry"}`}>
            {status?.mode === "live" ? "en vivo" : status?.mode === "notify" ? "señales" : "simulado"}
          </span>
          <Link href="/about" className="navlink">
            que es esto
          </Link>
        </nav>
      </header>

      <section className="hero">
        <div className="hero-label">El experimento</div>
        <h1 className="hero-title">Dejé un bot de IA tradeando solo, a ver si le gana al mercado.</h1>
        <div className="hero-numbers">
          <div className="equity">{equity === null ? "$ —" : money(equity)}</div>
          <div className={`pnl ${cls(pnlPct)}`}>
            {noDataYet
              ? "todavia no largó · deposito la guita y arranca"
              : `${pnlUsd! >= 0 ? "+" : ""}${money(pnlUsd)} (${pct(pnlPct)}) desde el dia 1`}
          </div>
        </div>
        <p className="hero-sub">
          Arranqué con {money(capital, 0)} reales en Wallbit. El bot decide todo solo: Claude piensa el plan, el código lo
          ejecuta. Yo solo miro. Gane o pierda, está todo acá, sin recortes.
        </p>
      </section>

      <section className="race-section">
        <div className="section-head">
          <h2>Cómo voy contra el resto</h2>
          <span className="section-note">todos largan con $100 hoy... menos Adorni</span>
        </div>
        <div className="paper chart">
          <EquityChart series={series} capital={capital} />
        </div>
        <Race standings={board} />
        <p className="fineprint">
          El <strong>S&amp;P 500</strong> es la jugada aburrida y sensata, el rival a vencer. El{" "}
          <strong>Bot Cositorto</strong> te promete duplicar la plata mes a mes: por lejos lo más prudente, ¿qué puede
          salir mal? Y la <strong>Cartera Adorni</strong> directamente metió $100 al Bitcoin en 2013, así que arranca
          arriba de todo, en otra galaxia. Un genio.
          {noDataYet && " Mi bot todavía no largó, pero los rivales ya están corriendo."}
        </p>
      </section>

      <section>
        <div className="section-head">
          <h2>Qué está pensando hoy</h2>
          <span className="section-note">{status?.thesis_date ?? ""}</span>
        </div>
        <div className="paper thesis">{status?.thesis ?? "El bot todavía no soltó su primer plan. Paciencia."}</div>
      </section>

      <section>
        <div className="section-head">
          <h2>Qué tiene comprado</h2>
        </div>
        {positions.length === 0 ? (
          <div className="paper empty-row">Cero posiciones abiertas. La plata está en efectivo, esperando.</div>
        ) : (
          <div className="paper">
            <table>
              <thead>
                <tr>
                  <th>Ticker</th>
                  <th className="num">Shares</th>
                  <th className="num">Promedio</th>
                  <th className="num">Ahora</th>
                  <th className="num">P&amp;L</th>
                </tr>
              </thead>
              <tbody>
                {positions.map((p) => {
                  const pnlP = p.pnl_usd !== null && p.cost_basis > 0 ? (p.pnl_usd / p.cost_basis) * 100 : null;
                  return (
                    <tr key={p.ticker}>
                      <td className="mono strong">{p.ticker}</td>
                      <td className="num mono">{p.shares.toFixed(4)}</td>
                      <td className="num">{money(p.avg_cost)}</td>
                      <td className="num">{money(p.last_price)}</td>
                      <td className={`num ${cls(p.pnl_usd)}`}>
                        {p.pnl_usd === null ? "-" : `${p.pnl_usd >= 0 ? "+" : ""}${money(p.pnl_usd)} (${pct(pnlP)})`}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section>
        <div className="section-head">
          <h2>Lo último que hizo</h2>
        </div>
        {trades.length === 0 ? (
          <div className="paper empty-row">Todavía no operó ni una vez.</div>
        ) : (
          <div className="paper">
            <table>
              <thead>
                <tr>
                  <th>Fecha</th>
                  <th>Operación</th>
                  <th className="num">Monto</th>
                  <th>Estado</th>
                </tr>
              </thead>
              <tbody>
                {trades.map((t, i) => (
                  <tr key={i}>
                    <td className="mono">
                      {new Date(t.ts).toLocaleDateString("es-AR", { day: "2-digit", month: "short", timeZone: "America/New_York" })}
                    </td>
                    <td>
                      <span className={`pill ${t.side === "buy" ? "buy" : "sell"}`}>{t.side === "buy" ? "COMPRA" : "VENTA"}</span>{" "}
                      <span className="mono strong">{t.ticker}</span>
                      {t.reason && <span className="reason">{t.reason}</span>}
                    </td>
                    <td className="num">{money(t.fill_usd ?? t.req_amount_usd)}</td>
                    <td className="mono muted">{t.mode === "dry" ? "simulado" : t.status === "awaiting_manual" ? "esperando" : t.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section>
        <div className="section-head">
          <h2>Las cuentas claras</h2>
          <span className="section-note">lo que gana vs lo que cuesta pensarlo</span>
        </div>
        <div className="metrics">
          <div className="paper metric">
            <div className="label">P&amp;L del trading</div>
            <div className={`value ${cls(pnlUsd)}`}>{pnlUsd === null ? "-" : `${pnlUsd >= 0 ? "+" : ""}${money(pnlUsd)}`}</div>
          </div>
          <div className="paper metric">
            <div className="label">Costo de IA (Claude)</div>
            <div className="value">{apiCost === null ? "-" : `−${money(apiCost)}`}</div>
          </div>
          <div className="paper metric">
            <div className="label">Neto de verdad</div>
            <div className={`value ${cls(pnlUsd !== null && apiCost !== null ? pnlUsd - apiCost : null)}`}>
              {pnlUsd !== null && apiCost !== null ? `${pnlUsd - apiCost >= 0 ? "+" : ""}${money(pnlUsd - apiCost)}` : "-"}
            </div>
          </div>
        </div>
      </section>

      {journal.length > 0 && (
        <section>
          <div className="section-head">
            <h2>El diario del bot</h2>
            <span className="section-note">lo que pensó, en sus palabras</span>
          </div>
          <div className="paper">
            {journal.map((j, i) => (
              <div className="journal-entry" key={i}>
                <div className="meta">
                  {j.date} · {j.type}
                </div>
                {j.content.length > 520 ? j.content.slice(0, 520) + "…" : j.content}
              </div>
            ))}
          </div>
        </section>
      )}

      <footer>
        <div>
          Timberbot · un experimento de trading autónomo, en público. <Link href="/about">Cómo funciona →</Link>
        </div>
        <div className="disclaimer">
          Esto no es consejo financiero ni nada que se le parezca. Es plata real que se puede ir a cero a propósito.
          {status?.updated_at && ` Actualizado: ${new Date(status.updated_at).toLocaleString("es-AR")}.`}
        </div>
      </footer>
    </main>
  );
}
