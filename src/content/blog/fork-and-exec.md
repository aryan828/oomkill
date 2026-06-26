---
title: What happens on fork and exec
description: The two-step Unix process model, copy-on-write page tables, how a shell wires up redirections between fork and exec, and why zombies and large-heap forks bite in production.
pubDate: 2026-06-25
tags: [linux, systems]
---

Every process on a Linux box that isn't PID 1 was created by another process splitting itself in two. There is no "create a process running this program" primitive in the classic Unix model. Instead there are two calls, and you almost always use them back to back: `fork()` makes a copy of the calling process, and then the copy calls `exec()` to throw away its own program and load a different one in place. A copy, then a replacement. It's a strange shape the first time you see it, because most other operating systems give you a single spawn call (`CreateProcess` on Windows, `posix_spawn` as a bolt-on) that does it all at once.

The split looks redundant until you notice what it buys you. Between the `fork()` and the `exec()`, there's a window where you're running as a brand-new process that is still an exact copy of the parent — and you can do work there. You can close file descriptors, rewire stdin and stdout to a pipe, drop privileges with `setuid`, change directory, put yourself in a new cgroup or namespace. By the time you call `exec()`, the environment for the new program is already set up, and you did it with ordinary code in the child instead of needing a giant spawn API with a flag for every possible adjustment. This is my notes on what actually happens in those two calls, and where it goes wrong.

## fork(): a copy that isn't really a copy

`fork()` creates a new process by duplicating the calling one. The new process — the **child** — is a near-exact replica of the **parent**. Same program text, same heap contents, same stack, same register state, same open files. Execution continues in *both* processes from the point of the `fork()` return, which is the part that confuses everyone at first: one call, two returns.

You tell which process you're in by the return value. In the parent, `fork()` returns the child's PID (a positive number). In the child, it returns `0`. On failure no child is created and it returns `-1` in the parent with `errno` set. So the canonical idiom is a three-way branch:

```c
pid_t pid = fork();
if (pid < 0) {
    perror("fork");          // failed, no child
} else if (pid == 0) {
    // child: pid is 0 here
} else {
    // parent: pid is the child's PID
}
```

What's actually copied versus shared is the interesting part. The child gets its own copy of the address space, its own copy of the file descriptor table, copies of the signal dispositions, and so on. But "copy of the address space" is a lie told for convenience — see the next section. And the file descriptor table is a particularly sharp distinction: the **fd table is copied**, but the **open file descriptions it points at are shared**.

That distinction matters because the file offset lives in the open file description, not the fd. After a fork, parent and child each have their own fd number `3`, but both `3`s point at the *same* underlying open file description. If the parent reads and advances the offset, the child sees the advanced offset too. They share the offset, the status flags, and the read/write position. This is exactly why a shell pipeline works: the child can write to the same pipe the parent set up, because the fd survives the fork pointing at the same kernel object.

<figure class="diagram">
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 660 290" fill="none" role="img" aria-labelledby="fig-fdtable-title">
<title id="fig-fdtable-title">After fork, parent and child each have their own copied file descriptor table, but both tables point at the same shared open file description in the kernel, which holds the single shared file offset.</title>
<defs>
  <marker id="arr-fd-1" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
    <path d="M0 0 L7 3.5 L0 7 Z" fill="var(--color-muted)"/>
  </marker>
