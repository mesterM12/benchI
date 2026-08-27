# Worker isolation envelope

Research question: what isolation and outbound-network controls can benchI reliably enforce for arbitrary repositories, coding agents, tests, Custom Agent Adapters, and Custom Scorers in a self-hosted Docker Compose deployment?

## Decision

Treat every executable input in an Eval Trial as hostile, including repository build/install scripts, agent tools and MCP servers, acceptance checks, Custom Agent Adapters, and Custom Scorers. Run each trust phase in a fresh container with only the inputs and outputs that phase needs. In particular, scoring must not share a container, writable filesystem, credentials, or network namespace with agent execution.

The strongest portable deployment profile is a Linux-container boundary with no Docker daemon access, no host namespaces/devices, no added capabilities, a non-root user, a read-only root filesystem, explicit writable scratch space, resource/process limits, and either `network_mode: none` or a dedicated internal network. This is useful process, filesystem, and denial-of-service containment, but it is not a virtual-machine security boundary: containers share the Docker host's Linux kernel, and Docker itself warns that default capabilities and mounts can provide incomplete isolation, particularly when combined with kernel vulnerabilities.[^docker-security]

For work that needs narrowly allowed outbound access, Compose alone cannot express a destination or domain allowlist. Use a dedicated native-Linux worker host and enforce egress outside the trial container with host firewall rules and/or a mandatory application proxy whose own egress is allowlisted. A deny-by-default policy must cover IPv4, IPv6, direct IP traffic, DNS, Docker bridge forwarding, and host/local-network destinations. Otherwise describe the mode as "network enabled," not "allowlisted."

Do not mount the Docker socket, Docker client certificates, or equivalent daemon credentials into any process that executes arbitrary repository or extension code. Docker documents that daemon credentials permit instructions that give root access to the daemon host, and that bind mounts can alter host files.[^docker-daemon][^docker-bind] Sandcastle's Docker provider needs a Docker client outside the sandbox to create child containers; therefore its orchestrator must remain trusted and separated from trial code, or target a dedicated disposable/rootless daemon with no valuable co-tenants.

## Threat boundaries

There are two distinct boundaries:

1. **Compose worker boundary.** Compose configures the long-lived benchI service container. If arbitrary adapters, scorers, hooks, or repository commands execute directly here, they inherit everything available to that service, including mounted paths, environment secrets, networks, and any Docker daemon access.
2. **Eval Trial boundary.** Sandcastle's Docker provider starts another container through `docker run`. Its source shows that it bind-mounts the worktree and Git paths, runs as a selected UID/GID, and optionally passes networks, supplementary groups, devices, and a CPU limit.[^sandcastle-docker][^sandcastle-lifecycle] Limits on the outer Compose worker do not automatically become limits on sibling containers created by the Docker daemon. The trial container needs its own policy.

Sandcastle calls the Docker provider a bind-mount provider and states that the agent writes directly to the host worktree through that mount.[^sandcastle-readme] That protects unrelated paths only to the extent that no other host paths or daemon credentials are exposed. The writable worktree itself is intentionally attacker-controlled output and must never contain hidden Acceptance Material or installation secrets.

The current Sandcastle Docker launch path does **not** set `--network none`, `--read-only`, memory/PID limits, `--cap-drop`, `no-new-privileges`, or a custom seccomp/AppArmor policy; without an explicit `network` option it uses Docker's default bridge.[^sandcastle-lifecycle] Docker's bridge documentation says that bridge containers receive masqueraded external access, and unrelated containers using the default bridge can communicate by IP.[^docker-bridge] Consequently, Sandcastle's stock `docker()` defaults are not the target isolation envelope. benchI must either extend/wrap the provider so every child is created with the full policy, use a separately configured sandbox provider, or decline to claim those controls.

## Portable guarantees

These are Docker/Compose-level controls that can be represented consistently for Linux containers, including Docker Desktop's Linux VM. Their implementation still depends on the Docker Engine and underlying kernel; startup validation must fail closed if the engine rejects or omits a required setting.

