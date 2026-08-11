import { describe, expect, it, mock } from 'bun:test';
import type {
	ExecEvent,
	ExecHandle,
	Sandbox,
	SandboxFsOps,
} from 'microsandbox';
import { MicrosandboxSession } from './microsandbox-session';

async function collect(stream: ReadableStream<Uint8Array>): Promise<string> {
	const reader = stream.getReader();
	let text = '';
	const decoder = new TextDecoder();
	while (true) {
		const { value, done } = await reader.read();
		if (done) break;
		if (value) text += decoder.decode(value, { stream: true });
	}
	text += decoder.decode();
	return text;
}

/** Builds a fake `ExecHandle`: an `AsyncIterable<ExecEvent>` plus `kill()`. */
function makeExecHandle(events: ExecEvent[]) {
	const kill = mock(async () => {});
	const handle: AsyncIterable<ExecEvent> & { kill: typeof kill } = {
		[Symbol.asyncIterator]() {
			let index = 0;
			return {
				async next(): Promise<IteratorResult<ExecEvent>> {
					if (index < events.length) {
						return { value: events[index++] as ExecEvent, done: false };
					}
					return { value: undefined, done: true };
				},
			};
		},
		kill,
	};
	return { handle: handle as unknown as ExecHandle, spies: { kill } };
}

type FsSpies = {
	read: ReturnType<typeof mock>;
	readStream: ReturnType<typeof mock>;
	write: ReturnType<typeof mock>;
	writeStream: ReturnType<typeof mock>;
};

/** Fake `ExecOutput`: defaults to a successful, silent exit. */
function makeExecOutput(
	overrides: {
		success?: boolean;
		code?: number;
		stderr?: string;
		stdout?: string;
	} = {},
) {
	const success = overrides.success ?? true;
	return {
		success,
		code: overrides.code ?? (success ? 0 : 1),
		stderr: () => overrides.stderr ?? '',
		stdout: () => overrides.stdout ?? '',
	};
}

/** Builds a fake `Sandbox`. Only the members `MicrosandboxSession` touches are implemented. */
function makeMockSandbox(overrides: { name?: string } = {}) {
	const execStreamWith = mock(
		async (_cmd: string, _configure: (builder: unknown) => unknown) =>
			makeExecHandle([]).handle,
	);
	const exec = mock(async (_cmd: string, _args?: Iterable<string>) =>
		makeExecOutput(),
	);

	const fsSpies: FsSpies = {
		read: mock(async (_path: string) => new Uint8Array()),
		readStream: mock(async (_path: string) => ({
			[Symbol.asyncIterator]: async function* () {},
		})),
		write: mock(async (_path: string, _data: Uint8Array | string) => {}),
		writeStream: mock(async (_path: string) => ({
			write: mock(async (_data: Uint8Array) => {}),
			close: mock(async () => {}),
		})),
	};
	const fs = mock(() => fsSpies as unknown as SandboxFsOps);

	const sandbox = {
		name: overrides.name ?? 'sbx_test',
		execStreamWith,
		exec,
		fs,
	};
	return {
		sandbox: sandbox as unknown as Sandbox,
		spies: { execStreamWith, exec, fs: fsSpies },
	};
}

