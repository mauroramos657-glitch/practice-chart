# Practice Chart — gráfico de trading para practicar (paper trading)

App web (Flask + [Lightweight Charts](https://tradingview.github.io/lightweight-charts/) de
TradingView) para practicar lectura de gráficos y gestión de riesgo con precios **reales**,
sin arriesgar plata real.

## Qué hace de verdad (y qué no)

**Sí, con datos reales:**
- Velas reales de **Binance** (cripto, WebSocket en vivo, tick a tick) y **Yahoo Finance**
  (forex/acciones/ETFs, con polling cada 20s — Yahoo no tiene WebSocket público).
- Herramientas de dibujo reales sobre el gráfico: línea de tendencia, horizontal, rayo,
  rectángulo y Fibonacci (con imán/snap opcional a los OHLC de la vela).
- Indicadores reales calculados en el cliente: SMA, EMA, Bollinger, RSI, MACD (verificados
  contra pandas/numpy — ver `tests/`).
- Modo **Replay**: congela el feed en vivo, elegís una barra de inicio (o arranca a la mitad
  del historial cargado) y avanzás vela por vela o en automático a distintas velocidades.
- Simulador de órdenes (paper trading): Comprar/Vender, SL/TP con Take Profit y tamaño de
  posición calculados solos a partir de tu % de riesgo y ratio R:R (editables), balance
  persistente, historial y estadísticas (efectividad, factor de beneficio, drawdown, curva
  de equity), exportación a CSV.

**No, y por qué:**
- **No es TradingView.** Es un clon simplificado con lo esencial que pediste (mover/zoomear
  el gráfico ya lo trae Lightweight Charts de fábrica: arrastrar, rueda del mouse, pellizcar
  en celular). No tiene guardado de layouts en la nube, alertas, Pine Script, ni cientos de
  indicadores.
- **El Replay no "rebobina a cualquier fecha pasada" todavía**: trabaja sobre el lote de
  velas ya cargado (500 por defecto). El backend ya soporta pedir rangos de fecha
  (`start`/`end` en `/api/candles`), pero conectar eso a un selector de fecha en la UI queda
  como próximo paso si te sirve.
- **Las órdenes son 100% simuladas** (papel). No hay conexión a ningún bróker ni exchange
  real: ninguna operación mueve plata de verdad.
- El plan gratuito de Yahoo/Binance públicos no requiere API key, pero **Binance puede estar
  bloqueado o limitado según el país/hosting** (algunos proveedores de nube bloquean IPs de
  EE.UU./ciertas regiones para Binance). Si eso pasa, usá el proveedor Yahoo mientras tanto.

## Estructura

```
app.py                  Backend Flask: sirve la página y hace de proxy de /api/candles
static/index.html       Interfaz
static/css/app.css      Estilos (tema oscuro)
static/js/core.js       Indicadores, motor de órdenes, estadísticas, zonas horarias (sin DOM)
static/js/drawings.js   Herramientas de dibujo (primitivas de Lightweight Charts v5)
static/js/app.js        Orquesta todo: datos, indicadores, replay, panel de operaciones
tests/test_core.js      21 tests de core.js (indicadores comparados con pandas/numpy)
tests/gen_reference.py  Genera los valores de referencia de pandas para los tests
tests/test_ui.py        Prueba de extremo a extremo con Playwright (mockea la red)
```

## Correr en local

```bash
pip install -r requirements.txt
python app.py
# abrir http://localhost:5000
```

Para probar el núcleo de cálculo (indicadores, órdenes, estadísticas, zonas horarias):

```bash
python3 tests/gen_reference.py   # requiere pandas/numpy, genera tests/reference.json
node tests/test_core.js
```

## Desplegar gratis (para poder abrirlo desde el celu o donde sea)

### Opción A — Render.com (recomendada, tiene `render.yaml` ya armado)
1. Subí esta carpeta a un repositorio de GitHub.
2. Entrá a [render.com](https://render.com) → **New** → **Blueprint** → elegí el repo.
   Render va a leer `render.yaml` solo.
3. Esperá el build (1-2 minutos) y abrí la URL que te da (`https://tu-app.onrender.com`).

Si preferís no usar Blueprint: **New → Web Service**, conectá el repo, y completá:
- Build command: `pip install -r requirements.txt`
- Start command: `gunicorn app:app --bind 0.0.0.0:$PORT`

**Importante del plan free de Render:** el servicio "se duerme" tras ~15 min sin uso y
tarda unos 30-50s en despertar la próxima vez que entrás. Es normal, no es un error.

### Opción B — Railway.app
1. `railway init` en esta carpeta (o subí el repo y "Deploy from GitHub").
2. Railway detecta el `Procfile` solo. Variables de entorno: ninguna obligatoria.
3. Te da una URL pública al terminar el deploy.

### Variables de entorno opcionales
- `RATE_LIMIT_PER_MIN` (default `240`): pedidos por minuto por IP al endpoint `/api/candles`.
- `PORT`: la pone la plataforma sola; en local usa `5000`.

## Notas de seguridad / límites
- El backend cachea cada pedido de velas unos segundos y limita pedidos por IP, para no
  golpear a Binance/Yahoo de más ni que te bloqueen.
- Todo el estado de trading (balance, historial, operación abierta) vive en el
  `localStorage` del navegador — es por dispositivo/navegador, no hay cuenta ni backend de
  usuarios. Si borrás datos del sitio, se resetea.
