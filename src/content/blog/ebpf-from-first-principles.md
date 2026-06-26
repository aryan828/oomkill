---
title: eBPF from first principles
description: What eBPF actually is — a tiny verified virtual machine inside the kernel — and how the verifier, maps, helpers, and attach points fit together to let you run code in kernel space without it being able to crash the box.
pubDate: 2026-06-26
tags: [linux, ebpf, systems, networking]
---

The first time I really understood eBPF was when I stopped thinking of it as "a way to do fast networking" and started thinking of it as what it literally is: a small register virtual machine baked into the Linux kernel, plus a static analyzer that refuses to load any program it can't prove is safe. Everything else — Cilium replacing kube-proxy, bpftrace one-liners, Falco watching syscalls — is built on those two facts. You can write code, hand it to the kernel, and the kernel will run it in kernel space at native speed *after first proving it can't loop forever, read memory it shouldn't, or panic the machine*.

That last clause is the whole trick. A kernel module can do anything; a bad one corrupts memory and takes the box down with it. An eBPF program is the opposite bargain: you give up generality, and in exchange the kernel guarantees the thing can't hurt it. This post is my notes on how that bargain actually works underneath — the VM, the verifier, the maps, the helpers, and the spectrum of places you can hook.

## The virtual machine

eBPF is a register-based VM. It has **11 64-bit registers** (R0–R10), a program counter, and a 512-byte stack. The registers aren't arbitrary scratch space — they have a calling convention burned into the design:

- **R0** holds return values from helper calls and the program's own exit value.
- **R1–R5** pass arguments to helper functions. On program entry, **R1** holds a pointer to the context (an `skb` for a packet program, a `pt_regs` for a kprobe, and so on).
- **R6–R9** are callee-saved: their values survive across helper calls.
- **R10** is a read-only frame pointer to the top of the stack. You can read it and compute offsets from it, but you can't write to it.

This is a deliberate echo of real 64-bit hardware (roughly the x86-64 / arm64 calling conventions), which is exactly why the JIT step later can map BPF registers almost one-to-one onto machine registers. The instruction set is small and fixed-width: load/store, ALU ops, jumps, and a `call` instruction. There's no `printf`, no arbitrary memory, no syscalls from inside. The VM is intentionally anemic.

This is the "e" in eBPF — *extended* BPF. The original, now called **cBPF** (classic BPF), was the Berkeley Packet Filter: two 32-bit registers and a tiny instruction set whose entire job was deciding whether `tcpdump` should keep a packet. Extended BPF kept the spiritual idea (a safe little filter VM in the kernel) and blew it up into a general-purpose-ish execution engine: 64-bit registers, maps, helper calls, and dozens of attach points that have nothing to do with packets. Internally the kernel still calls all of it "BPF"; cBPF programs are now transparently translated to eBPF before they run.

## The lifecycle: source to running code

A program goes through a fixed pipeline before a single instruction executes on a hook. You write restricted C, `clang`/LLVM (which has a `bpf` backend target) compiles it to BPF bytecode in an ELF object file, you load it through the `bpf()` syscall, the **verifier** scrutinizes it, the **JIT** turns it into native code, and finally you attach it to a hook where the kernel will run it on every relevant event.

<figure class="diagram">
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 660 220" fill="none" role="img" aria-labelledby="fig-ebpf-lifecycle-title">
<title id="fig-ebpf-lifecycle-title">The eBPF lifecycle pipeline: restricted C is compiled by clang/LLVM to BPF bytecode, loaded via the bpf() syscall, checked by the verifier, JIT-compiled to native code, then attached to a kernel hook where it runs on every event.</title>
<defs>
  <marker id="arr-ebpf-life" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
    <path d="M0 0 L7 3.5 L0 7 Z" fill="var(--color-muted)"/>
  </marker>
