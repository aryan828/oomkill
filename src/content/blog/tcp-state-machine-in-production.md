---
title: The TCP state machine in production
description: The eleven TCP connection states, who lands in TIME-WAIT vs CLOSE-WAIT, and why a pile of sockets in either one is usually telling you something is wrong — port exhaustion, a missing close(), or a SYN flood.
pubDate: 2026-06-24
tags: [networking, linux, tcp, systems]
---

The first time TCP states stopped being a textbook diagram for me was a box that suddenly couldn't open outbound connections. The app logged `cannot assign requested address` over and over. Plenty of memory, plenty of CPU, the network was fine. The actual problem was sitting in plain sight:

```sh
$ ss -tan state time-wait | wc -l
28147
```

Twenty-eight thousand sockets in **TIME-WAIT**, every one of them holding an ephemeral port hostage. The connection had long since closed at the application layer — there was nothing left to read or write — but the kernel was keeping a tombstone around on purpose, and those tombstones had eaten the entire port range.

That's the thing about the TCP state machine. Most of the time you never think about it: connections open, do their job, and close. But every connection is always in exactly one of eleven states, and the transitions between them are where production problems live. This post is my notes on those states — what each one means, who transitions where, and which ones show up in your `ss` output when something is broken. The boring details matter here more than almost anywhere else.

## The eleven states

TCP is a state machine defined back in RFC 793. A connection is always in one of these states:

- **CLOSED** — not a real state, the resting point. No connection exists.
- **LISTEN** — a server socket waiting for incoming SYNs.
- **SYN-SENT** — a client has sent a SYN and is waiting for the SYN-ACK.
- **SYN-RECEIVED** — a SYN arrived, a SYN-ACK went out, waiting for the final ACK.
- **ESTABLISHED** — the handshake is done, data flows.
- **FIN-WAIT-1** — we sent a FIN; waiting for it to be ACKed.
- **FIN-WAIT-2** — our FIN was ACKed; waiting for the peer's FIN.
- **CLOSE-WAIT** — the peer sent a FIN, we ACKed it; waiting for *our* application to close.
- **CLOSING** — both sides sent FINs simultaneously; waiting for the ACK.
- **LAST-ACK** — we sent our FIN (as the passive closer); waiting for its ACK.
- **TIME-WAIT** — we were the active closer; waiting out 2×MSL before fully releasing.

The two states that generate almost all the operational pain are TIME-WAIT and CLOSE-WAIT, and the reason is symmetry: TCP close is a four-way exchange, and the two sides take *different* paths through the machine depending on who closes first. Get that asymmetry wrong in your mental model and you'll misdiagnose every teardown bug you ever hit.

## The handshake: getting to ESTABLISHED

The famous three-way handshake is really just both sides walking their half of the state machine until they agree the connection is up.

The client calls `connect()`: it sends a **SYN** and moves to **SYN-SENT**. The server, sitting in **LISTEN**, receives the SYN, replies with a **SYN-ACK**, and moves to **SYN-RECEIVED**. The client receives the SYN-ACK, sends a final **ACK**, and jumps to **ESTABLISHED**. When that ACK lands at the server, the server also moves to **ESTABLISHED**. Three packets, two state machines, one connection.

