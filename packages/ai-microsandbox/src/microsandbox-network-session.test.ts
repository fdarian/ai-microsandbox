import { describe, expect, it, mock } from 'bun:test';
import type { Sandbox } from 'microsandbox';
import { MicrosandboxNetworkSession } from './microsandbox-network-session';
import { MicrosandboxSession } from './microsandbox-session';

function makeMockSandbox(
	overrides: { name?: string; config?: Record<string, unknown> } = {},
) {
	const config = mock(
		async () =>
			overrides.config ?? {
				workdir: '/root',
				network: {
					ports: [
						{ hostPort: 41111, guestPort: 3000, protocol: 'tcp' },
						{ hostPort: 41112, guestPort: 8080, protocol: 'tcp' },
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
		it('reads defaultWorkingDirectory and ports from Sandbox.config()', async () => {
			const { sandbox } = makeMockSandbox();
			const session = await MicrosandboxNetworkSession.create({
				sandbox,
				ownsLifecycle: true,
			});
			expect(session.id).toBe('sbx_net_test');
			expect(session.defaultWorkingDirectory).toBe('/root');
			expect(session.ports).toEqual([3000, 8080]);
		});

		it('throws when config() does not expose a workdir', async () => {
			const { sandbox } = makeMockSandbox({
				config: { network: { ports: [] } },
			});
			await expect(
				MicrosandboxNetworkSession.create({ sandbox, ownsLifecycle: true }),
			).rejects.toThrow(/working directory/i);
		});
	});

	describe('getPortUrl', () => {
		it('resolves a mapped guest port to a loopback URL', async () => {
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
	});
});