</defs>
<rect x="14" y="40" width="92" height="48" rx="6" fill="var(--color-border)" stroke="var(--color-muted)" stroke-width="1.5"/>
<text x="60" y="60" fill="var(--color-text)" font-family="ui-monospace,monospace" font-size="10" font-weight="600" text-anchor="middle">restricted C</text>
<text x="60" y="75" fill="var(--color-muted)" font-family="ui-monospace,monospace" font-size="8.5" text-anchor="middle">.c source</text>
<line x1="106" y1="64" x2="132" y2="64" stroke="var(--color-muted)" stroke-width="1.3" marker-end="url(#arr-ebpf-life)"/>
<rect x="134" y="40" width="92" height="48" rx="6" fill="var(--color-border)" stroke="var(--color-muted)" stroke-width="1.5"/>
<text x="180" y="60" fill="var(--color-text)" font-family="ui-monospace,monospace" font-size="10" font-weight="600" text-anchor="middle">clang/LLVM</text>
<text x="180" y="75" fill="var(--color-muted)" font-family="ui-monospace,monospace" font-size="8.5" text-anchor="middle">bytecode .o</text>
<line x1="226" y1="64" x2="252" y2="64" stroke="var(--color-muted)" stroke-width="1.3" marker-end="url(#arr-ebpf-life)"/>
<rect x="254" y="40" width="92" height="48" rx="6" fill="var(--color-border)" stroke="var(--color-muted)" stroke-width="1.5"/>
<text x="300" y="60" fill="var(--color-text)" font-family="ui-monospace,monospace" font-size="10" font-weight="600" text-anchor="middle">bpf()</text>
<text x="300" y="75" fill="var(--color-muted)" font-family="ui-monospace,monospace" font-size="8.5" text-anchor="middle">syscall: load</text>
<line x1="346" y1="64" x2="372" y2="64" stroke="var(--color-muted)" stroke-width="1.3" marker-end="url(#arr-ebpf-life)"/>
<rect x="374" y="40" width="92" height="48" rx="6" fill="var(--color-border)" stroke="var(--color-accent)" stroke-width="1.6"/>
<text x="420" y="60" fill="var(--color-text)" font-family="ui-monospace,monospace" font-size="10" font-weight="600" text-anchor="middle">verifier</text>
<text x="420" y="75" fill="var(--color-muted)" font-family="ui-monospace,monospace" font-size="8.5" text-anchor="middle">accept / reject</text>
<line x1="466" y1="64" x2="492" y2="64" stroke="var(--color-muted)" stroke-width="1.3" marker-end="url(#arr-ebpf-life)"/>
<rect x="494" y="40" width="92" height="48" rx="6" fill="var(--color-border)" stroke="var(--color-muted)" stroke-width="1.5"/>
<text x="540" y="60" fill="var(--color-text)" font-family="ui-monospace,monospace" font-size="10" font-weight="600" text-anchor="middle">JIT</text>
<text x="540" y="75" fill="var(--color-muted)" font-family="ui-monospace,monospace" font-size="8.5" text-anchor="middle">native code</text>
<line x1="540" y1="88" x2="540" y2="120" stroke="var(--color-muted)" stroke-width="1.3" marker-end="url(#arr-ebpf-life)"/>
<rect x="430" y="122" width="200" height="44" rx="6" fill="var(--color-border)" stroke="var(--color-accent)" stroke-width="1.6"/>
<text x="530" y="142" fill="var(--color-text)" font-family="ui-monospace,monospace" font-size="10" font-weight="600" text-anchor="middle">attach to hook</text>
<text x="530" y="157" fill="var(--color-muted)" font-family="ui-monospace,monospace" font-size="8.5" text-anchor="middle">runs on every matching event</text>
<text x="300" y="190" fill="var(--color-muted)" font-family="system-ui, sans-serif" font-size="9.5" text-anchor="middle">If the verifier rejects, the program never loads — nothing runs in the kernel.</text>
</svg>
<figcaption>The pipeline from C source to a running, JIT-compiled program. The verifier is the gate: anything it can't prove safe is rejected before it reaches the JIT or a hook.</figcaption>
</figure>

The crucial property is that the verifier runs *at load time, once*, not on every execution. By the time the program is attached, it's already been proven safe and compiled to native instructions, so the runtime cost on the hot path is just running native code. You pay the safety tax up front.

## The verifier is the whole game

If you only understand one component, make it this one. The verifier is what makes eBPF fundamentally different from a kernel module, and almost every frustrating "why won't my program load" moment traces back to it.

It works in two broad phases. **First, a control-flow check.** The verifier builds the program's control-flow graph and does a DAG check: it rejects unreachable instructions and, historically, rejected any back-edge — i.e. loops — outright. The program had to be a directed acyclic graph that always marched toward an exit.

