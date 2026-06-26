---
title: cgroups v2 from scratch
description: Building up control groups by hand in a shell — the unified hierarchy, the filesystem interface, and what actually happens when a memory limit gets hit.
pubDate: 2026-06-26
tags: [linux, systems, containers]
---

Every container you've ever run is, underneath, a normal Linux process with two things bolted on: a set of namespaces that change what it can _see_, and a cgroup that limits what it can _use_. Namespaces get most of the attention because they're the visible magic — a process that thinks it's PID 1 on its own machine. cgroups are the quieter half. They're the reason a container can't eat all the RAM on the box and take its neighbors down with it.

This post is my notes from sitting in front of a Linux shell and building cgroups by hand — no Docker, no systemd unit, just `mkdir` and `echo` into files. The "from scratch" part matters: once you've created a cgroup with a directory and capped its memory by writing a number to a file, the abstraction stops being mysterious. It's a filesystem.

Everything here is cgroup **v2**. v1 still exists and still ships, but v2 has been the default on every major distro for years now, and it's what containers and systemd actually use today.

## The one big change from v1: a single hierarchy

The thing to understand before touching anything is why v2 exists at all.

In cgroup v1, every **controller** (the kernel subsystem that enforces one kind of limit — memory, cpu, io, and so on) had its _own independent hierarchy_. You could mount the memory controller as one tree and the cpu controller as a completely different tree, with different groupings. A process could be in one memory cgroup and an unrelated cpu cgroup at the same time.

This sounds flexible. In practice it was a mess. The controllers couldn't coordinate because they didn't share a structure — the memory controller had no idea which cpu group a process belonged to, so things like "account this page-cache writeback to the right io group" were basically impossible.

cgroup v2 throws that out. There is **one** hierarchy. Every process lives in exactly one cgroup, and all controllers operate on that same tree. You enable or disable individual controllers per-subtree, but the structure is shared.

<figure class="diagram">
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 660 320" fill="none" role="img" aria-labelledby="fig-hierarchy-title">
<title id="fig-hierarchy-title">cgroup v1 uses a separate independent hierarchy per controller; cgroup v2 uses one unified hierarchy that every controller operates on.</title>
<text x="160" y="26" fill="var(--color-muted)" font-family="ui-monospace,monospace" font-size="11" font-weight="600" text-anchor="middle">v1: hierarchy per controller</text>
<text x="500" y="26" fill="var(--color-muted)" font-family="ui-monospace,monospace" font-size="11" font-weight="600" text-anchor="middle">v2: one unified hierarchy</text>

<!-- v1 tree: memory -->
<rect x="30" y="48" width="110" height="26" rx="4" fill="var(--color-border)" stroke="var(--color-muted)" stroke-width="1.5"/>
<text x="85" y="65" fill="var(--color-text)" font-family="ui-monospace,monospace" font-size="10" text-anchor="middle">memory</text>
<line x1="60" y1="74" x2="50" y2="100" stroke="var(--color-muted)" stroke-width="1.2"/>
<line x1="110" y1="74" x2="120" y2="100" stroke="var(--color-muted)" stroke-width="1.2"/>
<rect x="20" y="100" width="60" height="22" rx="4" fill="var(--color-border)" stroke="var(--color-muted)" stroke-width="1.2"/>
<rect x="100" y="100" width="60" height="22" rx="4" fill="var(--color-border)" stroke="var(--color-muted)" stroke-width="1.2"/>

<!-- v1 tree: cpu -->
<rect x="30" y="150" width="110" height="26" rx="4" fill="var(--color-border)" stroke="var(--color-muted)" stroke-width="1.5"/>
<text x="85" y="167" fill="var(--color-text)" font-family="ui-monospace,monospace" font-size="10" text-anchor="middle">cpu</text>
<line x1="60" y1="176" x2="50" y2="202" stroke="var(--color-muted)" stroke-width="1.2"/>
<line x1="110" y1="176" x2="120" y2="202" stroke="var(--color-muted)" stroke-width="1.2"/>
<rect x="20" y="202" width="60" height="22" rx="4" fill="var(--color-border)" stroke="var(--color-muted)" stroke-width="1.2"/>
<rect x="100" y="202" width="60" height="22" rx="4" fill="var(--color-border)" stroke="var(--color-muted)" stroke-width="1.2"/>

