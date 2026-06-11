# wallbit-trading-agent

> Un bot de IA tradeando solo con **$100** reales sobre Wallbit, en vivo y en público.
> El dashboard se llama **Timberbot** y compite contra el S&P 500, el Bot Cositorto y la Cartera Adorni.

Dos cerebros, una sola fuente de verdad:

- **Planner** (Claude + web search): lee noticias y emite un plan en JSON, machine-readable.
- **Executor** (determinístico, sin LLM): evalúa las reglas del plan contra precios reales y dispara. Cero tokens en el hot path.

El LLM piensa, el código ejecuta. **SQLite es la única fuente de verdad**; el dashboard y el deploy remoto se construyen alrededor de ese archivo.

---

## Cómo piensa (cadencia de modelos)

Para mantener el gasto por debajo de **$10/mes** sin resignar análisis:

| Día | Modelo | Web search | Para qué |
|---|---|---|---|
| **Lunes** (y la 1ra corrida de todas) | `claude-opus-4-8` (deep) | 6 búsquedas | Fija la tesis de la semana |
| **Martes a viernes** | `claude-sonnet-4-6` | 3 búsquedas | Ajusta dentro de esa tesis |

El mid-day está **apagado** por defecto (`MIDDAY_ENABLED`). Todo configurable por env:
`WEEKLY_DEEP_PLAN`, `DEEP_PLAN_WEEKDAY` (1 = lunes), `PLANNER_MODEL`, `DAILY_MODEL`.

---

## Setup

```bash
bun install
cp .env.example .env    # completar ANTHROPIC_API_KEY (y WALLBIT_API_KEY cuando exista)
bun test                # 99 tests: motor de reglas, guardrails, calendario, executor, broker
bun run smoke           # chequea quotes de Yahoo + que los model IDs resuelvan
```

Sin `WALLBIT_API_KEY` el sistema corre completo en **dry-run** (broker de papel con $100 simulados, fills al precio de mercado real).

---

## Modos de ejecución (`EXECUTION_MODE`)

Los tres comparten todo el pipeline (planner, motor de reglas, guardrails); solo cambia el último paso:

- **`dry_run`** — loguea la orden en SQLite como simulada. Para los primeros días.
- **`notify`** (fase live de v1, **no requiere Wallbit Pro**) — manda por webhook la orden exacta lista para ejecutar a mano:
  `SEÑAL: COMPRAR NVDA $40 a ~$142.30 · stop loss $135.00 · take profit $155.00`.
  El sistema detecta el fill real en el próximo poll de posiciones (alcanza scope `read`). Si en 15 min no apareció, re-notifica una vez; a los 30 min marca orden y regla como `missed`. Ventas o stops nativos ejecutados en la app se detectan y reconcilian solos.
- **`live`** — ejecuta directo vía API (requiere plan Pro de Wallbit, ~$9/mes). Mismo código, distinta llave.

### Cuando tengas la API key de Wallbit (scope `read` alcanza para notify)

```bash
bun run verify          # read-only: balances, catálogo, fees, frescura Wallbit vs Yahoo
bun run verify --init   # captura capital inicial real, baseline SPY y reconcilia posiciones
```

---

## Deploy

### Opción A — Gratis, sin máquina prendida (GitHub Actions + Supabase) · recomendada

El estado vive en **Supabase Storage**: cada corrida baja la DB, opera y la vuelve a subir. Un workflow de GitHub Actions (`.github/workflows/agent.yml`) corre `bun run tick` por **cron cada ~5 min** en horario de mercado.

> No es realtime: el cron puede demorarse o saltearse alguna corrida. Para `notify` (ejecutás a mano) es más que suficiente.

**Pasos:**