<figure class="diagram">
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 300" fill="none" role="img" aria-labelledby="fig-handshake-title">
<title id="fig-handshake-title">The three-way handshake as a ladder diagram: the client sends SYN and enters SYN-SENT, the server replies SYN-ACK and enters SYN-RECEIVED, the client ACKs and both sides reach ESTABLISHED.</title>
<defs>
<marker id="arr-tcp-hs" markerWidth="8" markerHeight="8" refX="7" refY="3.5" orient="auto">
<path d="M0 0 L7 3.5 L0 7 Z" fill="var(--color-muted)"/>
</marker>
</defs>
<text x="120" y="24" fill="var(--color-text)" font-family="system-ui, sans-serif" font-size="13" font-weight="600" text-anchor="middle">Client</text>
<text x="520" y="24" fill="var(--color-text)" font-family="system-ui, sans-serif" font-size="13" font-weight="600" text-anchor="middle">Server</text>
<line x1="120" y1="36" x2="120" y2="284" stroke="var(--color-border)" stroke-width="1.5"/>
<line x1="520" y1="36" x2="520" y2="284" stroke="var(--color-border)" stroke-width="1.5"/>
<text x="120" y="54" fill="var(--color-muted)" font-family="ui-monospace,monospace" font-size="9" text-anchor="middle">CLOSED</text>
<text x="520" y="54" fill="var(--color-accent)" font-family="ui-monospace,monospace" font-size="9" text-anchor="middle">LISTEN</text>
<text x="320" y="76" fill="var(--color-text)" font-family="ui-monospace,monospace" font-size="10" text-anchor="middle">SYN</text>
<line x1="124" y1="84" x2="516" y2="110" stroke="var(--color-muted)" stroke-width="1.8" marker-end="url(#arr-tcp-hs)"/>
<text x="120" y="100" fill="var(--color-accent)" font-family="ui-monospace,monospace" font-size="9" text-anchor="middle">SYN-SENT</text>
<text x="520" y="128" fill="var(--color-accent)" font-family="ui-monospace,monospace" font-size="9" text-anchor="middle">SYN-RECEIVED</text>
<text x="320" y="138" fill="var(--color-text)" font-family="ui-monospace,monospace" font-size="10" text-anchor="middle">SYN-ACK</text>
<line x1="516" y1="146" x2="124" y2="172" stroke="var(--color-muted)" stroke-width="1.8" marker-end="url(#arr-tcp-hs)"/>
<text x="120" y="190" fill="var(--color-accent)" font-family="ui-monospace,monospace" font-size="9" text-anchor="middle">ESTABLISHED</text>
<text x="320" y="200" fill="var(--color-text)" font-family="ui-monospace,monospace" font-size="10" text-anchor="middle">ACK</text>
<line x1="124" y1="208" x2="516" y2="234" stroke="var(--color-muted)" stroke-width="1.8" marker-end="url(#arr-tcp-hs)"/>
<text x="520" y="252" fill="var(--color-accent)" font-family="ui-monospace,monospace" font-size="9" text-anchor="middle">ESTABLISHED</text>
<text x="320" y="278" fill="var(--color-muted)" font-family="system-ui, sans-serif" font-size="10" text-anchor="middle">data can flow once both sides are ESTABLISHED</text>
</svg>
<figcaption>Three packets, two state machines. The client leads through SYN-SENT; the server passes through SYN-RECEIVED before both land in ESTABLISHED.</figcaption>
</figure>

That SYN-RECEIVED state is short-lived in normal operation, but it's exactly where a server is most vulnerable, because the kernel has to allocate state for a half-open connection before it knows whether the client is real. More on that when we get to SYN floods.

If the destination port has nothing listening, the server's kernel answers the SYN with a **RST** instead of a SYN-ACK. The client's `connect()` returns `ECONNREFUSED` — the famous "connection refused." No state is established; the client never leaves CLOSED in any meaningful way. RST is TCP's abort button, and it jumps a connection straight to CLOSED from wherever it was.

## The teardown: who lands where

Closing is where the asymmetry bites. TCP teardown is a four-way exchange — FIN, ACK, FIN, ACK — because each direction of the connection is closed independently. Whoever calls `close()` first is the **active closer**; the other side is the **passive closer**. Their paths through the state machine are completely different, and only the active closer pays the TIME-WAIT tax.

The active closer sends a **FIN** and moves to **FIN-WAIT-1**. The peer ACKs it, and the active closer moves to **FIN-WAIT-2** — its direction is now closed, but it still waits for the peer to finish. Meanwhile the passive closer, on receiving that first FIN, ACKs it and moves to **CLOSE-WAIT**. Crucially, the passive side *stays* in CLOSE-WAIT until its own application calls `close()`. When it finally does, it sends its FIN and moves to **LAST-ACK**. The active closer receives that FIN, sends the final ACK, and enters **TIME-WAIT**. The passive closer receives the ACK and goes straight to CLOSED — done, clean, no waiting.

