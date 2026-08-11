import { convertAsyncIteratorToReadableStream } from '@ai-sdk/provider-utils';

/**
 * Bridges a microsandbox `AsyncIterable<Uint8Array>` (e.g. the `FsReadStream`
 * returned by `SandboxFsOps.readStream`) into the `ReadableStream<Uint8Array>`
 * shape the `SandboxSession.readFile` contract requires.
 */
export function asyncIterableToReadableStream(
	iterable: AsyncIterable<Uint8Array>,
): ReadableStream<Uint8Array> {
	return convertAsyncIteratorToReadableStream(iterable[Symbol.asyncIterator]());
}

/**
 * Minimal shape shared by microsandbox's write-side sinks (`FsWriteSink`,
 * `ExecSink`): push chunks, then close to signal EOF.
 */
type WritableSink = {
	write(data: Uint8Array): Promise<void>;
	close(): Promise<void>;
};

/**
 * Pumps a `ReadableStream<Uint8Array>` into a microsandbox write sink one
 * chunk at a time, so `writeFile` streams instead of buffering the whole
 * payload in memory before the first byte reaches the sandbox.
 */
export async function pumpReadableStreamToSink(
	stream: ReadableStream<Uint8Array>,
	sink: WritableSink,
	abortSignal?: AbortSignal,
): Promise<void> {
	const reader = stream.getReader();
	try {
		while (true) {
			abortSignal?.throwIfAborted();
			const { value, done } = await reader.read();
			if (done) break;
			if (value != null) await sink.write(value);
		}
	} finally {
		reader.releaseLock();
	}
	await sink.close();
}

/**
 * Collects a `ReadableStream<Uint8Array>` into a UTF-8 string. Used by
 * `run()` to gather stdout/stderr from the same streaming primitive that
 * backs `spawn()`, per the contract's note that `run` is a thin wrapper over
 * `spawn` + collect.
 */
export async function collectStreamAsText(
	stream: ReadableStream<Uint8Array>,
): Promise<string> {
	const chunks: Uint8Array[] = [];
	const reader = stream.getReader();
	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			if (value != null) chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	return Buffer.concat(chunks).toString('utf-8');
}
