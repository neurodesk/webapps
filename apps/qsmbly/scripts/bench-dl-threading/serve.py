#!/usr/bin/env python3
"""Serve QSMbly cross-origin-isolated, with a result sink for headless bench runs.

Same COOP/COEP as the repo-root `serve.py` (wasm threads need cross-origin isolation), plus
`POST /result`, which appends each JSON body to `results.jsonl` next to this file. That is what
lets `run_bench.sh` drive a headless browser and collect timings without a debugger attached.

    python3 scripts/bench-dl-threading/serve.py [port]      # default 8099, serves the repo root
"""
import os
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))


class BenchHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        # `credentialless` matches the repo-root server and the deployed coi-serviceworker
        # config: SharedArrayBuffer is enabled, and cross-origin weights still fetch.
        self.send_header("Cross-Origin-Embedder-Policy", "credentialless")
        # Never cache, so a rebuilt bundle is always the one measured.
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_POST(self):
        if self.path.rstrip("/") != "/result":
            self.send_error(404)
            return
        body = self.rfile.read(int(self.headers.get("Content-Length") or 0))
        with open(os.path.join(HERE, "results.jsonl"), "ab") as f:
            f.write(body.rstrip(b"\n") + b"\n")
        self.send_response(204)
        self.end_headers()

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8099
    print(f"serving {REPO} cross-origin-isolated on http://localhost:{port}")
    print(f"bench page: http://localhost:{port}/scripts/bench-dl-threading/index.html")
    ThreadingHTTPServer(("", port), partial(BenchHandler, directory=REPO)).serve_forever()
