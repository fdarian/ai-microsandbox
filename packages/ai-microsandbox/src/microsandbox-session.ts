import { posix } from 'node:path';
import type {
	Experimental_SandboxProcess as SandboxProcess,
	Experimental_SandboxSession as SandboxSession,
} from '@ai-sdk/provider-utils';
import { extractLines } from '@ai-sdk/provider-utils';
import {
	type ExecHandle,
	IoError,
	type Sandbox,
	SandboxFsOpsError,
} from 'microsandbox';
import {
	asyncIterableToReadableStream,
	collectStreamAsText,
	pumpReadableStreamToSink,
} from './streams';

/**
 * `Experimental_SandboxSession` implementation backed by a `microsandbox`
 * `Sandbox` instance. This is the tool-safe surface (file I/O, exec, spawn);
 * it is what `MicrosandboxNetworkSession.restricted()` returns and is not
 * constructed directly by consumers. The network sandbox session owns the
 * lifetime of the underlying sandbox.
 */
export class MicrosandboxSession implements SandboxSession {
	constructor(
		protected readonly sandbox: Sandbox,
		private readonly workDir?: string,
	) {}

	get description(): string {
		return [
			`microsandbox sandbox (name: ${this.sandbox.name}).`,
			'Filesystem changes persist for the lifetime of the sandbox.',
		].join('\n');
	}

	async run({
		command,
		workingDirectory,
		env,
		abortSignal,
	}: {
		command: string;
		workingDirectory?: string;
		env?: Record<string, string>;
		abortSignal?: AbortSignal;
	}): Promise<{ exitCode: number; stdout: string; stderr: string }> {
		// `run` is a thin wrapper over `spawn`: the buffered `Sandbox.exec()` has
		// no way to cancel mid-flight, and the contract requires `abortSignal`
		// support everywhere, so both primitives drive the same streaming handle.
		const process = await this.spawn({
			command,
			workingDirectory,
			env,
			abortSignal,
		});
		const [stdout, stderr, result] = await Promise.all([
			collectStreamAsText(process.stdout),
			collectStreamAsText(process.stderr),
			process.wait(),
		]);
		return { exitCode: result.exitCode, stdout, stderr };
	}

	async spawn({
		command,
		workingDirectory,
		env,
		abortSignal,
	}: {
		command: string;
		workingDirectory?: string;
		env?: Record<string, string>;
		abortSignal?: AbortSignal;
	}): Promise<SandboxProcess> {
		abortSignal?.throwIfAborted();

		// Registered before the `execStreamWith` round trip below, not after it
		// resolves: an `AbortSignal` fires 'abort' at most once, to whoever is
		// listening at that instant. Registering only once `handle` exists (as
		// `createSandboxProcess` used to) leaves a window where an abort during
		// the round trip has no listener and is silently missed — the process
		// then runs to completion server-side despite the caller cancelling.
		let handle: ExecHandle | undefined;
		let abortedBeforeHandleReady = false;
		const onAbort = () => {
			if (handle == null) {
				abortedBeforeHandleReady = true;
				return;
			}
			void handle.kill().catch(() => {});
		};
		abortSignal?.addEventListener('abort', onAbort, { once: true });

		try {
			// The contract's `command` is a shell string; microsandbox's
			// `shellStream` doesn't accept a `cwd`/`env` options argument, so run
			// it explicitly as `sh -c <command>` through `execStreamWith`, which
			// does.
			handle = await this.sandbox.execStreamWith('sh', (builder) => {
				let configured = builder.arg('-c').arg(command);
				const cwd = workingDirectory ?? this.workDir;
				if (cwd !== undefined) configured = configured.cwd(cwd);
				if (env !== undefined) configured = configured.envs(env);
				return configured;
			});
		} catch (error) {
			abortSignal?.removeEventListener('abort', onAbort);
			throw error;
		}

		if (abortedBeforeHandleReady) {
			// `onAbort` fired while `handle` was still unassigned and no-opped;
			// kill now that we have a handle to kill.
			await handle.kill().catch(() => {});
		}

		return createSandboxProcess(handle, abortSignal, onAbort);
	}