</defs>
<rect x="30" y="40" width="160" height="110" rx="6" fill="var(--color-border)" stroke="var(--color-muted)" stroke-width="1.5"/>
<text x="110" y="60" fill="var(--color-text)" font-family="ui-monospace,monospace" font-size="10" font-weight="600" text-anchor="middle">parent fd table</text>
<rect x="50" y="74" width="120" height="22" rx="3" fill="var(--color-border)" stroke="var(--color-muted)" stroke-width="1.2"/>
<text x="110" y="89" fill="var(--color-muted)" font-family="ui-monospace,monospace" font-size="9" text-anchor="middle">fd 3 ───────▶</text>
<rect x="470" y="40" width="160" height="110" rx="6" fill="var(--color-border)" stroke="var(--color-muted)" stroke-width="1.5"/>
<text x="550" y="60" fill="var(--color-text)" font-family="ui-monospace,monospace" font-size="10" font-weight="600" text-anchor="middle">child fd table</text>
<rect x="490" y="74" width="120" height="22" rx="3" fill="var(--color-border)" stroke="var(--color-muted)" stroke-width="1.2"/>
<text x="550" y="89" fill="var(--color-muted)" font-family="ui-monospace,monospace" font-size="9" text-anchor="middle">◀─────── fd 3</text>
<rect x="240" y="190" width="180" height="64" rx="6" fill="var(--color-border)" stroke="var(--color-accent)" stroke-width="1.6"/>
<text x="330" y="212" fill="var(--color-text)" font-family="ui-monospace,monospace" font-size="10" font-weight="600" text-anchor="middle">open file description</text>
<text x="330" y="230" fill="var(--color-muted)" font-family="ui-monospace,monospace" font-size="9" text-anchor="middle">offset = 4096 (SHARED)</text>
<text x="330" y="244" fill="var(--color-muted)" font-family="ui-monospace,monospace" font-size="9" text-anchor="middle">status flags, inode ref</text>
<line x1="110" y1="96" x2="270" y2="190" stroke="var(--color-accent)" stroke-width="1.5" marker-end="url(#arr-fd-1)"/>
<line x1="550" y1="96" x2="390" y2="190" stroke="var(--color-accent)" stroke-width="1.5" marker-end="url(#arr-fd-1)"/>
<text x="330" y="120" fill="var(--color-muted)" font-family="system-ui,sans-serif" font-size="9.5" text-anchor="middle">tables are copied · the thing they point at is shared</text>
</svg>
<figcaption>The fd table is duplicated by fork, but the open file description — where the offset lives — is shared. Advance the offset in one process and the other sees it move.</figcaption>
</figure>

A few other inheritance details worth keeping straight: the child does *not* inherit pending signals (its pending set starts empty), it does not inherit timers or memory locks, its CPU-time counters reset to zero, and — critically for multithreaded programs — only the calling thread survives into the child. All other threads vanish. That's why after a `fork()` in a multithreaded process you can safely call only async-signal-safe functions until you `exec()`: a mutex held by some other thread at fork time is now locked forever in the child, because the thread that would have unlocked it doesn't exist anymore.

## Copy-on-write: why fork doesn't copy gigabytes

If `fork()` genuinely duplicated the address space, forking a process with an 8 GB heap would mean copying 8 GB of memory every time, most of which the child immediately discards by calling `exec()`. That would be absurd, and Unix figured this out decades ago. The mechanism is **copy-on-write** (COW).

On a fork, the kernel does copy the **page tables** — the per-process structures that map virtual addresses to physical pages. But it does *not* copy the physical pages themselves. Instead it points both the parent's and the child's page-table entries at the same physical pages, and marks every one of those shared, writable pages as **read-only** in both processes. Both processes now see identical memory, and nothing was actually duplicated except the bookkeeping.

The copy happens lazily, on the first write. When either process tries to write to one of those read-only pages, the CPU raises a **page fault**. The kernel's fault handler recognizes this as a COW fault, allocates a fresh physical page, copies the contents of the original into it, remaps that one page as writable in the faulting process, and lets the write proceed. Only the pages that actually get written ever get copied, one 4 KiB page at a time. Pages that are only ever read — and for a process that forks then execs, that's nearly all of them — stay shared until they're thrown away.

<figure class="diagram">
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 660 320" fill="none" role="img" aria-labelledby="fig-cow-title">
<title id="fig-cow-title">Before a write, parent and child page tables both map to the same read-only physical pages. After the child writes to one page, the kernel copies that single page and remaps it writable in the child, leaving the others still shared.</title>
<defs>
  <marker id="arr-cow-1" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
    <path d="M0 0 L7 3.5 L0 7 Z" fill="var(--color-muted)"/>
  </marker>