1. Subí el repo a GitHub **público** (Actions ilimitado gratis). Las claves nunca van al repo.
2. Creá un proyecto en Supabase y corré `supabase/schema.sql` en el SQL Editor.
3. En GitHub → **Settings → Secrets and variables → Actions**, cargá:
   `ANTHROPIC_API_KEY`, `WALLBIT_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `WEBHOOK_URL`.
4. Probalo a mano: pestaña **Actions → agent-tick → Run workflow**.

El bucket `agent-state` de Storage se crea solo en la primera corrida.

### Opción B — Proceso 24/7 (Mac con launchd, o Fly.io)

```bash
bun start               # scheduler + executor + planner, loop cada 15s
```

launchd (Mac clamshell):

```bash
./scripts/install-launchd.sh
sudo pmset -a sleep 0 disksleep 0 autorestart 1
```

En Fly.io corre el mismo `bun start` sin cambios. Logs en `logs/agent-YYYY-MM-DD.log` (retención 14 días).

---

## Comandos

```bash
bun start               # proceso largo (local / Fly)
bun run tick            # una sola pasada (lo que usa GitHub Actions)
bun run plan            # corrida manual del planner
bun run plan --midday   # revisión de mediodía manual
bun run review          # review semanal manual
bun run stats           # P&L, costos API, hit rate, uptime
bun run unfreeze        # libera el kill switch tras revisión manual
```

---

## Cronograma (ET)

| Hora | Qué |
|---|---|
| 08:30 | Planner pre-market (lunes: Opus deep 6 búsquedas · resto: Sonnet 3 búsquedas) |
| 09:30–16:00 | Executor (cada 90s local · cada ~5 min en GitHub Actions) + sync Supabase |
| 12:30 | Mid-day (apagado por defecto, `MIDDAY_ENABLED`) |
| 16:05 | Cierre del día: journal + snapshot |
| Vie 16:10 | Review semanal (`claude-fable-5`): reescribe `strategy.md` |

---

## Guardrails (en código, el planner no los puede tocar)

Invertido máximo = capital inicial · **40% máx por posición** · **8 órdenes/día** (solo compras) · compra sin stopLoss rechazada · **-8% diario** congela compras · **equity < 65%** del capital inicial = **kill switch** (todo congelado hasta `bun run unfreeze`) · solo catálogo Wallbit con precio > $5.

Las ventas (stops/exits) nunca se bloquean por cap ni por daily stop. Los fills nunca se asumen: la orden queda pendiente y se verifica contra el delta real de shares del portfolio.

---

## Dashboard público — Timberbot

Minimalista, en vivo: tu bot vs **S&P 500** (lo aburrido), **Bot Cositorto** (la estafa que "duplica mes a mes") y **Cartera Adorni** (metió $100 al Bitcoin en 2013, un genio).

1. Supabase: `supabase/schema.sql` ya corrido (mismo proyecto del agente).
2. Deploy de `dashboard/` en **Vercel** con **Root Directory = `dashboard`**.
3. Env vars del dashboard (lectura pública, anon key): `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `NEXT_PUBLIC_SITE_URL`.

Push one-way y best-effort: si Supabase o Vercel se caen, el trading no se entera. La service key nunca toca el front.

---

## Precios

**Yahoo Finance chart API** como fuente primaria (gratis, sin key: precio + previous close + open, frescura ~tiempo real para US equities). Endpoint no oficial, por eso está detrás de `prices.ts` con cache de 55s. **Wallbit `/assets/{symbol}`** queda como cross-check/fallback (`PRICE_SOURCE=wallbit` si `bun run verify` confirma frescura). `pct_change_intraday_*` se mide vs **previous close**.

---

## Costos

Target **< $1.50/día, < $10/mes**. Cada llamada registra tokens, búsquedas web y costo estimado en `api_costs`.
Referencia real: el deep de Opus sale **~$1.14**; los días de Sonnet, centavos. El executor cuesta **$0** por diseño.

Si `bun run stats` muestra que se pasa, hay **alerta automática por webhook**; bajá `DAILY_MODEL` a un modelo más barato en `.env`.

---

## Go-live checklist

1. 3–5 días en `EXECUTION_MODE=dry_run` con planes reales.
2. Revisar planes / journal / órdenes simuladas (`bun run stats` + dashboard).
3. Cargar ~$100 en la cuenta **de inversión** de Wallbit y `bun run verify --init`.
4. `EXECUTION_MODE=notify` + `WEBHOOK_URL`, reiniciar el servicio. El sistema señala, vos ejecutás en la app.
5. `EXECUTION_MODE=live` queda listo: se activa solo si más adelante pagás Wallbit Pro y creás una key con scope `trade`.
