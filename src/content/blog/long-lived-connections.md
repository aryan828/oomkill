---
title: Long-Lived Connections
description: What persistent connections buy you, what they cost, and failure modes that are easy to miss when you're learning the stack.
pubDate: 2026-05-18
tags: [systems, networking, http]
---

Long-lived connections are one of those topics that sound simple until you try to explain why a live UI "feels stuck" while every health check is green.

The usual failure mode: the client still thinks the WebSocket is open, but a load balancer dropped the flow minutes ago because idle timeouts didn't line up. Nothing crashes. Metrics look fine. The connection just quietly lies.

This post is my notes on what long-lived connections are, where they show up, and why the boring middlebox details matter as much as the application code. Most of it comes from reading, small experiments, and getting surprised in homelab setups.

## What we're actually talking about

Most of the internet still runs on TCP, and TCP has a personality trait: once it's open, it *wants* to stay open.

A **long-lived connection** is exactly what it sounds like. You open a socket once and reuse it for a while instead of handshaking, requesting, and closing for every single interaction. On paper that's obvious. In production it's a trade: you save repeated setup cost, but you inherit **state**. Something, somewhere, has to remember that this connection exists, who's on the other end, and when it's safe to kill it.

If you've only ever built request/response APIs, you can go years without thinking about this. The moment you add live UI, streaming, chat, or a connection pool to Postgres, you're in the club.

## The naive model (and why it hurts)

Here's the version of HTTP we all learned in tutorials:

1. TCP handshake (one round trip, more if TLS is involved)
2. Send request, read response
3. Close the connection

Clean. Easy to reason about. Also expensive if you're doing it hundreds of times a second.

In a small browser polling experiment I ran locally (one request per second), the interesting cost wasn't the JSON. It was setup. Each poll opened a fresh connection because keep-alive was off on one hop. Turning it on and fixing a stray `Connection: close` header cut latency noticeably. Same logic, fewer handshakes.

For a dashboard that fires twenty parallel requests on page load, or a mobile app that wakes up and syncs, the tax adds up fast. You're not paying for bytes so much as for **round trips** and **setup**.

<figure class="diagram">
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 248" fill="none" role="img" aria-labelledby="fig-keepalive-title">
<title id="fig-keepalive-title">Short-lived connections open a new socket per request; keep-alive reuses one socket.</title>
<defs>
<marker id="arrow-muted" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
<path d="M0 0 L7 3.5 L0 7 Z" fill="var(--color-muted)"/>
</marker>
<marker id="arrow-accent" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
<path d="M0 0 L7 3.5 L0 7 Z" fill="var(--color-accent)"/>
</marker>
</defs>
<text x="320" y="22" fill="var(--color-muted)" font-family="ui-monospace, monospace" font-size="11" font-weight="600" text-anchor="middle">SHORT-LIVED</text>
<text x="320" y="36" fill="var(--color-muted)" font-family="ui-monospace, monospace" font-size="10" text-anchor="middle">one request per connection</text>
<rect x="56" y="52" width="76" height="38" rx="6" fill="var(--color-border)" stroke="var(--color-muted)" stroke-width="1.5"/>
<text x="94" y="76" fill="var(--color-text)" font-family="system-ui, sans-serif" font-size="12" font-weight="600" text-anchor="middle">Client</text>
<rect x="508" y="52" width="76" height="38" rx="6" fill="var(--color-border)" stroke="var(--color-muted)" stroke-width="1.5"/>
<text x="546" y="76" fill="var(--color-text)" font-family="system-ui, sans-serif" font-size="12" font-weight="600" text-anchor="middle">Server</text>
<text x="320" y="64" fill="var(--color-muted)" font-family="ui-monospace, monospace" font-size="10" text-anchor="middle">handshake · request · close</text>
<line x1="140" y1="71" x2="504" y2="71" stroke="var(--color-muted)" stroke-width="2" stroke-dasharray="5 4" marker-end="url(#arrow-muted)"/>
<rect x="56" y="98" width="76" height="38" rx="6" fill="var(--color-border)" stroke="var(--color-muted)" stroke-width="1.5" opacity="0.85"/>
<text x="94" y="122" fill="var(--color-text)" font-family="system-ui, sans-serif" font-size="12" font-weight="600" text-anchor="middle">Client</text>
<rect x="508" y="98" width="76" height="38" rx="6" fill="var(--color-border)" stroke="var(--color-muted)" stroke-width="1.5" opacity="0.85"/>
<text x="546" y="122" fill="var(--color-text)" font-family="system-ui, sans-serif" font-size="12" font-weight="600" text-anchor="middle">Server</text>
<text x="320" y="110" fill="var(--color-muted)" font-family="ui-monospace, monospace" font-size="10" text-anchor="middle">handshake · request · close (again)</text>
<line x1="140" y1="117" x2="504" y2="117" stroke="var(--color-muted)" stroke-width="2" stroke-dasharray="5 4" marker-end="url(#arrow-muted)"/>
<line x1="48" y1="148" x2="592" y2="148" stroke="var(--color-border)" stroke-width="1"/>
<text x="320" y="168" fill="var(--color-accent)" font-family="ui-monospace, monospace" font-size="11" font-weight="600" text-anchor="middle">KEEP-ALIVE</text>
<text x="320" y="182" fill="var(--color-muted)" font-family="ui-monospace, monospace" font-size="10" text-anchor="middle">one TCP connection, many requests</text>
<rect x="56" y="192" width="76" height="38" rx="6" fill="var(--color-border)" stroke="var(--color-accent)" stroke-width="2"/>
<text x="94" y="216" fill="var(--color-text)" font-family="system-ui, sans-serif" font-size="12" font-weight="600" text-anchor="middle">Client</text>
<rect x="508" y="192" width="76" height="38" rx="6" fill="var(--color-border)" stroke="var(--color-accent)" stroke-width="2"/>
<text x="546" y="216" fill="var(--color-text)" font-family="system-ui, sans-serif" font-size="12" font-weight="600" text-anchor="middle">Server</text>
<line x1="140" y1="211" x2="504" y2="211" stroke="var(--color-accent)" stroke-width="2.5" marker-end="url(#arrow-accent)"/>
<circle cx="232" cy="211" r="4" fill="var(--color-accent)"/>
<circle cx="320" cy="211" r="4" fill="var(--color-accent)"/>
<circle cx="408" cy="211" r="4" fill="var(--color-accent)"/>
<text x="320" y="204" fill="var(--color-accent)" font-family="ui-monospace, monospace" font-size="10" text-anchor="middle">req · req · req</text>
</svg>
<figcaption>Short-lived: a new handshake per request. Keep-alive: one socket, many requests.</figcaption>
</figure>

