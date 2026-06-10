---
title: Container Networking
description: How a packet gets from pod A to pod B, what CNI plugins actually do, and why iptables eventually breaks down at scale.
pubDate: 2026-06-10
tags: [kubernetes, networking, linux, systems]
---

When you run two pods on the same node and they talk to each other, the packets don't go over the physical network. They go through a software stack inside the kernel: virtual ethernet interfaces, a Linux bridge, and a routing table that only exists on that machine. When the pods are on different nodes, you layer an encapsulation protocol on top of that, or you use BGP to advertise pod subnets as real routes. And when traffic hits a Kubernetes Service, something has to intercept the packet and rewrite the destination before it reaches any of that.

This is the stack from bottom to top.

## Network namespaces and veth pairs

Linux network namespaces are the foundation. Each pod gets its own namespace with its own network stack: its own interfaces, routing table, and iptables rules. From inside the pod, it looks like a machine that has exactly one ethernet interface (`eth0`) and an IP address that belongs to it.

The problem is isolation by itself is useless. You need a way to move packets from one namespace to another. That's what a **veth pair** does. A veth is a linked pair of virtual interfaces: anything that enters one end comes out the other. The kernel creates two interfaces and connects them. You put one end (`eth0`) inside the pod's namespace and leave the other end (typically named `vethXXXXXX`) in the root namespace of the host. Now the pod and the host share a wire.

One veth pair gets you pod-to-host. To get pod-to-pod on the same node, you need something to bridge the host ends together. A **Linux bridge** does this. It acts like a virtual switch: it learns which MAC addresses live on which ports and forwards frames accordingly. All the `vethXXXXXX` interfaces on the host get plugged into the bridge (usually named `cni0` or `cbr0` depending on the plugin). The bridge also gets an IP in the pod CIDR, which becomes the default gateway for every pod on the node.

<figure class="diagram">
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 660 340" fill="none" role="img" aria-labelledby="fig-same-node-title">
<title id="fig-same-node-title">Same-node pod-to-pod packet path: packets travel from pod A's eth0, through a veth pair to the bridge, across to the peer veth pair, into pod B's eth0.</title>
<defs>
  <marker id="arr" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
    <path d="M0 0 L7 3.5 L0 7 Z" fill="var(--color-muted)"/>
  </marker>
  <marker id="arr-accent" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
    <path d="M0 0 L7 3.5 L0 7 Z" fill="var(--color-accent)"/>
  </marker>
</defs>

<!-- Node background -->
<rect x="10" y="10" width="640" height="320" rx="8" fill="none" stroke="var(--color-border)" stroke-width="1.5" stroke-dasharray="6 4"/>
<text x="26" y="30" fill="var(--color-muted)" font-family="ui-monospace,monospace" font-size="10">Node (root namespace)</text>

<!-- Pod A namespace -->
<rect x="30" y="50" width="160" height="100" rx="6" fill="var(--color-border)" stroke="var(--color-muted)" stroke-width="1.5"/>
<text x="110" y="70" fill="var(--color-muted)" font-family="ui-monospace,monospace" font-size="9" text-anchor="middle">pod namespace</text>
<rect x="60" y="80" width="100" height="28" rx="4" fill="var(--color-border)" stroke="var(--color-accent)" stroke-width="1.5"/>
<text x="110" y="99" fill="var(--color-text)" font-family="ui-monospace,monospace" font-size="11" font-weight="600" text-anchor="middle">Pod A</text>
<text x="110" y="128" fill="var(--color-muted)" font-family="ui-monospace,monospace" font-size="9" text-anchor="middle">eth0  10.0.1.2</text>

<!-- Pod B namespace -->
<rect x="470" y="50" width="160" height="100" rx="6" fill="var(--color-border)" stroke="var(--color-muted)" stroke-width="1.5"/>
<text x="550" y="70" fill="var(--color-muted)" font-family="ui-monospace,monospace" font-size="9" text-anchor="middle">pod namespace</text>
<rect x="500" y="80" width="100" height="28" rx="4" fill="var(--color-border)" stroke="var(--color-accent)" stroke-width="1.5"/>
<text x="550" y="99" fill="var(--color-text)" font-family="ui-monospace,monospace" font-size="11" font-weight="600" text-anchor="middle">Pod B</text>
<text x="550" y="128" fill="var(--color-muted)" font-family="ui-monospace,monospace" font-size="9" text-anchor="middle">eth0  10.0.1.3</text>