<!-- v1 tree: io -->
<rect x="30" y="252" width="110" height="26" rx="4" fill="var(--color-border)" stroke="var(--color-muted)" stroke-width="1.5"/>
<text x="85" y="269" fill="var(--color-text)" font-family="ui-monospace,monospace" font-size="10" text-anchor="middle">io</text>

<!-- divider -->
<line x1="330" y1="40" x2="330" y2="290" stroke="var(--color-border)" stroke-width="1.5" stroke-dasharray="5 4"/>

<!-- v2 unified tree -->
<rect x="445" y="48" width="110" height="26" rx="4" fill="var(--color-border)" stroke="var(--color-accent)" stroke-width="1.5"/>
<text x="500" y="65" fill="var(--color-text)" font-family="ui-monospace,monospace" font-size="10" text-anchor="middle">/ (root)</text>
<line x1="470" y1="74" x2="430" y2="118" stroke="var(--color-accent)" stroke-width="1.4"/>
<line x1="530" y1="74" x2="570" y2="118" stroke="var(--color-accent)" stroke-width="1.4"/>
<rect x="375" y="118" width="110" height="26" rx="4" fill="var(--color-border)" stroke="var(--color-muted)" stroke-width="1.5"/>
<text x="430" y="135" fill="var(--color-text)" font-family="ui-monospace,monospace" font-size="10" text-anchor="middle">app.slice</text>
<rect x="515" y="118" width="110" height="26" rx="4" fill="var(--color-border)" stroke="var(--color-muted)" stroke-width="1.5"/>
<text x="570" y="135" fill="var(--color-text)" font-family="ui-monospace,monospace" font-size="10" text-anchor="middle">system.slice</text>
<line x1="430" y1="144" x2="430" y2="184" stroke="var(--color-muted)" stroke-width="1.2"/>
<rect x="375" y="184" width="110" height="26" rx="4" fill="var(--color-border)" stroke="var(--color-muted)" stroke-width="1.2"/>
<text x="430" y="201" fill="var(--color-text)" font-family="ui-monospace,monospace" font-size="10" text-anchor="middle">web.service</text>
<text x="500" y="250" fill="var(--color-muted)" font-family="ui-monospace,monospace" font-size="9" text-anchor="middle">every controller acts</text>
<text x="500" y="263" fill="var(--color-muted)" font-family="ui-monospace,monospace" font-size="9" text-anchor="middle">on this one tree</text>
</svg>
<figcaption>v1 gave each controller its own tree, so they couldn't coordinate. v2 has a single hierarchy; controllers are toggled per-subtree but share the structure.</figcaption>
</figure>

## It's a filesystem

cgroup v2 is exposed as a pseudo-filesystem of type `cgroup2`, mounted (on basically every modern system) at `/sys/fs/cgroup`. You don't usually mount it yourself — the init system does it at boot — but you can confirm it:

```sh
$ mount | grep cgroup2
cgroup2 on /sys/fs/cgroup type cgroup2 (rw,nosuid,nodev,noexec,relatime,...)
```

If you ever needed to mount it on a bare system, it's a one-liner:

```sh
mount -t cgroup2 none /sys/fs/cgroup
```

Once mounted, the entire API is files. You create a cgroup by making a directory. The kernel _automatically_ populates that directory with the control and stats files — you never create those yourself:

```sh
$ cd /sys/fs/cgroup
$ mkdir demo
$ ls demo
cgroup.controllers   cgroup.procs        cpu.stat        memory.current
cgroup.events        cgroup.subtree_control  io.stat     memory.events
cgroup.freeze        cgroup.threads      memory.max      memory.stat
...
```

A few of these are worth naming now, because they show up everywhere:

