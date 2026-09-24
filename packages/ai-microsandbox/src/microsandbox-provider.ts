import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import {
	HarnessSandboxAuthenticationError,
	type HarnessV1NetworkSandboxSession,
	type HarnessV1SandboxProvider,
} from '@ai-sdk/harness';
import type { Experimental_SandboxSession as SandboxSession } from '@ai-sdk/provider-utils';
import {
	CloudHttpError,
	HttpError,
	Sandbox,
	type SandboxBuilder,
} from 'microsandbox';
import { MicrosandboxNetworkSession } from './microsandbox-network-session';
import { MicrosandboxSession } from './microsandbox-session';

const PROVIDER_ID = 'microsandbox';
const SESSION_NAME_PREFIX = 'ai-sdk-harness-session-';
const DEFAULT_NAME_PREFIX = 'ai-sdk-harness';
/** microsandbox caps sandbox names at 128 UTF-8 bytes (see `Sandbox.builder`'s doc comment). */
const MAX_NAME_BYTES = 128;
const BRIDGE_GUEST_PORT = 8765;
const pendingHostPorts = new Set<number>();

/**
 * Settings for {@link createMicrosandbox}. Two mutually-exclusive shapes:
 *
 * - `{ sandbox }` — wrap an already-created `microsandbox` `Sandbox`. The
 *   caller owns its lifecycle; the provider's `stop()` and `destroy()` are
 *   no-ops.
 * - `{ image?, namePrefix?, configure?, setup? }` — provider creates a fresh sandbox
 *   per session. `setup` runs against each new VM before the harness's
 *   `onFirstCreate` bootstrap; `configure` customizes the fluent builder.
 */
export type MicrosandboxSettings =
	| { sandbox: Sandbox }
	| {
			sandbox?: never;
			image?: string;
			namePrefix?: string;
			configure?: (builder: SandboxBuilder) => SandboxBuilder;
			setup?: (
				session: SandboxSession,
				opts: { abortSignal?: AbortSignal },
			) => Promise<void>;
	  };

type CreateNewSettings = Extract<MicrosandboxSettings, { sandbox?: never }>;

export function createMicrosandbox(
	settings: MicrosandboxSettings = {} as MicrosandboxSettings,
): MicrosandboxProvider {
	return new MicrosandboxProvider(settings);
}

/**
 * `HarnessV1SandboxProvider` implementation backed by `microsandbox`.
 * Construct one via {@link createMicrosandbox} at module scope and pass it to
 * a `HarnessAgent` (or call `createSession()` directly for raw access to a
 * network sandbox session).
 */
export class MicrosandboxProvider implements HarnessV1SandboxProvider {
	readonly specificationVersion = 'harness-sandbox-v1' as const;
	readonly providerId = PROVIDER_ID;

	constructor(private readonly settings: MicrosandboxSettings) {}

	createSession = async (options?: {
		sessionId?: string;
		abortSignal?: AbortSignal;
		identity?: string;
		onFirstCreate?: (
			session: SandboxSession,
			opts: { abortSignal?: AbortSignal },
		) => Promise<void>;
	}): Promise<HarnessV1NetworkSandboxSession> => {
		options?.abortSignal?.throwIfAborted();

		if ('sandbox' in this.settings && this.settings.sandbox != null) {
			return MicrosandboxNetworkSession.create({
				sandbox: this.settings.sandbox,
				ownsLifecycle: false,
			});
		}

		const settings = this.settings as CreateNewSettings;
		const name = options?.sessionId
			? sessionSandboxName(options.sessionId)
			: randomSandboxName(settings.namePrefix);

		const hostPort = await allocateHostPort();
		const sandbox = await (async () => {
			try {
				return await withAuthenticationError(async () => {
					let builder = Sandbox.builder(name).port(hostPort, BRIDGE_GUEST_PORT);
					if (settings.image != null) builder = builder.image(settings.image);
					if (settings.configure != null) builder = settings.configure(builder);
					return builder.create();
				});
			} finally {
				pendingHostPorts.delete(hostPort);
			}
		})();

		// microsandbox has no snapshot-based one-time-setup hook that would let
		// `onFirstCreate`'s side effects be baked into a reusable template:
		// snapshots require stop -> snapshot -> reboot and are local-backend-only,
		// and `identity` has no persistence story on this provider. Setup and
		// `onFirstCreate` therefore run against every freshly created sandbox.
		if (settings.setup != null || options?.onFirstCreate != null) {
			const session = new MicrosandboxSession(sandbox);
			const opts = { abortSignal: options?.abortSignal };
			await settings.setup?.(session, opts);
			await options?.onFirstCreate?.(session, opts);
		}

		return MicrosandboxNetworkSession.create({ sandbox, ownsLifecycle: true });
	};