</figure>

**HTTP keep-alive** is the first escape hatch. Same TCP connection, multiple requests to the same host. Your browser does this by default. Your reverse proxy probably does too. You usually only notice it when something in the chain disables it, or when idle timeouts fight each other.

**HTTP/2** pushes further: many logical streams multiplex over one TCP connection. The browser can send twenty requests in parallel without opening twenty sockets. The tricky part is that head-of-line blocking moves from the HTTP layer down to TCP — one lost packet stalls all streams until it's retransmitted.

**HTTP/3** swaps TCP for QUIC, which is UDP plus reliability logic built into the protocol. Each stream is independent at the transport layer, so a dropped packet only stalls the one stream it belongs to, not everything else. The tradeoff is that QUIC is a much fatter stack to operate: your LB needs to handle UDP, path MTU discovery behaves differently, and connection migration (when a phone switches from WiFi to LTE mid-session) is a real feature you now have to think about rather than a lucky accident.

Multiplexing is great until you realize your load balancer needs to actually understand the protocol end-to-end, not just pass bytes through and hope. An nginx in TCP proxy mode in front of a gRPC backend over HTTP/2 will give you one connection to each backend pod — your clever connection-level routing disappears.

The trade is always the same: fewer handshakes and less CPU spent on setup, in exchange for **remembering things**. Who's connected. How long they've been idle. What happens when they go away without saying goodbye.

## The zoo of long-lived patterns

Not all long-lived connections are the same shape. Here's how I mentally sort them.

| Pattern | Direction | Typical use |
| --- | --- | --- |
| HTTP keep-alive | Request/response | Browsers, REST APIs, nginx → app |
| WebSockets | Bidirectional | Live dashboards, games, collab tools |
| Server-Sent Events | Server → client | Notifications, log tailing, "good enough" push |
| gRPC / HTTP/2 streams | Multiplexed RPC | Service-to-service, internal APIs |
| Connection pools | App → database | Postgres, Redis, anything with `max_connections` |

### HTTP keep-alive

This is the baseline. It's so default now that the interesting bugs are subtle: a middleware that forces `Connection: close`, a health check that opens a new connection per probe and exhausts ephemeral ports, a client library that pools incorrectly across hosts.

If your API "works in curl" but stutters in the browser, it's worth checking whether you're accidentally paying the full connection tax on every call.

### WebSockets

WebSockets upgrade HTTP into a bidirectional channel. They're great when the UI needs to change the moment something happens on the server. They're less great when you reach for them because you heard they're "real-time" and you only needed occasional server push.

It's tempting to run generic RPC over WebSockets because the client library is already there. It works until you need proper backpressure, versioning, or straightforward HTTP debugging. Then you miss HTTP.

### Server-Sent Events (SSE)

