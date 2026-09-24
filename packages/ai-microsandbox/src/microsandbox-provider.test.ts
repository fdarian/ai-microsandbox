import { afterEach, describe, expect, it, mock } from 'bun:test';
import type { Sandbox as SandboxType } from 'microsandbox';
import * as realMicrosandbox from 'microsandbox';

function makeFakeSandbox(name: string) {
	return {
		name,
		config: mock(async () => ({
			runtime: { workdir: '/root' },
			network: { ports: [] },
		})),
		stop: mock(async () => {}),
		exec: mock(async () => ({})),
		fs: mock(() => ({})),
	} as unknown as SandboxType;
}

function makeFakeBuilder(sandbox: SandboxType) {
	const port = mock(function (this: unknown, _host: number, _guest: number) {
		return this;
	});
	const image = mock(function (this: unknown) {
		return this;
	});
	const create = mock(async () => sandbox);
	return { builder: { port, image, create }, spies: { port, image, create } };
}

/** Re-mocks the `microsandbox` module's `Sandbox` static, keeping every other
 * real export (error classes, etc.) intact for `instanceof` checks. */
function mockSandboxStatics(overrides: {
	builder?: ReturnType<typeof mock>;
	get?: ReturnType<typeof mock>;
	remove?: ReturnType<typeof mock>;
}) {
	mock.module('microsandbox', () => ({
		...realMicrosandbox,
		Sandbox: {
			...realMicrosandbox.Sandbox,
			builder: overrides.builder ?? realMicrosandbox.Sandbox.builder,
			get: overrides.get ?? realMicrosandbox.Sandbox.get,
			remove: overrides.remove ?? realMicrosandbox.Sandbox.remove,
		},
	}));
}

async function importProvider() {
	return import('./microsandbox-provider');
}