**Second, symbolic execution.** Starting from the first instruction, the verifier walks every reachable path through the program and simulates it, tracking the state of every register and every stack slot as it goes. It doesn't run the program; it tracks what it *knows* about each value. Every register has a type — `NOT_INIT` (never written, therefore unreadable), `SCALAR_VALUE` (a number, not usable as a pointer), or one of several pointer types like `PTR_TO_CTX`, `PTR_TO_MAP_VALUE`, `PTR_TO_STACK`, `PTR_TO_PACKET`. The rules are strict and a little surprising the first time:

- A register that was never written to is **not readable**. `R0 = R2` fails immediately if R2 was never initialized.
- Reading from the stack is only allowed *after* you've written to that slot.
- After a helper call, R1–R5 are scratched to unreadable and R0 takes the helper's return type. R6–R9 survive.
- Pointer arithmetic is heavily constrained. Adding two pointers produces a `SCALAR_VALUE` (a now-useless number), because the result isn't a meaningful address.

For scalars and pointer offsets, the verifier tracks **ranges**, not just types. For each value it keeps signed and unsigned min/max bounds and a "tnum" — a known-bits representation (a mask of unknown bits plus the known values). When you read a byte into a register, it knows the top 56 bits are zero and the low 8 are unknown. When you compare a value `> 8` and take the true branch, it narrows the minimum to 9. This range tracking is how it proves memory accesses are in bounds.

<figure class="diagram">
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 660 300" fill="none" role="img" aria-labelledby="fig-ebpf-verifier-title">
<title id="fig-ebpf-verifier-title">The verifier explores every path through the program, tracking register types and value ranges; a path that reads uninitialized state, accesses memory out of bounds, or exceeds the complexity limit causes rejection, while a fully-proven program is accepted.</title>
<defs>
  <marker id="arr-ebpf-ver" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
    <path d="M0 0 L7 3.5 L0 7 Z" fill="var(--color-muted)"/>
  </marker>
</defs>
<rect x="30" y="30" width="160" height="40" rx="6" fill="var(--color-border)" stroke="var(--color-muted)" stroke-width="1.5"/>
<text x="110" y="48" fill="var(--color-text)" font-family="ui-monospace,monospace" font-size="10" font-weight="600" text-anchor="middle">entry: R1 = ctx</text>
<text x="110" y="62" fill="var(--color-muted)" font-family="ui-monospace,monospace" font-size="8.5" text-anchor="middle">R0..R9 = NOT_INIT</text>
<line x1="110" y1="70" x2="110" y2="98" stroke="var(--color-muted)" stroke-width="1.3" marker-end="url(#arr-ebpf-ver)"/>
<rect x="20" y="100" width="180" height="56" rx="6" fill="var(--color-border)" stroke="var(--color-muted)" stroke-width="1.5"/>
<text x="110" y="120" fill="var(--color-text)" font-family="ui-monospace,monospace" font-size="9.5" text-anchor="middle">simulate each insn</text>
<text x="110" y="134" fill="var(--color-muted)" font-family="ui-monospace,monospace" font-size="8.5" text-anchor="middle">track type per register</text>
<text x="110" y="147" fill="var(--color-muted)" font-family="ui-monospace,monospace" font-size="8.5" text-anchor="middle">track min/max + known bits</text>
<line x1="200" y1="128" x2="252" y2="128" stroke="var(--color-muted)" stroke-width="1.3" marker-end="url(#arr-ebpf-ver)"/>
<rect x="254" y="98" width="170" height="60" rx="6" fill="var(--color-border)" stroke="var(--color-accent)" stroke-width="1.6"/>
<text x="339" y="116" fill="var(--color-text)" font-family="ui-monospace,monospace" font-size="9.5" text-anchor="middle">every path safe?</text>
<text x="339" y="130" fill="var(--color-muted)" font-family="ui-monospace,monospace" font-size="8" text-anchor="middle">in bounds? initialized?</text>
<text x="339" y="142" fill="var(--color-muted)" font-family="ui-monospace,monospace" font-size="8" text-anchor="middle">terminates? &lt; 1M insns?</text>
<line x1="424" y1="115" x2="486" y2="80" stroke="var(--color-muted)" stroke-width="1.3" marker-end="url(#arr-ebpf-ver)"/>
<line x1="424" y1="140" x2="486" y2="172" stroke="var(--color-muted)" stroke-width="1.3" marker-end="url(#arr-ebpf-ver)"/>
<rect x="488" y="56" width="150" height="44" rx="6" fill="none" stroke="var(--color-accent)" stroke-width="1.6"/>
<text x="563" y="76" fill="var(--color-text)" font-family="ui-monospace,monospace" font-size="10" font-weight="600" text-anchor="middle">ACCEPT</text>
<text x="563" y="90" fill="var(--color-muted)" font-family="ui-monospace,monospace" font-size="8.5" text-anchor="middle">→ JIT → attach</text>
<rect x="488" y="150" width="150" height="44" rx="6" fill="none" stroke="var(--color-muted)" stroke-width="1.6" stroke-dasharray="5 4"/>
<text x="563" y="170" fill="var(--color-text)" font-family="ui-monospace,monospace" font-size="10" font-weight="600" text-anchor="middle">REJECT</text>
<text x="563" y="184" fill="var(--color-muted)" font-family="ui-monospace,monospace" font-size="8.5" text-anchor="middle">load() fails, -EACCES</text>
<rect x="120" y="210" width="430" height="62" rx="6" fill="var(--color-border)" stroke="var(--color-muted)" stroke-width="1.2"/>
<text x="335" y="230" fill="var(--color-muted)" font-family="system-ui, sans-serif" font-size="9.5" text-anchor="middle">State pruning: at each revisited instruction, if a previous accepted</text>
<text x="335" y="245" fill="var(--color-muted)" font-family="system-ui, sans-serif" font-size="9.5" text-anchor="middle">state subsumes the current one, the branch is pruned — otherwise</text>
<text x="335" y="260" fill="var(--color-muted)" font-family="system-ui, sans-serif" font-size="9.5" text-anchor="middle">exploring every path would blow up exponentially.</text>
</svg>
<figcaption>The verifier accepts only if every reachable path is provably safe. Without state pruning — skipping revisited states already known safe — the path explosion would make verification intractable.</figcaption>
</figure>