SSE keeps a one-way stream open over ordinary HTTP. I like SSE more than I expected. For "server tells the client something changed" it's often enough, and you don't have to redesign your auth or routing around a separate protocol.

The constraints are real though: text framing, one direction, and some proxies buffer SSE oddly. Know your path.

### gRPC and HTTP/2 streams

Inside the cluster, multiplexed RPC over long-lived connections is usually the right default. One connection, many in-flight calls, less handshake noise.

The footgun is at the edge. Terminate TLS at an L7 LB that doesn't speak HTTP/2 to the backend correctly, or pin HTTP/1.1 somewhere in the chain, and you'll spend a week reading grpc-go logs that look fine in isolation.

The subtler problem is **backpressure**. With HTTP/1.1 you get implicit backpressure for free — the client can only have one in-flight request per connection, so the server's processing rate naturally limits throughput. With HTTP/2 multiplexing, the client can queue hundreds of streams on one connection. If the server is slow, the client buffers pile up on the sender side. gRPC exposes this through `WINDOW_UPDATE` frames at the stream level, but most client libraries don't surface flow-control errors in a way that's easy to act on. The symptom is usually "memory growing slowly on the client" while server latency looks fine.

### Database connection pools

Pools are long-lived connections wearing a trench coat. Opening Postgres isn't free: auth, memory for backend state, sometimes surprising latency on cold start. Pools amortize that and cap how many concurrent queries can hit the database at once.

A common pool footgun: each replica opens `pool_size` connections, you scale replicas up, and suddenly `replicas × pool_size` blows past `max_connections` on the database. The app looks healthy. The database isn't.

## When the path lies to you

Middleboxes have opinions, and they don't always tell you.

Picture this:

- The client opens a WebSocket through an L7 load balancer with a **60 second idle timeout**
- The user goes to get coffee. Traffic is quiet for 90 seconds.
- The LB drops the flow. No RST packet drama. Just… gone.
- The client still thinks it's connected until the next ping fails, or until the user clicks something and nothing happens

Your server logs might show a clean disconnect eventually. Your metrics won't scream. The user experience is "why is this broken until I refresh?"

<figure class="diagram">
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 260" fill="none" role="img" aria-labelledby="fig-timeout-title">
<title id="fig-timeout-title">Idle timeouts should be aligned shortest to longest from client to server.</title>
<text x="320" y="24" fill="var(--color-muted)" font-family="ui-monospace, monospace" font-size="11" font-weight="600" text-anchor="middle">IDLE TIMEOUTS</text>
<text x="320" y="40" fill="var(--color-muted)" font-family="ui-monospace, monospace" font-size="10" text-anchor="middle">align shortest → longest</text>
<rect x="160" y="56" width="320" height="48" rx="8" fill="var(--color-border)" stroke="var(--color-accent)" stroke-width="1.5" opacity="0.35"/>
<text x="320" y="86" fill="var(--color-text)" font-family="system-ui, sans-serif" font-size="13" font-weight="600" text-anchor="middle">Client ping / keepalive</text>
<text x="500" y="86" fill="var(--color-accent)" font-family="ui-monospace, monospace" font-size="12" font-weight="600" text-anchor="middle">30s</text>
<rect x="120" y="116" width="400" height="48" rx="8" fill="var(--color-border)" stroke="#fbbf24" stroke-width="1.5" opacity="0.35"/>
<text x="320" y="146" fill="var(--color-text)" font-family="system-ui, sans-serif" font-size="13" font-weight="600" text-anchor="middle">L7 load balancer idle</text>
<text x="532" y="146" fill="#fbbf24" font-family="ui-monospace, monospace" font-size="12" font-weight="600" text-anchor="middle">60s</text>
<rect x="80" y="176" width="480" height="48" rx="8" fill="var(--color-border)" stroke="var(--color-muted)" stroke-width="1.5" opacity="0.35"/>
<text x="320" y="206" fill="var(--color-text)" font-family="system-ui, sans-serif" font-size="13" font-weight="600" text-anchor="middle">App server / WebSocket idle</text>
<text x="548" y="206" fill="var(--color-muted)" font-family="ui-monospace, monospace" font-size="12" font-weight="600" text-anchor="middle">120s</text>
<text x="320" y="244" fill="var(--color-muted)" font-family="system-ui, sans-serif" font-size="11" text-anchor="middle">If LB timeout &lt; client ping interval → silent drops</text>
</svg>
<figcaption>Align idle timeouts: client ping interval &lt; LB idle &lt; server idle.</figcaption>
</figure>

What I try to remember when building anything long-lived:

- **Line up idle timeouts** so the client pings more often than the LB gives up, and the LB gives up before the app server forgets. At minimum, know which layer kills first.
- **Send application-level pings** on WebSockets and similar. TCP keepalive exists, but it's slow and easy to tune wrong.
- **Treat reconnect as normal user flow**, not an edge case. Backoff, resync state, don't assume the socket that hasn't written in a while is still alive.

