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
	constructor(protected readonly sandbox: Sandbox) {}

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

		// The contract's `command` is a shell string; microsandbox's `shellStream`
		// doesn't accept a `cwd`/`env` options argument, so run it explicitly as
		// `sh -c <command>` through `execStreamWith`, which does.
		const handle = await this.sandbox.execStreamWith('sh', (builder) => {
			let configured = builder.arg('-c').arg(command);
			if (workingDirectory !== undefined)
				configured = configured.cwd(workingDirectory);
			if (env !== undefined) configured = configured.envs(env);
			return configured;
		});

		return createSandboxProcess(handle, abortSignal);
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
			const fsStream = await this.sandbox.fs().readStream(path);
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
			return await this.sandbox.fs().read(path);
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
		await this.ensureParentDirectory(path);
		const sink = await this.sandbox.fs().writeStream(path);
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
		await this.ensureParentDirectory(path);
		await this.sandbox.fs().write(path, content);
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
		await this.sandbox.exec('mkdir', ['-p', parent]);
	}
}

/**
 * Demuxes a microsandbox `ExecHandle` (an `AsyncIterable<ExecEvent>` yielding
 * `started`/`stdout`/`stderr`/`exited` events) into the two independent
 * `ReadableStream<Uint8Array>`s the `SandboxProcess` contract expects, mirroring
 * `createSandboxProcess` in `@ai-sdk/sandbox-vercel`.
 */
function createSandboxProcess(
	handle: ExecHandle,
	abortSignal: AbortSignal | undefined,
): SandboxProcess {
	let pid: number | undefined;
	let exitCode: number | undefined;
	const controllers: {
		stdout?: ReadableStreamDefaultController<Uint8Array>;
		stderr?: ReadableStreamDefaultController<Uint8Array>;
	} = {};

	const stdout = new ReadableStream<Uint8Array>({
		start(controller) {
			controllers.stdout = controller;
		},
	});

	const stderr = new ReadableStream<Uint8Array>({
		start(controller) {
			controllers.stderr = controller;
		},
	});

	const onAbort = () => {
		void handle.kill();
	};
	abortSignal?.addEventListener('abort', onAbort, { once: true });

	const drained = (async () => {
		try {
			for await (const event of handle) {
				switch (event.kind) {
					case 'started':
						pid = event.pid;
						break;
					case 'stdout':
						controllers.stdout?.enqueue(event.data);
						break;
					case 'stderr':
						controllers.stderr?.enqueue(event.data);
						break;
					case 'exited':
						exitCode = event.code;
						break;
				}
			}
			controllers.stdout?.close();
			controllers.stderr?.close();
		} catch (error) {
			controllers.stdout?.error(error);
			controllers.stderr?.error(error);
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
			await drained;
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
