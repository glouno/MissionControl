# Controller-owned inference relay

Each execution gets its own Docker internal bridge network in isolated gateway
mode. Its worker reaches only an inference relay. The relay has no host mounts,
cloud credentials, controller operator token, host network or Docker socket.

The controller launches the relay with `docker exec -i`. Bounded length-prefixed
frames carry inference requests and streamed responses over that process's stdin
and stdout. Every request must authenticate a scoped inference capability whose
session matches the relay. The controller gateway revalidates lease/model/provider
permissions and calls only its configured HTTPS upstream. It strips worker-supplied
cloud credentials. Losing a relay channel revokes its session capability.

This transport avoids filesystem Unix-socket mounts across Docker Desktop's VM.
It still requires a real Docker Desktop/macOS qualification run. Gateway network
mode also requires a Docker release that supports isolated internal bridges.

After a build, `node scripts/qualify-gateway.mjs /private/reviewed-image-digest.txt`
performs a synthetic, credential-free Docker proof with an existing immutable
Python-capable image. It checks streaming, no relay mounts, and denial of selected
metadata/private endpoints; it creates/removes only its own recorded resources.
A Linux proof is evidence for those tested paths, not a complete egress-security
proof or evidence of macOS support.
