import { afterEach, describe, expect, it, mock } from 'bun:test';
import type { Sandbox } from 'microsandbox';
import * as realMicrosandbox from 'microsandbox';
import { MicrosandboxNetworkSession } from './microsandbox-network-session';
import { MicrosandboxSession } from './microsandbox-session';

function makeMockSandbox(
	overrides: { name?: string; config?: Record<string, unknown> } = {},
) {
	const config = mock(
		async () =>
			overrides.config ?? {
				runtime: { workdir: '/root' },
				network: {
					ports: [
						{
							hostPort: 41111,
							guestPort: 3000,
							protocol: 'tcp',
							hostBind: '127.0.0.1',
						},
						{
							hostPort: 41112,
							guestPort: 8080,
							protocol: 'tcp',
							hostBind: '127.0.0.1',
						},
						{
							hostPort: 41113,
							guestPort: 5353,
							protocol: 'udp',
							hostBind: '127.0.0.1',
						},
					],
				},
			},
	);
	const stop = mock(async () => {});
	const sandbox = {
		name: overrides.name ?? 'sbx_net_test',
		config,
		stop,
		exec: mock(async () => ({})),
		fs: mock(() => ({})),
	};
	return { sandbox: sandbox as unknown as Sandbox, spies: { config, stop } };
}

