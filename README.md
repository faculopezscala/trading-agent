# wallbit-trading-agent

Sistema de trading autónomo sobre Wallbit. Dos cerebros:

- **Planner** (`claude-sonnet-4-6` + web search, 1-2 corridas/día): lee noticias y emite un plan JSON machine-readable.
- **Executor** (determinístico, sin LLM, cada 90s en horario de mercado): evalúa las reglas del plan contra precios reales y ejecuta. Cero tokens en el hot path.

El LLM piensa, el código ejecuta. SQLite es la única fuente de verdad.

## Setup

```bash
bun install
cp .env.example .env   # completar ANTHROPIC_API_KEY (y WALLBIT_API_KEY cuando exista)
bun test               # 89 tests: motor de reglas, guardrails, calendario, executor
bun run smoke          # chequea quotes de Yahoo + que los model IDs resuelvan
```

Sin `WALLBIT_API_KEY` el sistema corre completo en **dry-run** (broker de papel con $150 simulados, fills al precio de mercado real).

## Modos de ejecución (`EXECUTION_MODE`)

Los tres comparten todo el pipeline (planner, motor de reglas, guardrails); solo cambia el último paso:

- **`dry_run`**: loguea la orden en SQLite como simulada. Para los primeros días.
- **`notify`** (fase live de v1, **no requiere Wallbit Pro**): manda por webhook la orden exacta lista para ejecutar a mano en la app, ej: `SEÑAL: COMPRAR NVDA $40 a ~$142.30. Cargar en la app: stop loss $135.00, take profit $155.00`. El sistema detecta el fill real en el próximo poll de posiciones (solo scope `read`). Si en 15 min no apareció, re-notifica una vez; a los 30 min marca orden y regla como `missed`. Los SL/TP van siempre en la señal para cargarlos como órdenes nativas de Wallbit: la protección no depende de que la Mac esté viva ni de que veas el teléfono. Ventas manuales o stops nativos que ejecuten en la app se detectan y reconcilian solos.
- **`live`**: ejecuta directo vía API (requiere plan Pro de Wallbit, ~$9/mes). Mismo código, distinta llave.

### Cuando tengas la API key de Wallbit (scope read alcanza para notify)

```bash
bun run verify          # read-only: balances, catálogo, fees, frescura de precios Wallbit vs Yahoo
bun run verify --init   # captura capital inicial real, baseline SPY y reconcilia posiciones
```

### Correr

```bash
bun start               # proceso completo (scheduler + executor + planner)
bun run plan            # corrida manual del planner (para probar ya mismo)
bun run plan --midday   # revisión de mediodía manual
bun run review          # review semanal manual
bun run stats           # P&L, costos API, hit rate, uptime
bun run unfreeze        # libera el kill switch tras revisión manual
```

### Deploy en launchd (Mac clamshell)

```bash
./scripts/install-launchd.sh
sudo pmset -a sleep 0 disksleep 0
sudo pmset -a autorestart 1
pmset -g    # verificar
```

Logs de texto en `logs/agent-YYYY-MM-DD.log` (retención 14 días). Trades, planes, journal y P&L viven en `data/agent.db` para siempre.

## Cronograma (ET)

| Hora | Qué |
|---|---|
| 08:30 | Planner pre-market (web search, máx 6 búsquedas) |
| 09:30-16:00 | Executor cada `TICK_INTERVAL_SEC` (90s) + sync Supabase cada 15 min |
| 12:30 | Revisión mid-day (solo cancela reglas / agrega exits) |
| 16:05 | Cierre del día: journal + snapshot |
| Vie 16:10 | Review semanal (`claude-fable-5`): reescribe `strategy.md` |

## Decisiones que te debo avisar

- **Precios: Yahoo Finance chart API como fuente primaria.** Gratis, sin key, precio + previous close + open con frescura ~tiempo real para US equities. Es un endpoint no oficial: puede cambiar sin aviso, por eso está detrás de una interfaz (`prices.ts`). Presupuesto de rate: 1 request por ticker por tick, con cache de 55s y ≤12 tickers ≈ 480 req/h peor caso, muy por debajo de lo tolerado. **Wallbit `/assets/{symbol}` queda como cross-check/fallback**: no expone previous close y su frescura está sin verificar hasta tener la key (`bun run verify` la mide; si resulta fresca, `PRICE_SOURCE=wallbit`).
- **`pct_change_intraday_*` se mide vs previous close** (el "% del día" estándar de cualquier broker), no vs open.
- **Cap de 8 órdenes/día aplica a compras; las ventas (stops/exits) nunca se bloquean** por cap ni por daily stop. Kill switch sí congela todo.
- **Fills nunca se asumen** (live ni notify): la orden queda pendiente y se verifica contra el delta de shares del portfolio real. Live: `unverified` a los 15 min. Notify: recordatorio a los 15 min, `missed` a los 30.

## Guardrails (en código, el planner no los puede tocar)

Invertido máximo = capital inicial · 40% máx por posición · 8 órdenes/día · compra sin stopLoss rechazada · -8% diario congela compras · equity < 65% del capital inicial = kill switch (todo congelado hasta `bun run unfreeze`) · solo catálogo Wallbit con precio > $5.

## Dashboard público (build in public)

1. Crear proyecto en Supabase, correr `supabase/schema.sql` en el SQL editor.
2. En `.env` del agente: `SUPABASE_URL` + `SUPABASE_SERVICE_KEY` (service role).
3. Deploy de `dashboard/` en Vercel con `NEXT_PUBLIC_SUPABASE_URL` + `NEXT_PUBLIC_SUPABASE_ANON_KEY`.

Push one-way y best-effort: si Supabase o Vercel se caen, el trading no se entera.

## Go-live checklist

1. 3-5 días con `EXECUTION_MODE=dry_run` y planes reales (`bun start`).
2. Revisar planes/journal/órdenes simuladas (`bun run stats` + dashboard).
3. `bun run verify --init` con la key real (scope read alcanza).
4. `EXECUTION_MODE=notify` en `.env` + `WEBHOOK_URL` configurado, reiniciar el servicio: `launchctl unload ~/Library/LaunchAgents/com.facu.wallbit-agent.plist && launchctl load ~/Library/LaunchAgents/com.facu.wallbit-agent.plist`. Esta es la fase live de v1: el sistema señala, vos ejecutás en la app.
5. `EXECUTION_MODE=live` queda implementado; se activa solo si más adelante pagás Wallbit Pro y creás una key con scope `trade`.

## Costos

Target < $1.50/día, < $10/mes. Cada llamada registra tokens (input/cached/output), búsquedas web y costo estimado en `api_costs`. Si `bun run stats` muestra que el planner se pasa, bajar `PLANNER_MODEL=claude-haiku-4-5` en `.env` (hay alerta automática por webhook). El executor cuesta $0 por diseño. La escalación a `claude-haiku-4-5` ante eventos ambiguos queda stubbed para v2 (`ESCALATION_MODEL`).
