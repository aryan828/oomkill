---
title: ArgoCD Internals
description: What each ArgoCD component actually does, how the reconciliation loop works, and where things go quietly wrong.
pubDate: 2026-06-10
tags: [kubernetes, gitops, systems]
---

ArgoCD looks simple from the outside: git is the source of truth, the cluster reflects git, done. The complexity is in how it stays true. There are five components, each with a distinct job, and the interesting failure modes live at the boundaries between them.

This post is my notes on what each piece does, how a reconcile actually happens, and what breaks when something is slow or missing.

## The components

A standard ArgoCD installation runs five processes. They have different responsibilities and different failure characteristics.

| Component | Kind | What it owns |
| --- | --- | --- |
| `argocd-application-controller` | StatefulSet | Reconciliation loop, sync execution, cluster cache |
| `argocd-repo-server` | Deployment | Git operations, manifest rendering, render cache |
| `argocd-server` | Deployment | gRPC/REST API, UI backend, RBAC enforcement |
| `argocd-applicationset-controller` | Deployment | ApplicationSet → Application generation |
| `argocd-dex-server` | Deployment | OIDC federation (optional) |

Redis is also there, acting as a shared cache layer between these processes. It is not a source of truth — just a cache. I'll come back to that.

<figure class="diagram">
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 300" fill="none" role="img" aria-labelledby="fig-components-title">
<title id="fig-components-title">ArgoCD component relationships: git and cluster sit outside; the five internal components and Redis sit in the middle.</title>
<defs>
  <marker id="arr" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
    <path d="M0 0 L7 3.5 L0 7 Z" fill="var(--color-muted)"/>
  </marker>
  <marker id="arr-accent" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
    <path d="M0 0 L7 3.5 L0 7 Z" fill="var(--color-accent)"/>
  </marker>
</defs>

<!-- Git repo (left) -->
<rect x="12" y="120" width="80" height="36" rx="6" fill="var(--color-border)" stroke="var(--color-muted)" stroke-width="1.5"/>
<text x="52" y="143" fill="var(--color-text)" font-family="ui-monospace,monospace" font-size="11" font-weight="600" text-anchor="middle">git repo</text>

<!-- Kubernetes cluster (right) -->
<rect x="548" y="120" width="80" height="36" rx="6" fill="var(--color-border)" stroke="var(--color-muted)" stroke-width="1.5"/>
<text x="588" y="138" fill="var(--color-text)" font-family="ui-monospace,monospace" font-size="11" font-weight="600" text-anchor="middle">k8s</text>
<text x="588" y="152" fill="var(--color-text)" font-family="ui-monospace,monospace" font-size="11" font-weight="600" text-anchor="middle">cluster</text>

<!-- repo-server -->
<rect x="134" y="60" width="130" height="36" rx="6" fill="var(--color-border)" stroke="var(--color-accent)" stroke-width="1.5"/>
<text x="199" y="83" fill="var(--color-text)" font-family="ui-monospace,monospace" font-size="11" font-weight="600" text-anchor="middle">repo-server</text>

<!-- argocd-server -->
<rect x="134" y="180" width="130" height="36" rx="6" fill="var(--color-border)" stroke="var(--color-muted)" stroke-width="1.5"/>
<text x="199" y="203" fill="var(--color-text)" font-family="ui-monospace,monospace" font-size="11" font-weight="600" text-anchor="middle">argocd-server</text>

<!-- application-controller -->
<rect x="376" y="110" width="148" height="36" rx="6" fill="var(--color-border)" stroke="var(--color-accent)" stroke-width="1.5"/>
<text x="450" y="128" fill="var(--color-text)" font-family="ui-monospace,monospace" font-size="10" font-weight="600" text-anchor="middle">application-controller</text>
<text x="450" y="141" fill="var(--color-muted)" font-family="ui-monospace,monospace" font-size="9" text-anchor="middle">StatefulSet</text>