Two more pieces make this tractable and bearable. **State pruning**: the verifier caches the register/stack state at instructions it has already analyzed. When it reaches that instruction again on another path, if a previously-accepted state is a superset of the current one (at least as general, at least as strict on alignment), it prunes the branch — the earlier acceptance implies this one is fine too. Liveness tracking of which registers actually get used later makes more states equivalent and prunes harder. Without this, the path explosion would be exponential.

And the **complexity limit**: the verifier will only analyze up to **1 million instructions** total across all paths before giving up. This is why a logically-fine program can still be rejected for being "too complex" — you didn't write an infinite loop, you just gave the verifier more branches than it's willing to explore. The practical program size limit for unprivileged-style loads has historically been 4,096 instructions; privileged programs can be far larger, bounded by that 1M analysis budget.

**Bounded loops** arrived in kernel **5.3**. Before that, every loop had to be manually unrolled (`#pragma unroll`) so the program stayed a DAG. Since 5.3 the verifier can accept a real loop as long as it can prove the loop has an exit condition that's guaranteed to become true — it simulates iterations and prunes states until the loop's induction variable provably terminates. You still can't write an unbounded `while (1)`.

The thing to internalize: the verifier is a *safety* tool, not a *security* tool. It proves the program can't crash or read out of bounds. It does not reason about whether what the program does is a good idea.

## Helpers: you can't just call kernel functions

A BPF program can't call arbitrary kernel functions. If it could, every program would be welded to one exact kernel version's internal symbols, and a typo could jump anywhere. Instead the kernel exposes a stable, curated set of **helper functions** — things like `bpf_map_lookup_elem()`, `bpf_ktime_get_ns()`, `bpf_get_current_pid_tgid()`, `bpf_probe_read_kernel()`, `bpf_perf_event_output()`. The `call` instruction dispatches to these by number, the verifier checks that R1–R5 match the helper's declared argument constraints, and R0 comes back with a known return type.

Which helpers a program is *allowed* to call depends on its program type. A socket filter and a tracing probe see different helper sets, because what's safe to expose differs by context. This whitelisting is a load-time decision baked into the verifier's per-type configuration.

The newer mechanism is **kfuncs** — kernel functions explicitly annotated as callable from BPF. Unlike the fixed helper ABI (which is treated as a stable contract), kfuncs are not promised to be stable across versions; they let the kernel expose functionality faster without committing to a frozen API forever. Combined with BTF (below), the verifier can type-check kfunc calls properly. Modern BPF increasingly leans on kfuncs rather than minting new numbered helpers.

## Maps: the only way to hold or share state

