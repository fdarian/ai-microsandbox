# ai-microsandbox

_This package is **experimental**._

`HarnessV1SandboxProvider` implementation for [microsandbox](https://microsandbox.dev), a local-first microVM sandbox runtime. Use it to give an [AI SDK harness](https://ai-sdk.dev) hardware-isolated command execution and file I/O without paying for a hosted sandbox service.

## Setup

```bash
npm i ai-microsandbox microsandbox @ai-sdk/harness
```

microsandbox boots a real microVM **on the machine running your Node process** — it is not a hosted API you call over HTTPS. That machine needs hardware virtualization: KVM on Linux, Apple Silicon on macOS, or Windows Hypervisor Platform on Windows. Most CI runners, serverless functions, and containers-within-containers don't have one. **The microsandbox cloud backend is not supported for harnesses** because it does not expose published bridge ports.

**Credentials:** Environment variables and API credentials supplied to harness agents are forwarded into the VM. This adapter does not broker credentials or implement `addRequestTransformations`; only run trusted guest code with credentials you intend to expose there.

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

`image` is required. Use `workDir` to override the image's `WORKDIR`; if neither is set, the adapter creates `/workspace` and uses it as the session working directory. The quick-start with `alpine` therefore works without an image `WORKDIR`. You can also use the fluent builder directly:

```ts
const provider = createMicrosandbox({
  image: 'alpine',
  workDir: '/workspace',
});
```

Use `setup` for guest initialization needed before the harness bootstrap (for example, enabling a package manager). It runs once for each newly created VM, before the caller's `onFirstCreate`, with a plain sandbox session and the caller's abort signal. It does not run when wrapping or resuming an existing sandbox:

```ts
const provider = createMicrosandbox({
  image: 'node:22',
  setup: async (session, opts) => {
    const result = await session.run({ command: 'corepack enable --install-directory ~/.local/bin', abortSignal: opts.abortSignal });
    if (result.exitCode !== 0) throw new Error(result.stderr);
  },
});
```

## Ports

Each newly created session publishes guest TCP port **8765** (or `bridgePort`) to an auto-picked local host port (or the explicit `hostPort`) before `configure` runs. The Claude Code, Codex, and OpenCode bridge adapters use the first exposed port by default. An adapter configured with an explicit `port` must use the same `bridgePort`. Wrapping or resuming a sandbox uses its existing port map.

An auto-picked host port can rarely be taken by another process before microsandbox binds it; that surfaces as a bridge connection failure.

Port publishing is fixed at sandbox creation time (via `configure`'s `.port(hostPort, guestPort)` for additional ports); this adapter has no way to change it mid-session (`setPorts` is unimplemented).

`getPortEndpoint` resolves a published TCP guest port to `{ url }` (no additional headers); `getPortUrl` returns that URL for older consumers. microsandbox has no public URL or tunnel — `.port()` only forwards a host port to a guest port over the bind address the mapping was created with (`127.0.0.1` unless you passed `.portBind(...)`) — so the URL is only reachable from wherever that bind address routes to, typically the machine running your Node process:

```ts
const url = await networkSession.getPortUrl({ port: 80 }); // "http://127.0.0.1:<hostPort>"
```

Only TCP ports appear in `ports`. Requesting a port that wasn't published — including a UDP-only port — throws `HarnessCapabilityUnsupportedError`. Wildcard binds (`0.0.0.0` / `::`) resolve to loopback URLs; IPv6 addresses are bracketed. URLs default to `http` (or the requested `ws`/`https`); requesting `https` changes the URL scheme only and does **not** configure TLS in the guest. **Cloud has no published ports**, so bridge endpoints cannot be resolved there.

## Backend

microsandbox runs sandboxes locally by default. Its cloud backend is **not supported for harnesses**: the cloud wire format does not report published ports, so a bridge cannot connect. Use the local backend on a virtualization-capable host.

Cloud authentication failures are mapped to `HarnessSandboxAuthenticationError`, but this does not make cloud harness sessions functional.

## Guest recipes

- **Claude Code:** run the agent as a non-root user; Claude Code refuses root. For example, build an image with a writable work directory and switch to the `node` user before starting the sandbox:

  ```dockerfile
  FROM node:22-alpine
  RUN mkdir -p /workspace && chown node:node /workspace
  USER node
  WORKDIR /workspace
  ```

  Pass the built image as `image`; these are guest-image choices, not adapter defaults.
- **pnpm:** in a Node image, run `corepack enable --install-directory ~/.local/bin` during `setup` and ensure `~/.local/bin` is on the guest `PATH`.
- **OpenCode:** allocate at least 2 GiB of guest memory with `configure: builder => builder.memory(MiB(2048))` (import `MiB` from `microsandbox`).
- **Bun-compiled binaries:** microsandbox's native loader may need `NAPI_RS_NATIVE_LIBRARY_PATH` pointing to its `.node` addon, while `setRuntimeMsbPath` from `microsandbox/native` controls the separate `msb` executable. This packaging path issue should be fixed upstream in microsandbox; the two settings are not interchangeable.

## Not implemented

- **Session templating (`identity` / snapshots)** — microsandbox snapshots require stop → snapshot → reboot and are local-backend-only, so there's no equivalent to baking a one-time-setup hook into a reusable template. `onFirstCreate` still runs, just against every freshly created sandbox instead of once per identity.
- **`setNetworkPolicy`, `setPorts`** — microsandbox fixes network policy and the port map at sandbox build time; set them via `configure` at creation instead.
- **`bridgePorts`** — see [Wrapping an existing sandbox](#wrapping-an-existing-sandbox).
- **Mid-flight abort of file I/O** — `sandbox.fs()`'s read/write methods take no cancellation signal, so `abortSignal` only gates the *start* of `readFile`/`readBinaryFile`/`readTextFile`/`writeBinaryFile`/`writeTextFile`; once one of those is under way, aborting doesn't interrupt it. `writeFile` is the exception — it streams the source in chunks and checks the signal between each one.