describe('MicrosandboxSession', () => {
	describe('description', () => {
		it('mentions the sandbox name', () => {
			const { sandbox } = makeMockSandbox();
			expect(new MicrosandboxSession(sandbox).description).toContain(
				'sbx_test',
			);
		});
	});

	describe('spawn', () => {
		it('runs the command as `sh -c <command>` and demuxes stdout/stderr/exit', async () => {
			const { sandbox, spies } = makeMockSandbox();
			const { handle } = makeExecHandle([
				{ kind: 'started', pid: 42 },
				{ kind: 'stdout', data: new TextEncoder().encode('out\n') },
				{ kind: 'stderr', data: new TextEncoder().encode('err\n') },
				{ kind: 'exited', code: 0 },
			]);
			spies.execStreamWith.mockResolvedValueOnce(handle);

			const process = await new MicrosandboxSession(sandbox).spawn({
				command: 'echo hi',
			});

			expect(spies.execStreamWith).toHaveBeenCalledWith(
				'sh',
				expect.any(Function),
			);
			const [stdout, stderr, result] = await Promise.all([
				collect(process.stdout),
				collect(process.stderr),
				process.wait(),
			]);
			expect(stdout).toBe('out\n');
			expect(stderr).toBe('err\n');
			expect(result.exitCode).toBe(0);
			expect(process.pid).toBe(42);
		});

		it('builds the exec options as `-c <command>`, in order', async () => {
			const { sandbox, spies } = makeMockSandbox();
			spies.execStreamWith.mockResolvedValueOnce(
				makeExecHandle([{ kind: 'exited', code: 0 }]).handle,
			);

			const argCalls: string[] = [];
			const builder = {
				arg: mock(function (this: unknown, value: string) {
					argCalls.push(value);
					return this;
				}),
				cwd: mock(function (this: unknown) {
					return this;
				}),
				envs: mock(function (this: unknown) {
					return this;
				}),
			};

			await new MicrosandboxSession(sandbox).spawn({
				command: 'echo "hi there"',
			});

			const [, configure] = spies.execStreamWith.mock.calls[0] as [
				string,
				(b: typeof builder) => unknown,
			];
			configure(builder);
			expect(argCalls).toEqual(['-c', 'echo "hi there"']);
		});

		it('forwards workingDirectory and env through the exec options builder', async () => {
			const { sandbox, spies } = makeMockSandbox();
			spies.execStreamWith.mockResolvedValueOnce(
				makeExecHandle([{ kind: 'exited', code: 0 }]).handle,
			);

			const cwdCalls: string[] = [];
			const envCalls: Record<string, string>[] = [];
			const builder = {
				arg: mock(function (this: unknown) {
					return this;
				}),
				cwd: mock(function (this: unknown, path: string) {
					cwdCalls.push(path);
					return this;
				}),
				envs: mock(function (this: unknown, vars: Record<string, string>) {
					envCalls.push(vars);
					return this;
				}),
			};

			await new MicrosandboxSession(sandbox).spawn({
				command: 'ls',
				workingDirectory: '/work',
				env: { FOO: 'bar' },
			});

			const [, configure] = spies.execStreamWith.mock.calls[0] as [
				string,
				(b: typeof builder) => unknown,
			];
			configure(builder);
			expect(cwdCalls).toEqual(['/work']);
			expect(envCalls).toEqual([{ FOO: 'bar' }]);
		});

		it('kill() delegates to the underlying exec handle', async () => {
			const { sandbox, spies } = makeMockSandbox();
			const { handle, spies: handleSpies } = makeExecHandle([]);
			spies.execStreamWith.mockResolvedValueOnce(handle);

			const process = await new MicrosandboxSession(sandbox).spawn({
				command: 'sleep 10',
			});
			await process.kill();
			expect(handleSpies.kill).toHaveBeenCalledTimes(1);
		});

		it('throws on a pre-aborted signal before starting the process', async () => {
			const { sandbox, spies } = makeMockSandbox();
			const ac = new AbortController();
			ac.abort(new Error('cancelled up front'));

			await expect(
				new MicrosandboxSession(sandbox).spawn({
					command: 'echo',
					abortSignal: ac.signal,
				}),
			).rejects.toThrow('cancelled up front');
			expect(spies.execStreamWith).not.toHaveBeenCalled();
		});

		it('aborting mid-flight kills the process and rejects wait() with the abort reason', async () => {
			const { sandbox, spies } = makeMockSandbox();
			let resolveExited: (event: ExecEvent) => void = () => {};
			const kill = mock(async () => {
				resolveExited({ kind: 'exited', code: 137 });
			});
			const pendingExit = new Promise<ExecEvent>((resolve) => {
				resolveExited = resolve;
			});
			const handle: AsyncIterable<ExecEvent> & { kill: typeof kill } = {
				[Symbol.asyncIterator]() {
					let yielded = false;
					return {
						async next(): Promise<IteratorResult<ExecEvent>> {
							if (yielded) return { value: undefined, done: true };
							yielded = true;
							return { value: await pendingExit, done: false };
						},
					};
				},
				kill,
			};
			spies.execStreamWith.mockResolvedValueOnce(
				handle as unknown as ExecHandle,
			);

			const ac = new AbortController();
			const process = await new MicrosandboxSession(sandbox).spawn({
				command: 'sleep 10',
				abortSignal: ac.signal,
			});
			ac.abort(new Error('user cancelled'));

			await expect(process.wait()).rejects.toThrow('user cancelled');
			expect(kill).toHaveBeenCalledTimes(1);
		});

		it('kills the process when aborted while execStreamWith is still in flight', async () => {
			// This is the race the abort listener has to close: nothing exists to
			// listen for 'abort' until `execStreamWith` resolves, so an abort
			// fired *during* that round trip must still result in a kill once the
			// handle is available — not be silently missed.
			const { sandbox, spies } = makeMockSandbox();
			const { handle, spies: handleSpies } = makeExecHandle([]);
			let resolveExecStreamWith: (h: ExecHandle) => void = () => {};
			const pending = new Promise<ExecHandle>((resolve) => {
				resolveExecStreamWith = resolve;
			});
			spies.execStreamWith.mockImplementationOnce(() => pending);

			const ac = new AbortController();
			const spawnPromise = new MicrosandboxSession(sandbox).spawn({
				command: 'sleep 10',
				abortSignal: ac.signal,
			});

			// Fires synchronously; at this point `execStreamWith`'s promise is
			// still pending, so under the old implementation nothing was
			// listening yet.
			ac.abort(new Error('cancelled mid-flight'));
			resolveExecStreamWith(handle);
			await spawnPromise;

			expect(handleSpies.kill).toHaveBeenCalledTimes(1);
		});
	});

	describe('run', () => {
		it('collects stdout/stderr and exit code via spawn', async () => {
			const { sandbox, spies } = makeMockSandbox();
			spies.execStreamWith.mockResolvedValueOnce(
				makeExecHandle([
					{ kind: 'stdout', data: new TextEncoder().encode('hi\n') },
					{ kind: 'stderr', data: new TextEncoder().encode('oops\n') },
					{ kind: 'exited', code: 3 },
				]).handle,
			);

			const result = await new MicrosandboxSession(sandbox).run({
				command: 'echo hi',
			});
			expect(result).toEqual({ exitCode: 3, stdout: 'hi\n', stderr: 'oops\n' });
		});

		it('closes the same execStreamWith-in-flight abort race as spawn()', async () => {
			const { sandbox, spies } = makeMockSandbox();
			const { handle, spies: handleSpies } = makeExecHandle([]);
			let resolveExecStreamWith: (h: ExecHandle) => void = () => {};
			const pending = new Promise<ExecHandle>((resolve) => {
				resolveExecStreamWith = resolve;
			});
			spies.execStreamWith.mockImplementationOnce(() => pending);

			const ac = new AbortController();
			const runPromise = new MicrosandboxSession(sandbox).run({
				command: 'sleep 10',
				abortSignal: ac.signal,
			});

			ac.abort(new Error('cancelled mid-flight'));
			resolveExecStreamWith(handle);

			await expect(runPromise).rejects.toThrow('cancelled mid-flight');
			expect(handleSpies.kill).toHaveBeenCalledTimes(1);
		});
	});

	describe('file I/O', () => {
		it('readBinaryFile returns bytes from fs().read()', async () => {
			const { sandbox, spies } = makeMockSandbox();
			spies.fs.read.mockResolvedValueOnce(new Uint8Array([1, 2, 3]));
			const bytes = await new MicrosandboxSession(sandbox).readBinaryFile({
				path: '/x',
			});
			expect(bytes).toEqual(new Uint8Array([1, 2, 3]));
		});

		it('readBinaryFile returns null when the path does not exist', async () => {
			const { IoError } = await import('microsandbox');
			const { sandbox, spies } = makeMockSandbox();
			spies.fs.read.mockRejectedValueOnce(
				new IoError('No such file or directory (os error 2)'),
			);
			const bytes = await new MicrosandboxSession(sandbox).readBinaryFile({
				path: '/missing',
			});
			expect(bytes).toBeNull();
		});

		it('readBinaryFile rethrows non-not-found IoErrors', async () => {
			const { IoError } = await import('microsandbox');
			const { sandbox, spies } = makeMockSandbox();
			spies.fs.read.mockRejectedValueOnce(new IoError('Permission denied'));
			await expect(
				new MicrosandboxSession(sandbox).readBinaryFile({
					path: '/root/secret',
				}),
			).rejects.toThrow('Permission denied');
		});

		it('readTextFile decodes and applies startLine/endLine', async () => {
			const { sandbox, spies } = makeMockSandbox();
			spies.fs.read.mockResolvedValueOnce(
				new TextEncoder().encode('a\nb\nc\nd\n'),
			);
			const text = await new MicrosandboxSession(sandbox).readTextFile({
				path: '/x',
				startLine: 2,
				endLine: 3,
			});
			expect(text).toBe('b\nc');
		});

		it('writeBinaryFile creates the parent directory and writes bytes', async () => {
			const { sandbox, spies } = makeMockSandbox();
			const bytes = new Uint8Array([0, 1, 2, 255]);
			await new MicrosandboxSession(sandbox).writeBinaryFile({
				path: '/work/sub/file.bin',
				content: bytes,
			});

			expect(spies.exec).toHaveBeenCalledWith('mkdir', ['-p', '/work/sub']);
			expect(spies.fs.write).toHaveBeenCalledWith('/work/sub/file.bin', bytes);
		});

		it('writeBinaryFile throws with the captured stderr when mkdir -p fails', async () => {
			const { sandbox, spies } = makeMockSandbox();
			spies.exec.mockResolvedValueOnce(
				makeExecOutput({
					success: false,
					code: 1,
					stderr: 'mkdir: Read-only file system',
				}),
			);

			await expect(
				new MicrosandboxSession(sandbox).writeBinaryFile({
					path: '/readonly/sub/file.bin',
					content: new Uint8Array([1]),
				}),
			).rejects.toThrow(/Read-only file system/);
			expect(spies.fs.write).not.toHaveBeenCalled();
		});

		it('writeBinaryFile skips mkdir for a top-level path', async () => {
			const { sandbox, spies } = makeMockSandbox();
			await new MicrosandboxSession(sandbox).writeBinaryFile({
				path: '/file.bin',
				content: new Uint8Array([1]),
			});
			expect(spies.exec).not.toHaveBeenCalled();
		});

		it('writeTextFile encodes utf-8 and delegates to writeBinaryFile', async () => {
			const { sandbox, spies } = makeMockSandbox();
			await new MicrosandboxSession(sandbox).writeTextFile({
				path: '/work/hello.txt',
				content: 'hi',
			});
			const [path, data] = spies.fs.write.mock.calls[0] as [string, Uint8Array];
			expect(path).toBe('/work/hello.txt');
			expect(Buffer.from(data).toString('utf8')).toBe('hi');
		});

		it('readFile/writeFile round-trip through Web streams', async () => {
			const { sandbox, spies } = makeMockSandbox();
			const payload = new TextEncoder().encode('streamed');

			const sink = {
				write: mock(async (_d: Uint8Array) => {}),
				close: mock(async () => {}),
			};
			spies.fs.writeStream.mockResolvedValueOnce(sink);

			await new MicrosandboxSession(sandbox).writeFile({
				path: '/work/streamed.txt',
				content: new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(payload);
						controller.close();
					},
				}),
			});
			expect(spies.exec).toHaveBeenCalledWith('mkdir', ['-p', '/work']);
			expect(sink.write).toHaveBeenCalledWith(payload);
			expect(sink.close).toHaveBeenCalledTimes(1);

			spies.fs.readStream.mockResolvedValueOnce({
				[Symbol.asyncIterator]: async function* () {
					yield payload;
				},
			});
			const stream = await new MicrosandboxSession(sandbox).readFile({
				path: '/work/streamed.txt',
			});
			expect(stream).not.toBeNull();
			expect(await collect(stream as ReadableStream<Uint8Array>)).toBe(
				'streamed',
			);
		});

		it('readFile returns null when the path does not exist', async () => {
			const { SandboxFsOpsError } = await import('microsandbox');
			const { sandbox, spies } = makeMockSandbox();
			spies.fs.readStream.mockRejectedValueOnce(
				new SandboxFsOpsError('path not found'),
			);
			const stream = await new MicrosandboxSession(sandbox).readFile({
				path: '/missing',
			});
			expect(stream).toBeNull();
		});
	});
});