	async readFile({
		path,
		abortSignal,
	}: {
		path: string;
		abortSignal?: AbortSignal;
	}): Promise<ReadableStream<Uint8Array> | null> {
		abortSignal?.throwIfAborted();
		try {
			const fsStream = await this.sandbox
				.fs()
				.readStream(this.resolvePath(path));
			return asyncIterableToReadableStream(fsStream);
		} catch (error) {
			if (isFileNotFoundError(error)) return null;
			throw error;
		}
	}

	async readBinaryFile({
		path,
		abortSignal,
	}: {
		path: string;
		abortSignal?: AbortSignal;
	}): Promise<Uint8Array | null> {
		abortSignal?.throwIfAborted();
		try {
			return await this.sandbox.fs().read(this.resolvePath(path));
		} catch (error) {
			if (isFileNotFoundError(error)) return null;
			throw error;
		}
	}

	async readTextFile({
		path,
		encoding = 'utf-8',
		startLine,
		endLine,
		abortSignal,
	}: {
		path: string;
		encoding?: string;
		startLine?: number;
		endLine?: number;
		abortSignal?: AbortSignal;
	}): Promise<string | null> {
		const bytes = await this.readBinaryFile({ path, abortSignal });
		if (bytes == null) return null;
		const text = Buffer.from(bytes).toString(encoding as BufferEncoding);
		return extractLines({ text, startLine, endLine });
	}

	async writeFile({
		path,
		content,
		abortSignal,
	}: {
		path: string;
		content: ReadableStream<Uint8Array>;
		abortSignal?: AbortSignal;
	}): Promise<void> {
		abortSignal?.throwIfAborted();
		const resolvedPath = this.resolvePath(path);
		await this.ensureParentDirectory(resolvedPath);
		const sink = await this.sandbox.fs().writeStream(resolvedPath);
		await pumpReadableStreamToSink(content, sink, abortSignal);
	}

	async writeBinaryFile({
		path,
		content,
		abortSignal,
	}: {
		path: string;
		content: Uint8Array;
		abortSignal?: AbortSignal;
	}): Promise<void> {
		abortSignal?.throwIfAborted();
		const resolvedPath = this.resolvePath(path);
		await this.ensureParentDirectory(resolvedPath);
		await this.sandbox.fs().write(resolvedPath, content);
	}

	async writeTextFile({
		path,
		content,
		encoding = 'utf-8',
		abortSignal,
	}: {
		path: string;
		content: string;
		encoding?: string;
		abortSignal?: AbortSignal;
	}): Promise<void> {
		const buffer = Buffer.from(content, encoding as BufferEncoding);
		await this.writeBinaryFile({
			path,
			content: new Uint8Array(
				buffer.buffer,
				buffer.byteOffset,
				buffer.byteLength,
			),
			abortSignal,
		});
	}

	/**
	 * Creates the parent directory of `path`, recursively. The installed
	 * `SandboxFsOps.mkdir(path)` type takes no `{ recursive: true }` option (or
	 * any options at all), so this shells out to `mkdir -p` instead of relying
	 * on `fs().mkdir()`.
	 */
	private async ensureParentDirectory(path: string): Promise<void> {
		const parent = posix.dirname(path);
		if (parent === '.' || parent === '/' || parent === '') return;
		// `exec()` resolves with an `ExecOutput` regardless of the command's own
		// exit status — it only rejects on an exec-launch failure — so a `mkdir
		// -p` that fails (read-only filesystem, permission denied on an
		// ancestor, ...) must be checked explicitly or it's silently swallowed.
		const result = await this.sandbox.exec('mkdir', ['-p', parent]);
		if (!result.success) {
			throw new Error(
				`Failed to create parent directory "${parent}" for "${path}" (mkdir -p exited ${result.code}): ${result.stderr()}`,
			);
		}
	}

	private resolvePath(path: string): string {
		return this.workDir == null ? path : posix.resolve(this.workDir, path);
	}
}