<!-- Redis -->
<rect x="270" y="130" width="80" height="36" rx="6" fill="var(--color-border)" stroke="var(--color-muted)" stroke-width="1.5" stroke-dasharray="4 3"/>
<text x="310" y="148" fill="var(--color-muted)" font-family="ui-monospace,monospace" font-size="11" text-anchor="middle">Redis</text>
<text x="310" y="161" fill="var(--color-muted)" font-family="ui-monospace,monospace" font-size="9" text-anchor="middle">(cache)</text>

<!-- git → repo-server -->
<line x1="92" y1="130" x2="134" y2="88" stroke="var(--color-muted)" stroke-width="1.5" marker-end="url(#arr)"/>

<!-- repo-server → controller -->
<line x1="264" y1="78" x2="376" y2="120" stroke="var(--color-accent)" stroke-width="1.5" marker-end="url(#arr-accent)"/>
<text x="318" y="90" fill="var(--color-accent)" font-family="ui-monospace,monospace" font-size="9" text-anchor="middle">manifests</text>

<!-- argocd-server → controller (triggers sync) -->
<line x1="264" y1="192" x2="376" y2="138" stroke="var(--color-muted)" stroke-width="1.5" marker-end="url(#arr)"/>
<text x="315" y="178" fill="var(--color-muted)" font-family="ui-monospace,monospace" font-size="9" text-anchor="middle">writes Operation</text>

<!-- controller → cluster -->
<line x1="524" y1="128" x2="548" y2="130" stroke="var(--color-accent)" stroke-width="1.5" marker-end="url(#arr-accent)"/>
<text x="535" y="120" fill="var(--color-accent)" font-family="ui-monospace,monospace" font-size="9" text-anchor="middle">apply</text>

<!-- controller → Redis -->
<line x1="376" y1="140" x2="350" y2="150" stroke="var(--color-muted)" stroke-width="1.2" stroke-dasharray="3 3" marker-end="url(#arr)"/>

<!-- repo-server → Redis -->
<line x1="199" y1="96" x2="290" y2="132" stroke="var(--color-muted)" stroke-width="1.2" stroke-dasharray="3 3" marker-end="url(#arr)"/>

<!-- cluster watch (controller → cluster, bottom arc) -->
<path d="M524 146 Q540 200 548 155" stroke="var(--color-muted)" stroke-width="1.2" stroke-dasharray="3 3" fill="none" marker-end="url(#arr)"/>
<text x="570" y="188" fill="var(--color-muted)" font-family="ui-monospace,monospace" font-size="9" text-anchor="middle">watch</text>
</svg>
<figcaption>The application controller is the only component that talks to the cluster. The repo server is the only one that talks to git. The API server talks to neither — it writes an Operation to the CRD and the controller picks it up.</figcaption>
</figure>

The key thing to understand up front: **the API server does not run any reconciliation**. When you click Sync in the UI, the server writes an `Operation` field to the Application CRD in etcd. The controller is watching that CRD and picks it up. The two processes are decoupled through Kubernetes resources.

## The Application Controller

This is the core of ArgoCD. It runs as a `StatefulSet` (for sharding across clusters) and owns two things: figuring out if an application is in sync, and actually syncing it when told to.

It has four work queues with dedicated goroutine pools:

- `appRefreshQueue` — runs status reconciliation (is the app in sync?)
- `appOperationQueue` — runs sync execution (apply resources to the cluster)
- `appComparisonTypeRefreshQueue` — adjusts comparison depth
- `projectRefreshQueue` — refreshes apps when their AppProject changes

Default workers: 20 for status reconciliation, 10 for sync execution. For a cluster with hundreds of apps, you'll need to tune both up.

### The reconciliation loop

Every 180 seconds (plus up to 60s of random jitter to avoid thundering herds), the controller enqueues all applications for reconciliation. This is the baseline polling fallback — webhooks can trigger reconciles sooner, but the timer is always there.

`processAppRefreshQueueItem` is the main work function. In order:

1. Pull the application from the informer cache
2. Decide how deep the comparison should be (more on this below)
3. Call `appStateManager.CompareAppState()` — the expensive step
4. Run auto-sync if configured
5. Patch `app.Status` back to etcd

`CompareAppState` does two things in parallel: it fetches target manifests from the repo server (a gRPC call), and it reads live cluster state from the in-memory cluster cache (no API server round-trip). Then it diffs them.

**Comparison levels** control how fresh the manifests need to be:

| Level | What it does |
| --- | --- |
| `CompareWithNothing` | Skip the diff, just refresh the resource health tree |
| `CompareWithRecent` | Diff against the revision from the last successful comparison |
| `CompareWithLatest` | Fetch fresh manifests from the repo server (may use Redis cache) |
| `CompareWithLatestForceResolve` | Force the repo server to re-resolve the git ref — bypasses all caches |

A normal webhook-triggered refresh runs at `CompareWithLatest`. A hard refresh (the button in the UI, or `argocd app get --hard-refresh`) runs at `CompareWithLatestForceResolve` — it forces a real `git fetch`.

### What OutOfSync actually means

After `CompareAppState` fetches target manifests and live state, it calls `argodiff.StateDiffs()`. This is a 3-way merge per resource using the `kubectl.kubernetes.io/last-applied-configuration` annotation as the base — the same logic as `kubectl apply`.

If `ResourceDiff.Modified == true` for any resource, the application is `OutOfSync`. `IgnoreDifferences` rules are applied before this — you can point them at specific JSON paths or write JQ expressions to filter out fields you don't control (injected sidecars, operator-managed annotations, etc.).

The alternative is server-side diff: with `ServerSideDiff=true` in sync options, ArgoCD submits a dry-run `kubectl apply --server-side --dry-run=server` and reads the managed-fields diff back. More accurate for resources that admission controllers mutate, but requires an extra API server round-trip per reconcile.

## The Repo Server

The repo server is a stateless gRPC service that does one thing: given a `(repoURL, revision, path)`, return rendered manifests. It is the only component that touches git. It never talks to the cluster.

The controller and API server both call it via gRPC — `RepoServerService.GenerateManifest`.

**Tool dispatch** — when a request comes in, the repo server figures out what renderer to use:

1. Config Management Plugin (CMP) — checks for plugin sockets in `/plugins`
2. Helm — detected by `Chart.yaml` presence
3. Kustomize — detected by `kustomize.yaml` / `kustomization.yml`
4. Plain YAML — fallthrough for everything else

For Helm, it runs `helm dependency build` then `helm template`. For Kustomize, it runs `kustomize edit set ...` for each image/parameter override, then `kustomize build`. For plain YAML, it reads all `.yaml` / `.yml` files from the path recursively.

**Concurrency control** matters here. Kustomize uses `kustomize edit` commands that mutate files on disk, so it holds a per-repository lock while rendering. If you have ten apps pointing at the same repo with different Kustomize overlays, they serialize. `--parallelismlimit` caps concurrent child processes to prevent fork bombs under load.

**Failure backoff:** If manifest generation fails repeatedly, the repo server tracks `NumberOfConsecutiveFailures`. After a configurable threshold, generation is paused for a period to stop hammering broken configurations and filling logs with the same error.

### Caching

The repo server caches aggressively in Redis. The manifest response for a `(repoURL, commitSHA, appPath, tool-config-hash)` tuple is cached for 24 hours. If the same commit SHA comes in twice, the second request hits cache and returns immediately.

Some of the key Redis key patterns:

| Key | What's stored | TTL |
| --- | --- | --- |
| `git-refs\|<repo>` | Branch-to-SHA reference map | 3 min |
| `helm-index\|<repo>` | Helm repo index.yaml | 3 min |
| `revisionmetadata\|<repo>\|<rev>` | Commit author, date, message | 24 h |
| `appdetails\|<...>` | Source type, detected parameters | 24 h |
| manifest response | Rendered YAML for a commit+path | 24 h |