<!-- veth pair A label -->
<text x="110" y="175" fill="var(--color-muted)" font-family="ui-monospace,monospace" font-size="9" text-anchor="middle">veth pair</text>

<!-- veth pair B label -->
<text x="550" y="175" fill="var(--color-muted)" font-family="ui-monospace,monospace" font-size="9" text-anchor="middle">veth pair</text>

<!-- veth lines A -->
<line x1="110" y1="150" x2="110" y2="195" stroke="var(--color-muted)" stroke-width="1.5" stroke-dasharray="4 3"/>

<!-- veth lines B -->
<line x1="550" y1="150" x2="550" y2="195" stroke="var(--color-muted)" stroke-width="1.5" stroke-dasharray="4 3"/>

<!-- Bridge -->
<rect x="200" y="195" width="260" height="44" rx="6" fill="var(--color-border)" stroke="var(--color-muted)" stroke-width="1.5"/>
<text x="330" y="215" fill="var(--color-text)" font-family="ui-monospace,monospace" font-size="11" font-weight="600" text-anchor="middle">Linux bridge (cni0)</text>
<text x="330" y="230" fill="var(--color-muted)" font-family="ui-monospace,monospace" font-size="9" text-anchor="middle">10.0.1.1  (default gateway)</text>

<!-- veth A host end to bridge -->
<line x1="110" y1="195" x2="200" y2="217" stroke="var(--color-accent)" stroke-width="1.5" marker-end="url(#arr-accent)"/>

<!-- veth B host end to bridge -->
<line x1="550" y1="195" x2="460" y2="217" stroke="var(--color-accent)" stroke-width="1.5" marker-end="url(#arr-accent)"/>

<!-- Host NIC -->
<rect x="260" y="280" width="140" height="36" rx="6" fill="var(--color-border)" stroke="var(--color-muted)" stroke-width="1.5"/>
<text x="330" y="303" fill="var(--color-text)" font-family="ui-monospace,monospace" font-size="11" font-weight="600" text-anchor="middle">eth0 (host NIC)</text>

<!-- bridge to host NIC -->
<line x1="330" y1="239" x2="330" y2="280" stroke="var(--color-muted)" stroke-width="1.2" stroke-dasharray="4 3" marker-end="url(#arr)"/>
<text x="360" y="265" fill="var(--color-muted)" font-family="ui-monospace,monospace" font-size="9">off-node</text>
</svg>
<figcaption>Same-node packet path. Pod A's eth0 connects via veth pair to the host bridge. Pod B's eth0 connects the same way. The bridge forwards between the two. Off-node traffic exits via the host NIC.</figcaption>
</figure>

A packet from Pod A to Pod B on the same node: leaves `eth0` in pod A's namespace, crosses the veth pair into the root namespace, gets forwarded by the bridge to the peer veth, crosses back into pod B's namespace, arrives at `eth0`. The physical NIC never sees it.

## Cross-node traffic: overlay vs underlay

Getting a packet to a pod on a different node requires the host to know how to reach the destination pod IP. There are two broad approaches.

**Overlay networks** wrap the pod-to-pod packet in a new outer packet addressed to the destination node's real IP. The most common encapsulation protocols are VXLAN (UDP, port 8472) and IPIP (IP-in-IP). The sending node's CNI plugin acts as a tunnel endpoint: it receives a pod-addressed frame, wraps it in a UDP datagram destined for the remote node, and sends it. The receiving node unwraps it and delivers the original packet to the destination pod via its veth pair. Neither the pod nor the physical network needs to know about pod IPs. Flannel's default mode works this way, as does Calico when it falls back to VXLAN on networks that block IPIP.

The overlay is operationally simple because it needs nothing from the physical network. The tradeoff is overhead: every packet carries an extra IP and UDP header (around 50 bytes for VXLAN), encapsulation and decapsulation burn CPU cycles, and the effective MTU available to pods is lower than the physical MTU.

