(function () {
  'use strict';
  const LC = LightweightCharts;
  const LS_KEY = 'ptc_state_v1';

  /* ============================== Estado ============================== */
  const SYMBOLS = {
    binance: [
      { symbol: 'BTCUSDT', desc: 'Bitcoin / Dólar', mult: 1, step: 0.0001 },
      { symbol: 'ETHUSDT', desc: 'Ethereum / Dólar', mult: 1, step: 0.001 },
      { symbol: 'SOLUSDT', desc: 'Solana / Dólar', mult: 1, step: 0.01 },
      { symbol: 'BNBUSDT', desc: 'BNB / Dólar', mult: 1, step: 0.001 },
    ],
    yahoo: [
      { symbol: 'EURUSD=X', desc: 'Euro / Dólar', mult: 100000, step: 1000 },
      { symbol: 'GBPUSD=X', desc: 'Libra / Dólar', mult: 100000, step: 1000 },
      { symbol: 'QQQ', desc: 'ETF Nasdaq-100 (proxy de MNQ)', mult: 1, step: 1 },
      { symbol: 'SPY', desc: 'ETF S&P 500', mult: 1, step: 1 },
    ],
  };
  const TFS = ['1m', '5m', '15m', '30m', '1h', '4h', '1d'];
  const BINANCE_TF_MS = { '1m': 60e3, '5m': 300e3, '15m': 900e3, '30m': 1800e3, '1h': 3600e3, '4h': 14400e3, '1d': 86400e3 };

  const st = {
    provider: 'binance', symbol: 'BTCUSDT', interval: '15m', mult: 1, step: 0.0001,
    tz: 'America/Argentina/Buenos_Aires',
    candles: [], // {time (seg UTC), open, high, low, close}
    ws: null, pollTimer: null,
    indicators: { sma: false, ema: false, bb: false, rsi: false, macd: false },
    indicatorParams: { smaP: 20, emaP: 20, bbP: 20, bbK: 2, rsiP: 14, macdF: 12, macdS: 26, macdSig: 9 },
    seriesInd: {}, // handles de series de indicadores
    replay: { on: false, all: [], idx: 0, playing: false, timer: null },
    balance: 10000, riskPct: 1, rr: 2,
    position: null, // {side, entry, sl, tp, qty, openTime, priceLines:[...]}
    trades: [],
    dm: null, // DrawingManager
  };

  function save() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({
        balance: st.balance, trades: st.trades, riskPct: st.riskPct, rr: st.rr, tz: st.tz,
      }));
    } catch (e) { /* localStorage puede no estar disponible */ }
  }
  function load() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return;
      const d = JSON.parse(raw);
      if (typeof d.balance === 'number') st.balance = d.balance;
      if (Array.isArray(d.trades)) st.trades = d.trades;
      if (typeof d.riskPct === 'number') st.riskPct = d.riskPct;
      if (typeof d.rr === 'number') st.rr = d.rr;
      if (d.tz) st.tz = d.tz;
    } catch (e) { /* ignorar estado corrupto */ }
  }

  function toast(msg, kind) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.className = kind || '';
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { el.className = 'hidden'; }, 3200);
  }

  /* ============================== Chart ============================== */
  const container = document.getElementById('chartContainer');
  const chart = LC.createChart(container, {
    layout: { background: { type: 'solid', color: '#131722' }, textColor: '#d1d4dc' },
    grid: { vertLines: { color: '#2a2e39' }, horzLines: { color: '#2a2e39' } },
    rightPriceScale: { borderColor: '#2a2e39' },
    timeScale: {
      borderColor: '#2a2e39', timeVisible: true, secondsVisible: false,
      tickMarkFormatter: (time, tickMarkType) => Core.fmtTick(time, tickMarkType, st.tz),
    },
    localization: {
      timeFormatter: (time) => Core.fmtDateTime(time, st.tz),
    },
    crosshair: { mode: LC.CrosshairMode.Normal },
  });
  const mainSeries = chart.addSeries(LC.CandlestickSeries, {
    upColor: '#26a69a', downColor: '#ef5350', borderVisible: false,
    wickUpColor: '#26a69a', wickDownColor: '#ef5350',
  });

  function resizeChart() {
    chart.resize(container.clientWidth, container.clientHeight);
  }
  window.addEventListener('resize', resizeChart);
  new ResizeObserver(resizeChart).observe(container);

  st.dm = new Drawings.DrawingManager(chart, mainSeries, {
    getBar: (time) => st.candles.find((c) => c.time === time) || null,
  });

  /* ============================== Datos ============================== */
  function stopFeeds() {
    if (st.ws) { try { st.ws.close(); } catch (e) {} st.ws = null; }
    if (st.pollTimer) { clearInterval(st.pollTimer); st.pollTimer = null; }
    setLive(false);
  }
  function setLive(on) {
    const dot = document.getElementById('liveDot');
    dot.textContent = on ? '● en vivo' : '○ histórico';
    dot.className = on ? 'on' : 'off';
  }

  async function fetchCandles(limit) {
    const url = `/api/candles?provider=${st.provider}&symbol=${encodeURIComponent(st.symbol)}&interval=${st.interval}&limit=${limit || 500}`;
    const r = await fetch(url);
    const body = await r.json();
    if (!r.ok) throw new Error(body.error || ('HTTP ' + r.status));
    return body.candles;
  }

  function setOhlcReadout(c) {
    if (!c) { document.getElementById('ohlcReadout').textContent = ''; return; }
    const d = st.step < 1 ? Math.max(0, -Math.floor(Math.log10(st.step))) : 2;
    const f = (v) => v.toFixed(d);
    document.getElementById('ohlcReadout').textContent =
      `O ${f(c.open)}  H ${f(c.high)}  L ${f(c.low)}  C ${f(c.close)}`;
  }

  async function loadSymbol() {
    stopFeeds();
    document.getElementById('symName').textContent = st.symbol;
    const meta = (SYMBOLS[st.provider] || []).find((s) => s.symbol === st.symbol);
    document.getElementById('symDesc').textContent =
      (st.provider === 'binance' ? 'Binance · Cripto' : 'Yahoo Finance') + (meta ? ' · ' + meta.desc : '');
    try {
      st.candles = await fetchCandles(500);
    } catch (e) {
      toast('No se pudieron cargar velas: ' + e.message, 'err');
      st.candles = [];
    }
    mainSeries.setData(st.candles.map(toLC));
    setOhlcReadout(st.candles[st.candles.length - 1]);
    recomputeIndicators();
    chart.timeScale().fitContent();
    if (!st.replay.on) startFeed();
    checkPositionAgainstLast();
  }

  function toLC(c) { return { time: c.time, open: c.open, high: c.high, low: c.low, close: c.close }; }

  function upsertCandle(c) {
    const arr = st.candles;
    const last = arr[arr.length - 1];
    if (last && last.time === c.time) arr[arr.length - 1] = c;
    else if (!last || c.time > last.time) arr.push(c);
    else return; // dato viejo, se ignora
    mainSeries.update(toLC(c));
    setOhlcReadout(c);
    recomputeIndicators();
    if (st.position) checkPositionTick(c.close, c.time);
  }

  function startFeed() {
    if (st.provider === 'binance') {
      const stream = st.symbol.toLowerCase() + '@kline_' + st.interval;
      let ws;
      try { ws = new WebSocket('wss://stream.binance.com:9443/ws/' + stream); }
      catch (e) { toast('No se pudo abrir el WebSocket de Binance', 'err'); return; }
      st.ws = ws;
      ws.onopen = () => setLive(true);
      ws.onclose = () => setLive(false);
      ws.onerror = () => toast('Se cortó la conexión en vivo con Binance', 'warn');
      ws.onmessage = (ev) => {
        let msg; try { msg = JSON.parse(ev.data); } catch (e) { return; }
        const k = msg.k; if (!k) return;
        upsertCandle({
          time: Math.floor(k.t / 1000), open: +k.o, high: +k.h, low: +k.l, close: +k.c,
        });
      };
    } else {
      setLive(true);
      st.pollTimer = setInterval(async () => {
        try {
          const fresh = await fetchCandles(3);
          fresh.forEach(upsertCandle);
        } catch (e) { /* se reintenta en el próximo ciclo */ }
      }, 20000);
    }
  }

  /* ============================== Indicadores ============================== */
  function clearIndicatorSeries() {
    Object.values(st.seriesInd).forEach((s) => {
      (Array.isArray(s) ? s : [s]).forEach((x) => { try { chart.removeSeries(x); } catch (e) {} });
    });
    st.seriesInd = {};
  }

  function toLine(times, values) {
    const out = [];
    for (let i = 0; i < values.length; i++) if (values[i] != null) out.push({ time: times[i], value: values[i] });
    return out;
  }

  function recomputeIndicators() {
    clearIndicatorSeries();
    const times = st.candles.map((c) => c.time);
    const closes = st.candles.map((c) => c.close);
    const p = st.indicatorParams;
    if (st.indicators.sma) {
      const s = chart.addSeries(LC.LineSeries, { color: '#f2b90a', lineWidth: 2, priceLineVisible: false });
      s.setData(toLine(times, Core.sma(closes, p.smaP)));
      st.seriesInd.sma = s;
    }
    if (st.indicators.ema) {
      const s = chart.addSeries(LC.LineSeries, { color: '#4dd0e1', lineWidth: 2, priceLineVisible: false });
      s.setData(toLine(times, Core.ema(closes, p.emaP)));
      st.seriesInd.ema = s;
    }
    if (st.indicators.bb) {
      const b = Core.bollinger(closes, p.bbP, p.bbK);
      const up_ = chart.addSeries(LC.LineSeries, { color: 'rgba(150,150,255,.7)', lineWidth: 1, priceLineVisible: false });
      const lo_ = chart.addSeries(LC.LineSeries, { color: 'rgba(150,150,255,.7)', lineWidth: 1, priceLineVisible: false });
      up_.setData(toLine(times, b.upper)); lo_.setData(toLine(times, b.lower));
      st.seriesInd.bb = [up_, lo_];
    }
    if (st.indicators.rsi) {
      const s = chart.addSeries(LC.LineSeries, { color: '#ba68c8', lineWidth: 2, priceLineVisible: false }, 1);
      s.setData(toLine(times, Core.rsi(closes, p.rsiP)));
      s.createPriceLine({ price: 70, color: '#555', lineWidth: 1, lineStyle: LC.LineStyle.Dashed, axisLabelVisible: false });
      s.createPriceLine({ price: 30, color: '#555', lineWidth: 1, lineStyle: LC.LineStyle.Dashed, axisLabelVisible: false });
      st.seriesInd.rsi = s;
    }
    if (st.indicators.macd) {
      const m = Core.macd(closes, p.macdF, p.macdS, p.macdSig);
      const paneIdx = st.indicators.rsi ? 2 : 1;
      const hist = chart.addSeries(LC.HistogramSeries, { priceLineVisible: false }, paneIdx);
      hist.setData(times.map((t, i) => (m.hist[i] == null ? null : {
        time: t, value: m.hist[i], color: m.hist[i] >= 0 ? '#26a69a88' : '#ef535088',
      })).filter(Boolean));
      const line = chart.addSeries(LC.LineSeries, { color: '#2962ff', lineWidth: 1.5, priceLineVisible: false }, paneIdx);
      line.setData(toLine(times, m.macd));
      const sig = chart.addSeries(LC.LineSeries, { color: '#f2b90a', lineWidth: 1.5, priceLineVisible: false }, paneIdx);
      sig.setData(toLine(times, m.signal));
      st.seriesInd.macd = [hist, line, sig];
    }
  }

  /* ============================== Panel de operaciones ============================== */
  const $ = (id) => document.getElementById(id);
  let pendingSide = null;

  function refreshTradeUI() {
    $('balanceOut').textContent = st.balance.toFixed(2);
    $('modeOut').textContent = st.replay.on ? 'Replay (histórico)' : (st.provider === 'binance' ? 'Tiempo real' : 'Retrasado ~15 min');
    const noPos = !st.position;
    $('btnBuy').disabled = !noPos; $('btnSell').disabled = !noPos;
    $('pendingBox').classList.toggle('hidden', !pendingSide);
    $('posBox').classList.toggle('hidden', noPos);
    if (st.position) {
      const p = st.position;
      $('posSide').textContent = p.side === 'long' ? 'Compra' : 'Venta';
      $('posEntry').textContent = p.entry.toFixed(4);
      $('posSl').textContent = p.sl.toFixed(4);
      $('posTp').textContent = p.tp.toFixed(4);
      const last = st.candles[st.candles.length - 1];
      if (last) {
        const u = Core.unrealized({ side: p.side, entry: p.entry, sl0: p.sl0, qty: p.qty, mult: p.mult }, last.close);
        const el = $('posPnl');
        el.textContent = (u.pnl >= 0 ? '+' : '') + u.pnl.toFixed(2) + ' USD (' + u.r.toFixed(2) + 'R)';
        el.className = 'mono ' + (u.pnl >= 0 ? 'pnl-pos' : 'pnl-neg');
      }
    }
  }

  function currentPrice() {
    const last = st.candles[st.candles.length - 1];
    return last ? last.close : null;
  }

  function openPending(side) {
    if (st.position) { toast('Ya tenés una posición abierta', 'warn'); return; }
    const entry = currentPrice();
    if (entry == null) { toast('Todavía no hay precio cargado', 'warn'); return; }
    pendingSide = side;
    const sl = side === 'long' ? entry * 0.995 : entry * 1.005;
    const tp = Core.computeTp(side, entry, sl, st.rr);
    $('pEntry').textContent = entry.toFixed(4);
    $('pSl').value = sl.toFixed(6);
    $('pTp').value = tp.toFixed(6);
    $('pQty').value = Core.calcQty({ balance: st.balance, riskPct: st.riskPct, entry, sl, mult: st.mult, step: st.step });
    updatePendingRR();
    refreshTradeUI();
    st.dm.setTool(null);
    document.querySelectorAll('#toolbar .tool').forEach((b) => b.classList.remove('active'));
    document.querySelector('[data-tool="cursor"]').classList.add('active');
  }

  function updatePendingRR() {
    const entry = parseFloat($('pEntry').textContent);
    const sl = parseFloat($('pSl').value), tp = parseFloat($('pTp').value);
    const rr = Core.rrFrom(pendingSide, entry, sl, tp);
    $('pRR').textContent = Number.isFinite(rr) ? rr.toFixed(2) + ' : 1' : '—';
  }
  ['pSl'].forEach((id) => $(id).addEventListener('input', () => {
    const entry = parseFloat($('pEntry').textContent), sl = parseFloat($(id).value);
    if (Number.isFinite(entry) && Number.isFinite(sl)) {
      const tp = Core.computeTp(pendingSide, entry, sl, st.rr);
      $('pTp').value = tp.toFixed(6);
      $('pQty').value = Core.calcQty({ balance: st.balance, riskPct: st.riskPct, entry, sl, mult: st.mult, step: st.step });
    }
    updatePendingRR();
  }));
  $('pTp').addEventListener('input', updatePendingRR);

  function confirmOrder() {
    const entry = parseFloat($('pEntry').textContent);
    const sl = parseFloat($('pSl').value), tp = parseFloat($('pTp').value), qty = parseFloat($('pQty').value);
    const err = Core.validateOrder(pendingSide, entry, sl, tp);
    if (err) { toast(err, 'err'); return; }
    if (!(qty > 0)) { toast('La cantidad calculada es 0: subí el riesgo % o achicá la distancia al SL', 'err'); return; }
    const last = st.candles[st.candles.length - 1];
    st.position = {
      side: pendingSide, entry, sl, sl0: sl, tp, qty, mult: st.mult, feePct: 0.04,
      openTime: last ? last.time : Math.floor(Date.now() / 1000), symbol: st.symbol,
      mode: st.replay.on ? 'replay' : 'live',
      lines: [
        mainSeries.createPriceLine({ price: entry, color: '#2962ff', lineWidth: 1, lineStyle: LC.LineStyle.Dashed, title: 'Entrada' }),
        mainSeries.createPriceLine({ price: sl, color: '#ef5350', lineWidth: 1, lineStyle: LC.LineStyle.Dashed, title: 'SL' }),
        mainSeries.createPriceLine({ price: tp, color: '#26a69a', lineWidth: 1, lineStyle: LC.LineStyle.Dashed, title: 'TP' }),
      ],
    };
    pendingSide = null;
    refreshTradeUI();
    toast('Orden confirmada');
  }

  function cancelPending() { pendingSide = null; refreshTradeUI(); }

  function removePositionLines() {
    if (st.position) st.position.lines.forEach((l) => { try { mainSeries.removePriceLine(l); } catch (e) {} });
  }

  function finishPosition(exitPrice, exitTime, reason) {
    const trade = Core.closeTrade(st.position, exitPrice, exitTime, reason);
    removePositionLines();
    st.position = null;
    st.balance += trade.pnl;
    st.trades.push(trade);
    save();
    refreshTradeUI(); renderHistory(); renderStats();
    toast((trade.pnl >= 0 ? 'Ganancia' : 'Pérdida') + ': ' + trade.pnl.toFixed(2) + ' USD (' + reason + ')',
      trade.pnl >= 0 ? '' : 'warn');
  }

  // Se llama con cada vela completa nueva (histórico/replay): usa OHLC completo.
  function checkPositionBar(bar) {
    if (!st.position) return;
    const hit = Core.checkExitBar(st.position, bar);
    if (hit) finishPosition(hit.price, bar.time, hit.reason);
  }
  // Se llama con cada tick en vivo (la vela todavía puede no estar cerrada).
  function checkPositionTick(price, time) {
    if (!st.position) return;
    const hit = Core.checkExitTick(st.position, price);
    if (hit) finishPosition(hit.price, time, hit.reason);
  }
  function checkPositionAgainstLast() {
    const last = st.candles[st.candles.length - 1];
    if (last) checkPositionTick(last.close, last.time);
  }

  $('btnBuy').onclick = () => openPending('long');
  $('btnSell').onclick = () => openPending('short');
  $('pConfirm').onclick = confirmOrder;
  $('pCancel').onclick = cancelPending;
  $('btnCloseManual').onclick = () => {
    if (!st.position) return;
    const last = st.candles[st.candles.length - 1];
    finishPosition(last.close, last.time, 'Manual');
  };
  $('riskPct').addEventListener('change', (e) => { st.riskPct = parseFloat(e.target.value) || 1; save(); });
  $('rrTarget').addEventListener('change', (e) => { st.rr = parseFloat(e.target.value) || 2; save(); });

  /* ============================== Historial y estadísticas ============================== */
  function renderHistory() {
    const tbody = document.querySelector('#histTable tbody');
    tbody.innerHTML = st.trades.slice().reverse().map((t) => `<tr>
      <td>${Core.fmtDateTime(t.exitTime, st.tz)}</td><td>${t.symbol}</td>
      <td>${t.side === 'long' ? 'Compra' : 'Venta'}</td>
      <td class="mono">${t.entry.toFixed(4)}</td><td class="mono">${t.exit.toFixed(4)}</td>
      <td>${t.reason}</td>
      <td class="mono ${t.pnl >= 0 ? 'pnl-pos' : 'pnl-neg'}">${t.pnl >= 0 ? '+' : ''}${t.pnl.toFixed(2)}</td>
      <td class="mono">${t.r.toFixed(2)}</td>
    </tr>`).join('') || '<tr><td colspan="8" class="dim">Todavía no cerraste operaciones</td></tr>';
  }

  function renderStats() {
    const s = Core.stats(st.trades, st.balance - st.trades.reduce((a, t) => a + t.pnl, 0));
    const cards = [
      ['Operaciones', s.n], ['Efectividad', s.winRate.toFixed(0) + '%'],
      ['Resultado neto', (s.net >= 0 ? '+' : '') + s.net.toFixed(2)],
      ['Factor de beneficio', Number.isFinite(s.profitFactor) ? s.profitFactor.toFixed(2) : '∞'],
      ['R promedio', s.avgR.toFixed(2)], ['Máx. caída', '-' + s.maxDdPct.toFixed(1) + '%'],
      ['Racha perdedora máx.', s.maxStreak], ['Expectativa', s.expectancy.toFixed(2)],
    ];
    document.getElementById('statsGrid').innerHTML = cards.map(([label, val]) =>
      `<div class="stat-card"><b>${val}</b><span>${label}</span></div>`).join('');
    drawEquity(s.equity);
  }

  function drawEquity(equity) {
    const cv = document.getElementById('equityCanvas');
    const ctx = cv.getContext('2d');
    const w = cv.width, h = cv.height;
    ctx.clearRect(0, 0, w, h);
    if (equity.length < 2) { ctx.fillStyle = '#787b86'; ctx.fillText('Sin operaciones todavía', 10, h / 2); return; }
    const min = Math.min.apply(null, equity), max = Math.max.apply(null, equity);
    const pad = (max - min) * 0.1 || 1;
    const y = (v) => h - ((v - (min - pad)) / ((max + pad) - (min - pad))) * h;
    ctx.strokeStyle = '#2962ff'; ctx.lineWidth = 2; ctx.beginPath();
    equity.forEach((v, i) => {
      const x = (i / (equity.length - 1)) * w;
      i === 0 ? ctx.moveTo(x, y(v)) : ctx.lineTo(x, y(v));
    });
    ctx.stroke();
  }

  document.querySelectorAll('.ptab').forEach((btn) => btn.addEventListener('click', () => {
    document.querySelectorAll('.ptab').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.panel').forEach((p) => p.classList.add('hidden'));
    btn.classList.add('active');
    document.getElementById('panel-' + btn.dataset.panel).classList.remove('hidden');
    if (btn.dataset.panel === 'stats') renderStats();
  }));

  $('btnExportCsv').onclick = () => {
    if (!st.trades.length) { toast('No hay operaciones para exportar', 'warn'); return; }
    const blob = new Blob([Core.toCSV(st.trades, st.tz)], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = 'operaciones_practice_chart.csv'; a.click();
  };

  /* ============================== Toolbar de dibujo ============================== */
  document.querySelectorAll('#toolbar .tool').forEach((btn) => btn.addEventListener('click', () => {
    document.querySelectorAll('#toolbar .tool').forEach((b) => b.classList.remove('active'));
    const tool = btn.dataset.tool === 'cursor' ? null : btn.dataset.tool;
    st.dm.setTool(tool);
    if (tool) btn.classList.add('active'); else document.querySelector('[data-tool="cursor"]').classList.add('active');
  }));
  $('btnClearDraw').onclick = () => st.dm.clearAll();
  $('btnMagnet').onclick = (e) => {
    const on = !e.target.classList.contains('on');
    e.target.classList.toggle('on', on);
    st.dm.setMagnet(on);
  };

  /* ============================== Menú de indicadores ============================== */
  function bindIndicator(key, checkboxId, paramIds) {
    $(checkboxId).addEventListener('change', (e) => { st.indicators[key] = e.target.checked; recomputeIndicators(); });
    (paramIds || []).forEach(([id, field]) => $(id).addEventListener('change', (e) => {
      st.indicatorParams[field] = parseFloat(e.target.value) || st.indicatorParams[field];
      if (st.indicators[key]) recomputeIndicators();
    }));
  }
  bindIndicator('sma', 'ind-sma', [['ind-sma-p', 'smaP']]);
  bindIndicator('ema', 'ind-ema', [['ind-ema-p', 'emaP']]);
  bindIndicator('bb', 'ind-bb', [['ind-bb-p', 'bbP'], ['ind-bb-k', 'bbK']]);
  bindIndicator('rsi', 'ind-rsi', [['ind-rsi-p', 'rsiP']]);
  bindIndicator('macd', 'ind-macd', [['ind-macd-f', 'macdF'], ['ind-macd-s', 'macdS'], ['ind-macd-sig', 'macdSig']]);
  $('btnIndic').onclick = () => { $('indicMenu').classList.toggle('hidden'); $('symbolMenu').classList.add('hidden'); };
  $('indicClose').onclick = () => $('indicMenu').classList.add('hidden');

  /* ============================== Menú de símbolo/proveedor ============================== */
  function renderSymbolList() {
    const box = $('symList');
    box.innerHTML = '';
    (SYMBOLS[st.provider] || []).forEach((s) => {
      const b = document.createElement('button');
      b.className = 'chip' + (s.symbol === st.symbol ? ' active' : '');
      b.textContent = s.symbol;
      b.onclick = () => { setSymbol(s.symbol, s.mult, s.step); $('symbolMenu').classList.add('hidden'); };
      box.appendChild(b);
    });
    $('providerWarning').textContent = st.provider === 'yahoo'
      ? 'Yahoo Finance no es tiempo real puro: el precio puede llegar con algunos minutos de retraso y se actualiza cada 20s, no vela a vela.'
      : 'Binance transmite velas en vivo por WebSocket, tick a tick.';
  }
  function setSymbol(symbol, mult, step) {
    st.symbol = symbol; st.mult = mult || 1; st.step = step || (mult >= 1000 ? 0.0001 : 1);
    if (st.replay.on) exitReplay();
    loadSymbol();
    renderSymbolList();
  }
  $('btnMenu').onclick = () => { $('symbolMenu').classList.toggle('hidden'); $('indicMenu').classList.add('hidden'); };
  $('symClose').onclick = () => $('symbolMenu').classList.add('hidden');
  $('providerSel').addEventListener('change', (e) => {
    st.provider = e.target.value;
    const first = SYMBOLS[st.provider][0];
    setSymbol(first.symbol, first.mult, first.step);
  });
  $('symCustomGo').onclick = () => {
    const v = $('symCustom').value.trim();
    if (v) { setSymbol(v.toUpperCase().includes('=') || st.provider === 'binance' ? v.toUpperCase() : v, 1, 1); $('symbolMenu').classList.add('hidden'); }
  };
  $('tzSel').addEventListener('change', (e) => {
    st.tz = e.target.value; save();
    chart.applyOptions({}); // fuerza redibujo de las marcas del eje
    chart.timeScale().applyOptions({ tickMarkFormatter: (t, k) => Core.fmtTick(t, k, st.tz) });
  });

  /* ============================== Temporalidades ============================== */
  function renderTfChips() {
    const box = $('tfGroup');
    box.innerHTML = '';
    TFS.forEach((tf) => {
      const b = document.createElement('button');
      b.className = 'chip' + (tf === st.interval ? ' active' : '');
      b.textContent = tf;
      b.onclick = () => { st.interval = tf; if (st.replay.on) exitReplay(); loadSymbol(); renderTfChips(); };
      box.appendChild(b);
    });
  }

  /* ============================== Replay ============================== */
  function enterReplay() {
    stopFeeds();
    st.replay.on = true;
    st.replay.all = st.candles.slice();
    st.replay.idx = Math.max(20, Math.floor(st.replay.all.length * 0.5));
    st.candles = st.replay.all.slice(0, st.replay.idx);
    mainSeries.setData(st.candles.map(toLC));
    recomputeIndicators();
    document.getElementById('replayBar').classList.remove('hidden');
    document.getElementById('btnReplay').textContent = '⏹ Salir de Replay';
    document.getElementById('cornerBadge').textContent = 'REPLAY';
    updateReplayInfo();
    toast('Modo Replay: elegí una barra de inicio o avanzá con ⏭');
  }
  function exitReplay() {
    stopReplayPlay();
    st.replay.on = false;
    document.getElementById('replayBar').classList.add('hidden');
    document.getElementById('btnReplay').textContent = '⏮ Replay';
    document.getElementById('cornerBadge').textContent = '';
    loadSymbol();
  }
  function replayStep() {
    if (st.replay.idx >= st.replay.all.length) { stopReplayPlay(); toast('Llegaste al final de la serie cargada', 'warn'); return; }
    const bar = st.replay.all[st.replay.idx];
    st.candles.push(bar);
    st.replay.idx++;
    mainSeries.update(toLC(bar));
    setOhlcReadout(bar);
    recomputeIndicators();
    checkPositionBar(bar);
    updateReplayInfo();
    refreshTradeUI();
  }
  function updateReplayInfo() {
    document.getElementById('rpInfo').textContent = `Barra ${st.replay.idx} / ${st.replay.all.length}`;
  }
  function stopReplayPlay() {
    st.replay.playing = false;
    if (st.replay.timer) { clearInterval(st.replay.timer); st.replay.timer = null; }
    document.getElementById('rpPlay').textContent = '▶';
  }
  document.getElementById('btnReplay').onclick = () => (st.replay.on ? exitReplay() : enterReplay());
  document.getElementById('rpExit').onclick = exitReplay;
  document.getElementById('rpFwd').onclick = replayStep;
  document.getElementById('rpBack').onclick = () => {
    if (st.replay.idx <= 20) return;
    st.replay.idx--;
    st.candles.pop();
    mainSeries.setData(st.candles.map(toLC));
    setOhlcReadout(st.candles[st.candles.length - 1]);
    recomputeIndicators();
    updateReplayInfo();
  };
  document.getElementById('rpPlay').onclick = () => {
    if (st.replay.playing) { stopReplayPlay(); return; }
    st.replay.playing = true;
    document.getElementById('rpPlay').textContent = '⏸';
    const speed = parseInt(document.getElementById('rpSpeed').value, 10);
    st.replay.timer = setInterval(replayStep, speed);
  };
  document.getElementById('rpSpeed').addEventListener('change', () => {
    if (st.replay.playing) { stopReplayPlay(); document.getElementById('rpPlay').click(); }
  });
  document.getElementById('rpStart').onclick = () => {
    toast('Hacé click sobre una vela del gráfico para elegir el inicio del Replay');
    const handler = (param) => {
      if (!param.time) return;
      const idx = st.replay.all.findIndex((c) => c.time === param.time);
      if (idx > 5) {
        st.replay.idx = idx;
        st.candles = st.replay.all.slice(0, idx);
        mainSeries.setData(st.candles.map(toLC));
        setOhlcReadout(st.candles[st.candles.length - 1]);
        recomputeIndicators();
        updateReplayInfo();
      }
      chart.unsubscribeClick(handler);
    };
    chart.subscribeClick(handler);
  };

  /* ============================== Atajos y arranque ============================== */
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      document.querySelectorAll('#toolbar .tool').forEach((b) => b.classList.remove('active'));
      document.querySelector('[data-tool="cursor"]').classList.add('active');
      st.dm.setTool(null);
      cancelPending();
    }
  });
  if (window.matchMedia('(max-width: 820px)').matches) {
    const rp = document.getElementById('rightPanel');
    document.getElementById('btnMenu').addEventListener('dblclick', () => rp.classList.toggle('open'));
  }

  load();
  renderTfChips();
  renderSymbolList();
  $('tzSel').value = st.tz;
  $('riskPct').value = st.riskPct;
  $('rrTarget').value = st.rr;
  renderHistory();
  refreshTradeUI();
  loadSymbol();
})();