When a webhook arrives for a new commit, the repo server calls `repoCache.SetNewRevisionManifests(newSHA, oldSHA)` — it renames the Redis entry from the old SHA key to the new one. This warms the cache before the Application Controller asks for it, so the first reconcile after a push is fast.

## The Cluster Cache

The Application Controller maintains an in-memory cache of every Kubernetes resource across every managed cluster. This is what lets it reconcile thousands of apps without hammering the API server.

On startup, it pages through all resources via paginated List calls (page size 500), then establishes Watches. After that, the API server streams events to the cache — Add, Update, Delete. The controller doesn't poll; it reacts.

Each cached resource carries:
- Which ArgoCD application owns it (the tracking label/annotation)
- Its computed health status
- A manifest hash for change detection
- Networking metadata for Services and Pods (for the network view in the UI)

When the cluster cache receives an event for a resource owned by an app, it enqueues that app for reconciliation at `CompareWithRecent`. This is how a manual `kubectl edit` on a live resource triggers an immediate OutOfSync — the watch fires, the controller wakes up.

The cluster watch resyncs every 10 minutes — a full relist to catch any events that might have been missed during a disconnect.

**Resource tracking modes:**
- `label` — stores `<appName>` as a Kubernetes label (63-character limit enforced)
- `annotation` — stores the full tracking ID as an annotation (no size limit)
- `annotation+label` — both, for compatibility with older ArgoCD tooling

The tracking ID format is `<appName>:<group>/<kind>:<namespace>/<name>`. This is what ArgoCD uses to determine which resources belong to which application, and which need to be pruned when they disappear from git.

## Redis

Redis is disposable. The ArgoCD docs say it explicitly: if Redis loses all data, the system rebuilds without service disruption.

What's in Redis:

| Key pattern | What's stored | TTL |
| --- | --- | --- |
| `app\|managed-resources\|<appName>` | Full `[]ResourceDiff` — the diff result | 1 h |
| `app\|resources-tree\|<appName>` | Resource hierarchy for UI tree view | 1 h |
| `cluster\|info\|<server>` | Cluster connection metadata | 10 min |
| Repo manifest cache | All the repo server keys above | 3 min – 24 h |

**What breaks when Redis goes down:**
- The repo server has no manifest cache. Every reconcile forces a fresh manifest render — repo server CPU and git fetch load spike.
- The UI's resource tree view requires recomputation on every request — API server load goes up.
- Applications still sync. Status still reconciles. The cluster cache is in the controller's heap, not Redis. Ongoing syncs continue.

The slowdown can be severe under load, but it's a performance problem, not a correctness problem. When Redis comes back, the caches rebuild from live state over the next few minutes.

## Webhook vs. Polling

ArgoCD refreshes apps two ways: polling and webhooks.

**Polling** is the fallback. The `timeout.reconciliation` setting in `argocd-cm` (default 3 minutes) controls how often the API server enqueues a refresh for all apps. Regardless of whether webhooks work, apps will eventually be checked.

**Webhooks** make it fast. GitHub, GitLab, Bitbucket, Azure DevOps, and Gogs are all supported at `/api/webhook`. The API server validates the HMAC signature, then pushes the event onto a buffered channel (capacity 50,000). Worker goroutines drain the channel.

For each incoming webhook, ArgoCD picks which apps to refresh by checking three things:
1. Does the repo URL match the app's source URL? (normalized for SSH/HTTPS variants)
2. Does the pushed branch/tag match the app's `targetRevision`?
3. Do any changed files overlap with the app's `argocd.argoproj.io/manifest-generate-paths` annotation?

That third check is critical for monorepos. Without `manifest-generate-paths`, every push to the repo refreshes every app. With it set to the app's chart or overlay directory, only pushes that touch that path trigger a refresh. For a monorepo with 50 apps, this is the difference between 50 repo server render calls and 1.

