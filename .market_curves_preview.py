from __future__ import annotations

import json
import math
import mimetypes
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


ROOT = Path(__file__).resolve().parent
PUBLIC = ROOT / "public"


def strategy(identifier: str, name: str, asset: str, state: str, phase: float, slope: float) -> dict:
    curve = [round(1 + slope * index + .025 * math.sin(index / 7 + phase), 4) for index in range(90)]
    return {
        "id": identifier, "name": name, "archetype": "Momentum", "asset": asset, "state": state,
        "generation": 1, "parent": None, "backtests": 4,
        "params": {"fast": 8, "slow": 28, "threshold": .003, "position_size": .55},
        "metrics": {"score": 66 + phase, "annualized": .08 + slope * 10, "sharpe": .9 + phase / 10, "drawdown": .07 + phase / 100, "return": curve[-1] - 1, "curve": curve, "regime_scores": {"Expansion": .4, "Compression": .1, "Stress": -.05, "Recovery": .3}},
        "validation": {"sharpe": .65 + phase / 10, "return": .05, "drawdown": .08},
        "rework": {"attempt": 0, "max_attempts": 3, "history": []},
        "monitor": {"returns": [], "streak": 0, "adjustments": 0, "sharpe": .8, "drawdown": .04, "ratio": .9},
    }


def fixture() -> dict:
    strategies = [
        strategy("AX-01-001", "Orion Pulse", "SPY", "healthy", 0, .0012),
        strategy("AX-01-002", "Kestrel Drift", "QQQ", "watch", 2, .00055),
        strategy("AX-01-003", "Helix Break", "IWM", "released", 4, .0009),
        strategy("AX-01-004", "Cobalt Revert", "TLT", "adjusted", 6, -.0001),
    ]
    return {
        "meta": {"cycle": 7, "clock": 160, "environment": "ALPACA PAPER", "seed": 20260801},
        "summary": {"generated": 0, "testing": 0, "validation": 0, "released": 4, "dropped": 1, "average_score": 67.5, "capital": 101200},
        "strategies": strategies, "events": [{"kind": "HEALTHY", "title": "Orion Pulse cleared monitor", "detail": "rolling evidence remains healthy", "time": "15:00"}],
        "policy": {"release_score": 61, "min_sharpe": .55, "max_drawdown": .2, "validation_min_sharpe": .3, "validation_max_drawdown": .2, "monitor_window": 21},
        "alpaca": {"connected": False, "managed_symbols": []},
    }


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_: object) -> None: return
    def send_json(self) -> None:
        body = json.dumps(fixture()).encode(); self.send_response(200); self.send_header("content-type", "application/json"); self.send_header("content-length", str(len(body))); self.end_headers(); self.wfile.write(body)
    def do_GET(self) -> None:
        if self.path == "/api/state": return self.send_json()
        path = PUBLIC / ("index.html" if self.path == "/" else self.path.removeprefix("/"))
        if not path.is_file(): self.send_error(404); return
        body = path.read_bytes(); self.send_response(200); self.send_header("content-type", mimetypes.guess_type(path.name)[0] or "application/octet-stream"); self.send_header("content-length", str(len(body))); self.end_headers(); self.wfile.write(body)


ThreadingHTTPServer(("127.0.0.1", 8768), Handler).serve_forever()