- **`cgroup.procs`** — the list of process IDs in this cgroup. Read it to see who's here; write a PID to it to _move_ that process in.
- **`cgroup.controllers`** — which controllers are _available_ to this cgroup (handed down from the parent).
- **`cgroup.subtree_control`** — which controllers are _enabled for the children_ of this cgroup.
- **`*.max`, `*.current`, `*.stat`, `*.events`** — the per-controller limits, live readings, statistics, and event counters.

Moving a process is as blunt as it sounds. Writing a PID into `cgroup.procs` migrates it:

```sh
$ echo $$ > /sys/fs/cgroup/demo/cgroup.procs   # put this shell in 'demo'
$ cat /proc/self/cgroup
0::/demo
```

That `0::/demo` line in `/proc/self/cgroup` is the v2 tell: a single `0::` entry (no per-controller list like v1 had) pointing at the cgroup path relative to the mount.

## Enabling controllers, and the "no internal processes" rule

Creating a directory gives you a cgroup, but it doesn't automatically give you _limits_. A controller has to be enabled for a cgroup's children by writing to the **parent's** `cgroup.subtree_control`:

```sh
$ cd /sys/fs/cgroup
$ cat cgroup.controllers          # what's available at the root
cpuset cpu io memory hugetlb pids
$ echo "+memory +cpu" > cgroup.subtree_control
$ cat demo/cgroup.controllers     # now memory + cpu are available in demo
cpu memory
```

The `+`/`-` syntax enables and disables. A controller can only be enabled for a child if it's available in the parent — controllers flow _downward_, and a parent can never hand out a controller it doesn't itself have.

Here's the rule that trips everyone up the first time. In v2, a cgroup that has controllers enabled for its children **cannot also contain processes directly** (the root cgroup is the one exception). This is the _no internal processes_ rule. The reasoning: a controller distributes a resource _between_ a cgroup's children, and it'd be ambiguous to also have loose processes sitting at that same level competing with the child groups.

So the moment you try to do both, the kernel says no:

```sh
$ echo "+memory" > demo/cgroup.subtree_control
$ echo 1234 > demo/cgroup.procs
bash: echo: write error: Device or resource busy
```

The fix is the structure every real system actually uses: **processes live in leaf cgroups**. You push the work down into children and reserve the inner nodes for grouping and distribution.

<figure class="diagram">
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 300" fill="none" role="img" aria-labelledby="fig-leaf-title">
<title id="fig-leaf-title">A valid cgroup v2 layout: inner cgroups enable controllers for children and hold no processes, while processes live only in leaf cgroups.</title>
<defs>
  <marker id="arrd" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
    <path d="M0 0 L7 3.5 L0 7 Z" fill="var(--color-muted)"/>
  </marker>
</defs>
<!-- root -->
<rect x="255" y="24" width="130" height="40" rx="6" fill="var(--color-border)" stroke="var(--color-accent)" stroke-width="1.5"/>
<text x="320" y="42" fill="var(--color-text)" font-family="ui-monospace,monospace" font-size="11" font-weight="600" text-anchor="middle">demo</text>
<text x="320" y="56" fill="var(--color-muted)" font-family="ui-monospace,monospace" font-size="8.5" text-anchor="middle">subtree_control: +cpu +memory</text>

<!-- two children -->
<line x1="290" y1="64" x2="170" y2="108" stroke="var(--color-muted)" stroke-width="1.3" marker-end="url(#arrd)"/>
<line x1="350" y1="64" x2="470" y2="108" stroke="var(--color-muted)" stroke-width="1.3" marker-end="url(#arrd)"/>

<rect x="95" y="110" width="150" height="44" rx="6" fill="var(--color-border)" stroke="var(--color-muted)" stroke-width="1.5"/>
<text x="170" y="129" fill="var(--color-text)" font-family="ui-monospace,monospace" font-size="10" font-weight="600" text-anchor="middle">web (leaf)</text>
<text x="170" y="144" fill="var(--color-muted)" font-family="ui-monospace,monospace" font-size="9" text-anchor="middle">memory.max = 512M</text>

