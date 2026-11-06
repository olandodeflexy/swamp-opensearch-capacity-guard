# OpenSearch Capacity Guard for Swamp

A typed Swamp behavior and a workflow that check an OpenSearch cluster for the capacity problems behind a heap-exhaustion incident I handled in July, on a three-node Wazuh indexer cluster.

That night, JVM heap on the indexer nodes was nearly full, retained heap after garbage collection was about 95%, and the parent circuit breaker was rejecting requests. Shard count was part of the cause: 540 primary shards on 2 GiB heaps. The immediate fix was a larger heap, made as one reviewed Git change. The structural fix is fewer shards: one primary per daily index, plus lifecycle migration of old indices. The post-incident report listed alerts for heap, breaker trips, shard density and cluster health. This repo is those alerts as a deterministic check.

## What's Here

| Path | What it is |
|---|---|
| `extensions/behaviors/opensearch_capacity.ts` | Behavior type `@olandodeflexy/opensearch-capacity`. Method `snapshot` reads `/_nodes/stats/jvm,breaker` and `/_cluster/health` and writes one typed `capacity` resource. |
| `staging/indexer-capacity-guard.body.yaml` | Workflow body: a `collect` job runs the snapshot, then a `verify` job runs six asserts against the stored data. |
| `mock/opensearch_mock.py` | Local mock of the two endpoints. It replays three states: `incident`, `post-fix` and `target`. |
| `setup.sh` / `reset.sh` | Builds the local Swamp repo around the source, and removes it again. |

## The Checks

| Assert | Severity | Rule |
|---|---|---|
| `cluster-not-red` | high | Cluster status is not red |
| `retained-heap-critical` | high | Old generation below 85% of heap on the worst node |
| `breaker-trips-not-increasing` | high | Parent breaker trips have not risen since the previous snapshot |
| `retained-heap-warning` | medium | Old generation below 70% of heap |
| `shard-density` | medium | No more than 20 active shards per GiB of heap, per node |
| `all-replicas-assigned` | medium | No unassigned shards |

The workflow runs every 5 minutes. Run it with `--fail-on high` to page, or with `--fail-on medium` in CI or a weekly review.

## Design Choices

- **A typed behavior, not `command/shell`.** The asserts read numbers such as `maxOldGenPercent` because the output schema promises numbers. If the API response changes shape, the run fails at the boundary, not in a dashboard later.
- **The password can only come from a vault.** The `password` global argument is marked `sensitive`, and the definition stores only `${{ vault.get(default, opensearch-password) }}`. `swamp doctor secrets` stays clean.
- **Old generation as a proxy for retained heap.** `heap_used_percent` swings with every young-generation collection. The old-generation pool is what stays after GC, and that's what was full in July.
- **Shard density is measured against the smallest heap.** The node with the least heap fails first, so the budget is checked there.
- **Every run is versioned data.** Each snapshot is a version of `indexer/capacity`, so the breaker check compares it with the previous one, and the run history is the evidence.

## Run It

You need [Swamp](https://swamp-club.com/manual) installed and `swamp auth login` done once. Use two terminals, and type the same made-up password in both.

**Terminal 1: the mock cluster**

```bash
read -s "MOCK_OPENSEARCH_PASSWORD?Mock password: " && export MOCK_OPENSEARCH_PASSWORD   # zsh; in bash: read -rsp "Mock password: " MOCK_OPENSEARCH_PASSWORD
python3 mock/opensearch_mock.py --scenario incident
```

**Terminal 2: Swamp**

```bash
./setup.sh                                                    # repo init, vault secret, definition, workflow, validate
swamp behavior run indexer snapshot                           # one snapshot by hand
swamp workflow run indexer-capacity-guard --fail-on high      # incident: 4 asserts fail, exit 1
```

Restart the mock with `--scenario post-fix`. Then:

```bash
swamp workflow run indexer-capacity-guard --fail-on high      # passes, exit 0; 2 medium findings recorded
```

Restart the mock with `--scenario target`. Then:

```bash
swamp workflow run indexer-capacity-guard --fail-on medium    # all 6 pass, exit 0
```

To inspect what was recorded:

```bash
swamp doctor secrets
swamp data versions indexer capacity
swamp workflow history list indexer-capacity-guard
```

`./reset.sh` removes the generated repo files, the local vault and the run history.

## Expected Results

| Scenario | Heap per node | Shards (active) | Worst old gen | Shards per GiB | Result at `--fail-on high` |
|---|---|---|---|---|---|
| `incident` | 2 GiB | 1019 | 95% | 169.8 | Fails: old gen critical and warning, shard density, unassigned replicas |
| `post-fix` | 8 GiB | 1019 | 21% | 42.5 | Passes; shard density and unassigned replicas recorded as medium |
| `target` | 8 GiB | 340 | 18% | 14.2 | Passes all six, also at `--fail-on medium` |

## Limits

- It has been run in local mode against the mock, not against a live cluster.
- Breaker counters reset when a node restarts, so the trip check catches increases between snapshots, not a total since the node started.
- The mock fills in only the fields the behavior reads.
