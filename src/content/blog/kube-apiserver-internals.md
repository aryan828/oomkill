---
title: kube-apiserver Internals
description: How the Kubernetes API server processes requests, talks to etcd, and keeps every controller and kubelet in sync without polling.
pubDate: 2026-06-10
tags: [kubernetes, systems, distributed-systems]
---

The kube-apiserver is the only component in the Kubernetes control plane that the others aren't supposed to talk around. Controllers, kubelets, schedulers: everything goes through it. It's the hub in a literal hub-and-spoke pattern, and that design choice ripples through every part of how the system works.

This post covers how the API server processes a request from start to finish, how its relationship with etcd enables the watch mechanism every controller depends on, and what the client-go machinery actually does under the hood.

## The hub-and-spoke pattern

All API usage from nodes and pods terminates at the API server. None of the other control plane components are designed to expose remote services. The scheduler, controller-manager, and cloud-controller-manager all pull from the API server; they push nothing. The kubelet on each node registers itself and reports pod status through the API server. Critically though, when the API server needs to talk *to* a kubelet (for `kubectl exec`, `kubectl logs`, or health probing) it calls the kubelet's HTTPS endpoint directly, and by default it does not verify the kubelet's serving certificate. That makes those connections vulnerable to MITM attacks on untrusted networks. Pass `--kubelet-certificate-authority` if you care about that path.

<figure class="diagram">
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 320" fill="none" role="img" aria-labelledby="fig-hub-title">
<title id="fig-hub-title">kube-apiserver hub-and-spoke: all components communicate through the API server; the API server connects outward to kubelet and etcd.</title>
<defs>
  <marker id="arr" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
    <path d="M0 0 L7 3.5 L0 7 Z" fill="var(--color-muted)"/>
  </marker>
  <marker id="arr-accent" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
    <path d="M0 0 L7 3.5 L0 7 Z" fill="var(--color-accent)"/>
  </marker>
</defs>

<!-- API server (center) -->
<rect x="240" y="130" width="160" height="44" rx="6" fill="var(--color-border)" stroke="var(--color-accent)" stroke-width="2"/>
<text x="320" y="156" fill="var(--color-text)" font-family="ui-monospace,monospace" font-size="13" font-weight="700" text-anchor="middle">kube-apiserver</text>

<!-- etcd (right) -->
<rect x="480" y="134" width="80" height="36" rx="6" fill="var(--color-border)" stroke="var(--color-muted)" stroke-width="1.5"/>
<text x="520" y="157" fill="var(--color-text)" font-family="ui-monospace,monospace" font-size="11" font-weight="600" text-anchor="middle">etcd</text>

<!-- scheduler (top-left) -->
<rect x="60" y="30" width="120" height="36" rx="6" fill="var(--color-border)" stroke="var(--color-muted)" stroke-width="1.5"/>
<text x="120" y="53" fill="var(--color-text)" font-family="ui-monospace,monospace" font-size="11" font-weight="600" text-anchor="middle">kube-scheduler</text>

<!-- controller-manager (top-right) -->
<rect x="350" y="30" width="156" height="36" rx="6" fill="var(--color-border)" stroke="var(--color-muted)" stroke-width="1.5"/>
<text x="428" y="53" fill="var(--color-text)" font-family="ui-monospace,monospace" font-size="11" font-weight="600" text-anchor="middle">controller-manager</text>

<!-- kubelet (bottom-left) -->
<rect x="60" y="234" width="80" height="36" rx="6" fill="var(--color-border)" stroke="var(--color-muted)" stroke-width="1.5"/>
<text x="100" y="257" fill="var(--color-text)" font-family="ui-monospace,monospace" font-size="11" font-weight="600" text-anchor="middle">kubelet</text>

<!-- kubectl / users (bottom-right) -->
<rect x="440" y="234" width="80" height="36" rx="6" fill="var(--color-border)" stroke="var(--color-muted)" stroke-width="1.5"/>
<text x="480" y="257" fill="var(--color-text)" font-family="ui-monospace,monospace" font-size="11" font-weight="600" text-anchor="middle">kubectl</text>

<!-- apiserver ↔ etcd -->
<line x1="400" y1="152" x2="480" y2="152" stroke="var(--color-accent)" stroke-width="1.5" marker-end="url(#arr-accent)"/>
<text x="438" y="145" fill="var(--color-accent)" font-family="ui-monospace,monospace" font-size="9" text-anchor="middle">read/write</text>