| Control | Achievable guarantee | Qualification |
| --- | --- | --- |
| Per-phase container | PID, mount, network, IPC, and related namespace separation from ordinary peer/host processes | Containers share a kernel; do not use `privileged`, host PID/IPC/network modes, namespace sharing, or exposed devices. Linux documents namespaces as isolated instances of global resources and identifies the resources each namespace type covers.[^linux-namespaces] Docker describes them as the primary container-isolation mechanism.[^docker-security] |
| No network | `network_mode: none` gives the container only loopback and turns off container networking.[^docker-none][^compose-services] | Strongest outbound control. It also prevents agent API calls, dependency downloads, and Compose service access; prefetch dependencies/artifacts in a separate trusted stage. Loopback remains available to processes in the same container. |
| Closed service network | A dedicated Compose network with `internal: true` has no default gateway for external connectivity.[^compose-networking] | Members can still communicate with each other. Any second non-internal network restores external access. Prefer `none` when no peer is required. |
| Filesystem scope | Mount only a trial-specific writable workspace; mount immutable inputs read-only; make the container root filesystem read-only and provide bounded scratch mounts | Docker warns bind mounts are writable by default and can modify host files; `ro` prevents writes to that mount.[^docker-bind] A writable repository can modify every file in that repository, including Git metadata if mounted. Do not mount host home, credentials, daemon sockets, hidden checks, or other trials. |
| Identity and privilege | Run as a numeric non-root UID/GID, drop all capabilities, add none back unless demonstrated necessary, and set `no-new-privileges` | Linux capabilities split root privileges into independently controllable per-thread units.[^linux-capabilities] Docker starts with a restricted set but recommends removing every capability not required.[^docker-security] Non-root and capability removal reduce impact; they do not repair an unsafe mount or kernel escape. |
| System-call surface | Keep Docker's default seccomp profile at minimum | Docker's default profile is an allowlist and blocks roughly 44 calls, but is intentionally only moderately protective for compatibility.[^docker-seccomp] Validate agent/test compatibility before narrowing it. |
| Resource containment | Set hard memory and CPU quotas, a PID limit, bounded writable storage/tmpfs, `ulimits`, an execution deadline, and forced cleanup | Containers have no resource constraints by default. Docker documents hard memory and CPU controls; CPU shares are only relative, not a ceiling.[^docker-resources] Linux cgroup v2 documents hierarchical resource distribution and states that descendant restrictions cannot override ancestor restrictions.[^linux-cgroup] Limits reduce denial of service but cannot guarantee host availability against every kernel/filesystem workload. |
| Secret separation | Inject only the credential needed by the agent phase; never place scorer/acceptance secrets in that phase; destroy the container after use | A hostile process can read any secret available to its process/container and can exfiltrate it whenever network is enabled. Docker/Compose secret delivery is availability control, not protection from code intentionally given the secret. |
| Artifact boundary | Export a declared, size-bounded artifact set after termination; validate paths/types; score from a fresh read-only snapshot | Do not trust exit status, logs, Git metadata, symlinks, device nodes, sockets, or generated executables merely because they came from a container. |

The same minimum profile applies to arbitrary repositories, coding agents, tests, adapters, and scorers. "Admin approved" is provenance/policy metadata, not technical confinement. If benchI intentionally treats a component as trusted, record that exception; do not silently run it in the worker control plane.

## Linux-only hardening

For a native Linux production host, add defense in depth and verify it at worker startup:

- Run a dedicated Docker Engine per worker pool, preferably rootless. Docker says rootless mode runs both daemon and containers as a non-root user inside a user namespace to mitigate daemon/runtime vulnerabilities.[^docker-rootless] Rootless has operational limitations and is not a VM boundary.
- Alternatively enable daemon-wide `userns-remap`; container root maps to an unprivileged high host UID. Docker notes bind-mount ownership complexity and incompatible host namespace/privileged modes.[^docker-userns] Avoid per-container `userns=host` exceptions.
- Apply a tested custom seccomp allowlist and an enforcing AppArmor or SELinux policy. Docker's default AppArmor profile is only "moderately protective"; custom profiles can deny filesystem, executable, capability, mount, and network operations.[^docker-apparmor]
- Enforce outbound policy in the host's Docker forwarding path. Docker creates iptables/nftables rules for bridge networks and notes that Docker-published traffic bypasses the `ufw` `INPUT`/`OUTPUT` path.[^docker-firewall] Therefore an ordinary host `ufw` policy is not evidence that container egress is denied. Use the Docker-aware forwarding hook/backend appropriate to the installed Engine, test IPv4 and IPv6, and continuously probe the policy.
- Place online trials on a dedicated network with no route to host management, RFC1918/ULA/link-local networks, cloud metadata, or other Docker networks. Route permitted traffic only through a controlled proxy. A DNS allowlist alone is bypassable through direct IPs, alternate resolvers, DNS rebinding, and already-open connections.
- Use tmpfs for ephemeral secrets/scratch only with memory and swap policy understood. Docker states tmpfs is Linux-only, counts against the memory cgroup, and may be persisted to swap.[^docker-tmpfs]
- Keep the host kernel, Docker Engine, containerd, and runtime patched; dedicate the host to workers and keep control-plane/data services off it. Docker itself recommends running other services in containers on a Docker server and identifies the shared kernel and daemon as core attack surfaces.[^docker-security]