<figure class="diagram">
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360" fill="none" role="img" aria-labelledby="fig-teardown-title">
<title id="fig-teardown-title">The four-way close as a ladder diagram. The active closer sends FIN, passes through FIN-WAIT-1 and FIN-WAIT-2, then ends in TIME-WAIT. The passive closer passes through CLOSE-WAIT and LAST-ACK before reaching CLOSED.</title>
<defs>
<marker id="arr-tcp-tw" markerWidth="8" markerHeight="8" refX="7" refY="3.5" orient="auto">
<path d="M0 0 L7 3.5 L0 7 Z" fill="var(--color-muted)"/>
</marker>
</defs>
<text x="120" y="24" fill="var(--color-text)" font-family="system-ui, sans-serif" font-size="13" font-weight="600" text-anchor="middle">Active closer</text>
<text x="520" y="24" fill="var(--color-text)" font-family="system-ui, sans-serif" font-size="13" font-weight="600" text-anchor="middle">Passive closer</text>
<line x1="120" y1="36" x2="120" y2="344" stroke="var(--color-border)" stroke-width="1.5"/>
<line x1="520" y1="36" x2="520" y2="344" stroke="var(--color-border)" stroke-width="1.5"/>
<text x="120" y="52" fill="var(--color-muted)" font-family="ui-monospace,monospace" font-size="9" text-anchor="middle">ESTABLISHED</text>
<text x="520" y="52" fill="var(--color-muted)" font-family="ui-monospace,monospace" font-size="9" text-anchor="middle">ESTABLISHED</text>
<text x="320" y="72" fill="var(--color-text)" font-family="ui-monospace,monospace" font-size="10" text-anchor="middle">FIN</text>
<line x1="124" y1="80" x2="516" y2="104" stroke="var(--color-muted)" stroke-width="1.8" marker-end="url(#arr-tcp-tw)"/>
<text x="120" y="96" fill="var(--color-text)" font-family="ui-monospace,monospace" font-size="9" text-anchor="middle">FIN-WAIT-1</text>
<text x="520" y="122" fill="var(--color-accent)" font-family="ui-monospace,monospace" font-size="9" font-weight="600" text-anchor="middle">CLOSE-WAIT</text>
<text x="320" y="118" fill="var(--color-text)" font-family="ui-monospace,monospace" font-size="10" text-anchor="middle">ACK</text>
<line x1="516" y1="126" x2="124" y2="150" stroke="var(--color-muted)" stroke-width="1.8" marker-end="url(#arr-tcp-tw)"/>
<text x="120" y="166" fill="var(--color-text)" font-family="ui-monospace,monospace" font-size="9" text-anchor="middle">FIN-WAIT-2</text>
<text x="320" y="186" fill="var(--color-muted)" font-family="system-ui, sans-serif" font-size="9" text-anchor="middle">…app finally calls close()…</text>
<text x="320" y="216" fill="var(--color-text)" font-family="ui-monospace,monospace" font-size="10" text-anchor="middle">FIN</text>
<line x1="516" y1="224" x2="124" y2="248" stroke="var(--color-muted)" stroke-width="1.8" marker-end="url(#arr-tcp-tw)"/>
<text x="520" y="206" fill="var(--color-text)" font-family="ui-monospace,monospace" font-size="9" text-anchor="middle">LAST-ACK</text>
<rect x="64" y="262" width="112" height="26" rx="6" fill="var(--color-border)" stroke="var(--color-accent)" stroke-width="2"/>
<text x="120" y="279" fill="var(--color-text)" font-family="ui-monospace,monospace" font-size="10" font-weight="600" text-anchor="middle">TIME-WAIT</text>
<text x="320" y="282" fill="var(--color-text)" font-family="ui-monospace,monospace" font-size="10" text-anchor="middle">ACK</text>
<line x1="124" y1="290" x2="516" y2="314" stroke="var(--color-muted)" stroke-width="1.8" marker-end="url(#arr-tcp-tw)"/>
<text x="520" y="332" fill="var(--color-muted)" font-family="ui-monospace,monospace" font-size="9" text-anchor="middle">CLOSED</text>
<text x="120" y="332" fill="var(--color-muted)" font-family="ui-monospace,monospace" font-size="9" text-anchor="middle">CLOSED after 2×MSL</text>
</svg>
<figcaption>Only the side that closes first lands in TIME-WAIT. The passive side passes through CLOSE-WAIT and LAST-ACK, then closes cleanly. Whoever closes first pays the wait.</figcaption>
</figure>

