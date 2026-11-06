// extensions/behaviors/opensearch_capacity.ts
// Reads the capacity signals that went unwatched before the July heap
// incident: JVM heap, old-generation usage, parent circuit-breaker trips and
// shard density per GiB of heap.
import { z } from "npm:zod@4";

const GIB = 1024 ** 3;

const GlobalArgsSchema = z.object({
  url: z.string().url().describe("Base URL of the OpenSearch cluster"),
  username: z.string().default("admin").describe("Basic-auth user"),
  password: z.string().meta({ sensitive: true }).describe(
    "Basic-auth password; must come from a vault",
  ),
  timeout: z.number().positive().default(10000).describe(
    "Request timeout in milliseconds",
  ),
});

const NodeSchema = z.object({
  name: z.string(),
  heapMaxGiB: z.number(),
  heapUsedPercent: z.number(),
  oldGenPercent: z.number().describe(
    "Old-generation pool as a percentage of max heap; proxy for retained heap",
  ),
  parentBreakerTrips: z.number(),
});

const CapacitySchema = z.object({
  status: z.enum(["green", "yellow", "red"]),
  nodeCount: z.number(),
  activePrimaryShards: z.number(),
  activeShards: z.number(),
  unassignedShards: z.number(),
  maxHeapUsedPercent: z.number(),
  maxOldGenPercent: z.number(),
  totalParentBreakerTrips: z.number(),
  shardsPerNode: z.number(),
  shardsPerHeapGiB: z.number().describe(
    "Active shards per node divided by the smallest node heap in GiB",
  ),
  nodes: z.array(NodeSchema),
});

// deno-lint-ignore no-explicit-any
async function getJson(path: string, globalArgs: any) {
  const { url, username, password, timeout } = globalArgs;
  const response = await fetch(new URL(path, url), {
    headers: { Authorization: "Basic " + btoa(`${username}:${password}`) },
    signal: AbortSignal.timeout(timeout),
  });
  if (!response.ok) {
    throw new Error(`GET ${path} returned HTTP ${response.status}`);
  }
  return await response.json();
}

const round = (value: number) => Math.round(value * 10) / 10;

export const behavior = {
  type: "@olandodeflexy/opensearch-capacity",
  version: "2026.11.03.1",

  globalArguments: GlobalArgsSchema,

  resources: {
    capacity: {
      description: "Heap, breaker and shard-density snapshot of the cluster",
      schema: CapacitySchema,
      lifetime: "infinite" as const,
      garbageCollection: 500,
    },
  },

  methods: {
    snapshot: {
      description: "Read node JVM and breaker stats plus cluster health",
      arguments: z.object({}),
      // deno-lint-ignore no-explicit-any
      async execute(_args: Record<string, never>, context: any) {
        const [stats, health] = await Promise.all([
          getJson("/_nodes/stats/jvm,breaker", context.globalArgs),
          getJson("/_cluster/health", context.globalArgs),
        ]);

        // deno-lint-ignore no-explicit-any
        const nodes = Object.values(stats.nodes).map((node: any) => {
          const heapMax = node.jvm.mem.heap_max_in_bytes;
          return {
            name: node.name,
            heapMaxGiB: round(heapMax / GIB),
            heapUsedPercent: node.jvm.mem.heap_used_percent,
            oldGenPercent: round(
              (100 * node.jvm.mem.pools.old.used_in_bytes) / heapMax,
            ),
            parentBreakerTrips: node.breakers.parent.tripped,
          };
        });

        const nodeCount = nodes.length;
        const shardsPerNode = health.active_shards / nodeCount;
        const smallestHeap = Math.min(...nodes.map((n) => n.heapMaxGiB));

        const capacity = {
          status: health.status,
          nodeCount,
          activePrimaryShards: health.active_primary_shards,
          activeShards: health.active_shards,
          unassignedShards: health.unassigned_shards,
          maxHeapUsedPercent: Math.max(...nodes.map((n) => n.heapUsedPercent)),
          maxOldGenPercent: Math.max(...nodes.map((n) => n.oldGenPercent)),
          totalParentBreakerTrips: nodes.reduce(
            (sum, n) => sum + n.parentBreakerTrips,
            0,
          ),
          shardsPerNode: round(shardsPerNode),
          shardsPerHeapGiB: round(shardsPerNode / smallestHeap),
          nodes,
        };

        const handle = await context.writeResource(
          "capacity",
          "capacity",
          capacity,
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