A BPF program's stack is 512 bytes and vanishes when the program returns. To keep state across invocations, share data between two BPF programs, or talk to userspace, you use **maps** — typed key/value stores that live in kernel memory and outlive any single program run. Both BPF programs (via helpers) and userspace (via the `bpf()` syscall) can read and write them. Maps are *the* communication channel.

<figure class="diagram">
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 660 280" fill="none" role="img" aria-labelledby="fig-ebpf-maps-title">
<title id="fig-ebpf-maps-title">BPF maps are key/value stores in kernel memory that act as a bridge: kernel-side BPF programs read and write them through helper functions, while userspace reads and writes the same maps through the bpf() syscall.</title>
<defs>
  <marker id="arr-ebpf-map" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
    <path d="M0 0 L7 3.5 L0 7 Z" fill="var(--color-muted)"/>
  </marker>
</defs>
<rect x="20" y="20" width="620" height="86" rx="8" fill="none" stroke="var(--color-border)" stroke-width="1.5" stroke-dasharray="6 4"/>
<text x="36" y="40" fill="var(--color-muted)" font-family="ui-monospace,monospace" font-size="10">userspace</text>
<rect x="60" y="48" width="150" height="44" rx="6" fill="var(--color-border)" stroke="var(--color-muted)" stroke-width="1.5"/>
<text x="135" y="68" fill="var(--color-text)" font-family="ui-monospace,monospace" font-size="10" font-weight="600" text-anchor="middle">loader / agent</text>
<text x="135" y="82" fill="var(--color-muted)" font-family="ui-monospace,monospace" font-size="8.5" text-anchor="middle">reads stats, sets config</text>
<rect x="440" y="48" width="150" height="44" rx="6" fill="var(--color-border)" stroke="var(--color-muted)" stroke-width="1.5"/>
<text x="515" y="68" fill="var(--color-text)" font-family="ui-monospace,monospace" font-size="10" font-weight="600" text-anchor="middle">ring buffer reader</text>
<text x="515" y="82" fill="var(--color-muted)" font-family="ui-monospace,monospace" font-size="8.5" text-anchor="middle">drains events</text>
<rect x="180" y="130" width="300" height="56" rx="8" fill="var(--color-border)" stroke="var(--color-accent)" stroke-width="1.8"/>
<text x="330" y="152" fill="var(--color-text)" font-family="ui-monospace,monospace" font-size="11" font-weight="700" text-anchor="middle">BPF maps (kernel memory)</text>
<text x="330" y="170" fill="var(--color-muted)" font-family="ui-monospace,monospace" font-size="8.5" text-anchor="middle">hash · array · per-CPU · LRU · LPM trie · ringbuf</text>
<rect x="20" y="214" width="620" height="56" rx="8" fill="none" stroke="var(--color-border)" stroke-width="1.5" stroke-dasharray="6 4"/>
<text x="36" y="234" fill="var(--color-muted)" font-family="ui-monospace,monospace" font-size="10">kernel: attached BPF programs</text>
<rect x="80" y="240" width="140" height="24" rx="5" fill="var(--color-border)" stroke="var(--color-muted)" stroke-width="1.3"/>
<text x="150" y="256" fill="var(--color-text)" font-family="ui-monospace,monospace" font-size="9" text-anchor="middle">XDP program</text>
<rect x="260" y="240" width="140" height="24" rx="5" fill="var(--color-border)" stroke="var(--color-muted)" stroke-width="1.3"/>
<text x="330" y="256" fill="var(--color-text)" font-family="ui-monospace,monospace" font-size="9" text-anchor="middle">kprobe program</text>
<rect x="440" y="240" width="140" height="24" rx="5" fill="var(--color-border)" stroke="var(--color-muted)" stroke-width="1.3"/>
<text x="510" y="256" fill="var(--color-text)" font-family="ui-monospace,monospace" font-size="9" text-anchor="middle">tc program</text>
<line x1="135" y1="92" x2="240" y2="130" stroke="var(--color-muted)" stroke-width="1.3" marker-end="url(#arr-ebpf-map)"/>
<line x1="420" y1="130" x2="515" y2="92" stroke="var(--color-muted)" stroke-width="1.3" marker-end="url(#arr-ebpf-map)"/>
<line x1="150" y1="240" x2="240" y2="186" stroke="var(--color-accent)" stroke-width="1.4" marker-end="url(#arr-ebpf-map)"/>
<line x1="330" y1="240" x2="330" y2="188" stroke="var(--color-accent)" stroke-width="1.4" marker-end="url(#arr-ebpf-map)"/>
<line x1="510" y1="240" x2="420" y2="186" stroke="var(--color-accent)" stroke-width="1.4" marker-end="url(#arr-ebpf-map)"/>
</svg>
<figcaption>Maps are the shared-state bridge. Several kernel-side programs and userspace agents all read and write the same map by file descriptor — it's how a load balancer's config gets in and how observability events get out.</figcaption>
</figure>