</defs>
<text x="165" y="22" fill="var(--color-muted)" font-family="system-ui,sans-serif" font-size="11" font-weight="600" text-anchor="middle">right after fork</text>
<text x="495" y="22" fill="var(--color-muted)" font-family="system-ui,sans-serif" font-size="11" font-weight="600" text-anchor="middle">after child writes page B</text>
<rect x="30" y="44" width="90" height="24" rx="4" fill="var(--color-border)" stroke="var(--color-muted)" stroke-width="1.3"/>
<text x="75" y="60" fill="var(--color-text)" font-family="ui-monospace,monospace" font-size="9" text-anchor="middle">parent PT</text>
<rect x="210" y="44" width="90" height="24" rx="4" fill="var(--color-border)" stroke="var(--color-muted)" stroke-width="1.3"/>
<text x="255" y="60" fill="var(--color-text)" font-family="ui-monospace,monospace" font-size="9" text-anchor="middle">child PT</text>
<rect x="120" y="120" width="90" height="26" rx="4" fill="var(--color-border)" stroke="var(--color-accent)" stroke-width="1.5"/>
<text x="165" y="137" fill="var(--color-text)" font-family="ui-monospace,monospace" font-size="9" text-anchor="middle">page A (RO)</text>
<rect x="120" y="156" width="90" height="26" rx="4" fill="var(--color-border)" stroke="var(--color-accent)" stroke-width="1.5"/>
<text x="165" y="173" fill="var(--color-text)" font-family="ui-monospace,monospace" font-size="9" text-anchor="middle">page B (RO)</text>
<line x1="68" y1="68" x2="135" y2="120" stroke="var(--color-muted)" stroke-width="1.2" marker-end="url(#arr-cow-1)"/>
<line x1="70" y1="68" x2="140" y2="156" stroke="var(--color-muted)" stroke-width="1.2" marker-end="url(#arr-cow-1)"/>
<line x1="255" y1="68" x2="195" y2="120" stroke="var(--color-muted)" stroke-width="1.2" marker-end="url(#arr-cow-1)"/>
<line x1="252" y1="68" x2="190" y2="156" stroke="var(--color-muted)" stroke-width="1.2" marker-end="url(#arr-cow-1)"/>
<line x1="340" y1="160" x2="370" y2="160" stroke="var(--color-muted)" stroke-width="1.4" stroke-dasharray="4 3" marker-end="url(#arr-cow-1)"/>
<rect x="380" y="44" width="90" height="24" rx="4" fill="var(--color-border)" stroke="var(--color-muted)" stroke-width="1.3"/>
<text x="425" y="60" fill="var(--color-text)" font-family="ui-monospace,monospace" font-size="9" text-anchor="middle">parent PT</text>
<rect x="540" y="44" width="90" height="24" rx="4" fill="var(--color-border)" stroke="var(--color-muted)" stroke-width="1.3"/>
<text x="585" y="60" fill="var(--color-text)" font-family="ui-monospace,monospace" font-size="9" text-anchor="middle">child PT</text>
<rect x="460" y="118" width="90" height="26" rx="4" fill="var(--color-border)" stroke="var(--color-accent)" stroke-width="1.5"/>
<text x="505" y="135" fill="var(--color-text)" font-family="ui-monospace,monospace" font-size="9" text-anchor="middle">page A (RO)</text>
<rect x="430" y="156" width="100" height="26" rx="4" fill="var(--color-border)" stroke="var(--color-muted)" stroke-width="1.3"/>
<text x="480" y="173" fill="var(--color-text)" font-family="ui-monospace,monospace" font-size="9" text-anchor="middle">B (RW, parent)</text>
<rect x="540" y="200" width="100" height="26" rx="4" fill="var(--color-border)" stroke="var(--color-accent)" stroke-width="1.6"/>
<text x="590" y="217" fill="var(--color-text)" font-family="ui-monospace,monospace" font-size="9" text-anchor="middle">B' copy (RW)</text>
<line x1="418" y1="68" x2="470" y2="118" stroke="var(--color-muted)" stroke-width="1.2" marker-end="url(#arr-cow-1)"/>
<line x1="415" y1="68" x2="465" y2="156" stroke="var(--color-muted)" stroke-width="1.2" marker-end="url(#arr-cow-1)"/>
<line x1="582" y1="68" x2="525" y2="118" stroke="var(--color-muted)" stroke-width="1.2" marker-end="url(#arr-cow-1)"/>
<line x1="585" y1="68" x2="585" y2="200" stroke="var(--color-accent)" stroke-width="1.3" marker-end="url(#arr-cow-1)"/>
<text x="330" y="290" fill="var(--color-muted)" font-family="system-ui,sans-serif" font-size="9.5" text-anchor="middle">page A stays shared and read-only · only the written page B is duplicated, one page at a time</text>
</svg>
<figcaption>Page tables are copied at fork; physical pages are shared read-only. The first write to a page triggers a fault, the kernel copies just that page and remaps it writable. Untouched pages stay shared.</figcaption>
</figure>

It's worth being precise about what's *not* free here. Copying the page tables is real work, and its cost scales with the size of the parent's address space — a process mapping hundreds of gigabytes has a lot of page-table entries to walk and duplicate, and marking everything read-only forces TLB flushes. So `fork()` is cheap-ish, not free, and it gets less cheap the bigger the process is.