The single most important takeaway from that diagram: **the side that initiates the close is the one that ends up in TIME-WAIT.** If your clients close first, your clients accumulate TIME-WAIT. If your servers close first, your servers do. This decides which machine in your fleet feels the pain, and it's a protocol-design lever you actually control.

## TIME-WAIT, in depth

TIME-WAIT is the state everyone wants to "fix," usually by Googling a sysctl and pasting it into `/etc/sysctl.conf`. It's worth understanding why it exists before reaching for that, because most of the popular advice is wrong or outright dangerous.

The active closer waits in TIME-WAIT for **2×MSL** (twice the Maximum Segment Lifetime) for two distinct reasons:

1. **To deliver the final ACK reliably.** If that last ACK is lost, the passive closer is stuck in LAST-ACK and will retransmit its FIN. The connection has to still exist in TIME-WAIT to receive that retransmitted FIN and re-send the ACK. Without TIME-WAIT, the kernel would respond to the stray FIN with a RST, and the peer's close would error out.
2. **To let old duplicate segments die.** A delayed packet from this connection could still be wandering the network. If you immediately reused the same 4-tuple (source IP, source port, dest IP, dest port) for a new connection, a stale segment with a plausible sequence number could be accepted into the new connection and corrupt it. TIME-WAIT keeps the 4-tuple quarantined until any in-flight segments have certainly expired.

RFC 793 specifies 2×MSL, and with MSL traditionally 30 seconds, that's 60 seconds. On Linux the value is **not tunable** — it's hardcoded in the kernel as `TCP_TIMEWAIT_LEN`, defined in `include/net/tcp.h` as `60*HZ`, about 60 seconds. People expect to find a knob for it and there isn't one; that surprises a lot of people.

The production problem is **ephemeral port exhaustion**. A busy client or forward proxy that opens thousands of short-lived outbound connections per second is the active closer on every one of them. Each closed connection sits in TIME-WAIT for a full minute, holding its local port. The default ephemeral range (`net.ipv4.ip_local_port_range`) is roughly 28,000–32,000 ports. To a fixed destination IP and port, that caps you at around 500 new connections per second before TIME-WAIT sockets pile up faster than they expire. When the range is exhausted, `connect()` fails with `EADDRNOTAVAIL` — the "cannot assign requested address" I opened with.

```sh
# how many sockets are in each state right now
$ ss -tan | awk 'NR>1 {print $1}' | sort | uniq -c
   8123 ESTAB
  28147 TIME-WAIT
     12 LISTEN

# group the time-wait sockets by destination to find the hot path
$ ss -tan state time-wait | awk '{print $4}' | sed 's/:[^:]*$//' | sort | uniq -c | sort -rn | head
```

Mitigations, roughly in order of how much I trust them:

- **Connection pooling / keep-alive.** This is the real fix. If you stop opening a fresh connection per request and reuse a pool instead, the TIME-WAIT churn evaporates because you're not closing connections constantly. Everything below is a workaround for not doing this.
- **Widen `ip_local_port_range`.** More ports means more headroom before exhaustion. Cheap and safe: `sysctl -w net.ipv4.ip_local_port_range="1024 65535"`. It buys you a bigger ceiling, not a different shape of problem.
- **`net.ipv4.tcp_tw_reuse`.** This lets the kernel reuse a TIME-WAIT socket for a *new outbound* connection when TCP timestamps prove the new connection's segments can't be confused with the old one's. It's reasonably safe for outbound/client-side connections and is the sanctioned knob. It does nothing for inbound connections.
- **More 4-tuples.** Add destination ports, destination IPs, or source IPs. Each new combination is a fresh pool of 64K ports. This is how you scale a proxy past the single-tuple limit.
- **`SO_REUSEADDR`** lets a proxy bind-before-connect without tripping over `EADDRINUSE` on a lingering local tuple. Useful when explicitly binding source ports.
- **`net.ipv4.tcp_max_tw_buckets`** caps the total number of TIME-WAIT sockets; beyond the cap, the kernel just destroys them (and logs about it). It's a safety valve against unbounded memory growth, not a real fix — destroying TIME-WAIT sockets early reintroduces exactly the risks the state exists to prevent.