<rect x="395" y="110" width="150" height="44" rx="6" fill="var(--color-border)" stroke="var(--color-muted)" stroke-width="1.5"/>
<text x="470" y="129" fill="var(--color-text)" font-family="ui-monospace,monospace" font-size="10" font-weight="600" text-anchor="middle">batch (leaf)</text>
<text x="470" y="144" fill="var(--color-muted)" font-family="ui-monospace,monospace" font-size="9" text-anchor="middle">cpu.max = 50000 100000</text>

<!-- processes in leaves -->
<rect x="110" y="180" width="50" height="22" rx="4" fill="var(--color-border)" stroke="var(--color-accent)" stroke-width="1.2"/>
<text x="135" y="195" fill="var(--color-text)" font-family="ui-monospace,monospace" font-size="9" text-anchor="middle">PID</text>
<rect x="180" y="180" width="50" height="22" rx="4" fill="var(--color-border)" stroke="var(--color-accent)" stroke-width="1.2"/>
<text x="205" y="195" fill="var(--color-text)" font-family="ui-monospace,monospace" font-size="9" text-anchor="middle">PID</text>
<line x1="170" y1="154" x2="170" y2="178" stroke="var(--color-muted)" stroke-width="1.1" stroke-dasharray="3 3"/>

<rect x="410" y="180" width="50" height="22" rx="4" fill="var(--color-border)" stroke="var(--color-accent)" stroke-width="1.2"/>
<text x="435" y="195" fill="var(--color-text)" font-family="ui-monospace,monospace" font-size="9" text-anchor="middle">PID</text>
<line x1="470" y1="154" x2="470" y2="178" stroke="var(--color-muted)" stroke-width="1.1" stroke-dasharray="3 3"/>

<text x="320" y="240" fill="var(--color-muted)" font-family="ui-monospace,monospace" font-size="9.5" text-anchor="middle">inner cgroup: no processes, distributes resources</text>
<text x="320" y="256" fill="var(--color-muted)" font-family="ui-monospace,monospace" font-size="9.5" text-anchor="middle">leaf cgroup: holds the processes, carries the limits</text>
</svg>
<figcaption>The no-internal-processes rule forces a clean shape: grouping nodes in the middle, processes only in the leaves. Every container runtime lays things out this way.</figcaption>
</figure>

## The memory controller, and the kill this site is named after

This is the controller worth knowing in detail, partly because it's the one that bites, and partly because it's the literal subject of this domain.

The headline knobs:

- **`memory.max`** — the hard limit. The cgroup's usage cannot exceed this. Default is `max` (unlimited).
- **`memory.high`** — a soft limit. Crossing it doesn't kill anything; it puts the cgroup under heavy reclaim pressure and _throttles_ allocations to slow it down. This is the knob you actually want for graceful behavior.
- **`memory.low` / `memory.min`** — protection in the other direction: memory the kernel tries (low) or refuses (min) to reclaim from this group when the system is under pressure.
- **`memory.current`** — how much the cgroup is using right now.
- **`memory.events`** — counters: `low`, `high`, `max`, `oom`, and `oom_kill`.

Let me cap a cgroup hard and watch it die. I did this in my homelab on a throwaway VM, because the whole point is to trigger an OOM kill on purpose.

```sh
$ cd /sys/fs/cgroup/demo
$ mkdir hog && echo "+memory" > cgroup.subtree_control
$ echo 64M > hog/memory.max          # 64 MiB hard cap, no swap headroom

# launch a shell into the leaf, then allocate ~200MB
$ echo $$ > hog/cgroup.procs
$ python3 -c 'x = bytearray(200 * 1024 * 1024); input()'
Killed
```

`Killed`. The process asked for 200 MiB inside a 64 MiB box. The kernel tried to reclaim pages, couldn't free enough (there's nothing reclaimable in a fresh `bytearray`), and invoked the OOM killer **scoped to that cgroup** — it doesn't go looking at the rest of the machine. The counters tell the story afterward:

```sh
$ cat hog/memory.events
low 0
high 0
max 41
oom 1
oom_kill 1
```

