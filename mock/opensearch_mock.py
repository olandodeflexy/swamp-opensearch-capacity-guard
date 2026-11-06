"""Mock OpenSearch endpoints for the indexer capacity guard.

Replays three moments from a three-node indexer cluster with 540 primary
shards: the heap-exhaustion incident, the state right after the heap fix,
and the target state after shard remediation. Only the fields the guard
reads are filled in.

Usage: python3 mock/opensearch_mock.py --scenario incident [--port 9200]
Requires basic auth admin / $MOCK_OPENSEARCH_PASSWORD (default "changeme").
"""

import argparse
import base64
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

GIB = 1024 ** 3

SCENARIOS = {
    # 22:31 GMT on the incident night: 2 GiB heaps, parent breakers tripping.
    "incident": {
        "heap_gib": 2,
        "nodes": [(98, 95, 2_013_441), (85, 81, 1_987_220), (87, 83, 2_041_908)],
        "health": {"status": "yellow", "active_primary_shards": 540,
                   "active_shards": 1019, "unassigned_shards": 9},
    },
    # About 23:10 GMT after the fix: 8 GiB heaps, old generation near 21%,
    # breaker counters reset by the restart, shard count unchanged.
    "post-fix": {
        "heap_gib": 8,
        "nodes": [(46, 21, 0), (52, 20, 0), (39, 21, 0)],
        "health": {"status": "yellow", "active_primary_shards": 540,
                   "active_shards": 1019, "unassigned_shards": 9},
    },
    # Target after one primary per daily index and lifecycle migration.
    "target": {
        "heap_gib": 8,
        "nodes": [(41, 18, 0), (44, 17, 0), (38, 18, 0)],
        "health": {"status": "green", "active_primary_shards": 170,
                   "active_shards": 340, "unassigned_shards": 0},
    },
}


def node_stats(scenario):
    heap_max = scenario["heap_gib"] * GIB
    nodes = {}
    for index, (heap_pct, old_pct, tripped) in enumerate(scenario["nodes"]):
        nodes[f"node-{index}"] = {
            "name": f"wazuh-indexer-{index}",
            "jvm": {"mem": {
                "heap_used_percent": heap_pct,
                "heap_max_in_bytes": heap_max,
                "pools": {"old": {"used_in_bytes": heap_max * old_pct // 100}},
            }},
            "breakers": {"parent": {
                "limit_size_in_bytes": int(heap_max * 0.95),
                "tripped": tripped,
            }},
        }
    return {"cluster_name": "mock-indexer", "nodes": nodes}


class Handler(BaseHTTPRequestHandler):
    scenario = None
    expected_auth = None

    def do_GET(self):
        if self.headers.get("Authorization") != self.expected_auth:
            return self.reply(401, {"error": "unauthorized"})
        path = self.path.split("?")[0]
        if path == "/_nodes/stats/jvm,breaker":
            return self.reply(200, node_stats(self.scenario))
        if path == "/_cluster/health":
            return self.reply(200, {"cluster_name": "mock-indexer",
                                    "number_of_nodes": len(self.scenario["nodes"]),
                                    **self.scenario["health"]})
        self.reply(404, {"error": f"no mock for {path}"})

    def reply(self, status, body):
        payload = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--scenario", choices=sorted(SCENARIOS), required=True)
    parser.add_argument("--port", type=int, default=9200)
    args = parser.parse_args()
    password = os.environ.get("MOCK_OPENSEARCH_PASSWORD", "changeme")
    Handler.scenario = SCENARIOS[args.scenario]
    Handler.expected_auth = "Basic " + base64.b64encode(f"admin:{password}".encode()).decode()
    print(f"mock OpenSearch '{args.scenario}' on http://127.0.0.1:{args.port}")
    ThreadingHTTPServer(("127.0.0.1", args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