describe('MicrosandboxProvider', () => {
	afterEach(() => {
		mock.restore();
	});

	describe('createSession — wrap-existing', () => {
		it('wraps the given sandbox without calling Sandbox.builder', async () => {
			const builderSpy = mock(() => {
				throw new Error(
					'Sandbox.builder should not be called when wrapping an existing sandbox',
				);
			});
			mockSandboxStatics({ builder: builderSpy });
			const { createMicrosandbox } = await importProvider();

			const sandbox = makeFakeSandbox('caller-owned');
			const provider = createMicrosandbox({ sandbox });
			const session = await provider.createSession();

			expect(session.id).toBe('caller-owned');
			expect(builderSpy).not.toHaveBeenCalled();
		});
	});

	describe('createSession — create-new', () => {
		it('derives a deterministic name from sessionId and applies image/configure', async () => {
			const sandbox = makeFakeSandbox('ai-sdk-harness-session-abc123');
			const { builder, spies } = makeFakeBuilder(sandbox);
			const builderSpy = mock((_name: string) => builder);
			mockSandboxStatics({ builder: builderSpy });
			const { createMicrosandbox } = await importProvider();

			const configure = mock((b: typeof builder) => b);
			const provider = createMicrosandbox({
				image: 'my-image:latest',
				configure: configure as unknown as (
					builder: import('microsandbox').SandboxBuilder,
				) => import('microsandbox').SandboxBuilder,
			});
			const session = await provider.createSession({ sessionId: 'abc123' });

			expect(builderSpy).toHaveBeenCalledWith('ai-sdk-harness-session-abc123');
			expect(spies.image).toHaveBeenCalledWith('my-image:latest');
			expect(spies.port.mock.calls[0]?.[1]).toBe(8765);
			expect(spies.port.mock.calls[0]?.[0]).toBeGreaterThan(0);
			expect(configure).toHaveBeenCalledWith(builder);
			expect(spies.port.mock.invocationCallOrder[0]).toBeLessThan(
				configure.mock.invocationCallOrder[0] as number,
			);
			expect(session.id).toBe('ai-sdk-harness-session-abc123');
		});

		it('allocates distinct host ports for overlapping session creations', async () => {
			const sandbox = makeFakeSandbox('concurrent');
			const ports: number[] = [];
			const builderSpy = mock(() => ({
				port: mock(function (this: unknown, host: number, guest: number) {
					expect(guest).toBe(8765);
					ports.push(host);
					return this;
				}),
				create: mock(async () => {
					await new Promise((resolve) => setTimeout(resolve, 20));
					return sandbox;
				}),
			}));
			mockSandboxStatics({ builder: builderSpy });
			const { createMicrosandbox } = await importProvider();
			const provider = createMicrosandbox({});
			await Promise.all([provider.createSession(), provider.createSession()]);
			expect(ports).toHaveLength(2);
			expect(new Set(ports).size).toBe(2);
		});

		it('exposes the published bridge port as the first session endpoint', async () => {
			const sandbox = makeFakeSandbox('bridge');
			const builder = makeFakeBuilder(sandbox);
			const config = sandbox.config as ReturnType<typeof mock>;
			config.mockImplementation(async () => ({
				runtime: { workdir: '/root' },
				network: {
					ports: [
						{
							hostPort: builder.spies.port.mock.calls[0]?.[0],
							guestPort: 8765,
							protocol: 'tcp',
							hostBind: '127.0.0.1',
						},
					],
				},
			}));
			mockSandboxStatics({ builder: mock(() => builder.builder) });
			const { createMicrosandbox } = await importProvider();
			const session = await createMicrosandbox({}).createSession();
			expect(session.ports[0]).toBe(8765);
			expect(
				await session.getPortEndpoint({
					port: session.ports[0] as number,
					protocol: 'ws',
				}),
			).toEqual({
				url: `ws://127.0.0.1:${builder.spies.port.mock.calls[0]?.[0]}`,
			});
		});

		it('uses a random namePrefix-based name when no sessionId is given', async () => {
			const sandbox = makeFakeSandbox('random-name');
			const { builder } = makeFakeBuilder(sandbox);
			const builderSpy = mock((_name: string) => builder);
			mockSandboxStatics({ builder: builderSpy });
			const { createMicrosandbox } = await importProvider();

			const provider = createMicrosandbox({ namePrefix: 'my-prefix' });
			await provider.createSession();

			const [name] = builderSpy.mock.calls[0] as [string];
			expect(name.startsWith('my-prefix-')).toBe(true);
		});

		it('rejects a sessionId that would exceed the 128-byte sandbox name limit', async () => {
			mockSandboxStatics({});
			const { createMicrosandbox } = await importProvider();
			const provider = createMicrosandbox({});
			await expect(
				provider.createSession({ sessionId: 'x'.repeat(200) }),
			).rejects.toThrow(/128-byte limit/);
		});

		it('invokes onFirstCreate with a plain (non-network) session before returning', async () => {
			const sandbox = makeFakeSandbox('ai-sdk-harness-session-first');
			const { builder } = makeFakeBuilder(sandbox);
			mockSandboxStatics({ builder: mock(() => builder) });
			const { createMicrosandbox, MicrosandboxProvider: _P } =
				await importProvider();
			const { MicrosandboxNetworkSession } = await import(
				'./microsandbox-network-session'
			);

			const onFirstCreate = mock(async (session: unknown) => {
				expect(session).not.toBeInstanceOf(MicrosandboxNetworkSession);
			});
			const provider = createMicrosandbox({});
			await provider.createSession({ sessionId: 'first', onFirstCreate });

			expect(onFirstCreate).toHaveBeenCalledTimes(1);
		});
	});

	describe('resumeSession', () => {
		it('wraps the given sandbox without calling Sandbox.get for wrap-existing settings', async () => {
			const getSpy = mock(() => {
				throw new Error(
					'Sandbox.get should not be called when wrapping an existing sandbox',
				);
			});
			mockSandboxStatics({ get: getSpy });
			const { createMicrosandbox } = await importProvider();

			const sandbox = makeFakeSandbox('caller-owned');
			const provider = createMicrosandbox({ sandbox });
			const session = await provider.resumeSession({ sessionId: 'anything' });

			expect(session.id).toBe('caller-owned');
			expect(getSpy).not.toHaveBeenCalled();
		});

		it('looks up by deterministic name then connects without taking ownership', async () => {
			const sandbox = makeFakeSandbox('ai-sdk-harness-session-resumed');
			const connect = mock(async () => sandbox);
			const getSpy = mock(async (_name: string) => ({ connect }));
			mockSandboxStatics({ get: getSpy });
			const { createMicrosandbox } = await importProvider();

			const provider = createMicrosandbox({});
			const session = await provider.resumeSession({ sessionId: 'resumed' });

			expect(getSpy).toHaveBeenCalledWith('ai-sdk-harness-session-resumed');
			expect(connect).toHaveBeenCalledTimes(1);
			expect(session.id).toBe('ai-sdk-harness-session-resumed');

			// ownsLifecycle: false per connect()'s contract — stop() must be a no-op.
			await session.stop();
			expect(sandbox.stop).not.toHaveBeenCalled();
		});

		it('wraps an auth-shaped failure from Sandbox.get into HarnessSandboxAuthenticationError', async () => {
			const { HttpError } = realMicrosandbox;
			const getSpy = mock(async (_name: string) => {
				throw new HttpError('request failed: 401 Unauthorized');
			});
			mockSandboxStatics({ get: getSpy });
			const { createMicrosandbox } = await importProvider();
			const { HarnessSandboxAuthenticationError } = await import(
				'@ai-sdk/harness'
			);

			const provider = createMicrosandbox({});
			await expect(
				provider.resumeSession({ sessionId: 'get-auth-fail' }),
			).rejects.toBeInstanceOf(HarnessSandboxAuthenticationError);
		});

		it('wraps an auth-shaped failure from handle.connect() into HarnessSandboxAuthenticationError', async () => {
			const { HttpError } = realMicrosandbox;
			const connect = mock(async () => {
				throw new HttpError('request failed: 403 Forbidden');
			});
			const getSpy = mock(async (_name: string) => ({ connect }));
			mockSandboxStatics({ get: getSpy });
			const { createMicrosandbox } = await importProvider();
			const { HarnessSandboxAuthenticationError } = await import(
				'@ai-sdk/harness'
			);

			const provider = createMicrosandbox({});
			await expect(
				provider.resumeSession({ sessionId: 'connect-auth-fail' }),
			).rejects.toBeInstanceOf(HarnessSandboxAuthenticationError);
			expect(connect).toHaveBeenCalledTimes(1);
		});
	});

	describe('authentication error mapping', () => {
		it('wraps an HttpError with a 401/403-shaped message into HarnessSandboxAuthenticationError', async () => {
			const { HttpError } = realMicrosandbox;
			const create = mock(async () => {
				throw new HttpError('request failed: 401 Unauthorized');
			});
			const builderSpy = mock(() => ({
				port: mock(function (this: unknown) {
					return this;
				}),
				image: mock(function (this: unknown) {
					return this;
				}),
				create,
			}));
			mockSandboxStatics({ builder: builderSpy });
			const { createMicrosandbox } = await importProvider();
			const { HarnessSandboxAuthenticationError } = await import(
				'@ai-sdk/harness'
			);

			const provider = createMicrosandbox({});
			await expect(
				provider.createSession({ sessionId: 'auth-fail' }),
			).rejects.toBeInstanceOf(HarnessSandboxAuthenticationError);
		});

		it('does not wrap an HttpError without an auth-shaped message', async () => {
			const { HttpError } = realMicrosandbox;
			const create = mock(async () => {
				throw new HttpError('internal server error');
			});
			const builderSpy = mock(() => ({
				port: mock(function (this: unknown) {
					return this;
				}),
				image: mock(function (this: unknown) {
					return this;
				}),
				create,
			}));
			mockSandboxStatics({ builder: builderSpy });
			const { createMicrosandbox } = await importProvider();
			const { HarnessSandboxAuthenticationError } = await import(
				'@ai-sdk/harness'
			);

			const provider = createMicrosandbox({});
			const failure = provider.createSession({ sessionId: 'other-fail' });
			await expect(failure).rejects.not.toBeInstanceOf(
				HarnessSandboxAuthenticationError,
			);
			await expect(failure).rejects.toThrow('internal server error');
		});
	});
});
