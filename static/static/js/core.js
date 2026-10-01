/* Núcleo sin dependencias del DOM: se usa en el navegador (window.Core) y en los tests de Node. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Core = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ====================== Indicadores ====================== */
  // Todas devuelven un array del mismo largo que la entrada, con null donde aún no hay valor.

  function sma(values, period) {
    const n = values.length;
    const out = new Array(n).fill(null);
    if (!(period >= 1)) return out;
    let sum = 0;
    for (let i = 0; i < n; i++) {
      sum += values[i];
      if (i >= period) sum -= values[i - period];
      if (i >= period - 1) out[i] = sum / period;
    }
    return out;
  }

  // EMA con semilla = SMA de las primeras `period` muestras (igual que ta.ema de TradingView).
  // Acepta nulls al principio (se usa para la señal del MACD).
  function ema(values, period) {
    const n = values.length;
    const out = new Array(n).fill(null);
    let start = 0;
    while (start < n && values[start] == null) start++;
    if (!(period >= 1) || n - start < period) return out;
    let sum = 0;
    for (let i = start; i < start + period; i++) sum += values[i];
    let prev = sum / period;
    out[start + period - 1] = prev;
    const k = 2 / (period + 1);
    for (let i = start + period; i < n; i++) {
      prev = values[i] * k + prev * (1 - k);
      out[i] = prev;
    }
    return out;
  }

  // Bandas de Bollinger con desvío estándar poblacional (como TradingView).
  function bollinger(values, period, mult) {
    const n = values.length;
    const mid = sma(values, period);
    const upper = new Array(n).fill(null);
    const lower = new Array(n).fill(null);
    for (let i = period - 1; i < n; i++) {
      const m = mid[i];
      if (m == null) continue;
      let acc = 0;
      for (let j = i - period + 1; j <= i; j++) acc += (values[j] - m) * (values[j] - m);
      const sd = Math.sqrt(acc / period);
      upper[i] = m + mult * sd;
      lower[i] = m - mult * sd;
    }
    return { mid, upper, lower };
  }

  function rsiValue(avgGain, avgLoss) {
    if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
    return 100 - 100 / (1 + avgGain / avgLoss);
  }

  // RSI de Wilder (suavizado RMA).
  function rsi(values, period) {
    const n = values.length;
    const out = new Array(n).fill(null);
    if (!(period >= 1) || n <= period) return out;
    let gain = 0;
    let loss = 0;
    for (let i = 1; i <= period; i++) {
      const d = values[i] - values[i - 1];
      if (d >= 0) gain += d;
      else loss -= d;
    }
    let avgG = gain / period;
    let avgL = loss / period;
    out[period] = rsiValue(avgG, avgL);
    for (let i = period + 1; i < n; i++) {
      const d = values[i] - values[i - 1];
      avgG = (avgG * (period - 1) + (d > 0 ? d : 0)) / period;
      avgL = (avgL * (period - 1) + (d < 0 ? -d : 0)) / period;
      out[i] = rsiValue(avgG, avgL);
    }
    return out;
  }

  function macd(values, fast, slow, signalPeriod) {
    const ef = ema(values, fast);
    const es = ema(values, slow);
    const line = values.map((_, i) => (ef[i] != null && es[i] != null ? ef[i] - es[i] : null));
    const signal = ema(line, signalPeriod);
    const hist = line.map((v, i) => (v != null && signal[i] != null ? v - signal[i] : null));
    return { macd: line, signal, hist };
  }

  /* ====================== Motor de órdenes (paper trading) ====================== */

  function decimals(step) {
    const s = String(step);
    if (s.indexOf('e-') >= 0) return parseInt(s.split('e-')[1], 10);
    const i = s.indexOf('.');
    return i < 0 ? 0 : s.length - i - 1;
  }

  // Tamaño de posición para arriesgar `riskPct`% del balance entre entrada y stop.
  function calcQty(o) {
    const mult = o.mult || 1;
    const step = o.step || 1;
    const dist = Math.abs(o.entry - o.sl);
    if (!(dist > 0) || !(o.balance > 0) || !(o.riskPct > 0)) return 0;
    const raw = (o.balance * o.riskPct / 100) / (dist * mult);
    const q = Math.floor(raw / step + 1e-9) * step;
    return Number(q.toFixed(decimals(step)));
  }

  function computeTp(side, entry, sl, rr) {
    const risk = side === 'long' ? entry - sl : sl - entry;
    return side === 'long' ? entry + rr * risk : entry - rr * risk;
  }

  function rrFrom(side, entry, sl, tp) {
    const risk = side === 'long' ? entry - sl : sl - entry;
    const reward = side === 'long' ? tp - entry : entry - tp;
    return risk > 0 ? reward / risk : NaN;
  }

  // Devuelve un texto de error o null si la orden es coherente.
  function validateOrder(side, entry, sl, tp) {
    if (![entry, sl, tp].every(Number.isFinite)) return 'Completá Stop Loss y Take Profit con números';
    if (side === 'long') {
      if (!(sl < entry)) return 'En una compra el Stop Loss debe estar por debajo del precio';
      if (!(tp > entry)) return 'En una compra el Take Profit debe estar por encima del precio';
    } else {
      if (!(sl > entry)) return 'En una venta el Stop Loss debe estar por encima del precio';
      if (!(tp < entry)) return 'En una venta el Take Profit debe estar por debajo del precio';
    }
    return null;
  }

  // Revisa una vela completa posterior a la entrada. Si toca SL y TP en la misma vela
  // se asume el peor caso (SL primero). Contempla gaps de apertura.
  function checkExitBar(pos, bar) {
    if (pos.side === 'long') {
      if (bar.low <= pos.sl) return { price: Math.min(pos.sl, bar.open), reason: 'SL' };
      if (bar.high >= pos.tp) return { price: Math.max(pos.tp, bar.open), reason: 'TP' };
    } else {
      if (bar.high >= pos.sl) return { price: Math.max(pos.sl, bar.open), reason: 'SL' };
      if (bar.low <= pos.tp) return { price: Math.min(pos.tp, bar.open), reason: 'TP' };
    }
    return null;
  }

  // Revisa un precio suelto (vela en la que se entró, sin conocer qué pasó antes de la entrada).
  function checkExitTick(pos, price) {
    if (pos.side === 'long') {
      if (price <= pos.sl) return { price, reason: 'SL' };
      if (price >= pos.tp) return { price: pos.tp, reason: 'TP' };
    } else {
      if (price >= pos.sl) return { price, reason: 'SL' };
      if (price <= pos.tp) return { price: pos.tp, reason: 'TP' };
    }
    return null;
  }

  // Resultado si se cerrara ahora al precio dado (incluye comisión de ambos lados).
  function unrealized(pos, price) {
    const dir = pos.side === 'long' ? 1 : -1;
    const gross = (price - pos.entry) * dir * pos.qty * pos.mult;
    const fees = (pos.entry + price) * pos.qty * pos.mult * (pos.feePct || 0) / 100;
    const risk = Math.abs(pos.entry - pos.sl0) * pos.qty * pos.mult;
    const net = gross - fees;
    return { pnl: net, r: risk > 0 ? net / risk : 0 };
  }

  function closeTrade(pos, exitPrice, exitTime, reason) {
    const dir = pos.side === 'long' ? 1 : -1;
    const gross = (exitPrice - pos.entry) * dir * pos.qty * pos.mult;
    const fees = (pos.entry + exitPrice) * pos.qty * pos.mult * (pos.feePct || 0) / 100;
    const net = gross - fees;
    const risk = Math.abs(pos.entry - pos.sl0) * pos.qty * pos.mult;
    return {
      id: pos.id, mode: pos.mode, symbol: pos.symbol, side: pos.side, qty: pos.qty, mult: pos.mult,
      entry: pos.entry, exit: exitPrice, sl: pos.sl0, tp: pos.tp,
      openTime: pos.openTime, exitTime, reason,
      gross, fees, pnl: net, r: risk > 0 ? net / risk : 0,
    };
  }

  function stats(trades, initial) {
    const n = trades.length;
    const wins = trades.filter((t) => t.pnl > 0);
    const losses = trades.filter((t) =>