That `max 41` is the number of times an allocation bumped into the limit and forced reclaim before the final `oom_kill 1`. This is the exact mechanism behind a container showing `OOMKilled` in `kubectl describe pod`: the container's memory cgroup hit `memory.max`, reclaim failed, the cgroup-scoped OOM killer fired. The node as a whole was fine. One box, one limit, one dead process.

A detail that surprises people: **`memory.current` includes page cache**, not just anonymous heap memory. A process that reads a large file can push `memory.current` up with cached pages. That's usually fine — page cache is reclaimable, so it gets dropped under pressure rather than triggering a kill — but it means `memory.current` reads higher than the "real" working set, and that's by design.

<figure class="diagram">
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 250" fill="none" role="img" aria-labelledby="fig-oom-title">
<title id="fig-oom-title">When a cgroup's allocation crosses memory.high it is throttled and reclaimed; if it crosses memory.max and reclaim cannot free enough memory, the cgroup-scoped OOM killer fires.</title>
<defs>
  <marker id="arro" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
    <path d="M0 0 L7 3.5 L0 7 Z" fill="var(--color-muted)"/>
  </marker>
</defs>
<rect x="30" y="40" width="120" height="40" rx="6" fill="var(--color-border)" stroke="var(--color-muted)" stroke-width="1.5"/>
<text x="90" y="64" fill="var(--color-text)" font-family="ui-monospace,monospace" font-size="10" font-weight="600" text-anchor="middle">allocation</text>

<line x1="150" y1="60" x2="205" y2="60" stroke="var(--color-muted)" stroke-width="1.3" marker-end="url(#arro)"/>

<rect x="210" y="36" width="150" height="48" rx="6" fill="var(--color-border)" stroke="var(--color-muted)" stroke-width="1.5"/>
<text x="285" y="56" fill="var(--color-text)" font-family="ui-monospace,monospace" font-size="10" text-anchor="middle">cross memory.high?</text>
<text x="285" y="72" fill="var(--color-muted)" font-family="ui-monospace,monospace" font-size="9" text-anchor="middle">throttle + reclaim</text>

<line x1="360" y1="60" x2="415" y2="60" stroke="var(--color-muted)" stroke-width="1.3" marker-end="url(#arro)"/>

<rect x="420" y="36" width="150" height="48" rx="6" fill="var(--color-border)" stroke="var(--color-accent)" stroke-width="1.5"/>
<text x="495" y="56" fill="var(--color-text)" font-family="ui-monospace,monospace" font-size="10" text-anchor="middle">cross memory.max?</text>
<text x="495" y="72" fill="var(--color-muted)" font-family="ui-monospace,monospace" font-size="9" text-anchor="middle">reclaim, then…</text>

<line x1="495" y1="84" x2="495" y2="130" stroke="var(--color-muted)" stroke-width="1.3" marker-end="url(#arro)"/>
<rect x="395" y="132" width="200" height="44" rx="6" fill="none" stroke="var(--color-accent)" stroke-width="1.6"/>
<text x="495" y="152" fill="var(--color-text)" font-family="ui-monospace,monospace" font-size="10" font-weight="600" text-anchor="middle">reclaim failed →</text>
<text x="495" y="167" fill="var(--color-text)" font-family="ui-monospace,monospace" font-size="10" font-weight="600" text-anchor="middle">cgroup OOM kill</text>

<text x="285" y="120" fill="var(--color-muted)" font-family="ui-monospace,monospace" font-size="9" text-anchor="middle">high = slow down, stay alive</text>
<text x="285" y="200" fill="var(--color-muted)" font-family="ui-monospace,monospace" font-size="9" text-anchor="middle">max = hard wall; the kill is scoped to this cgroup only</text>
</svg>
<figcaption>memory.high throttles and reclaims to keep a group alive; memory.max is the hard wall. When reclaim can't satisfy an allocation under the max, the OOM killer fires inside the cgroup — not across the whole machine.</figcaption>
</figure>

## The cpu controller: weights and quotas

CPU limiting comes in two flavors, and they answer different questions.