And now the trap. You will find old tuning guides telling you to set **`net.ipv4.tcp_tw_recycle = 1`**. Do not. That option enabled aggressive recycling of TIME-WAIT sockets based on a per-host timestamp assumption, and it **breaks horribly behind NAT**: multiple clients sharing one public IP do not share a timestamp clock, so the server would reject SYNs from all but one of them, dropping connections seemingly at random and impossibly hard to diagnose. It got worse when Linux 4.10 started randomizing per-connection timestamp offsets, which broke `tcp_tw_recycle` even *without* NAT. The option was **removed entirely in Linux 4.12** — it doesn't exist on any modern kernel. If a guide recommends it, the guide is older than your problem.

## CLOSE-WAIT: the bug is in your code

If TIME-WAIT is a kernel feature people mistake for a bug, CLOSE-WAIT is the opposite: a state that almost always means a real application bug, in *your* code.

Recall the teardown. The peer sends a FIN. Your kernel receives it, ACKs it automatically, and moves the socket to **CLOSE-WAIT**. Then it waits — for your application to notice the peer is done and call `close()` on the socket. The transition out of CLOSE-WAIT (sending your FIN, moving to LAST-ACK) is driven entirely by your application code. The kernel cannot do it for you, because only your app knows whether it still has data to send.

So a pile of CLOSE-WAIT sockets means: the peer hung up, the kernel told your app (the read returns EOF / zero bytes), and your app never called `close()`. The fd leaks. The socket sits in CLOSE-WAIT *forever* — there is no timeout on this state — until the process dies and the kernel reaps its file descriptors. The classic version is a connection-handling loop that breaks out on an error path without closing the socket, or a connection pool that discards an object without closing the underlying fd.

<figure class="diagram">
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 250" fill="none" role="img" aria-labelledby="fig-closewait-title">
<title id="fig-closewait-title">A stuck CLOSE-WAIT socket: the peer's FIN was ACKed by the kernel, moving the socket to CLOSE-WAIT, but the application never calls close(), so the socket stays in CLOSE-WAIT indefinitely and the file descriptor leaks.</title>
<defs>
<marker id="arr-tcp-cw" markerWidth="8" markerHeight="8" refX="7" refY="3.5" orient="auto">
<path d="M0 0 L7 3.5 L0 7 Z" fill="var(--color-muted)"/>
</marker>
</defs>
<rect x="40" y="40" width="240" height="170" rx="8" fill="none" stroke="var(--color-border)" stroke-width="1.5" stroke-dasharray="6 4"/>
<text x="160" y="60" fill="var(--color-muted)" font-family="ui-monospace,monospace" font-size="10" text-anchor="middle">your process</text>
<rect x="70" y="74" width="180" height="34" rx="6" fill="var(--color-border)" stroke="var(--color-muted)" stroke-width="1.5"/>
<text x="160" y="95" fill="var(--color-text)" font-family="system-ui, sans-serif" font-size="11" text-anchor="middle">application (never close()s)</text>
<rect x="70" y="138" width="180" height="44" rx="6" fill="var(--color-border)" stroke="var(--color-accent)" stroke-width="2"/>
<text x="160" y="158" fill="var(--color-text)" font-family="ui-monospace,monospace" font-size="11" font-weight="600" text-anchor="middle">socket: CLOSE-WAIT</text>
<text x="160" y="173" fill="var(--color-muted)" font-family="ui-monospace,monospace" font-size="9" text-anchor="middle">fd leaked, stuck forever</text>
<line x1="160" y1="138" x2="160" y2="110" stroke="var(--color-muted)" stroke-width="1.5" stroke-dasharray="4 3" marker-end="url(#arr-tcp-cw)"/>
<text x="210" y="126" fill="var(--color-muted)" font-family="ui-monospace,monospace" font-size="9" text-anchor="middle">EOF</text>
<rect x="430" y="100" width="150" height="40" rx="6" fill="var(--color-border)" stroke="var(--color-muted)" stroke-width="1.5"/>
<text x="505" y="124" fill="var(--color-text)" font-family="system-ui, sans-serif" font-size="11" text-anchor="middle">peer (sent FIN)</text>
<line x1="430" y1="120" x2="262" y2="150" stroke="var(--color-muted)" stroke-width="1.8" marker-end="url(#arr-tcp-cw)"/>
<text x="350" y="120" fill="var(--color-text)" font-family="ui-monospace,monospace" font-size="10" text-anchor="middle">FIN</text>
<text x="350" y="158" fill="var(--color-muted)" font-family="ui-monospace,monospace" font-size="9" text-anchor="middle">(kernel auto-ACKed)</text>
<text x="320" y="232" fill="var(--color-muted)" font-family="system-ui, sans-serif" font-size="10" text-anchor="middle">kernel did its part; the missing close() is on the application</text>
</svg>
<figcaption>CLOSE-WAIT has no timeout. The kernel ACKed the peer's FIN; the socket waits on an application close() that never comes, leaking the fd until the process exits.</figcaption>
</figure>

