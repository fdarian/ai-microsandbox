import { describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Sandbox } from 'microsandbox';
import { createMicrosandbox } from '../src';

const image = 'node:22-alpine';
const bridge = `const http = require('node:http');
const crypto = require('node:crypto');
http.createServer().on('upgrade', (request, socket) => {
  const key = request.headers['sec-websocket-key'];
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: ' + accept + '\\r\\n\\r\\n');
}).listen(8765, '0.0.0.0');`;

async function reachable(url: string): Promise<void> {
	for (let attempt = 0; attempt < 30; attempt++) {
		try {
			await connect(url);
			return;
		} catch (error) {
			if (attempt === 29) throw error;
			await Bun.sleep(1000);
		}
	}
}

async function connect(url: string): Promise<void> {
	const socket = new WebSocket(url);
	await new Promise<void>((resolve, reject) => {
		const timeout = setTimeout(
			() => reject(new Error(`Bridge not reachable: ${url}`)),
			30_000,
		);
		socket.addEventListener(
			'open',
			() => {
				clearTimeout(timeout);
				resolve();
			},
			{ once: true },
		);
		socket.addEventListener(
			'error',
			() => {
				clearTimeout(timeout);
				reject(new Error(`WebSocket failed: ${url}`));
			},
			{ once: true },
		);
	});
	socket.close();
}

describe('real microsandbox VM', () => {
	it('creates, sets up, bootstraps a WebSocket bridge, uses files and processes, stops, resumes and destroys', async () => {
		const sessionId = randomUUID();
		const provider = createMicrosandbox({
			image,
			workDir: '/workspace',
			setup: async (session) => {
				await session.writeTextFile({
					path: '/workspace/setup.txt',
					content: 'ready',
				});
			},
		});
		const session = await provider.createSession({
			sessionId,
			onFirstCreate: async (sandbox) => {
				await sandbox.writeTextFile({
					path: '/workspace/bridge.cjs',
					content: bridge,
				});
			},
		});
		try {
			const file = await session
				.restricted()
				.readTextFile({ path: '/workspace/setup.txt' });
			expect(file).toBe('ready');
			const result = await session
				.restricted()
				.run({ command: 'cat setup.txt' });
			expect(result).toEqual({ exitCode: 0, stdout: 'ready', stderr: '' });
			const process = await session
				.restricted()
				.spawn({ command: 'node /workspace/bridge.cjs' });
			const url = await session.getPortUrl({ port: 8765, protocol: 'ws' });
			await reachable(url);
			await process.kill();
			await session.stop();
			const resumed = await provider.resumeSession({ sessionId });
			try {
				expect(
					await resumed
						.restricted()
						.readTextFile({ path: '/workspace/setup.txt' }),
				).toBe('ready');
				const resumedProcess = await resumed
					.restricted()
					.spawn({ command: 'node /workspace/bridge.cjs' });
				await reachable(
					await resumed.getPortUrl({ port: 8765, protocol: 'ws' }),
				);
				await resumedProcess.kill();
			} finally {
				await resumed.destroy();
				await resumed.destroy();
			}
		} finally {
			await session.destroy().catch(() => {});
		}
	}, 120_000);

	it('removes a VM when setup fails', async () => {
		const sessionId = randomUUID();
		const name = `ai-sdk-harness-session-${sessionId}`;
		const provider = createMicrosandbox({
			image,
			setup: async () => {
				throw new Error('setup failure');
			},
		});
		await expect(provider.createSession({ sessionId })).rejects.toThrow(
			'setup failure',
		);
		await expect(Sandbox.get(name)).rejects.toThrow();
	}, 120_000);

	it('creates concurrent sessions with distinct, reachable bridge ports', async () => {
		const provider = createMicrosandbox({ image, workDir: '/workspace' });
		const sessions = await Promise.all([
			provider.createSession(),
			provider.createSession(),
		]);
		try {
			const urls = await Promise.all(
				sessions.map(async (session) =>
					session.getPortUrl({ port: 8765, protocol: 'ws' }),
				),
			);
			expect(new Set(urls).size).toBe(2);
			const processes = await Promise.all(
				sessions.map(async (session) => {
					await session
						.restricted()
						.writeTextFile({ path: '/workspace/bridge.cjs', content: bridge });
					return session
						.restricted()
						.spawn({ command: 'node /workspace/bridge.cjs' });
				}),
			);
			try {
				await Promise.all(urls.map(reachable));
			} finally {
				await Promise.all(processes.map(async (process) => process.kill()));
			}
		} finally {
			await Promise.all(sessions.map(async (session) => session.destroy()));
		}
	}, 120_000);
});