These controls are Linux-only because seccomp, AppArmor/SELinux, user namespaces, cgroups, netfilter forwarding, and tmpfs behavior are Linux kernel facilities. Docker Desktop interposes a Linux VM and explicitly says the daemon runs there and bind mounts are mediated; host firewall, mount propagation, identity, and filesystem semantics therefore differ from native Linux.[^docker-bind] Desktop is suitable for development but should not be claimed equivalent to a validated native-Linux hardening profile.

## Outbound-network modes

benchI can truthfully expose three modes:

| Mode | Enforcement | Claim |
| --- | --- | --- |
| Offline | Per-trial `network_mode: none` | No container networking except loopback. This is the only simple, destination-independent outbound denial. |
| Closed local | One dedicated `internal: true` network and no other network attachment | No default external gateway; communication with explicitly attached peers remains possible. |
| Controlled online | Dedicated native-Linux bridge, host forwarding deny policy, blocked local/metadata ranges, and mandatory allowlisting proxy; no alternate network | Only policy-approved traffic is intended to leave. This is not a Compose-only or Sandcastle-default guarantee and must be integration-tested on every supported host configuration. |

Agent execution that requires a model API belongs in controlled-online mode and receives only its model credential. Tests should be offline after dependencies are prefetched whenever feasible. Acceptance checks and Custom Scorers should normally be offline. A component that must download dependencies or call an external service should do so in a separate fetch phase with narrowly scoped credentials, then pass immutable content-addressed inputs to an offline execution phase.

## Unsupported assumptions

benchI must not promise any of the following:

- **"Docker is a VM" or protects against kernel/runtime escapes.** All Linux containers on an Engine share its kernel; defaults are defense in depth, not a hostile multi-tenant VM boundary.[^docker-security]
- **"Compose service isolation applies to Sandcastle children."** Sandcastle issues independent `docker run` commands; the current source forwards only its own listed options.[^sandcastle-lifecycle]
- **"Default bridge means isolated/offline."** It provides masqueraded internet access and permits same-bridge communication.[^docker-bridge]
- **"`internal: true` is a domain allowlist."** It removes the external default gateway; it does not selectively permit internet destinations, and peers on that network remain reachable.[^compose-networking]
- **"No published ports means no outbound traffic."** Port publication controls inbound reachability; bridge masquerading provides outbound access independently.[^docker-bridge]
- **"Host `ufw` protects Docker traffic."** Docker documents that published traffic is diverted before the chains `ufw` uses.[^docker-firewall]
- **"Non-root means no host writes."** Bind-mount permissions and matching host IDs can still authorize writes; Sandcastle deliberately aligns the container UID/GID and mounts a writable worktree.[^sandcastle-docker][^docker-bind]
- **"Read-only root means no mutation or exfiltration."** Writable mounts/tmpfs, memory, stdout, and network remain channels.
- **"Hidden checks in another path in the same container are hidden."** Namespace membership exposes all mounted/readable content; use a separate scoring container and never mount hidden material into the agent phase.
- **"A secret environment variable is hidden from arbitrary code in that container."** It is intentionally delivered to that code's process environment.
- **"Sandcastle `noSandbox()` is safe for arbitrary code."** Sandcastle states that it runs the agent directly on the host and skips container isolation.[^sandcastle-readme]
- **"A mounted Docker socket is safe because the worker is itself a container."** Docker daemon access can create privileged containers and arbitrary host bind mounts; Docker treats equivalent client keys like a root password.[^docker-daemon][^docker-security]
- **"Resource limits make results deterministic."** They bound some consumption; host contention, kernel scheduling, caches, clocks, random sources, external services, and architecture remain variable.

## Residual risks

- A Linux kernel, Docker Engine, containerd, runtime, seccomp, AppArmor/SELinux, or filesystem vulnerability can permit escape or cross-trial interference.
- Online agents can exfiltrate repository content, prompts, available credentials, test behavior, and outputs to an allowed endpoint. Destination allowlisting cannot constrain what is encoded in permitted traffic.
- Coding-agent providers and permitted package registries are third parties; they can observe requests and return malicious or mutable content. Pin images and dependencies by digest and retain provenance.
- Writable bind mounts expose host-backed trial data. Sandcastle also mounts Git paths needed for worktree operation; malicious Git objects/configuration and symlink/path handling need independent validation before merge or artifact import.[^sandcastle-readme]
- Resource controls are incomplete against all denial-of-service classes: disk exhaustion outside bounded mounts, inode pressure, daemon API abuse, kernel bugs, fork bombs if PID limits are absent, and noisy-neighbor effects remain concerns.
- Side channels through shared CPU caches, page cache, kernel state, timing, resource contention, and observable service behavior are not eliminated.
- Cleanup after a compromised container is not proof of erasure. Bind-mounted output persists; tmpfs may swap; logs and daemon storage remain. Recycle dedicated worker hosts/VMs for stronger tenant separation.
- Custom Adapters and Scorers can subvert result integrity even when contained. Isolation protects infrastructure; it does not establish that a scorer is correct or an adapter faithfully implements the contract.
- The trusted orchestrator can still be compromised by malformed artifacts, logs, archives, Git data, or Docker API responses after the trial. Parse untrusted outputs defensively and minimize its privileges.