When I see CLOSE-WAIT climbing, I stop looking at the network immediately. I find which process owns the sockets and read its connection-handling code:

```sh
# which sockets are stuck, and who owns them
$ ss -tanp state close-wait
$ ss -tanp state close-wait | grep -oP 'pid=\K[0-9]+' | sort | uniq -c

# the slow death: fd count creeping toward the ulimit
$ ls /proc/<pid>/fd | wc -l
```

Left unchecked, this ends one of two ways: the process hits its file-descriptor limit and starts failing to accept or open connections with `EMFILE` ("too many open files"), or it slowly bloats until something else gives. Either way the fix is a `close()` on a path that's missing it.

## FIN-WAIT-2 and orphaned sockets

There's a mirror-image problem on the active closer's side. After you send your FIN and it's ACKed, you sit in **FIN-WAIT-2** waiting for the peer's FIN. But what if the peer is the one with the buggy code, sitting in CLOSE-WAIT, never sending its FIN? You'd wait forever too — except the kernel guards against this for *orphaned* sockets (ones the application has fully closed and handed off to the kernel).

`net.ipv4.tcp_fin_timeout` controls how long an orphaned socket lingers in FIN-WAIT-2 before the kernel gives up and tears it down. The default is 60 seconds. It only applies to orphaned sockets; if your application called `shutdown()` to half-close but is still holding the socket open, the kernel won't time it out, because you might still want to read. So you can see FIN-WAIT-2 sockets on the closer mirroring CLOSE-WAIT sockets on a broken peer — two views of the same missing `close()`, one on each machine.

## SYN-RECEIVED and the two queues

Back to the dangerous part of the handshake. When a server is flooded with connection attempts — legitimately or maliciously — the bottleneck is how Linux tracks half-open connections. Every LISTEN socket has **two** queues, not one, and conflating them is a common source of confusion.

- The **SYN queue** holds connections in SYN-RECEIVED: a SYN arrived, the kernel sent a SYN-ACK, and it's waiting for the client's final ACK. It also retransmits the SYN-ACK on timeout.
- The **accept queue** holds fully established connections that completed the handshake and are waiting for the application to call `accept()` and pick them up.

When the final ACK arrives, the kernel moves the connection from the SYN queue to the accept queue. When your app calls `accept()`, it dequeues from the accept queue.