## The Sync Operation Flow

When you click Sync:

1. **API server** receives the `ApplicationService.Sync` RPC, constructs an `Operation` struct (revision, prune flag, dry-run, sync strategy, resource selection), and writes it to the Application CRD's `.spec.operation` field via a Kubernetes patch call. That's all it does.

2. **Application Controller** watches Application CRDs via an informer. The Update event fires. `processAppOperationQueueItem` sees a non-nil `.spec.operation`, validates sync windows, calls `CompareAppState` to get concrete manifests, and builds a `SyncContext`.

3. **SyncContext.Sync** applies resources in waves. Waves come from the `argocd.argoproj.io/sync-wave` annotation (default wave 0). Within each wave: PreSync hooks run first, then resources are applied, then PostSync hooks. A 2-second delay between waves gives controllers time to react before ArgoCD checks health.

4. **Per resource**, three application strategies:
   - Default: `kubectl apply` (client-side apply; stores last-applied state in a 262KB-limited annotation)
   - `ServerSideApply=true`: `kubectl apply --server-side --force-conflicts` (no annotation, tracked via managed fields, no size limit)
   - `Replace=true` or `Force=true`: destructive; used for immutable resources like Jobs

5. **Prune**: resources present in the cluster with the app's tracking label, but absent from the target manifests, are deleted after all waves complete. `PruneLast=true` defers this until after health checks pass.

6. After sync completes, the controller calls `persistRevisionHistory` and records the event to `app.Status.History`.

The `ApplyOutOfSyncOnly=true` optimization skips applying resources that are already in sync — useful when you have hundreds of resources but only a handful changed.

## Health Assessment

ArgoCD computes health for each resource and aggregates up to the application level.

Lookup order for health logic:
1. Custom Lua script in `argocd-cm` (key: `resource.customizations.health.<group>_<kind>`)
2. Built-in Lua scripts embedded in the binary (ships hundreds of scripts for cert-manager, Flux, Crossplane, Istio, Prometheus, database operators, etc.)
3. Go-based built-in checks for core types (Deployment, StatefulSet, DaemonSet, Job, Service, PVC, Pod, Ingress, HPA)

Lua scripts run inside a sandboxed GopherLua VM with a 1-second timeout. The script receives the resource object as `obj` and must return `{status: "...", message: "..."}`.

**HealthStatusCode values:**
- `Healthy` — fully operational
- `Progressing` — not yet healthy but expected to recover (Deployment rollout in progress)
- `Suspended` — intentionally paused (CronJob suspended)
- `Degraded` — failed or cannot reach healthy state
- `Missing` — resource not present in cluster
- `Unknown` — health assessment failed

Application-level health is the worst status across all managed resources, in this priority order: `Healthy < Suspended < Progressing < Missing < Degraded < Unknown`. A single Degraded pod makes the whole application Degraded.

One important caveat: health is not inherited transitively. A parent resource's health reflects its own status fields — not the health of its children. A Deployment health check reads `spec.replicas` vs `status.availableReplicas`. It doesn't recurse into the Pods underneath.

## The ApplicationSet Controller

ApplicationSet is a separate controller that generates Application objects from templates. Instead of creating one Application CRD per app in git, you write one ApplicationSet and let the controller generate them.

Generators are the interesting part:

- **List**: fixed array of key-value maps → one app per entry
- **Cluster**: iterates registered ArgoCD clusters → one app per cluster (useful for fleet management)
- **Git files**: scans a repo for JSON/YAML files matching a glob → one app per file, parameters come from the file contents
- **Git directories**: one app per directory matching a pattern
- **Matrix**: cartesian product of two generators — (environments) × (apps) = N×M Applications
- **Merge**: combines two generators using a merge key to join matching rows

The reconcile loop generates all parameter sets from all generators, applies template substitution (`{{parameter.name}}` → value), then creates/updates/deletes Applications to match.