<!-- scheduler → apiserver -->
<line x1="180" y1="58" x2="258" y2="136" stroke="var(--color-muted)" stroke-width="1.5" marker-end="url(#arr)"/>

<!-- controller-manager → apiserver -->
<line x1="410" y1="66" x2="375" y2="132" stroke="var(--color-muted)" stroke-width="1.5" marker-end="url(#arr)"/>

<!-- kubelet → apiserver -->
<line x1="140" y1="243" x2="242" y2="170" stroke="var(--color-muted)" stroke-width="1.5" marker-end="url(#arr)"/>

<!-- kubectl → apiserver -->
<line x1="440" y1="248" x2="400" y2="174" stroke="var(--color-muted)" stroke-width="1.5" marker-end="url(#arr)"/>

<!-- apiserver → kubelet (dashed — exec/logs path) -->
<path d="M260 174 Q200 220 148 243" stroke="var(--color-muted)" stroke-width="1.2" stroke-dasharray="4 3" fill="none" marker-end="url(#arr)"/>
<text x="185" y="222" fill="var(--color-muted)" font-family="ui-monospace,monospace" font-size="9" text-anchor="middle">exec/logs</text>
</svg>
<figcaption>Solid lines: components reading or writing through the API server. Dashed: the reverse path where the API server calls the kubelet directly (exec, logs, port-forward). The API server is the only component with a direct connection to etcd.</figcaption>
</figure>

## What happens to a request

Every write request (`kubectl apply`, a controller patching status, the scheduler binding a pod) passes through the same pipeline inside the API server. The stages are roughly: TLS termination and authentication, authorization, admission control, schema validation, and finally persistence to etcd.

### Authentication

The API server supports multiple authenticator plugins simultaneously: client certificates, bearer tokens (static or from a token review webhook), bootstrap tokens, and OIDC. They run as a chain. The first one to recognize the credential wins. If none recognize it, the request proceeds as `system:anonymous`, which RBAC will almost certainly deny.

### Authorization

Authorization is also a chain, but the semantics are inverted from admission. A request is authorized as long as *any* module approves it. It's only denied if all modules return "no opinion" or "deny". For most clusters that means RBAC: a single RBAC `allow` is enough. The chain structure lets you bolt on Node authorization (restricts kubelets to resources on their own node) and Webhook authorization without replacing RBAC.

### Admission control

This is where the interesting manipulation happens, and it only applies to write operations. Reads (GET, LIST, WATCH) bypass admission entirely.

Admission runs in two sequential phases:

1. **Mutating admission**: plugins and webhooks may modify the object. Defaults get injected here (LimitRanger, DefaultStorageClass, etc.).
2. **Validating admission**: plugins and webhooks may only accept or reject. They see the final object after all mutations have applied.

If any controller in either phase rejects the request, the entire request is immediately rejected. The distinction between phases matters if you're writing a webhook: a mutating webhook cannot rely on seeing the final object state, because another mutating webhook might run after it. If your policy needs to inspect the final object, use a validating webhook, which runs after all mutations are complete.

The two-phase model extends to `ValidatingAdmissionPolicy` (Kubernetes 1.26+), which lets you embed CEL expressions directly in the cluster rather than running an out-of-process webhook server. Simpler operationally; it skips the HTTP round-trip, which matters under high write throughput.

## etcd and MVCC

The API server is the only component that talks to etcd. Everything else goes through the API server.

etcd uses multi-version concurrency control (MVCC). When a key is updated, the old version is preserved rather than overwritten. Every atomic mutation increments a monotonically increasing cluster-wide 64-bit counter called the **revision**. This gives you a total ordering of all mutations across the cluster, which is a property the watch mechanism depends on completely.

Compaction eventually purges old revisions to reclaim disk space. The counter never resets. "MVCC" describes the data model, not indefinite retention.

### Why revisions matter for watches

When you issue a LIST against the API server, the response includes a `resourceVersion`, a value derived from etcd's revision. When you subsequently issue a WATCH starting from that `resourceVersion`, you get every event since that revision, in order, with no gaps. Because revisions are total-ordered across all resource types, the watch stream is consistent: you won't see a Pod update arrive before the Namespace creation it depends on.