describe('MicrosandboxNetworkSession', () => {
	describe('create', () => {
		it('reads defaultWorkingDirectory from config.runtime.workdir and ports from config.network.ports', async () => {
			const { sandbox } = makeMockSandbox();
			const session = await MicrosandboxNetworkSession.create({
				sandbox,
				ownsLifecycle: true,
			});
			expect(session.id).toBe('sbx_net_test');
			expect(session.defaultWorkingDirectory).toBe('/root');
			expect(session.ports).toEqual([3000, 8080, 5353]);
		});

		it('throws when config.runtime.workdir is null (image declares no WORKDIR)', async () => {
			const { sandbox } = makeMockSandbox({
				config: { runtime: { workdir: null }, network: { ports: [] } },
			});
			await expect(
				MicrosandboxNetworkSession.create({ sandbox, ownsLifecycle: true }),
			).rejects.toThrow(/working directory/i);
		});

		it('throws when config has no runtime key at all', async () => {
			const { sandbox } = makeMockSandbox({
				config: { network: { ports: [] } },
			});
			await expect(
				MicrosandboxNetworkSession.create({ sandbox, ownsLifecycle: true }),
			).rejects.toThrow(/working directory/i);
		});
	});

	describe('getPortUrl', () => {
		it('returns the bridge endpoint and delegates the deprecated URL method', async () => {
			const { sandbox } = makeMockSandbox();
			const session = await MicrosandboxNetworkSession.create({
				sandbox,
				ownsLifecycle: true,
			});
			expect(
				await session.getPortEndpoint({ port: 3000, protocol: 'ws' }),
			).toEqual({
				url: 'ws://127.0.0.1:41111',
			});
			expect(await session.getPortUrl({ port: 3000, protocol: 'ws' })).toBe(
				'ws://127.0.0.1:41111',
			);
		});
		it('resolves a mapped TCP guest port to a URL using its hostBind', async () => {
			const { sandbox } = makeMockSandbox();
			const session = await MicrosandboxNetworkSession.create({
				sandbox,
				ownsLifecycle: true,
			});
			const url = await session.getPortUrl({ port: 3000 });
			expect(url).toBe('http://127.0.0.1:41111');
		});

		it('honours the protocol option', async () => {
			const { sandbox } = makeMockSandbox();
			const session = await MicrosandboxNetworkSession.create({
				sandbox,
				ownsLifecycle: true,
			});
			const url = await session.getPortUrl({ port: 8080, protocol: 'ws' });
			expect(url).toBe('ws://127.0.0.1:41112');
		});

		it('reflects a non-default hostBind (e.g. from .portBind(...))', async () => {
			const { sandbox } = makeMockSandbox({
				config: {
					runtime: { workdir: '/root' },
					network: {
						ports: [
							{
								hostPort: 9000,
								guestPort: 80,
								protocol: 'tcp',
								hostBind: '0.0.0.0',
							},
						],
					},
				},
			});
			const session = await MicrosandboxNetworkSession.create({
				sandbox,
				ownsLifecycle: true,
			});
			expect(await session.getPortUrl({ port: 80 })).toBe(
				'http://0.0.0.0:9000',
			);
		});

		it('throws HarnessCapabilityUnsupportedError for an unmapped port', async () => {
			const { HarnessCapabilityUnsupportedError } = await import(
				'@ai-sdk/harness'
			);
			const { sandbox } = makeMockSandbox();
			const session = await MicrosandboxNetworkSession.create({
				sandbox,
				ownsLifecycle: true,
			});
			await expect(session.getPortUrl({ port: 9999 })).rejects.toBeInstanceOf(
				HarnessCapabilityUnsupportedError,
			);
		});

		it('treats a UDP-only guest port as unmapped', async () => {
			const { sandbox } = makeMockSandbox();
			const session = await MicrosandboxNetworkSession.create({
				sandbox,
				ownsLifecycle: true,
			});
			// port 5353 is published, but only over UDP — not URL-addressable.
			await expect(session.getPortUrl({ port: 5353 })).rejects.toThrow();
		});

		it('mentions the cloud backend in the error when it is the active default', async () => {
			const { withDefaultBackend } = await import('microsandbox');
			const { sandbox } = makeMockSandbox({
				config: { runtime: { workdir: '/root' }, network: { ports: [] } },
			});
			const session = await MicrosandboxNetworkSession.create({
				sandbox,
				ownsLifecycle: true,
			});

			await withDefaultBackend(
				{ kind: 'cloud', apiKey: 'test-key' },
				async () => {
					await expect(session.getPortUrl({ port: 80 })).rejects.toThrow(
						/cloud/i,
					);
				},
			);
		});
	});

	describe('restricted', () => {
		it('returns a distinct plain session over the same sandbox', async () => {
			const { sandbox } = makeMockSandbox();
			const session = await MicrosandboxNetworkSession.create({
				sandbox,
				ownsLifecycle: true,
			});
			const restricted = session.restricted();
			expect(restricted).not.toBe(session);
			expect(restricted).toBeInstanceOf(MicrosandboxSession);
			expect(restricted).not.toBeInstanceOf(MicrosandboxNetworkSession);
		});
	});

	describe('stop/destroy', () => {
		afterEach(() => {
			mock.restore();
		});

		it('stop() is a no-op when the session does not own the sandbox lifecycle', async () => {
			const { sandbox, spies } = makeMockSandbox();
			const session = await MicrosandboxNetworkSession.create({
				sandbox,
				ownsLifecycle: false,
			});
			await session.stop();
			expect(spies.stop).not.toHaveBeenCalled();
		});

		it('stop() stops the sandbox when it owns the lifecycle', async () => {
			const { sandbox, spies } = makeMockSandbox();
			const session = await MicrosandboxNetworkSession.create({
				sandbox,
				ownsLifecycle: true,
			});
			await session.stop();
			expect(spies.stop).toHaveBeenCalledTimes(1);
		});

		it('destroy() is a no-op when the session does not own the sandbox lifecycle', async () => {
			const { sandbox, spies } = makeMockSandbox();
			const session = await MicrosandboxNetworkSession.create({
				sandbox,
				ownsLifecycle: false,
			});
			await session.destroy();
			expect(spies.stop).not.toHaveBeenCalled();
		});

		it('destroy() stops then removes the sandbox when it owns the lifecycle', async () => {
			const remove = mock(async (_name: string) => {});
			mock.module('microsandbox', () => ({
				...realMicrosandbox,
				Sandbox: { ...realMicrosandbox.Sandbox, remove },
			}));

			const { sandbox, spies } = makeMockSandbox({ name: 'sbx_owned' });
			const session = await MicrosandboxNetworkSession.create({
				sandbox,
				ownsLifecycle: true,
			});
			await session.destroy();

			expect(spies.stop).toHaveBeenCalledTimes(1);
			expect(remove).toHaveBeenCalledWith('sbx_owned');
		});

		it('destroy() still removes the sandbox even when stop() rejects', async () => {
			const remove = mock(async (_name: string) => {});
			mock.module('microsandbox', () => ({
				...realMicrosandbox,
				Sandbox: { ...realMicrosandbox.Sandbox, remove },
			}));

			const stop = mock(async () => {
				throw new Error('already stopped');
			});
			const sandbox = {
				name: 'sbx_swallow',
				config: mock(async () => ({
					runtime: { workdir: '/root' },
					network: { ports: [] },
				})),
				stop,
				exec: mock(async () => ({})),
				fs: mock(() => ({})),
			} as unknown as Sandbox;

			const session = await MicrosandboxNetworkSession.create({
				sandbox,
				ownsLifecycle: true,
			});
			await session.destroy();

			expect(stop).toHaveBeenCalledTimes(1);
			expect(remove).toHaveBeenCalledWith('sbx_swallow');
		});
	});

	describe('description', () => {
		it('includes the working directory and exposed ports', async () => {
			const { sandbox } = makeMockSandbox();
			const session = await MicrosandboxNetworkSession.create({
				sandbox,
				ownsLifecycle: true,
			});
			expect(session.description).toContain('/root');
			expect(session.description).toContain('3000, 8080, 5353');
		});
	});
});