**Progressive sync** (RollingSync strategy) is available if you need to roll out changes across groups of apps in sequence. Apps are grouped by label selectors. The controller waits for each group to reach `Healthy` before moving to the next. Important catch: RollingSync forces auto-sync off on all managed Applications — the ApplicationSet controller drives syncs, not the app controller's built-in auto-sync.

## The app-of-apps pattern

Before ApplicationSet existed, the common pattern was to put Application manifests in git and let a root Application sync them into the ArgoCD namespace. The Application Controller picks up the new CRDs via its informer and treats them as regular applications.

The controller has no concept of a parent-child relationship between applications. It sees them as independent. Ordering child app syncs requires adding `sync-wave` annotations to the Application manifests themselves — the controller doesn't infer any ordering from the app-of-apps topology.

The cascading deletion gotcha: without the `resources-finalizer.argocd.argoproj.io` finalizer on the child Application manifests, deleting the root app removes the CRDs but leaves all the actual workloads running in the cluster, orphaned. With the finalizer, ArgoCD deletes managed resources before removing the CRD.

## Failure modes

**Slow repo server:** The Application Controller has a 60-second gRPC timeout for `GenerateManifest`. If the repo server is under load (large Helm charts, many concurrent renders, a monorepo with many apps serializing behind the per-repo lock), timeouts start accumulating. Apps go to `Unknown` status with a condition explaining the timeout. There's a 180-second grace period — apps stay at their last known status before showing errors, which prevents false OutOfSync alarms during transient slowness.

**Redis down:** Performance degrades significantly. Every reconcile forces a manifest render. Every UI tree view requires recomputation. Under a large number of apps, the repo server and API server both see a load spike. Apps continue to sync correctly because the cluster cache is in the controller's heap, not Redis.

**Many resources in one sync:** `--kubectl-parallelism-limit` (default 20) caps concurrent kubectl calls. A 500-resource sync runs in batches of 20, plus 2 seconds between each sync wave. For applications with deep wave hierarchies, that adds up. Server-side apply removes the 262KB annotation limit for large resources, but you need a recent Kubernetes version and it requires an extra API server round-trip per reconcile.

**Thundering herd on startup:** The Application Controller starts and needs to build the cluster cache by listing all resources across all managed clusters. If many clusters are registered, the initial list phase hammers the Kubernetes API servers. The `clusterCacheListPageSize` (default 500) and the list semaphore limit concurrent list operations, but a cold start for a large fleet will always have a warm-up period before the first reconcile is accurate.

## Key numbers

| Parameter | Default | Where it lives |
| --- | --- | --- |
| App resync period | 180 s + up to 60 s jitter | `--app-resync` / `--app-resync-jitter` |
| Git polling interval | 3 min | `timeout.reconciliation` in `argocd-cm` |
| Repo server gRPC timeout | 60 s | `--repo-server-timeout-seconds` |
| Repo error grace period | 180 s | `--repo-error-grace-period-seconds` |
| Manifest cache TTL | 24 h | `--repo-cache-expiration` |
| App state cache TTL | 1 h | `ARGOCD_APP_STATE_CACHE_EXPIRATION` |
| Cluster watch resync | 10 min | `clusterCacheWatchResyncDuration` |
| Status processor workers | 20 | `--status-processors` |
| Operation processor workers | 10 | `--operation-processors` |
| kubectl parallelism | 20 | `--kubectl-parallelism-limit` |
| Sync wave delay | 2 s | `ARGOCD_SYNC_WAVE_DELAY` |

The numbers that bite people most often: the 60-second repo server timeout (too short for large Helm charts on first render), the 20 kubectl workers (too low for applications with hundreds of resources), and the git polling interval of 3 minutes (expected if webhooks aren't configured; surprising if they are but something in the chain is dropping them).

I'm still working through some of the ApplicationSet edge cases — progressive sync and the interaction between RollingSync and auto-sync has more to it than I've covered here. That might be a follow-up post if I can build a good lab setup for it.