**Underlay networks** skip the wrapper. Instead, each node advertises its pod subnet as a real route to the rest of the network. Calico does this with BGP: it runs a virtual BGP router on every node. By default, all nodes form an iBGP full mesh where every node peers with every other. That works fine up to around 100 nodes; past that, you switch to route reflectors or peer directly with physical top-of-rack switches and let the data center fabric carry pod routes natively. In this model a pod IP is a real IP from the network's perspective, there is no encapsulation overhead, and standard network tooling works without modification.

The choice is mostly about what your physical network allows. Public cloud CNIs often need overlays because the underlying network doesn't know about pod CIDRs. On-premises with BGP-capable switches, Calico's underlay mode is common and gives better performance.

## CNI: what the plugin interface actually is

CNI is not a daemon, a CRD, or a server. It's a convention: CNI plugins are ordinary binary executables, and the container runtime (containerd, CRI-O) invokes them directly.

The runtime creates the pod's network namespace. Then it calls the CNI plugin binary with:

- **stdin**: a JSON configuration blob specifying the plugin type, network name, IPAM settings, and any plugin-specific options
- **environment variables**: the container ID, the netns path, the desired interface name inside the namespace, and the operation being requested (ADD, DEL, CHECK, GC)

The plugin does its work (creates the veth pair, assigns the IP, configures routes) and writes a JSON result to stdout. Errors go to stderr. That's the entire protocol.

IPAM is intentionally separated. The main plugin handles interface wiring but delegates address allocation to a dedicated IPAM plugin, named by the `ipam.type` field in the config. The main plugin invokes the IPAM binary, which returns the assigned IP, subnet mask, gateway, and any additional routes. The main plugin then configures those on the interface. Common IPAM plugins are `host-local` (allocates from a per-node range stored on disk) and `dhcp` (issues a real DHCP request).

Plugins can also be chained: a configuration can list multiple plugins in sequence. Each plugin after the first receives the previous plugin's result as `prevResult`. This is how policy-based plugins (like Calico's network policy enforcement) compose with interface-creation plugins without needing to know how to create the interface themselves.

## Services and the load-balancing problem

Pod IPs are ephemeral. A new pod gets a new IP; a rollout replaces every IP in a Deployment. Services exist to give you a stable virtual IP (ClusterIP) that doesn't change when pods come and go.

The ClusterIP is a fiction. No interface on any machine holds it. When a packet is addressed to a ClusterIP, something in the kernel has to intercept it before it goes anywhere and rewrite the destination to a real pod IP. That interception is where iptables, IPVS, nftables, and eBPF diverge.

## iptables mode

kube-proxy watches the API server for Service and Endpoints changes and translates them into iptables rules in the `nat` table. When a packet destined for a ClusterIP hits `PREROUTING`, it traverses a chain that probabilistically DNATs it to one of the backend pod IPs. The probability weights are implemented by using `--probability` flags in consecutive rules: the first rule matches with probability 1/n, the second with 1/(n-1), and so on.

This works. The problem is it doesn't scale well. The ruleset size grows linearly with the number of Services times the number of endpoints. A cluster with 2,000 Services each backed by 10 pods carries at least 20,000 iptables records on every worker node. Every packet that hits a ClusterIP walks that list.

The deeper issue is in the control plane. Adding a single iptables rule requires acquiring a kernel lock, downloading the entire ruleset into userspace, modifying it, uploading the full ruleset back, and releasing the lock. There's no incremental update path. In a large cluster undergoing frequent rollouts this becomes a measurable bottleneck, and the lag between a pod becoming ready and the iptables rules reflecting that introduces a window where traffic gets sent to endpoints that don't exist yet.

## IPVS mode

IPVS (IP Virtual Server) is a load-balancing framework built into the Linux kernel, originally designed for high-performance TCP/UDP load balancing. kube-proxy's IPVS mode programs IPVS rules instead of iptables chains. The key difference is the data structure: IPVS uses hash tables internally, giving roughly O(1) lookup time regardless of the number of Services. It also supports proper load-balancing algorithms (round-robin, least-connections, weighted) rather than the probability-chain hack in iptables mode.