	resumeSession = async (options: {
		sessionId: string;
		abortSignal?: AbortSignal;
	}): Promise<HarnessV1NetworkSandboxSession> => {
		options.abortSignal?.throwIfAborted();

		if ('sandbox' in this.settings && this.settings.sandbox != null) {
			return MicrosandboxNetworkSession.create({
				sandbox: this.settings.sandbox,
				ownsLifecycle: false,
			});
		}

		const name = sessionSandboxName(options.sessionId);
		const handle = await withAuthenticationError(() => Sandbox.get(name));
		// `connect()` deliberately does not take lifecycle ownership — the
		// process that originally created the sandbox remains its owner.
		const sandbox = await withAuthenticationError(() => handle.connect());
		return MicrosandboxNetworkSession.create({ sandbox, ownsLifecycle: false });
	};
}

async function allocateHostPort(): Promise<number> {
	for (;;) {
		const server = createServer();
		const port = await new Promise<number>((resolve, reject) => {
			server.once('error', reject);
			server.listen(0, '127.0.0.1', () => {
				const address = server.address();
				if (address == null || typeof address === 'string') {
					reject(
						new Error(
							'Failed to allocate a TCP host port for the harness bridge.',
						),
					);
					return;
				}
				resolve(address.port);
			});
		});
		await new Promise<void>((resolve, reject) => {
			server.close((error) => (error == null ? resolve() : reject(error)));
		});
		if (pendingHostPorts.has(port)) continue;
		pendingHostPorts.add(port);
		return port;
	}
}

function sessionSandboxName(sessionId: string): string {
	return assertNameByteLength(`${SESSION_NAME_PREFIX}${sessionId}`);
}

function randomSandboxName(namePrefix: string | undefined): string {
	return assertNameByteLength(
		`${namePrefix ?? DEFAULT_NAME_PREFIX}-${randomUUID()}`,
	);
}

function assertNameByteLength(name: string): string {
	const byteLength = Buffer.byteLength(name, 'utf-8');
	if (byteLength > MAX_NAME_BYTES) {
		throw new Error(
			`microsandbox sandbox name "${name}" is ${byteLength} UTF-8 bytes, exceeding the ${MAX_NAME_BYTES}-byte limit microsandbox enforces on sandbox names. Use a shorter sessionId or namePrefix.`,
		);
	}
	return name;
}

const AUTHENTICATION_MESSAGE =
	'microsandbox cloud backend authentication failed. Verify the API key passed to setDefaultBackend({ kind: "cloud", apiKey }) (or the referenced profile) is set and valid.';

async function withAuthenticationError<T>(
	operation: () => Promise<T>,
): Promise<T> {
	try {
		return await operation();
	} catch (error) {
		if (!isAuthenticationFailure(error)) throw error;
		throw new HarnessSandboxAuthenticationError({
			message: AUTHENTICATION_MESSAGE,
			sandboxProviderId: PROVIDER_ID,
			cause: error,
		});
	}
}

// Neither `HttpError` nor `CloudHttpError` in the installed microsandbox
// types exposes a `.status`/`.statusCode` field (see `errors.d.ts`) — both
// carry only a constant `.code` and a free-text Rust `.message`. There is no
// typed way to distinguish a 401/403 from any other HTTP failure; this is a
// best-effort message-pattern match scoped to those two specific classes.
const AUTH_FAILURE_MESSAGE =
	/\b40[13]\b|unauthoriz|forbidden|invalid api key|missing api key/i;

function isAuthenticationFailure(error: unknown): boolean {
	if (!(error instanceof CloudHttpError) && !(error instanceof HttpError))
		return false;
	return AUTH_FAILURE_MESSAGE.test(error.message);
}