The map *type* picks the data structure and the semantics:

- **Hash** and **array** are the workhorses — arbitrary keys, or integer-indexed slots.
- **Per-CPU hash/array** keep a separate copy of each value per CPU. The point is to avoid locking: a program running on CPU 3 only ever touches CPU 3's copy, so concurrent updates from other cores can't race. Userspace sums the per-CPU values when it reads. This is how you build lock-free counters at packet rates.
- **LRU hash** evicts least-recently-used entries when full, so a bounded map can track an unbounded key space (flow tracking, for instance) without growing forever.
- **LPM trie** does longest-prefix matching — the natural structure for routing tables and CIDR lookups.
- **Ring buffer** (and the older per-CPU **perf buffer**) stream variable-sized events up to userspace. The ring buffer, added in 5.8, is a single MPSC buffer shared across CPUs with proper ordering, which fixed the perf buffer's per-CPU memory waste and event-reordering quirks.
- **Map-of-maps** and **program array** maps hold references to other maps or to programs (the latter powers tail calls, below).

## Attach points: a spectrum from the wire to the syscall

A program does nothing until it's attached to a hook, and the *program type* you compile determines both where it can attach and what its context (R1 on entry) looks like. The interesting mental model is a spectrum: the earlier in the stack you hook, the faster and cheaper you run, but the less context you have.

<figure class="diagram">
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 660 360" fill="none" role="img" aria-labelledby="fig-ebpf-hooks-title">
<title id="fig-ebpf-hooks-title">A vertical view of eBPF attach points across the stack: XDP runs in the NIC driver before an sk_buff exists, tc/clsact runs after sk_buff allocation, socket filters run at the socket layer, and kprobes, tracepoints, fentry/fexit, LSM and uprobes run up in the kernel and syscall layers.</title>
<rect x="40" y="20" width="580" height="40" rx="6" fill="var(--color-border)" stroke="var(--color-muted)" stroke-width="1.5"/>
<text x="200" y="44" fill="var(--color-text)" font-family="ui-monospace,monospace" font-size="10" font-weight="600" text-anchor="middle">user application</text>
<text x="500" y="40" fill="var(--color-muted)" font-family="ui-monospace,monospace" font-size="8.5" text-anchor="middle">uprobe / USDT attach here</text>
<rect x="40" y="68" width="580" height="40" rx="6" fill="var(--color-border)" stroke="var(--color-muted)" stroke-width="1.5"/>
<text x="200" y="92" fill="var(--color-text)" font-family="ui-monospace,monospace" font-size="10" font-weight="600" text-anchor="middle">syscalls</text>
<text x="500" y="88" fill="var(--color-muted)" font-family="ui-monospace,monospace" font-size="8.5" text-anchor="middle">tracepoints, kprobes, LSM</text>
<rect x="40" y="116" width="580" height="40" rx="6" fill="var(--color-border)" stroke="var(--color-muted)" stroke-width="1.5"/>
<text x="200" y="140" fill="var(--color-text)" font-family="ui-monospace,monospace" font-size="10" font-weight="600" text-anchor="middle">kernel functions</text>
<text x="500" y="136" fill="var(--color-muted)" font-family="ui-monospace,monospace" font-size="8.5" text-anchor="middle">kprobe/kretprobe, fentry/fexit</text>
<rect x="40" y="164" width="580" height="40" rx="6" fill="var(--color-border)" stroke="var(--color-muted)" stroke-width="1.5"/>
<text x="200" y="188" fill="var(--color-text)" font-family="ui-monospace,monospace" font-size="10" font-weight="600" text-anchor="middle">socket layer</text>
<text x="500" y="184" fill="var(--color-muted)" font-family="ui-monospace,monospace" font-size="8.5" text-anchor="middle">socket filter, sockops, cgroup hooks</text>
<rect x="40" y="212" width="580" height="40" rx="6" fill="var(--color-border)" stroke="var(--color-muted)" stroke-width="1.5"/>
<text x="200" y="236" fill="var(--color-text)" font-family="ui-monospace,monospace" font-size="10" font-weight="600" text-anchor="middle">TCP/IP stack (sk_buff)</text>
<text x="500" y="232" fill="var(--color-muted)" font-family="ui-monospace,monospace" font-size="8.5" text-anchor="middle">tc / clsact ingress + egress</text>
<rect x="40" y="260" width="580" height="44" rx="6" fill="var(--color-border)" stroke="var(--color-accent)" stroke-width="1.8"/>
<text x="200" y="282" fill="var(--color-text)" font-family="ui-monospace,monospace" font-size="10" font-weight="700" text-anchor="middle">NIC driver — XDP</text>
<text x="500" y="280" fill="var(--color-muted)" font-family="ui-monospace,monospace" font-size="8.5" text-anchor="middle">runs before sk_buff allocation</text>
<rect x="40" y="312" width="580" height="32" rx="6" fill="var(--color-border)" stroke="var(--color-muted)" stroke-width="1.2"/>
<text x="330" y="332" fill="var(--color-muted)" font-family="ui-monospace,monospace" font-size="9" text-anchor="middle">hardware / wire</text>
<text x="26" y="290" fill="var(--color-accent)" font-family="system-ui, sans-serif" font-size="9" text-anchor="middle" transform="rotate(-90 26 180)">earliest / fastest  ·  least context        most context / most flexible</text>
</svg>
<figcaption>The lower you hook, the earlier and cheaper you run but the less the kernel has done for you. XDP sees a raw frame with no socket buffer yet; a kprobe up in the syscall path sees rich kernel state but runs far later.</figcaption>
</figure>

