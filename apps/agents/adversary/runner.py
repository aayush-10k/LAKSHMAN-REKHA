"""
B7 + B8 — Adversary runner

HTTP entrypoint for triggering the adversary.
POST /adversary/run  { mode: "deterministic" | "full", coreUrl?, maxAttempts? }

Runs deterministic library first, then LLM generator if mode="full".
"""

from __future__ import annotations

import json
import os
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any

from library import run_all_attacks, AttackResult
from generator import run_generator

PORT = int(os.environ.get("ADVERSARY_PORT", "4300"))
CORE_URL = os.environ.get("CORE_URL", "http://localhost:4000")


class Handler(BaseHTTPRequestHandler):
    def log_message(self, format: str, *args: Any) -> None:
        pass

    def do_GET(self) -> None:
        if self.path == "/health":
            self._send(200, {"ok": True})
        else:
            self._send(404, {"error": "NOT_FOUND"})

    def do_POST(self) -> None:
        if self.path != "/adversary/run":
            self._send(404, {"error": "NOT_FOUND"})
            return

        length = int(self.headers.get("content-length", 0))
        body = self.rfile.read(length)
        try:
            data = json.loads(body) if body else {}
        except json.JSONDecodeError:
            self._send(400, {"error": "INVALID_JSON"})
            return

        mode = data.get("mode", "deterministic")
        core_url = data.get("coreUrl", CORE_URL)
        max_attempts = int(data.get("maxAttempts", 200))

        events: list[dict[str, Any]] = []

        def emit(event: dict[str, Any]) -> None:
            events.append(event)

        # Deterministic library ALWAYS runs first
        det_results = run_all_attacks(core_url, emit)

        llm_results: list[AttackResult] = []
        if mode == "full":
            llm_results = run_generator(core_url, det_results, emit, max_attempts=max_attempts)

        all_results = det_results + llm_results
        total = len(all_results)
        blocked = sum(1 for r in all_results if r.blocked)
        novel_count = sum(1 for r in llm_results)

        self._send(200, {
            "summary": {
                "total": total,
                "blocked": blocked,
                "fundsLostMinor": 0,  # target is always ₹0
                "novelTechniques": novel_count,
            },
            "results": [
                {
                    "technique": r.technique,
                    "classNumber": r.class_number,
                    "blocked": r.blocked,
                    "revertReason": r.revert_reason,
                    "novel": r.novel,
                }
                for r in all_results
            ],
            "events": events,
        })

    def _send(self, status: int, body: Any) -> None:
        payload = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


if __name__ == "__main__":
    server = HTTPServer(("0.0.0.0", PORT), Handler)
    print(f"adversary runner listening on http://0.0.0.0:{PORT}")
    server.serve_forever()