NAT gateways and corporate firewalls play the same game on longer timescales. If your mobile app "randomly disconnects" after five minutes in the background, I wouldn't start by blaming your Go scheduler. I'd draw the path and ask what's allowed to go idle.

## The bill you pay in file descriptors and RAM

On Linux, a connection is a file descriptor. Defaults like `ulimit -n` of 1024 were written for a world where a process opened a handful of files. A busy API server is not that world.

Each connection drags along more than an integer in a table:

```text
  Process memory grows with open connections
  ┌──────────────────────────────────────────┐
  │  App heap (session objects, buffers)     │
  ├──────────────────────────────────────────┤
  │  TLS state per connection                │
  ├──────────────────────────────────────────┤
  │  Kernel socket buffers (send/recv)       │
  └──────────────────────────────────────────┘
         ▲                    ▲
         │                    └── each FD = cost
         └── idle WebSockets still count
```

Kernel buffers. TLS session state. Whatever your framework hangs off `conn` in a map. **Thousands of idle WebSockets** can be a real memory problem, the quiet kind that doesn't spike CPU but slowly eats the box until the kernel's OOM killer picks a victim. (Yes, that's why this site is called oomkill. I'm not above a pun.)

Cap concurrent connections, expire idle ones on purpose, and when you're load testing, watch **open FD count** and **connection age**, not only RPS and latency. The scary graphs are often the boring ones.

## Failure modes that don't look like HTTP errors

Request/response fails loudly: 502, timeout, retry, done. Long-lived stuff fails sideways.

**Half-open TCP** after a network partition is the classic. One side thinks the connection is fine because it hasn't tried to write yet. The other side's socket is gone — process restarted, NAT entry expired, firewall rule changed. When the first side finally writes, it gets a `RST`. Until then, both sides are in a locally-consistent but globally-incoherent state.

The mechanism: TCP's `FIN`/`RST` machinery only runs if the other side is reachable and participates in the close. If the host reboots or the network severs without any packets getting through, the socket on the surviving side just… waits. `TCP_KEEPALIVE` is the kernel-level fix — it sends empty probes after idle time and tears down the socket if no `ACK` comes back — but the defaults are wild: `tcp_keepalive_time` is 7200 seconds (two hours) on most Linux kernels. That's how long your app can hold a dead connection open while thinking it's fine.

The honest fix is at the application layer: application-level heartbeats with short intervals (30s–60s), timeouts on reads, and treating "no data for N seconds" as "assume dead, reconnect." Don't rely on the kernel to clean up fast enough.

**Sticky sessions** plus long-lived connections plus Kubernetes rollouts is another favorite. User pinned to pod A. Pod A terminates. Client reconnects, maybe to pod B with empty in-memory state. Works great in staging with one replica.

**Thundering herd on reconnect** after a deploy is the one that punishes you for success. Everyone drops at once, everyone comes back at once, auth service and database see a spike that has nothing to do with steady-state traffic. If reconnect isn't jittered and bounded, you're load testing yourself accidentally.

A practical reconnect strategy: exponential backoff (doubling from ~100ms, capped at something like 30s) plus full jitter — pick a random value in `[0, min(cap, base × 2^attempt)]` rather than just adding a fixed jitter to the deterministic backoff. Without full jitter, a cohort that disconnected together will still reconnect together even with per-client noise added on top.

What I want in a client now is boring on purpose: reconnect with full-jitter backoff, resync from a known cursor or version, never trust a socket that hasn't proven it's alive recently, and make idempotent resume someone's actual job, not a comment in the README.

## What I'd tell past-me

Reuse connections when setup is expensive — that's why keep-alive and pools exist. Match timeouts across client, proxy, and server or you'll debug ghosts while dashboards stay green. Assume anything that lives longer than a single page view will disconnect at the worst time, and write the client accordingly.

When debugging a long-lived connection problem, draw the full path before you start reading code. Every hop between client and server has its own timeout, buffer, and opinion about what "idle" means. The bug is usually at a boundary you didn't know existed, not in the code you're looking at.

A few specific numbers worth keeping handy:
- Linux default `tcp_keepalive_time`: 7200s — way too long for most applications; tune it or use app-level heartbeats.
- AWS ALB idle timeout: 60s default — if your WebSockets go silent for longer, they'll be silently dropped; set a client ping interval under 55s.
- Postgres `max_connections` default: 100 — easy to exhaust when you have `replicas × pool_size` connections hammering a small RDS instance.

I'm still learning this stuff. Follow-up posts might dig into gRPC through nginx, pool sizing math, or QUIC connection migration, if I can reproduce the interesting parts in a small setup first.