Under the hood, Linux doesn't even have a distinct `fork()` syscall in the way you'd expect. `fork()` is a thin libc wrapper over **`clone()`**, the general-purpose "make a new task" syscall. `clone()` takes a pile of flags controlling exactly what's shared between parent and child — address space, fd table, signal handlers, namespaces — and `fork()` is just `clone()` with none of the sharing flags set (other than specifying `SIGCHLD` as the termination signal). Threads are the same `clone()` with `CLONE_VM | CLONE_FILES | CLONE_THREAD` and friends set, so they *share* the address space instead of copying it. Fork and thread creation are the same machinery dialed to opposite extremes. This lineage traces back to Plan 9's `rfork`, which introduced the idea of a single call with knobs for what to share.

## exec(): same process, new program

`fork()` gives you a second copy of yourself. `exec()` is how that copy stops being a copy. The real syscall is **`execve()`** (and its cousin `execveat()`); the familiar `execl`, `execlp`, `execvp`, and so on are libc wrappers that differ only in how you pass arguments and whether they search `PATH`.

`execve()` replaces the current process image. The text, the initialized and uninitialized data, the heap, and the stack are all torn down and rebuilt from the new program. But — and the man page is emphatic that calling this "a new process" is misleading — it is *the same process*. The **PID does not change**. The parent-child relationship is intact. Most process attributes carry over: the real UID/GID, the current working directory, the process group, and, importantly, **open file descriptors stay open across exec by default**.

That last point is the one that bites. File descriptors survive `execve()` unless they're marked **close-on-exec** (`FD_CLOEXEC`, settable with `fcntl`, or opened with `O_CLOEXEC` in the first place). This is intentional and necessary — it's how the shell hands a redirected stdout to the program it launches. But it's also a classic failure mode: a server opens a listening socket or a log file or a secret-bearing fd, then forks and execs a child (a CGI script, a plugin, a subprocess), and forgets to set `CLOEXEC`. Now the child has inherited an fd it was never meant to see. Leaked descriptors keep files and sockets alive longer than expected, and at worst hand a sensitive handle to untrusted code. The modern guidance is to open everything `O_CLOEXEC` by default and deliberately clear the flag only on the descriptors you mean to pass on.

A handful of things *are* reset on exec: signal handlers that were caught revert to their default disposition (you can't run the old program's handler in the new program — its code is gone), pending alternate signal stacks are dropped, memory mappings are discarded, and all threads but the caller are destroyed.

What does the kernel actually do to load the program? For a typical ELF binary it parses the ELF header, finds the program headers, and `mmap`s the loadable segments into the fresh address space — the text segment read-only and executable, data read-write. It sets up a new stack and lays out `argv`, `envp`, and the **auxiliary vector** (`auxv`, the kernel's channel for passing things like the page size, the address of the vDSO, and ELF metadata) on it. Then it has to decide where to jump. If the binary is statically linked, it jumps straight to the program's entry point. If it's dynamically linked — most binaries — the ELF file names an interpreter in its `PT_INTERP` segment, almost always the **dynamic linker** `ld-linux.so`. The kernel maps the dynamic linker too and jumps to *it* first. `ld.so` then loads the shared libraries the program needs, resolves symbols, and only then transfers control to the program's own entry point.

## Putting them together: how a shell runs a command

The fork-then-exec dance is exactly what your shell does on every command. When you type `ls > out.txt`, the shell forks. In the child — that window where it's still a copy of the shell but hasn't become `ls` yet — it does the redirection setup: open `out.txt`, then `dup2()` it onto fd 1 so stdout points at the file. Only after the plumbing is in place does the child `execve("/bin/ls", ...)`. The parent shell, meanwhile, calls `wait()` to block until the child finishes. Here's the whole shape in a dozen lines:

```c
pid_t pid = fork();
if (pid == 0) {
    // child: set up redirection, then become the new program
    int fd = open("out.txt", O_WRONLY | O_CREAT | O_TRUNC, 0644);
    dup2(fd, STDOUT_FILENO);   // stdout now points at the file
    close(fd);
    char *argv[] = {"ls", "-l", NULL};
    execvp("ls", argv);
    perror("execvp");          // only reached if exec failed
    _exit(127);
} else {
    int status;
    waitpid(pid, &status, 0);  // parent reaps the child
}
```

The redirection works precisely *because* fd inheritance survives exec: the child rewires fd 1 before exec, `ls` writes to fd 1 like always, and the bytes land in the file. Pipelines (`a | b`) are the same idea with a `pipe()` shared between two children. If you run this under `strace -f` you'll see the whole thing: a `clone` (that's `fork`), then in the child a `dup2` and an `execve`, and in the parent a `wait4`.