<figure class="diagram">
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 250" fill="none" role="img" aria-labelledby="fig-queues-title">
<title id="fig-queues-title">The two-queue model for incoming connections: SYNs land in the SYN queue as SYN-RECEIVED, the completing ACK promotes the connection into the accept queue as ESTABLISHED, and the application dequeues it with accept().</title>
<defs>
<marker id="arr-tcp-q" markerWidth="8" markerHeight="8" refX="7" refY="3.5" orient="auto">
<path d="M0 0 L7 3.5 L0 7 Z" fill="var(--color-accent)"/>
</marker>
</defs>
<text x="80" y="120" fill="var(--color-text)" font-family="system-ui, sans-serif" font-size="11" text-anchor="middle">SYN</text>
<line x1="100" y1="124" x2="168" y2="124" stroke="var(--color-accent)" stroke-width="1.8" marker-end="url(#arr-tcp-q)"/>
<rect x="174" y="70" width="150" height="108" rx="8" fill="var(--color-border)" stroke="var(--color-muted)" stroke-width="1.5"/>
<text x="249" y="90" fill="var(--color-text)" font-family="ui-monospace,monospace" font-size="11" font-weight="600" text-anchor="middle">SYN queue</text>
<text x="249" y="106" fill="var(--color-muted)" font-family="ui-monospace,monospace" font-size="9" text-anchor="middle">state: SYN-RECEIVED</text>
<rect x="190" y="118" width="118" height="18" rx="3" fill="var(--color-surface)" stroke="var(--color-muted)" stroke-width="1"/>
<rect x="190" y="142" width="118" height="18" rx="3" fill="var(--color-surface)" stroke="var(--color-muted)" stroke-width="1"/>
<text x="249" y="196" fill="var(--color-muted)" font-family="ui-monospace,monospace" font-size="9" text-anchor="middle">tcp_max_syn_backlog</text>
<line x1="324" y1="124" x2="392" y2="124" stroke="var(--color-accent)" stroke-width="1.8" marker-end="url(#arr-tcp-q)"/>
<text x="358" y="116" fill="var(--color-text)" font-family="ui-monospace,monospace" font-size="9" text-anchor="middle">ACK</text>
<rect x="398" y="70" width="150" height="108" rx="8" fill="var(--color-border)" stroke="var(--color-accent)" stroke-width="2"/>
<text x="473" y="90" fill="var(--color-text)" font-family="ui-monospace,monospace" font-size="11" font-weight="600" text-anchor="middle">accept queue</text>
<text x="473" y="106" fill="var(--color-muted)" font-family="ui-monospace,monospace" font-size="9" text-anchor="middle">state: ESTABLISHED</text>
<rect x="414" y="118" width="118" height="18" rx="3" fill="var(--color-surface)" stroke="var(--color-muted)" stroke-width="1"/>
<rect x="414" y="142" width="118" height="18" rx="3" fill="var(--color-surface)" stroke="var(--color-muted)" stroke-width="1"/>
<text x="473" y="196" fill="var(--color-muted)" font-family="ui-monospace,monospace" font-size="9" text-anchor="middle">backlog (capped by somaxconn)</text>
<line x1="548" y1="124" x2="600" y2="124" stroke="var(--color-accent)" stroke-width="1.8" marker-end="url(#arr-tcp-q)"/>
<text x="592" y="116" fill="var(--color-text)" font-family="ui-monospace,monospace" font-size="9" text-anchor="middle">accept()</text>
<text x="320" y="232" fill="var(--color-muted)" font-family="system-ui, sans-serif" font-size="10" text-anchor="middle">a SYN flood overruns the SYN queue; a slow app() overruns the accept queue</text>
</svg>
<figcaption>Two queues, two failure points. The SYN queue holds half-open SYN-RECEIVED connections; the accept queue holds completed ones waiting for accept().</figcaption>
</figure>

Both queues have limits. The accept queue size comes from the `backlog` argument to `listen()`, capped by `net.core.somaxconn`. On modern kernels `somaxconn` effectively caps both queues; `net.ipv4.tcp_max_syn_backlog` historically sized the SYN queue. If your app is slow to `accept()` and the accept queue fills, the kernel **drops** incoming SYNs and ACKs as a push-back signal — the client will retransmit and, hopefully, the app catches up. Those drops increment `ListenOverflows` and `ListenDrops`:

```sh
# accept-queue depth (Recv-Q) vs configured backlog (Send-Q) on listeners
$ ss -lnt
State   Recv-Q  Send-Q  Local Address:Port
LISTEN  0       1024    *:6443

# overflow / drop counters
$ nstat -az | grep -iE 'ListenOverflows|ListenDrops|SyncookiesSent'
$ netstat -s | grep -iE 'listen|SYN cookies'

# half-open connections sitting in the SYN queue
$ ss -n state syn-recv sport = :443 | wc -l
```