## The watch mechanism

WATCH is a distinct API verb, triggered by adding `?watch=true` to a GET request. The API server holds the connection open and streams events to the client as a chunked HTTP response. The client gets a sequence of typed events: `ADDED`, `MODIFIED`, `DELETED`, and `BOOKMARK` (a heartbeat that advances the client's `resourceVersion` without a real change).

The canonical client pattern is **list-watch**:

1. Issue a LIST to get current state at a specific `resourceVersion`.
2. Issue a WATCH starting from that `resourceVersion`.
3. Apply events to the local in-memory store.

This is how every controller and kubelet synchronizes state without polling. The watch replaces the timer; the list seeds the initial state.

When a watch connection drops, the client reconnects and re-watches from its last known `resourceVersion`. If that revision has been compacted out of etcd, the server returns a `410 Gone` and the client has to relist from scratch. This is the recovery path. It happens, it's handled, but it's expensive under churn.

## The Cacher: shielding etcd from the world

If every controller opened a watch against etcd directly, etcd would be crushed. The API server has an internal component called the **Cacher** that intercepts all WATCH and LIST requests for a given resource type and serves them from an in-memory store called `watchCache`.

The Cacher maintains a single `cache.Reflector` that talks to etcd using a ListerWatcher: one watch connection to etcd per resource type, regardless of how many clients are watching above it. It reads in chunks of 10,000 objects per page when initializing.

Client watches register as `cacheWatcher` objects against the `watchCache`. The Cacher never calls through to etcd's Watch API on behalf of individual clients. This multiplexing is what makes large clusters viable.

**Fan-out optimization**: when a client passes a field selector that matches an indexed field (like `spec.nodeName`), the Cacher routes that watcher to a per-value bucket (`valueWatchers[nodeName]`) rather than the global `allWatchers` bucket. When a change arrives, only watchers in the matching bucket get the event. This is how kubelets receive only the pods scheduled to their node without the API server broadcasting every pod update to everyone.

**Server-side predicate filtering**: when the Cacher evaluates a MODIFIED event, it decides what event type the client actually sees:

- Old object passed the filter, new one doesn't → deliver as `DELETED`
- New object passes, old one didn't → deliver as `ADDED`
- Both pass → deliver as `MODIFIED`
- Neither passes → emit nothing

This means a kubelet watching `spec.nodeName=node-1` sees an `ADDED` event when a pod is scheduled to its node, even though from etcd's perspective it was a MODIFIED event.

## client-go: the Reflector and SharedInformer

Most Kubernetes components are written against client-go, which provides two layers of abstraction above raw watches.

**Reflector** is the low-level producer. It calls List, records the returned `resourceVersion`, then calls Watch from that version. It pumps events into a `DeltaFIFO` queue. When a watch connection breaks and reconnects, any objects deleted during the gap can't be tracked. They show up in DeltaFIFO as `DeletedFinalStateUnknown`, with an uncertain final state and a potentially stale snapshot. Controllers have to handle this gracefully, which is one reason the level-driven design matters: you reconcile against what's there, not against what you think changed.

**SharedInformer** wraps a Reflector and adds an in-memory indexer and a fan-out event multiplexer. Multiple controllers in the same process register event handlers against the same SharedInformer. The key consequence: one watch connection to the API server, one deserialization pass per event, one cached copy per object. Without SharedInformers, every controller watching the same resource type would open its own connection and maintain its own cache, creating redundant load in every direction.

A `SharedInformerFactory` is typically instantiated once per process and used to obtain a SharedInformer per resource type. The Deployment controller, the ReplicaSet controller, and the Pod GC controller in kube-controller-manager all share the same Pod informer.

## Level-driven reconciliation

Controllers in Kubernetes are level-driven, not edge-driven. The distinction is operational: a level-driven controller reads current observed state and acts to move it toward desired state. An edge-driven controller reacts to transitions.

The implication: a controller cannot assume it has seen an object change from state A to state B. It can only assume it currently observes the object in state B. If it missed events while it was down, or if two events arrived in the wrong order, or if a watch reconnect caused a relist, the controller still needs to produce the correct outcome. It reconciles against what exists, not against what happened.

This is intentional. It makes controllers resilient to restarts, missed events, and redeliveries. The tradeoff is that you can't build a controller that depends on transition semantics. If you need to react to a value changing from `false` to `true`, you have to record that you've seen the `true` value (in the object's status, or via a finalizer) rather than relying on having observed the transition.

## API versioning

Versioning in Kubernetes is at the API path level (`/api/v1`, `/apis/apps/v1`, `/apis/rbac.authorization.k8s.io/v1alpha1`), not at the field level. This makes the stability guarantees explicit: a resource at `v1` will not have breaking changes, while `v1alpha1` makes no such promise. The API server can serve the same underlying object at multiple versions simultaneously, converting between them with a conversion function registered in the type machinery.

CRDs follow the same model: a CustomResourceDefinition specifies `versions`, each with a schema, and can designate one as the storage version. The API server converts on read and write. Once you add a version and objects get stored under it, removing it is a breaking change: old objects in etcd won't be readable.

## Extending the API: CRDs and the aggregation layer

Two mechanisms let you add resources to the Kubernetes API without modifying the API server binary.

**CustomResourceDefinitions** register new resource types directly in the main API server. The API server validates instances against the CRD's OpenAPI v3 schema (structural schemas, required since Kubernetes 1.15). The Cacher, watch mechanism, and admission pipeline all work for CRs exactly as they do for built-in types. The limitation is that you're running inside the main API server, so you can't use a custom storage backend or implement non-standard verbs.

**The aggregation layer** lets you run a separate API server process and register it under a path like `/apis/metrics.k8s.io/v1beta1`. The main API server proxies requests it receives for that group to your extension API server. This is how `metrics-server` works. Extension API servers get the full flexibility of a real API server (custom storage, custom admission logic, custom verbs) but they're operationally more complex. They need their own auth stack and must register via an `APIService` object.

The two approaches are not equivalent. A CRD is easier to operate and works well for most operator patterns. An aggregation API server is right when you need behavior the CRD model can't express: live data (metrics, logs), non-CRUD endpoints, or storage that isn't etcd.

## Operating the API server

A few operational realities worth knowing.

**High availability**: run 3+ instances behind a load balancer. Each instance is stateless; all state is in etcd. The leader-election controllers (scheduler, controller-manager) only run a single active instance at a time, but multiple API server replicas serve requests in parallel without coordination. The usual guidance is to keep etcd latency below 10ms for the API server to behave well; higher latency translates directly to higher request latency.

**API Priority and Fairness (APF)**: introduced to replace the older `--max-requests-inflight` / `--max-mutating-requests-inflight` flags. APF classifies requests into priority levels and queues them fairly, so a flood of low-priority requests (like a controller gone haywire doing repeated lists) cannot starve the system calls that matter (kubelet updates, health checks). It's configured through `FlowSchema` and `PriorityLevelConfiguration` resources.

**Auditing**: the API server can write an audit log of every request with configurable verbosity per API group and verb. Audit policies define which stages to log (RequestReceived, ResponseStarted, ResponseComplete, Panic) and which metadata to include. The two backends are log (stdout/file) and webhook (HTTP). At `RequestResponse` level you get the full request and response bodies, which is thorough but expensive at scale. Most clusters settle on logging metadata for most requests and full bodies only for sensitive operations like `secrets` writes.

**etcd compaction and defragmentation**: as the API server writes to etcd, old revisions accumulate. etcd compacts these on a schedule (`--auto-compaction-retention`), but compaction doesn't reclaim disk space. It just marks old revisions as deletable. Defragmentation (`etcdctl defrag`) actually reclaims the space. In large clusters, unscheduled defragmentation can cause elevated etcd latency during the operation; plan maintenance windows.

**Watch cache sizing**: the Cacher's watchCache for each resource type has a bounded event history. When a watch client falls behind and the events it needs have scrolled out of the cache, it gets a `410 Gone` and must relist. Under high write throughput, that cycle can become a performance problem. `--watch-cache-sizes` lets you increase the history buffer for specific resources.

---

The API server is one of those systems where the design choices at the bottom (etcd MVCC, total-ordered revisions, the hub-and-spoke topology) determine the shape of everything built on top. The watch mechanism works because revisions are total-ordered. SharedInformers work because the Cacher multiplexes. Level-driven controllers work because the watch mechanism guarantees eventual delivery without guaranteeing exactly-once. Pull on any thread and you find it connected to something three layers down.