Going roughly bottom to top:

- **XDP** (eXpress Data Path) runs in the NIC driver the moment a packet arrives, *before* the kernel allocates an `sk_buff`. That's why it's the fastest place to drop, redirect, or rewrite packets — there's no per-packet socket-buffer overhead yet. It's the basis of DDoS scrubbing and L4 load balancing. The tradeoff is you only have the raw packet bytes and almost no kernel context.
- **tc / clsact** hooks attach at traffic-control ingress and egress, after the `sk_buff` exists. Slightly later than XDP, but you get the full packet metadata and you can hook egress too (XDP is ingress-only on most drivers). This is where Cilium does a lot of its pod-to-pod policy work.
- **Socket-layer** hooks (socket filters, `sockops`, cgroup/connect hooks) operate at the socket boundary — e.g. rewriting a destination at `connect()` time before any packet is even formed.
- **kprobes / kretprobes** attach to (almost) any kernel function entry or return by patching the instruction stream. Maximum flexibility, but they're tied to internal function names and signatures, so they're fragile across kernel versions.
- **Tracepoints** are stable, named instrumentation points the kernel maintainers commit to keeping. Less flexible than kprobes, far more durable.
- **fentry / fexit** are the modern replacement for kprobes on function entry/exit. Built on BTF and trampolines, they're faster than kprobes and give you typed access to function arguments — but they require BTF (below).
- **LSM** hooks let a BPF program make security decisions at Linux Security Module checkpoints (this is what Tetragon and KRSI-style enforcement use).
- **uprobes / perf events** reach up into userspace function calls and hardware performance counters respectively.

## CO-RE: compile once, run everywhere

Here's the portability problem. A tracing program that reads `task->pid` needs the byte offset of `pid` within `struct task_struct`. That offset differs between kernel versions and configs. The old `bcc` approach shipped LLVM and kernel headers onto every target box and *recompiled the program at runtime* against the local headers. It worked, but dragging a compiler and headers onto every production node is heavy and slow.

**CO-RE** (Compile Once – Run Everywhere) fixes this with two pieces. **BTF** (BPF Type Format) is compact type information describing kernel structs and their layout; modern kernels ship their own BTF at `/sys/kernel/btf/vmlinux`. When you compile with CO-RE, clang emits **relocations**: instead of hard-coding "offset 0x4e8", the object records "the offset of field `pid` in `struct task_struct`." At load time, the loader library (**libbpf**) reads the running kernel's BTF, resolves each relocation to the correct offset *for this kernel*, and patches the bytecode before handing it to the verifier. One compiled binary adapts itself to whatever kernel it lands on, no on-target compiler required. This is the single biggest reason eBPF tooling became practical to ship as ordinary binaries.

