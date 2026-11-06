#!/usr/bin/env bash
# Turns this folder into a local Swamp repo: the indexer definition (password
# from the vault) and the indexer-capacity-guard workflow.
# Usage: ./setup.sh            (prompts for the mock password, hidden input)
#        ./reset.sh            (removes everything setup.sh created)
set -euo pipefail
cd "$(dirname "$0")"

command -v swamp >/dev/null 2>&1 || { echo "Install swamp first: https://swamp-club.com/manual"; exit 1; }
swamp auth whoami >/dev/null 2>&1 || { echo "Not signed in. Run: swamp auth login"; exit 1; }
[ ! -e .swamp.yaml ] || { echo "Already a Swamp repo. Run ./reset.sh first."; exit 1; }

swamp repo init .
swamp behavior type describe @olandodeflexy/opensearch-capacity

echo "Mock password (the same value as MOCK_OPENSEARCH_PASSWORD for the mock):"
swamp vault put default opensearch-password

swamp behavior create @olandodeflexy/opensearch-capacity indexer \
  --global-arg url=http://127.0.0.1:9200 \
  --global-arg 'password=${{ vault.get(default, opensearch-password) }}'

# Swamp assigns the workflow id; keep it and load the reviewed body under it.
swamp workflow create indexer-capacity-guard
python3 - workflows/workflow-indexer-capacity-guard.yaml staging/indexer-capacity-guard.body.yaml <<'PY'
import re, sys
target, body = sys.argv[1], sys.argv[2]
match = re.search(r'^id:\s*(\S+)', open(target).read(), re.M)
if not match:
    sys.exit("no id: line in " + target)
open(target, "w").write(f"id: {match.group(1)}\n" + open(body).read())
PY
swamp workflow validate indexer-capacity-guard

echo
echo "Ready. Start the mock in another terminal, then:"
echo "  swamp workflow run indexer-capacity-guard --fail-on high"
