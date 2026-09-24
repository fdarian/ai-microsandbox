# ai-microsandbox

_This package is **experimental**._

`HarnessV1SandboxProvider` implementation for [microsandbox](https://microsandbox.dev), a local-first microVM sandbox runtime. Use it to give an [AI SDK harness](https://ai-sdk.dev) hardware-isolated command execution and file I/O without paying for a hosted sandbox service.

## Setup

```bash
npm i ai-microsandbox microsandbox @ai-sdk/harness
```

microsandbox boots a real microVM **on the machine running your Node process** — it is not a hosted API you call over HTTPS. That machine needs hardware virtualization: KVM on Linux, Apple Silicon on macOS, or Windows Hypervisor Platform on Windows. Most CI runners, serverless functions, and containers-within-containers don't have one; run this where you control the host, or point it at [microsandbox's hosted backend](#backend) instead.

## Usage

```ts
import { createMicrosandbox } from 'ai-microsandbox';

const provider = createMicrosandbox({ image: 'alpine' });

const networkSession = await provider.createSession();
const session = networkSession.restricted();

await session.writeTextFile({ path: 'hello.txt', content: 'hi' });
const { stdout } = await session.run({ command: 'cat hello.txt' });
console.log(stdout); // "hi"

await networkSession.stop();
```

`createMicrosandbox()` is synchronous and performs no I/O; the actual microsandbox `Sandbox` — and the microVM behind it — is created on demand inside `createSession()`.

`networkSession.restricted()` returns the plain `Experimental_SandboxSession` view (file I/O, exec, spawn) that's safe to hand to AI SDK tools accepting `experimental_sandbox`. The network session itself additionally carries the infra surface the harness uses: `ports`, `getPortEndpoint`, `getPortUrl`, `stop`, `destroy`.

### Wrapping an existing sandbox

Pass an already-created `Sandbox` via `sandbox` instead of `image`/`configure` — e.g. when you need builder options this factory doesn't surface, or want to share one sandbox across multiple harness sessions. `stop()`/`destroy()` become no-ops; the caller keeps ownership.

```ts
import { createMicrosandbox } from 'ai-microsandbox';
import { Sandbox } from 'microsandbox';

const provider = createMicrosandbox({
  sandbox: await Sandbox.builder('my-sandbox').image('alpine').create(),
});
```

Sharing one wrapped sandbox across concurrent harness sessions is unmediated: every session sees the same sandbox, with no per-session port leasing (`bridgePorts`, which `@ai-sdk/sandbox-vercel` supports, is not implemented here).

### Configuring the sandbox

microsandbox's builder is fluent-only — there's no flat options object covering its ~50 setters (CPU, memory, volumes, network policy, secrets, ...). Reach for `configure` to call any of them before the sandbox is created:

```ts
import { MiB } from 'microsandbox';

const provider = createMicrosandbox({
  image: 'python',
  configure: builder => builder.cpus(2).memory(MiB(1024)).port(8080, 80),
});
```

To give the guest writable access to a host repository, bind its directory at a guest path. Leave off `.readonly()` and ensure the guest user has filesystem permissions on the host directory:

```ts
const provider = createMicrosandbox({
  image: 'python',
  configure: builder => builder.volume('/workspace/repo', mount => mount.bind('/absolute/path/to/repo')),
});
```

Some images declare no `WORKDIR` (a bare rootfs, or an OCI image without one) — microsandbox then has no default working directory at all, and `createSession()`/`resumeSession()` throw rather than guessing one. Set it explicitly:

```ts
const provider = createMicrosandbox({
  image: 'scratch',
  configure: builder => builder.workdir('/'),
});
```

## Ports

Each newly created session publishes guest TCP port **8765** to a free local host port before `configure` runs. The Claude Code, Codex, and OpenCode bridge adapters use the first exposed port by default, so they can connect without caller-side port setup. Concurrent session creations receive different host ports. An adapter configured with an explicit `port` other than 8765 needs that guest port published separately via `configure`. Wrapping an existing sandbox or resuming one uses its existing port map.

Port publishing is fixed at sandbox creation time (via `configure`'s `.port(hostPort, guestPort)` for additional ports); this adapter has no way to change it mid-session (`setPorts` is unimplemented).

`getPortEndpoint` resolves a published TCP guest port to `{ url }` (no additional headers); `getPortUrl` returns that URL for older consumers. microsandbox has no public URL or tunnel — `.port()` only forwards a host port to a guest port over the bind address the mapping was created with (`127.0.0.1` unless you passed `.portBind(...)`) — so the URL is only reachable from wherever that bind address routes to, typically the machine running your Node process:

```ts
const url = await networkSession.getPortUrl({ port: 80 }); // "http://127.0.0.1:<hostPort>"
```

Requesting a port that wasn't published — including a port only published over UDP — throws `HarnessCapabilityUnsupportedError`. **This always throws on the cloud backend**: its wire type carries no ports field at all, so published ports are structurally local-only regardless of what `configure` set.

## Backend

microsandbox runs sandboxes locally by default. Point it at microsandbox's hosted infrastructure instead with `setDefaultBackend` from the `microsandbox` package before creating a session — this adapter drives the same `Sandbox` API either way:

```ts
import { setDefaultBackend } from 'microsandbox';

setDefaultBackend({ kind: 'cloud', apiKey: process.env.MSB_API_KEY! });
```

A cloud-backend failure that looks like a 401/403 is wrapped in `HarnessSandboxAuthenticationError` from `@ai-sdk/harness`, with the underlying microsandbox error preserved as `cause`.

## Not implemented

- **Session templating (`identity` / snapshots)** — microsandbox snapshots require stop → snapshot → reboot and are local-backend-only, so there's no equivalent to baking a one-time-setup hook into a reusable template. `onFirstCreate` still runs, just against every freshly created sandbox instead of once per identity.
- **`setNetworkPolicy`, `setPorts`** — microsandbox fixes network policy and the port map at sandbox build time; set them via `configure` at creation instead.
- **`bridgePorts`** — see [Wrapping an existing sandbox](#wrapping-an-existing-sandbox).
- **Mid-flight abort of file I/O** — `sandbox.fs()`'s read/write methods take no cancellation signal, so `abortSignal` only gates the *start* of `readFile`/`readBinaryFile`/`readTextFile`/`writeBinaryFile`/`writeTextFile`; once one of those is under way, aborting doesn't interrupt it. `writeFile` is the exception — it streams the source in chunks and checks the signal between each one.
