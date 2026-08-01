"""Launch the Axiom strategy foundry terminal."""

from __future__ import annotations

import argparse
import json
import mimetypes
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

from strategy_lab import StrategyLab


ROOT = Path(__file__).resolve().parent
PUBLIC = ROOT / "public"


class AxiomHandler(BaseHTTPRequestHandler):
    lab: StrategyLab

    def log_message(self, fmt: str, *args: object) -> None:
        print(f"[axiom] {self.address_string()} — {fmt % args}")

    def _json(self, payload: object, status: HTTPStatus = HTTPStatus.OK) -> None:
        body = json.dumps(payload, separators=(",", ":"), allow_nan=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _file(self, path: Path) -> None:
        if not path.is_file():
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        body = path.read_bytes()
        content_type, _ = mimetypes.guess_type(path.name)
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", f"{content_type or 'application/octet-stream'}; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802 - stdlib handler API
        route = urlparse(self.path).path
        if route == "/api/state":
            self._json(self.lab.snapshot())
        elif route == "/":
            self._file(PUBLIC / "index.html")
        elif route.startswith("/assets/"):
            candidate = (PUBLIC / route.removeprefix("/")).resolve()
            if PUBLIC.resolve() not in candidate.parents:
                self.send_error(HTTPStatus.FORBIDDEN)
                return
            self._file(candidate)
        else:
            self.send_error(HTTPStatus.NOT_FOUND)

    def do_POST(self) -> None:  # noqa: N802 - stdlib handler API
        route = urlparse(self.path).path
        try:
            length = min(int(self.headers.get("Content-Length", "0")), 32_768)
            payload = json.loads(self.rfile.read(length) or b"{}")
            if route == "/api/generate":
                self.lab.generate_batch(max(1, min(int(payload.get("count", 6)), 12)))
            elif route == "/api/review":
                self.lab.review_candidates()
            elif route == "/api/advance":
                self.lab.advance_market(max(1, min(int(payload.get("periods", 1)), 4)))
            elif route == "/api/reproduce":
                self.lab.reproduce(str(payload["id"]))
            elif route == "/api/reset":
                self.lab.reset()
            else:
                self._json({"error": "Unknown endpoint"}, HTTPStatus.NOT_FOUND)
                return
            self._json(self.lab.snapshot())
        except (KeyError, TypeError, ValueError) as exc:
            self._json({"error": str(exc)}, HTTPStatus.BAD_REQUEST)


def run(host: str, port: int) -> None:
    lab = StrategyLab()
    AxiomHandler.lab = lab
    server = ThreadingHTTPServer((host, port), AxiomHandler)
    print(f"Axiom Strategy Foundry running at http://{host}:{port}")
    print("Paper simulation only. Press Ctrl+C to stop.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down Axiom.")
    finally:
        server.server_close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Axiom strategy foundry and paper-release terminal")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    options = parser.parse_args()
    run(options.host, options.port)
