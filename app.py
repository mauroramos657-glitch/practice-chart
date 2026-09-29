# -*- coding: utf-8 -*-
"""
Practice Chart - backend Flask.

Sirve la página y actúa de proxy de datos de mercado:
  GET /api/candles?provider=binance|yahoo&symbol=BTCUSDT&interval=15m&limit=500[&start=ms][&end=ms]

El navegador se conecta directo al WebSocket de Binance para el tiempo real;
Yahoo Finance no tiene WebSocket público, así que el frontend consulta este
endpoint cada pocos segundos.
"""
import os
import re
import threading
import time
from collections import defaultdict, deque
from urllib.parse import quote

import requests
from flask import Flask, jsonify, request, send_from_directory
from werkzeug.middleware.proxy_fix import ProxyFix

app = Flask(__name__, static_folder="static", static_url_path="/static")
if os.environ.get("TRUST_PROXY", "1") == "1":
    # Detrás de Render/Railway/Heroku la IP real viene en X-Forwarded-For.
    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)

BINANCE_HOSTS = [
    "https://data-api.binance.vision",  # endpoint público solo de market data
    "https://api.binance.com",
    "https://api.binance.us",
]
YAHOO_HOSTS = [
    "https://query1.finance.yahoo.com",
    "https://query2.finance.yahoo.com",
]
BINANCE_INTERVALS = {"1m", "5m", "15m", "30m", "1h", "4h", "1d"}
# Yahoo no tiene 4h: se arma agregando velas de 1h.
YAHOO_INTERVALS = {"1m": "1m", "5m": "5m", "15m": "15m", "30m": "30m", "1h": "60m", "4h": "60m", "1d": "1d"}
YAHOO_DEFAULT_RANGE = {"1m": "5d", "5m": "1mo", "15m": "1mo", "30m": "1mo", "60m": "6mo", "1d": "2y"}
INTERVAL_SECONDS = {"1m": 60, "5m": 300, "15m": 900, "30m": 1800, "1h": 3600, "4h": 14400, "1d": 86400}
SYMBOL_RE = re.compile(r"^[A-Za-z0-9=\-\.\^_]{1,24}$")
USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/124.0 Safari/537.36"
)
HTTP_TIMEOUT = 10
MAX_LIMIT = 1000
RATE_LIMIT_PER_MIN = int(os.environ.get("RATE_LIMIT_PER_MIN", "240"))


class UpstreamError(Exception):
    """Error al pedir datos al proveedor externo."""


# --------------------------------------------------------------------------
# Cache en memoria (por proceso) y límite de pedidos por IP
# --------------------------------------------------------------------------
_cache = {}
_cache_lock = threading.Lock()


def cache_get(key):
    with _cache_lock:
        item = _cache.get(key)
        if item and item[0] > time.time():
            return item[1]
        _cache.pop(key, None)
    return None


def cache_set(key, value, ttl):
    with _cache_lock:
        if len(_cache) > 400:
            now = time.time()
            for k in [k for k, v in _cache.items() if v[0] <= now]:
                _cache.pop(k, None)
            if len(_cache) > 400:
                _cache.clear()
        _cache[key] = (time.time() + ttl, value)


_hits = defaultdict(deque)
_hits_lock = threading.Lock()


def rate_limited(ip):
    now = time.time()
    with _hits_lock:
        q = _hits[ip]
        while q and q[0] < now - 60:
            q.popleft()
        if len(q) >= RATE_LIMIT_PER_MIN:
            return True
        q.append(now)
        if len(_hits) > 5000:
            _hits.clear()
    return False