IPVS mode still needs a handful of iptables rules for things IPVS doesn't handle natively (NodePort SNAT, masquerading), but the hot path for ClusterIP traffic goes through IPVS, not iptables chains.

Worth knowing: IPVS kube-proxy mode was deprecated in Kubernetes v1.35. The intended replacement is nftables mode.

## nftables mode

nftables is the successor to iptables in the Linux kernel. The interface is different but the bigger change is internal: nftables uses hash tables and red-black trees as backing data structures for sets and maps, enabling data structures that iptables rules can't express.

For Service dispatch, kube-proxy's nftables mode uses a **verdict map**: a single rule looks up the destination IP in a map and jumps directly to the matching action. The map lookup is roughly O(1). There's no chain to walk. At 5,000 Services, the median nftables dispatch latency is approximately equal to the best-case (p01) iptables dispatch latency.

The control-plane update story is also better. nftables supports atomic incremental updates: you can add or remove a single map entry without touching the rest of the ruleset. The full-download-modify-upload cycle that makes iptables slow to update is gone.

nftables kube-proxy mode graduated to beta in Kubernetes 1.33 and is the direction the project is heading for the traditional kube-proxy path.

## eBPF and Cilium

Cilium takes a fundamentally different approach: it replaces kube-proxy entirely and implements service load-balancing in eBPF programs attached directly to the kernel.

eBPF lets you load programs into the kernel that attach to predefined hook points: socket operations, TC (traffic control) ingress/egress, XDP (eXpress Data Path, runs before the kernel network stack even processes the packet). These programs run in a restricted virtual machine with a verifier that proves they can't crash the kernel before loading them.

Cilium stores service-to-backend mappings in BPF maps (hash tables living in kernel memory). When a pod opens a TCP connection to a ClusterIP, a BPF program attached to the `connect()` syscall intercepts it, looks up the ClusterIP in the BPF map, selects a backend, and rewrites the destination before the kernel even forms a network packet. The rewrite happens at the socket level. Because no packet has been formed yet, there is no source IP problem to solve (traditional DNAT has to track the rewrite in conntrack so the reply can be un-NATed). The connection proceeds directly to the backend pod IP.

When Cilium is running in kube-proxy replacement mode, there are no `KUBE-SVC-*` or `KUBE-SEP-*` iptables chains. Running `iptables-save | grep KUBE-SVC` returns nothing.

For cross-node traffic, Cilium attaches BPF programs at the TC ingress/egress hook points on each pod's veth interface. Network policies are enforced here as well, using a numeric identity model: each pod is assigned a security identity number stored in the BPF map, and policy rules reference identity numbers rather than IP addresses. This means policy enforcement is not broken by IP churn during rollouts.

## Choosing a model

The three approaches sit at different points on the complexity-vs-performance axis.

**kube-proxy iptables** is the default and the most conservative choice. It works everywhere and requires no kernel features beyond what any modern Linux has. It struggles past a few thousand Services and is being phased out in favor of nftables.

**kube-proxy nftables** is the current recommended path for clusters staying with the kube-proxy architecture. It gives O(1) dispatch and incremental updates. It requires a kernel with nftables support, which means Linux 5.13+ in practice.

**Cilium with eBPF** removes kube-proxy entirely and handles everything in BPF programs. It has the best performance characteristics, eliminates conntrack overhead on the ClusterIP path, and gives you identity-based network policy. The cost is operational complexity and a hard dependency on a recent kernel (5.10+ for full feature support).

For the underlying pod-to-pod transport, the choice between overlay and underlay mostly comes down to what the physical network supports. Overlays are simpler operationally and work everywhere; Calico BGP underlay performs better and integrates with existing network tooling when the fabric cooperates.

---

Every layer here is a Linux primitive doing one well-scoped job. Network namespaces give isolation. veth pairs cross namespace boundaries. Bridges forward between veth ends. Encapsulation tunnels connect nodes. And at the service layer, iptables chains, IPVS hash tables, nftables verdict maps, and eBPF socket hooks are all solving the same problem with progressively more efficient data structures. The reason the stack looks the way it does is that each layer was bolted on to solve a specific limitation in the layer below it.