## Required acceptance checks

Before advertising an isolation level, an installation should automatically verify the effective child-container configuration rather than only the Compose YAML:

- Inspect each trial container for network mode/memberships, user, capabilities, security options, read-only root, mounts, devices, PID/memory/CPU limits, and absence of daemon credentials.
- In offline mode, test DNS, IPv4, IPv6, host-gateway, local subnets, metadata addresses, and another trial/service; all except loopback must fail.
- In controlled-online mode, test approved and denied domains, direct approved/denied IPs, alternate DNS, IPv6, local/metadata ranges, and connection attempts that bypass the proxy.
- Attempt writes outside the declared workspace and into read-only inputs; attempt capability-sensitive operations and process exhaustion; ensure the trial is terminated and cleaned up at deadline.
- Confirm agent containers cannot read Acceptance Material, scorer credentials, another trial's workspace, worker control-plane files, or the Docker socket.
- Fail closed if required Linux security modules, cgroup controllers, firewall rules, rootless/userns mode, or Sandcastle child flags are unavailable.

## Sources

All sources below are first-party Docker documentation, Linux kernel/interface documentation, or Sandcastle documentation/source.

[^docker-security]: Docker, [Docker Engine security](https://docs.docker.com/engine/security/).
[^docker-daemon]: Docker, [Protect the Docker daemon socket](https://docs.docker.com/engine/security/protect-access/).
[^docker-bind]: Docker, [Bind mounts](https://docs.docker.com/engine/storage/bind-mounts/).
[^docker-none]: Docker, [None network driver](https://docs.docker.com/engine/network/drivers/none/).
[^docker-bridge]: Docker, [Bridge network driver](https://docs.docker.com/engine/network/drivers/bridge/).
[^docker-firewall]: Docker, [Packet filtering and firewalls](https://docs.docker.com/engine/network/packet-filtering-firewalls/).
[^docker-seccomp]: Docker, [Seccomp security profiles for Docker](https://docs.docker.com/engine/security/seccomp/).
[^docker-apparmor]: Docker, [AppArmor security profiles for Docker](https://docs.docker.com/engine/security/apparmor/).
[^docker-rootless]: Docker, [Rootless mode](https://docs.docker.com/engine/security/rootless/).
[^docker-userns]: Docker, [Isolate containers with a user namespace](https://docs.docker.com/engine/security/userns-remap/).
[^docker-resources]: Docker, [Resource constraints](https://docs.docker.com/engine/containers/resource_constraints/).
[^docker-tmpfs]: Docker, [tmpfs mounts](https://docs.docker.com/engine/storage/tmpfs/).
[^compose-networking]: Docker, [Networking in Compose](https://docs.docker.com/compose/how-tos/networking/).
[^compose-services]: Docker, [Compose service `network_mode`](https://docs.docker.com/reference/compose-file/services/#network_mode).
[^linux-namespaces]: Linux man-pages project, [`namespaces(7)`](https://man7.org/linux/man-pages/man7/namespaces.7.html).
[^linux-capabilities]: Linux man-pages project, [`capabilities(7)`](https://man7.org/linux/man-pages/man7/capabilities.7.html).
[^linux-cgroup]: Linux kernel documentation, [Control Group v2](https://docs.kernel.org/admin-guide/cgroup-v2.html).
[^sandcastle-readme]: Sandcastle, [README: sandbox providers and bind-mount behavior](https://github.com/mattpocock/sandcastle/blob/main/README.md).
[^sandcastle-docker]: Sandcastle, [`src/sandboxes/docker.ts`](https://github.com/mattpocock/sandcastle/blob/main/src/sandboxes/docker.ts).
[^sandcastle-lifecycle]: Sandcastle, [`src/DockerLifecycle.ts`](https://github.com/mattpocock/sandcastle/blob/main/src/DockerLifecycle.ts).