# --------------------------------------------------------------------------
# Proveedores
# --------------------------------------------------------------------------
def fetch_binance(symbol, interval, limit, start_ms, end_ms):
    params = {"symbol": symbol.upper(), "interval": interval, "limit": limit}
    if start_ms:
        params["startTime"] = start_ms
    if end_ms:
        params["endTime"] = end_ms
    last_err = "sin respuesta"
    for host in BINANCE_HOSTS:
        try:
            r = requests.get(
                f"{host}/api/v3/klines",
                params=params,
                timeout=HTTP_TIMEOUT,
                headers={"User-Agent": USER_AGENT},
            )
        except requests.RequestException as exc:
            last_err = f"{host}: {exc.__class__.__name__}"
            continue
        if r.status_code == 200:
            try:
                rows = r.json()
            except ValueError:
                last_err = f"{host}: respuesta inválida"
                continue
            return [
                {
                    "time": int(k[0] // 1000),
                    "open": float(k[1]),
                    "high": float(k[2]),
                    "low": float(k[3]),
                    "close": float(k[4]),
                    "volume": float(k[5]),
                }
                for k in rows
            ]
        last_err = f"{host}: HTTP {r.status_code}"
        if r.status_code == 400:
            # Símbolo o parámetros inválidos: en otro host va a fallar igual.
            raise UpstreamError(f"Binance rechazó el pedido (¿símbolo {symbol} inválido?)")
    raise UpstreamError(f"No se pudo leer Binance ({last_err})")


def aggregate(candles, bucket_seconds):
    """Agrupa velas en buckets alineados a UTC (se usa para armar 4h desde 1h)."""
    out = []
    for c in candles:
        t = c["time"] - (c["time"] % bucket_seconds)
        if out and out[-1]["time"] == t:
            last = out[-1]
            last["high"] = max(last["high"], c["high"])
            last["low"] = min(last["low"], c["low"])
            last["close"] = c["close"]
            last["volume"] += c["volume"]
        else:
            out.append({**c, "time": t})
    return out


def fetch_yahoo(symbol, interval, limit, start_ms, end_ms):
    yahoo_interval = YAHOO_INTERVALS[interval]
    params = {"interval": yahoo_interval, "includePrePost": "false"}
    if start_ms:
        params["period1"] = int(start_ms // 1000)
        params["period2"] = int((end_ms or time.time() * 1000) // 1000)
    else:
        params["range"] = YAHOO_DEFAULT_RANGE[yahoo_interval]
    last_err = "sin respuesta"
    payload = None
    for host in YAHOO_HOSTS:
        try:
            r = requests.get(
                f"{host}/v8/finance/chart/{quote(symbol, safe='')}",
                params=params,
                timeout=HTTP_TIMEOUT,
                headers={"User-Agent": USER_AGENT, "Accept": "application/json"},
            )
        except requests.RequestException as exc:
            last_err = f"{host}: {exc.__class__.__name__}"
            continue
        try:
            body = r.json()
        except ValueError:
            last_err = f"{host}: HTTP {r.status_code}"
            continue
        err = (body.get("chart") or {}).get("error")
        if err:
            # Ej.: rango no disponible para ese intervalo, símbolo inexistente.
            raise UpstreamError("Yahoo: " + (err.get("description") or str(err)))
        if r.status_code == 200:
            payload = body
            break
        last_err = f"{host}: HTTP {r.status_code}"
    if payload is None:
        raise UpstreamError(f"No se pudo leer Yahoo Finance ({last_err}). Puede estar bloqueando el servidor.")

    result = ((payload.get("chart") or {}).get("result") or [None])[0]
    if not result:
        raise UpstreamError("Yahoo no devolvió datos para ese símbolo")
    stamps = result.get("timestamp") or []
    quote_ = ((result.get("indicators") or {}).get("quote") or [{}])[0]
    opens, highs = quote_.get("open") or [], quote_.get("high") or []
    lows, closes = quote_.get("low") or [], quote_.get("close") or []
    vols = quote_.get("volume") or []
    candles = []
    for i, t in enumerate(stamps):
        try:
            o, h, l, c = opens[i], highs[i], lows[i], closes[i]
        except IndexError:
            continue
        if None in (o, h, l, c):
            continue
        v = vols[i] if i < len(vols) and vols[i] is not None else 0
        candles.append({"time": int(t), "open": float(o), "high": float(h), "low": float(l),
                        "close": float(c), "volume": float(v)})
    if interval == "4h":
        candles = aggregate(candles, INTERVAL_SECONDS["4h"])
    return candles


def clean(candles, limit):
    """Ordena, saca duplicados y se queda con las últimas `limit` velas."""
    seen = {}
    for c in candles:
        seen[c["time"]] = c
    ordered = [seen[t] for t in sorted(seen)]
    return ordered[-limit:]


# --------------------------------------------------------------------------
# Rutas
# --------------------------------------------------------------------------
def _int_arg(name, default=None, lo=None, hi=None):
    raw = request.args.get(name)
    if raw in (None, ""):
        return default
    try:
        val = int(float(raw))
    except ValueError:
        raise ValueError(f"Parámetro {name} inválido")
    if lo is not None:
        val = max(lo, val)
    if hi is not None:
        val = min(hi, val)
    return val


@app.get("/api/candles")
def api_candles():
    if rate_limited(request.remote_addr or "?"):
        return jsonify(error="Demasiados pedidos, esperá un momento"), 429
    provider = request.args.get("provider", "binance").lower()
    symbol = request.args.get("symbol", "BTCUSDT")
    interval = request.args.get("interval", "15m")
    try:
        limit = _int_arg("limit", 500, 1, MAX_LIMIT)
        start = _int_arg("start", None, 0)
        end = _int_arg("end", None, 0)
    except ValueError as exc:
        return jsonify(error=str(exc)), 400
    if provider not in ("binance", "yahoo"):
        return jsonify(error="provider debe ser binance o yahoo"), 400
    if not SYMBOL_RE.match(symbol):
        return jsonify(error="Símbolo inválido"), 400
    allowed = BINANCE_INTERVALS if provider == "binance" else set(YAHOO_INTERVALS)
    if interval not in allowed:
        return jsonify(error=f"Intervalo {interval} no disponible en {provider}"), 400

    key = (provider, symbol.upper(), interval, limit, start, end)
    cached = cache_get(key)
    if cached is not None:
        return jsonify(cached)
    try:
        if provider == "binance":
            candles = fetch_binance(symbol, interval, limit, start, end)
        else:
            candles = fetch_yahoo(symbol, interval, limit, start, end)
    except UpstreamError as exc:
        return jsonify(error=str(exc)), 502
    candles = clean(candles, limit)
    if not candles:
        return jsonify(error="El proveedor no devolvió velas para ese pedido"), 404
    body = {"provider": provider, "symbol": symbol, "interval": interval, "candles": candles}
    cache_set(key, body, 3 if start is None else 300)
    return jsonify(body)


@app.get("/healthz")
def healthz():
    return jsonify(ok=True)


@app.get("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "5000"))
    app.run(host="0.0.0.0", port=port, debug=os.environ.get("FLASK_DEBUG") == "1")