/**
 * Demuxes a microsandbox `ExecHandle` (an `AsyncIterable<ExecEvent>` yielding
 * `started`/`stdout`/`stderr`/`exited` events) into the two independent
 * `ReadableStream<Uint8Array>`s the `SandboxProcess` contract expects, mirroring
 * `createSandboxProcess` in `@ai-sdk/sandbox-vercel`.
 *
 * `onAbort` is registered by the caller (`spawn()`), before `handle` even
 * exists, to close the race described there — this function only owns
 * detaching it once the process is fully drained.
 */
function createSandboxProcess(
	handle: ExecHandle,
	abortSignal: AbortSignal | undefined,
	onAbort: () => void,
): SandboxProcess {
	let pid: number | undefined;
	let exitCode: number | undefined;
	const controllers: {
		stdout?: ReadableStreamDefaultController<Uint8Array>;
		stderr?: ReadableStreamDefaultController<Uint8Array>;
	} = {};
	const pendingPulls: { stdout?: () => void; stderr?: () => void } = {};

	const stdout = new ReadableStream<Uint8Array>({
		start(controller) {
			controllers.stdout = controller;
		},
		pull() {
			pendingPulls.stdout?.();
		},
	});

	const stderr = new ReadableStream<Uint8Array>({
		start(controller) {
			controllers.stderr = controller;
		},
		pull() {
			pendingPulls.stderr?.();
		},
	});
	const enqueue = async (kind: 'stdout' | 'stderr', data: Uint8Array) => {
		const controller = controllers[kind];
		if (controller == null)
			throw new Error(`Missing ${kind} stream controller`);
		if (controller.desiredSize != null && controller.desiredSize <= 0) {
			await new Promise<void>((resolve) => {
				pendingPulls[kind] = resolve;
			});
			delete pendingPulls[kind];
		}
		controller.enqueue(data);
	};

	const drained = (async () => {
		try {
			for await (const event of handle) {
				switch (event.kind) {
					case 'started':
						pid = event.pid;
						break;
					case 'stdout':
						await enqueue('stdout', event.data);
						break;
					case 'stderr':
						await enqueue('stderr', event.data);
						break;
					case 'exited':
						exitCode = event.code;
						break;
				}
			}
			controllers.stdout?.close();
			controllers.stderr?.close();
			return { success: true as const };
		} catch (error) {
			controllers.stdout?.error(error);
			controllers.stderr?.error(error);
			return { success: false as const, error };
		} finally {
			abortSignal?.removeEventListener('abort', onAbort);
		}
	})();

	return {
		get pid() {
			return pid;
		},
		stdout,
		stderr,
		async wait(): Promise<{ exitCode: number }> {
			const result = await drained;
			if (!result.success) throw result.error;
			if (abortSignal?.aborted) {
				throw abortSignal.reason ?? new DOMException('Aborted', 'AbortError');
			}
			if (exitCode === undefined) {
				throw new Error(
					'microsandbox exec stream ended without an `exited` event',
				);
			}
			return { exitCode };
		},
		async kill(): Promise<void> {
			await handle.kill();
		},
	} satisfies SandboxProcess;
}

/**
 * microsandbox has no dedicated "file not found" error class — every fs
 * failure surfaces as either `IoError` or `SandboxFsOpsError` (see
 * `errors.d.ts`), both carrying only a constant `.code` and a free-text Rust
 * `.message`. Detecting "path doesn't exist" is therefore necessarily a
 * message-pattern match on those two specific classes, not a blanket catch —
 * any other `IoError`/`SandboxFsOpsError` (permission denied, disk full, ...)
 * still propagates.
 */
const FILE_NOT_FOUND_MESSAGE = /no such file|not found|does not exist|enoent/i;

function isFileNotFoundError(error: unknown): boolean {
	if (!(error instanceof IoError) && !(error instanceof SandboxFsOpsError))
		return false;
	return FILE_NOT_FOUND_MESSAGE.test(error.message);
}