```sh
$ strace -f -e trace=clone,execve,wait4 sh -c 'ls -l > out.txt'
clone(child_stack=NULL, flags=CLONE_CHILD_CLEARTID|...|SIGCHLD) = 48213
[pid 48213] execve("/usr/bin/ls", ["ls", "-l"], 0x... /* 30 vars */) = 0
wait4(-1, [{WIFEXITED(s) && WEXITSTATUS(s) == 0}], 0, NULL) = 48213
```

## wait(), zombies, and orphans

That `waitpid()` in the parent isn't optional bookkeeping — it's load-bearing. When a process exits, the kernel can't fully discard it, because someone might still want to know *how* it exited: its exit status, whether a signal killed it, how much CPU it used. So the kernel keeps a husk of the process around — the task struct and its exit status, but no address space, no open files — until the parent collects it. This husk is a **zombie** (state `Z`, shown as `<defunct>` in `ps`). A zombie holds almost no resources except a PID slot, but it holds that.

The parent collects it by calling `wait()` or `waitpid()`, which is called **reaping**. Once reaped, the zombie is gone and its PID is free for reuse. The failure mode is a parent that forks children and never waits on them: the zombies pile up, each pinning a PID, and on a busy system you can exhaust the PID space. The classic "why are there 30,000 `<defunct>` processes" incident is always a parent that isn't reaping.

The companion case is the **orphan**: a child whose parent exits *first*. An orphan can't just be left parentless, because someone needs to reap it when it eventually dies. So the kernel **reparents** orphans — historically to PID 1 (`init`), or to the nearest ancestor that registered itself as a **subreaper** with `prctl(PR_SET_CHILD_SUBREAPER)`. PID 1's standing job is to `wait()` in a loop and reap whatever orphans get reparented onto it.

<figure class="diagram">
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 660 260" fill="none" role="img" aria-labelledby="fig-orphan-title">
<title id="fig-orphan-title">When a parent exits before its child, the orphaned child is reparented to PID 1, which is responsible for reaping it when it terminates so it does not linger as a zombie.</title>
<defs>
  <marker id="arr-orph-1" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
    <path d="M0 0 L7 3.5 L0 7 Z" fill="var(--color-muted)"/>
  </marker>
</defs>
<rect x="60" y="40" width="120" height="40" rx="6" fill="var(--color-border)" stroke="var(--color-muted)" stroke-width="1.5"/>
<text x="120" y="58" fill="var(--color-text)" font-family="ui-monospace,monospace" font-size="10" font-weight="600" text-anchor="middle">parent</text>
<text x="120" y="72" fill="var(--color-muted)" font-family="ui-monospace,monospace" font-size="8.5" text-anchor="middle">exits early</text>
<rect x="60" y="160" width="120" height="40" rx="6" fill="var(--color-border)" stroke="var(--color-accent)" stroke-width="1.5"/>
<text x="120" y="178" fill="var(--color-text)" font-family="ui-monospace,monospace" font-size="10" font-weight="600" text-anchor="middle">child</text>
<text x="120" y="192" fill="var(--color-muted)" font-family="ui-monospace,monospace" font-size="8.5" text-anchor="middle">still running</text>
<line x1="120" y1="80" x2="120" y2="158" stroke="var(--color-muted)" stroke-width="1.3" stroke-dasharray="4 3"/>
<text x="150" y="124" fill="var(--color-muted)" font-family="system-ui,sans-serif" font-size="9" text-anchor="start">was child of</text>
<rect x="480" y="40" width="120" height="40" rx="6" fill="var(--color-border)" stroke="var(--color-accent)" stroke-width="1.6"/>
<text x="540" y="58" fill="var(--color-text)" font-family="ui-monospace,monospace" font-size="10" font-weight="600" text-anchor="middle">PID 1 (init)</text>
<text x="540" y="72" fill="var(--color-muted)" font-family="ui-monospace,monospace" font-size="8.5" text-anchor="middle">reaps in a loop</text>
<line x1="180" y1="174" x2="490" y2="80" stroke="var(--color-accent)" stroke-width="1.5" marker-end="url(#arr-orph-1)"/>
<text x="345" y="150" fill="var(--color-muted)" font-family="system-ui,sans-serif" font-size="9.5" text-anchor="middle">reparented to PID 1; PID 1 will wait() on it when it dies</text>
</svg>
<figcaption>An orphaned child is reparented to PID 1 (or the nearest subreaper), whose duty is to reap it. Without a reaping PID 1, orphans that exit become permanent zombies.</figcaption>
</figure>