**`cpu.weight`** answers "when the CPU is contended, what share does this group get?" It's proportional, defaults to `100`, and ranges from `1` to `10000`. A group with weight `200` gets twice the CPU of a sibling with weight `100` — _but only when they're actually competing_. If nothing else wants the CPU, a low-weight group can still use all of it. This is work-conserving: idle capacity isn't wasted.

**`cpu.max`** answers "what's the absolute ceiling, even if the CPU is idle?" It's a hard quota written as two numbers, `$QUOTA $PERIOD`, both in microseconds:

```sh
$ echo "50000 100000" > batch/cpu.max   # 50ms of CPU per 100ms = half a core
```

That group gets at most 50ms of CPU time in every 100ms window. Once it's spent its quota, it's throttled until the next period — even if every other core on the machine is sitting idle. This is _not_ work-conserving, and that's exactly the point: it gives you predictable, capped behavior. `cpu.max` of `"max 100000"` (the default) means no ceiling.

The usage and throttling stats live in `cpu.stat`:

```sh
$ cat batch/cpu.stat
usage_usec 4192310
user_usec 3011200
system_usec 1181110
nr_periods 240
nr_throttled 173
throttled_usec 8021442
```

`nr_throttled` and `throttled_usec` are the ones to watch. If a workload feels slow and these are climbing, the cgroup is hitting its quota wall — the classic symptom of a too-tight CPU limit on a container. The app isn't broken; it's being told to wait.

## io, pids, and pressure

The same pattern repeats for the rest:

- **`io`** — `io.max` sets per-device read/write bandwidth and IOPS ceilings (keyed by device major:minor), and `io.weight` does proportional sharing. Proportional io control needs a capable elevator — `bfq` or the `blk-iocost` cost model — to mean much.
- **`pids`** — `pids.max` caps the number of processes/threads in the cgroup. Small, boring, and the cheapest defense against a fork bomb taking down a node.

The one extra thing v2 gives you that's genuinely useful in production is **PSI — Pressure Stall Information**. Each cgroup exposes `cpu.pressure`, `memory.pressure`, and `io.pressure`:

```sh
$ cat hog/memory.pressure
some avg10=12.40 avg60=8.10 avg300=2.30 total=98234110
full avg10=9.80 avg60=6.05 avg300=1.70 total=71200320
```

`some` is the share of time _at least one_ task was stalled waiting on memory; `full` is the share where _everything_ was stalled. Unlike a raw utilization number, pressure tells you whether contention is actually _hurting_ — a group can be at 100% memory usage and zero pressure (it just fits), or have spare capacity and high pressure (it's thrashing). It's the signal that finally distinguishes "busy" from "in trouble."

## How containers actually use all this

When you `docker run` or schedule a pod, nothing exotic happens at the cgroup layer — it's the same `mkdir` and `echo` you just did, done by the runtime. The container runtime (via `runc` or `crun`) creates a leaf cgroup for the container, writes the configured limits into `memory.max`, `cpu.max`, `pids.max`, and moves the container's init process into `cgroup.procs`. That's it. The `OOMKilled` status, the CPU throttling, the memory accounting — all of it is the kernel files we've been poking at.

On a systemd machine the tree is _delegated_: systemd owns `/sys/fs/cgroup` and hands out subtrees. Your services land under `system.slice`, user sessions under `user.slice`, and a runtime that wants to manage its own children asks for a delegated subtree (`Delegate=yes`) so systemd promises not to reorganize underneath it. This is why you'll see `kubepods.slice` or `system.slice/docker-<id>.scope` paths — that's the delegation boundary, not magic.

---

The thing that stuck with me after doing this by hand is how _small_ the interface is. There's no daemon, no API server, no protocol. A cgroup is a directory. A limit is a number you write to a file. The OOM killer that gives this site its name is the kernel reading `memory.max`, comparing it to `memory.current`, failing to reclaim, and picking a victim inside that one directory's subtree. Every layer of container tooling above this — runc, containerd, the kubelet — is ultimately just automating `mkdir` and `echo`. Once you've watched a process get killed for crossing a number you wrote into a file, "OOMKilled" stops being a scary status and starts being a sentence you can finish.
