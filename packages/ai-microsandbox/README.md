# ai-microsandbox

Run AI SDK harness sessions in local [microsandbox](https://microsandbox.dev) microVMs. The provider gives a harness file and process access plus a host-forwarded port for its in-VM bridge; you supply the guest image and agent setup.

The machine running your app must be able to start microsandbox VMs. **The cloud backend cannot host a harness session:** it does not report published ports, so the bridge has no reachable endpoint.

## Install

After the first npm release, install the package and its peers:

```sh
npm install ai-microsandbox microsandbox @ai-sdk/harness
```

The supported peer ranges are microsandbox `~0.6.18` and `@ai-sdk/harness` `^1.0.123`. This package is experimental.

## Run a session

```ts
import { createMicrosandbox } from 'ai-microsandbox';

const provider = createMicrosandbox({ image: 'alpine' });
const networkSession = await provider.createSession();

try {
  const session = networkSession.restricted();
  await session.writeTextFile({ path: 'hello.txt', content: 'hi' });
  const result = await session.run({ command: 'cat hello.txt' });
  console.log(result.stdout); // hi
} finally {
  await networkSession.destroy();
}
```

`restricted()` exposes file I/O and processes to tools accepting an AI SDK sandbox session. The network session also provides `ports`, `getPortEndpoint`, `stop` and `destroy`. A provider-created session owns its VM: `stop()` leaves it available for `resumeSession({ sessionId })`; `destroy()` stops and removes it. To resume, supply a `sessionId` when creating the session. On resume the session reads the VM's saved workdir and port mappings; a provider `workDir` override is not reapplied.

**Credentials enter the VM.** If you pass agent credentials through its environment or files, guest processes can read them. This adapter does not broker credentials or implement `addRequestTransformations`; do not treat the VM as a place to hide keys from code running inside it.

## Configure the guest

`image` is required for new VMs. `workDir` sets the session's command directory and resolves relative file paths there. The adapter creates an explicit `workDir` after boot; otherwise it uses the directory reported by the image. If none is reported, it creates and uses `/workspace`.

Use `setup` to initialize each new VM before the harness's `onFirstCreate` callback. It does not run on resume. `configure` receives the microsandbox builder for settings such as memory or volumes; the provider publishes the bridge port before calling it.

<details>
<summary>Guest setup recipes</summary>

- **Claude Code:** it refuses to run as root. Use an image with a non-root user and a writable work directory (for example, a `node:22-alpine` derivative with `/workspace` owned by `node`, `USER node`, and `WORKDIR /workspace`).
- **pnpm:** in a Node image, create `~/.local/bin`, add it to the guest's `PATH`, then run `corepack enable --install-directory ~/.local/bin` during `setup`. Check the command's exit code; `session.run()` does not throw on a nonzero exit.
- **OpenCode:** allocate 2 GiB with `configure: builder => builder.memory(MiB(2048))`, importing `MiB` from `microsandbox`.
- **Bun-compiled host binaries:** microsandbox's `NAPI_RS_NATIVE_LIBRARY_PATH` selects the native `.node` addon; `setRuntimeMsbPath` from `microsandbox/native` selects the separate `msb` executable. Set the appropriate path before loading the SDK. This packaging issue belongs upstream in microsandbox, not in the guest image.

</details>

<details>
<summary>Wrap a VM you already own</summary>

Pass `{ sandbox }` instead of `{ image }` to wrap an existing live microsandbox `Sandbox`. The adapter's `stop()` and `destroy()` then do nothing; you retain responsibility for its lifecycle. Its existing workdir and port mappings are used. Concurrent sessions wrapping the same VM share its filesystem and ports without per-session leasing.

</details>

## Bridge ports

New sessions publish guest TCP port `8765` to an auto-picked host port. Set `bridgePort` if your harness bridge listens on another guest port, or `hostPort` if you need a specific host port. Additional mappings can be added with `configure`; publishing cannot be changed after creation. Only TCP guest ports appear in `ports`.

`getPortEndpoint({ port: 8765, protocol: 'ws' })` resolves the host-forwarded WebSocket URL. The default scheme is `http`; requesting `https` only changes the URL scheme, **not** whether the guest serves TLS. These URLs are host-reachable forwards, not public tunnels. Wildcard binds resolve to loopback and IPv6 hosts are bracketed. A port that is not published (or is UDP-only) throws `HarnessCapabilityUnsupportedError`.

An auto-picked host port can rarely be taken by another process between the probe and microsandbox's bind. microsandbox 0.6.18 does not report that bind failure to creation; expect a bridge connection failure rather than an automatic retry.

## Limits

- `identity` does not provide reusable VM templates: `onFirstCreate` runs on every new VM, not on resume.
- `setPorts`, `setNetworkPolicy` and `bridgePorts` are not implemented. Configure the first two on the microsandbox builder before creation; wrapping a VM does not lease bridge ports.
- File I/O cannot be interrupted once a microsandbox read or write has started. `writeFile` checks abort between streamed chunks; the other file methods only check before starting.

## License

[MIT](LICENSE)