## Tail calls and the size ceiling

Because a single program is capped (4,096 instructions in the classic limit, and the 1M verifier budget overall), you sometimes need to chain logic. **Tail calls** let one program jump into another via `bpf_tail_call()`, indexing into a special program-array map. It's a jump, not a call — execution transfers entirely and does not return, much like `execve()` replacing a process image. This lets you build state machines and dispatch tables (parse the packet, then tail-call into the per-protocol handler) without blowing any one program's size budget. Tail-call chains are themselves bounded — the kernel caps the chain depth (33 in current kernels) so you can't recurse forever.

## A program you can actually read

Here's a minimal XDP program that counts received packets into a per-CPU array map and lets every packet through. It's close to the canonical "hello world" of the data path:

```c
#include <linux/bpf.h>
#include <bpf/bpf_helpers.h>

struct {
    __uint(type, BPF_MAP_TYPE_PERCPU_ARRAY);
    __uint(max_entries, 1);
    __type(key, __u32);
    __type(value, __u64);
} pkt_count SEC(".maps");

SEC("xdp")
int count_packets(struct xdp_md *ctx) {
    __u32 key = 0;
    __u64 *count = bpf_map_lookup_elem(&pkt_count, &key);
    if (count)            // verifier forces this NULL check
        __sync_fetch_and_add(count, 1);
    return XDP_PASS;      // hand the packet to the stack
}

char _license[] SEC("license") = "GPL";
```

The `if (count)` is not defensive style — it's mandatory. `bpf_map_lookup_elem` returns `PTR_TO_MAP_VALUE_OR_NULL`, and the verifier will reject any dereference until you've branched on NULL, at which point the pointer's type narrows to `PTR_TO_MAP_VALUE` and the access becomes provably safe. Omit the check and the load fails with `R0 invalid mem access 'map_value_or_null'`.

For pure observability you rarely write C at all. bpftrace compiles an awk-like one-liner straight to bytecode. This counts every `execve` by process name:

```sh
bpftrace -e 'tracepoint:syscalls:sys_enter_execve { @[comm] = count(); }'
```

`@[comm]` is a map keyed by process name; `count()` is the aggregation. Under the hood it's a tracepoint program writing a hash map that userspace drains and prints on exit. Same machinery as the XDP example, completely different ergonomics.

## Where this actually shows up

The big production users all sit on the same foundation. **Cilium** implements Kubernetes networking, service load-balancing, and identity-based policy in tc and XDP programs, storing service-to-backend maps in BPF hash maps — it can replace kube-proxy entirely. **Katran** (Meta's L4 load balancer) is XDP doing consistent-hash backend selection at the NIC. **bpftrace** and **bcc** are the observability toolkits built on kprobes, tracepoints, and uprobes. **Falco** and **Tetragon** watch syscalls and LSM hooks for runtime security, turning kernel events into security signals. Different domains, one substrate.

## The safety bargain, restated

The reason all of this is allowed to run in kernel space comes back to the verifier. A kernel module that dereferences a bad pointer panics the machine. A BPF program *cannot get that far*, because the verifier proved at load time that the pointer was bounds-checked, the loop terminates, the map lookup was NULL-checked, and no register was read before it was written. After verification, the JIT compiles it to native code and the kernel marks that memory read-only and hardens it against Spectre-style leaks. You get kernel-speed custom code with a static guarantee that a bug in it degrades to "the program is rejected" rather than "the box is down."

---

What stuck with me, after poking at this in a homelab and reading more verifier source than I'd like to admit, is that eBPF isn't really one technology — it's a small VM, an unusually thorough static analyzer, a set of typed shared-memory regions, and a curated syscall-like surface, all wearing one name. The VM is almost boring; the analyzer is the entire reason any of it is safe to ship. Once you see the verifier as the load-bearing wall, the rest of the design stops looking arbitrary: maps exist because the stack is tiny and transient, helpers exist because you can't call into the kernel freely, CO-RE exists because struct layouts move, and the attach-point spectrum exists because "where you hook" is just a trade between speed and context. It's the same lesson as cgroups and namespaces — the magic is a stack of small, well-scoped primitives, and the moment you can name each one, "eBPF" stops being a buzzword and starts being a thing you can reason about.
