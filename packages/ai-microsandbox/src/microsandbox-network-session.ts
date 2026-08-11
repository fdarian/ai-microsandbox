import {
	HarnessCapabilityUnsupportedError,
	type HarnessV1NetworkSandboxSession,
} from '@ai-sdk/harness';
import type { Experimental_SandboxSession as SandboxSession } from '@ai-sdk/provider-utils';
import { Sandbox } from 'microsandbox';
import { MicrosandboxSession } from './microsandbox-session';

const PROVIDER_ID = 'microsandbox';

/**
 * Runtime shape read back from `Sandbox.config()`. The installed microsandbox
 * types declare `SandboxConfig` as a bare `Record<string, unknown>` (see
 * `NapiSandboxConfig` in `internal/napi.d.ts`) — there is no typed response
 * schema for the live config readback. This shape is inferred from the
 * builder/modify setter names (`workdir`) and the `NetworkConfig`/
 * `PublishedPort` types (`network.ports[].{hostPort,guestPort}`) that the
 * same camelCase-remapping convention produces elsewhere in the SDK, not
 * from a documented return type. Treat it as best-effort.
 */
type MicrosandboxRuntimeConfig = {
	workdir?: string;
	network?: {
		ports?: ReadonlyArray<{
			hostPort: number;
			guestPort: number;
			protocol: 'tcp' | 'udp';
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
	private readonly hostPortByGuestPort: ReadonlyMap<number, number>;

	private constructor(input: {
		sandbox: Sandbox;
		ownsLifecycle: boolean;
		config: MicrosandboxRuntimeConfig;
	}) {
		super(input.sandbox);
		this.ownsLifecycle = input.ownsLifecycle;
		this.id = input.sandbox.name;

		const workdir = input.config.workdir;
		if (typeof workdir !== 'string' || workdir.length === 0) {
			throw new Error(
				`Could not determine the default working directory for microsandbox sandbox "${input.sandbox.name}": Sandbox.config() did not expose a "workdir" field. This is required by the harness sandbox contract and cannot be safely defaulted.`,
			);
		}
		this.defaultWorkingDirectory = workdir;

		const publishedPorts = input.config.network?.ports ?? [];
		this.ports = publishedPorts.map((port) => port.guestPort);
		this.hostPortByGuestPort = new Map(
			publishedPorts.map((port) => [port.guestPort, port.hostPort]),
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
	 * Resolves a sandbox-exposed port to a URL.
	 *
	 * microsandbox has no public URL or tunneling concept: `.port(hostPort,
	 * guestPort)` on the builder only creates a host<->guest TCP forward bound
	 * to `127.0.0.1` by default. This method resolves the guest port's mapped
	 * host port and returns `<protocol>://127.0.0.1:<hostPort>` — the result is
	 * only reachable from the machine running this Node process, never a public
	 * URL.
	 */
	getPortUrl = async (options: {
		port: number;
		protocol?: 'http' | 'https' | 'ws';
	}): Promise<string> => {
		const hostPort = this.hostPortByGuestPort.get(options.port);
		if (hostPort == null) {
			throw new HarnessCapabilityUnsupportedError({
				harnessId: PROVIDER_ID,
				message: `Port ${options.port} is not exposed on this sandbox. Exposed ports: [${this.ports.join(', ')}].`,
			});
		}
		const protocol = options.protocol ?? 'http';
		return `${protocol}://127.0.0.1:${hostPort}`;
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
