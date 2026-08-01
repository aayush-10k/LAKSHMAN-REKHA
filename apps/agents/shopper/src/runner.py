"""
B4 — Shopper agent HTTP runner

POST /agent/run  { taskId, taskDescription, plan, mode, agentId }

Runs the shopper agent synchronously and streams events back via SSE
(the agent emits them to the core bus which fans out to C's frontend).
"""

from __future__ import annotations

import json
import os
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any

from .shopper import run_task, BehaviourMode

PORT = int(os.environ.get("SHOPPER_PORT", "4200"))


class Handler(BaseHTTPRequestHandler):
    def log_message(self, format: str, *args: Any) -> None:
        pass  # suppress default stdout logging

    def do_POST(self) -> None:
        if self.path != "/agent/run":
            self._send(404, {"error": "NOT_FOUND"})
            return

        length = int(self.headers.get("content-length", 0))
        body = self.rfile.read(length)
        try:
            data = json.loads(body)
        except json.JSONDecodeError:
            self._send(400, {"error": "INVALID_JSON"})
            return

        task_id = data.get("taskId")
        description = data.get("taskDescription", "")
        plan = data.get("plan", [])
        mode: BehaviourMode = data.get("mode", "normal")
        agent_id = data.get("agentId", "")

        if not task_id or not agent_id:
            self._send(400, {"error": "taskId and agentId are required"})
            return

        # Collect events emitted by the agent (they also go to the core SSE bus)
        events: list[dict[str, Any]] = []

        def collect_emit(event: dict[str, Any]) -> None:
            events.append(event)
            # Also POST to the core bus forwarding endpoint if available
            try:
                import urllib.request as ur
                core_url = os.environ.get("CORE_URL", "http://localhost:4000")
                payload = json.dumps(event).encode()
                ur.urlopen(
                    ur.Request(f"{core_url}/internal/emit", data=payload, headers={"content-type": "application/json"}),
                    timeout=1,
                )
            except Exception:
                pass  # not critical — core may be unavailable

        try:
            results = run_task(
                task_id=task_id,
                task_description=description,
                plan=plan,
                mode=mode,
                agent_id=agent_id,
                emit=collect_emit,
            )
            self._send(200, {"taskId": task_id, "results": results, "events": events})
        except Exception as exc:
            self._send(500, {"error": str(exc)})

    def _send(self, status: int, body: Any) -> None:
        payload = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


if __name__ == "__main__":
    server = HTTPServer(("0.0.0.0", PORT), Handler)
    print(f"shopper agent listening on http://0.0.0.0:{PORT}")
    server.serve_forever()