This is the root of the container PID 1 problem. In a container, your application process is often PID 1 inside the container's PID namespace — but most applications were never written to be `init`. They don't reap orphans, because on a normal system that was `init`'s job. So when a process inside the container spawns grandchildren that get orphaned and exit, nobody reaps them, and the container slowly fills with zombies. The fix is a tiny init shim — **`tini`** or **`dumb-init`** — that runs as PID 1, forwards signals to your app, and does nothing else but `wait()` in a loop. Docker's `--init` flag injects exactly this.

You can watch a zombie appear by forking a child that exits while the parent sleeps without waiting, then looking at `ps`:

```sh
$ ps -el | grep defunct
1 Z  1000  4823  4811  0 ... -  0 -      pts/2  00:00:00 sleep <defunct>
```

That `Z` and `<defunct>` is a child that died and is waiting to be reaped. It'll vanish the moment its parent calls `wait()` — or immediately, reparented to and reaped by PID 1, if the parent exits.

## fork() at scale: the part that gets expensive

COW makes `fork()` look cheap, and for small processes it is. But the page-table copy cost scales with address-space size, and that turns `fork()` into a genuinely bad API for large processes — a critique made at length in the systems literature, most pointedly in the paper "A fork() in the road." A multi-gigabyte JVM or a database that forks pays to duplicate a large page-table hierarchy and eat a wave of TLB flushes, all to immediately throw most of it away on `exec()`.

Worse, there's the memory-accounting problem. Even though COW means the child won't *actually* use a second copy of the parent's memory, the kernel may have to *account* for the possibility that it could. With strict overcommit settings, forking a process using most of the machine's RAM can fail outright with **ENOMEM**, because the kernel refuses to promise memory it might not be able to deliver if every shared page got written. Linux's default heuristic overcommit usually lets the fork through, betting that the child will exec or exit before it dirties everything — but that bet is exactly what couples `fork()` to the **OOM killer**. If a forked child *does* start writing across all those shared pages under memory pressure, every write is a COW fault allocating a new page, and a wave of them — a COW storm, or in the pathological case a fork bomb multiplying processes faster than they can be reaped — drives the machine into reclaim and then into the OOM killer picking a victim.

This is not academic; it's the **Redis** snapshot story. Redis writes its RDB point-in-time dump by calling `fork()` and letting the child serialize the dataset while the parent keeps serving. COW is the whole trick: the child sees a frozen, consistent snapshot of memory for free, and only the keys the parent *modifies* during the save get copied. The catch is that if the parent is taking heavy writes during a save, more and more pages diverge and get duplicated, so memory usage can balloon toward 2x in the worst case — and on a box sized for one copy of the dataset, that's an OOM kill waiting to happen. Redis even logs `fork` failures and exposes the COW overhead in its stats for exactly this reason.

The alternatives exist because of all this. **`vfork()`** is the old optimization: it creates a child that *shares* the parent's address space (no page-table copy at all) and suspends the parent until the child calls `exec()` or `_exit()`. It's fast but treacherous — the child runs in the parent's memory, so it must do nothing but set up and exec. **`posix_spawn()`** is the modern, sane answer: a single library call (implemented on Linux over `clone()`, historically `vfork`) that does the fork-set-up-exec sequence for you with a declarative list of file actions and attribute changes, avoiding the cost and danger of copying a huge address space just to discard it. And `clone3()` is the current low-level interface, an extensible struct-based version of `clone()` that the runtime tooling reaches for when it needs precise control over namespaces and sharing.

---

The thing that finally made this click for me is that `fork()` and `exec()` aren't two halves of one operation that someone awkwardly failed to merge — they're two genuinely different primitives that compose. `fork()` answers "give me another process," and COW makes that nearly free until you touch memory. `exec()` answers "become a different program," in place, keeping your PID and your carefully-arranged file descriptors. Everything downstream is a consequence of that split: the shell's redirection trick lives in the gap between the two calls, leaked descriptors come from exec preserving fds, zombies come from the parent's duty to reap what fork created, and the OOM killer that names this site is never far away once a multi-gigabyte process decides to fork. Two calls, one copy, one replacement — and an entire operating system's worth of behavior falls out of them.
