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
	const image = mock(function (this: unknown) {
		return this;
	});
	const create = mock(async () => sandbox);
	return { builder: { image, create }, spies: { image, create } };
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
			expect(configure).toHaveBeenCalledWith(builder);
			expect(session.id).toBe('ai-sdk-harness-session-abc123');
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