A **SYN flood** attacks the SYN queue directly: an attacker sends a torrent of SYNs (often from spoofed source IPs) and never completes the handshake. The SYN queue fills with SYN-RECEIVED entries, each holding kernel memory, and legitimate SYNs get dropped. The defense is **SYN cookies** (`net.ipv4.tcp_syncookies`, on by default and engaged only when the SYN queue overflows). Instead of storing state for an incoming SYN, the kernel encodes the connection parameters into the SYN-ACK's initial sequence number using a cryptographic hash. It keeps *no* state. When a legitimate client's ACK comes back, the kernel verifies the reflected number and reconstructs the connection statelessly. The tradeoff: a SYN cookie has only a few bits to work with, so some TCP options (window scaling, SACK, timestamps) are squeezed or lost, which can degrade the resulting connection — a fine price to pay under attack, which is why it only kicks in when the queue is already overflowing.

## Half-open connections and the states that lie

The state machine has one structural blind spot: it only advances when packets arrive. If the peer vanishes without sending a FIN or RST — host crash, power loss, a NAT entry expiring, a firewall rule change — your side stays in **ESTABLISHED**, perfectly content, because nothing told it otherwise. This is a **half-open** connection, and the state machine simply doesn't notice. There's no packet to drive a transition.

You only discover the truth when you try to write and eventually get a RST or a timeout, or when TCP keepalive probes finally fire. The catch is that keepalive defaults are glacial — `tcp_keepalive_time` is 7200 seconds (two hours) on most Linux kernels — so the kernel will happily hold a dead ESTABLISHED socket for hours. I've written more about this in the long-lived-connections post; the short version is that for anything long-lived you want application-level heartbeats rather than trusting the kernel's state machine to spot a peer that died mid-connection. The state machine is honest about every packet it sees; it just can't reason about the packets that never come.

## Reading the machine in production

You don't debug TCP states by guessing. You count sockets by state and the counts tell you the story:

```sh
# the one-liner I run first on any "weird network" box
$ ss -s
Total: 41023
TCP:   38211 (estab 8123, closed 1840, orphaned 12, timewait 28147)

# full breakdown by state
$ ss -tan | awk 'NR>1 {print $1}' | sort | uniq -c | sort -rn
```

A rough field guide to what each pile is telling you:

- **Thousands of TIME-WAIT** on a client/proxy → you're closing too many short-lived connections; pool them, and check for `EADDRNOTAVAIL`.
- **Growing CLOSE-WAIT** → application bug, a missing `close()`; find the owning process and read its code, not the network.
- **FIN-WAIT-2 lingering** → the peer isn't sending its FIN (often the peer's missing `close()`); `tcp_fin_timeout` bounds the orphaned ones.
- **Many SYN-RECV** plus rising `ListenDrops`/`SyncookiesSent` → SYN flood or an accept queue you can't drain fast enough.
- **`Recv-Q` pinned at the backlog on a LISTEN socket** → your app isn't calling `accept()` fast enough; connections are queuing or being dropped.

`/proc/net/tcp` has the raw per-socket data (state is the `st` hex column: `01` ESTABLISHED, `06` TIME-WAIT, `08` CLOSE-WAIT, and so on), but `ss` and `nstat` are what I actually reach for. The counters in `nstat -az` and `netstat -s` are cumulative since boot — diff them over time to see what's happening *now*, not since the box came up.

---

What changed for me, once these states stopped being a diagram and started being `ss` output, is that the state machine became a diagnostic tool rather than trivia. A connection is always somewhere in those eleven states, and the boxes that hurt — TIME-WAIT, CLOSE-WAIT, FIN-WAIT-2, SYN-RECEIVED — each point at a specific, knowable cause. TIME-WAIT means you closed first and a lot; CLOSE-WAIT means you forgot to close at all; a full SYN queue means more SYNs are arriving than you can complete. The protocol isn't being mysterious. It's doing exactly what RFC 793 said it would, very patiently, and the pile of sockets in your terminal is just the state machine telling you, in the only language it has, which transition your code forgot to make.
