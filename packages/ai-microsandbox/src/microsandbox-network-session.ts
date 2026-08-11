import {
	HarnessCapabilityUnsupportedError,
	type HarnessV1NetworkSandboxSession,
} from '@ai-sdk/harness';
import type { Experimental_SandboxSession as SandboxSession } from '@ai-sdk/provider-utils';
import { defaultBackendKind, Sandbox } from 'microsandbox';
import { MicrosandboxSession } from './microsandbox-session';

const PROVIDER_ID = 'microsandbox';

/**
 * Runtime shape read back from `Sandbox.config()`. The installed microsandbox
 * types declare `SandboxConfig` as a bare `Record<string, unknown>` — there is
 * no typed accessor (`SandboxBuilder.build()` returns the same alias, and the
 * package ships no generated bindings for it), so this interface plus the
 * single cast in `create()` below is the correct approach rather than typing
 * this properly.
 *
 * This mirrors the actual snake_case-to-camelCase-remapped JSON the native
 * side emits: the working directory lives at `runtime.workdir` (not a
 * top-level `workdir` key), and published ports live at `network.ports[]`.
 * `runtime.workdir` is `string | null` — `null` when the sandbox's image
 * declares no `WORKDIR` (or a bare rootfs was used), not a missing-field
 * error. The cloud backend's wire type carries no ports field at all, so
 * `network.ports` is always `[]` there regardless of what was configured.
 */
type MicrosandboxRuntimeConfig = {
	runtime?: { workdir?: string | null };
	network?: {
		ports?: ReadonlyArray<{
			hostPort: number;
			guestPort: number;
			protocol: 'tcp' | 'udp';
			hostBind: string;
		}>;
	};
};

/**
 * `HarnessV1NetworkSandboxSession` backed by a `microsandbox` `Sandbox`. The
 * provider's `createSession()`/`resumeSession()` return one of these. It
 * extends {@link MicrosandboxSession} with the infra surface (ports,
 * lifecycle). It owns the sandbox's lifecycle only when the provider created
 * it; when the provider was given an existing sandbox (or merely connected to
 * one via `resumeSession`), `stop()` and `destroy()` are no-ops (the caller,
 * or the original creator, retains ownership).
 */
export class MicrosandboxNetworkSession
	extends MicrosandboxSession
	implements HarnessV1NetworkSandboxSession
{
	readonly id: string;
	readonly defaultWorkingDirectory: string;
	readonly ports: ReadonlyArray<number>;
	private readonly ownsLifecycle: boolean;
	private readonly tcpPortByGuestPort: ReadonlyMap<
		number,
		{ hostPort: number; hostBind: string }
	>;

	private constructor(input: {
		sandbox: Sandbox;
		ownsLifecycle: boolean;
		config: MicrosandboxRuntimeConfig;
	}) {
		super(input.sandbox);
		this.ownsLifecycle = input.ownsLifecycle;
		this.id = input.sandbox.name;

		const workdir = input.config.runtime?.workdir;
		if (workdir == null) {
			throw new Error(
				`microsandbox sandbox "${input.sandbox.name}" has no working directory configured — its image declares no WORKDIR (or a bare rootfs was used). Set one explicitly via configure: builder => builder.workdir('/some/path') when creating the sandbox; the harness sandbox contract requires a concrete defaultWorkingDirectory.`,
			);
		}
		this.defaultWorkingDirectory = workdir;

		const publishedPorts = input.config.network?.ports ?? [];
		this.ports = [...new Set(publishedPorts.map((port) => port.guestPort))];
		// getPortUrl only resolves TCP forwards; a UDP-only guest port is not a
		// URL-addressable resource, so it's excluded from this map (but still
		// shows up in `ports`, which just reflects what's published).
		this.tcpPortByGuestPort = new Map(
			publishedPorts
				.filter((port) => port.protocol === 'tcp')
				.map((port) => [
					port.guestPort,
					{ hostPort: port.hostPort, hostBind: port.hostBind },
				]),
		);
	}

	/**
	 * Wraps a live `Sandbox`, reading back its resolved working directory and
	 * port map from `Sandbox.config()`. Async because that readback is async on
	 * microsandbox (unlike e.g. `@vercel/sandbox`, which exposes it via a sync
	 * getter) — callers await this instead of using `new`.
	 */
	static async create(input: {
		sandbox: Sandbox;
		ownsLifecycle: boolean;
	}): Promise<MicrosandboxNetworkSession> {
		const config = (await input.sandbox.config()) as MicrosandboxRuntimeConfig;
		return new MicrosandboxNetworkSession({ ...input, config });
	}

	restricted(): SandboxSession {
		return new MicrosandboxSession(this.sandbox);
	}

	/**
	 * Resolves a sandbox-exposed TCP port to a URL.
	 *
	 * microsandbox has no public URL or tunneling concept: `.port(hostPort,
	 * guestPort)` on the builder only creates a host<->guest forward, bound to
	 * that port's `hostBind` (`127.0.0.1` unless the sandbox was configured
	 * with `.portBind(...)`/`.portUdpBind(...)`). This method resolves the
	 * guest port's mapping and returns `<protocol>://<hostBind>:<hostPort>` —
	 * reachable only from wherever that bind address routes to, never a public
	 * URL. A UDP-only guest port is treated as unmapped, since it isn't
	 * URL-addressable. On the cloud backend `network.ports` is always empty (its
	 * wire type has no ports field), so this always throws there.
	 */
	getPortUrl = async (options: {
		port: number;
		protocol?: 'http' | 'https' | 'ws';
	}): Promise<string> => {
		const mapped = this.tcpPortByGuestPort.get(options.port);
		if (mapped == null) {
			throw new HarnessCapabilityUnsupportedError({
				harnessId: PROVIDER_ID,
				message: buildUnmappedPortMessage({
					port: options.port,
					exposedPorts: this.ports,
				}),
			});
		}
		const protocol = options.protocol ?? 'http';
		return `${protocol}://${mapped.hostBind}:${mapped.hostPort}`;
	};

	stop = async (): Promise<void> => {
		if (!this.ownsLifecycle) return;
		await this.sandbox.stop();
	};

	destroy = async (): Promise<void> => {
		if (!this.ownsLifecycle) return;
		await this.sandbox.stop().catch(() => {});
		await Sandbox.remove(this.sandbox.name);
	};
}

function buildUnmappedPortMessage(input: {
	port: number;
	exposedPorts: ReadonlyArray<number>;
}): string {
	const base = `Port ${input.port} is not exposed on this sandbox. Exposed ports: [${input.exposedPorts.join(', ')}].`;
	// `defaultBackendKind()` reflects the process-wide active backend, which may
	// have changed since this sandbox was created (there's no per-instance
	// accessor in the installed types) — best-effort context, not a guarantee
	// about this specific sandbox's backend.
	if (defaultBackendKind() === 'cloud') {
		return `${base} The active default backend is "cloud" — microsandbox cloud sandboxes never report published ports (network.ports is always empty there), so getPortUrl cannot succeed against one.`;
	}
	return base;
}
