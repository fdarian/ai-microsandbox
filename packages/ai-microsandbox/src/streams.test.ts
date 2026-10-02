import { describe, expect, it, mock } from 'bun:test';
import { pumpReadableStreamToSink } from './streams';

describe('pumpReadableStreamToSink', () => {
	it('closes the sink after a successful pump', async () => {
		const sink = { write: mock(async () => {}), close: mock(async () => {}) };
		await pumpReadableStreamToSink(
			new ReadableStream({
				start(controller) {
					controller.enqueue(new Uint8Array([1]));
					controller.close();
				},
			}),
			sink,
		);
		expect(sink.write).toHaveBeenCalledWith(new Uint8Array([1]));
		expect(sink.close).toHaveBeenCalledTimes(1);
	});

	it('closes on write failure without masking the original error', async () => {
		const failure = new Error('write failed');
		const sink = {
			write: mock(async () => {
				throw failure;
			}),
			close: mock(async () => {
				throw new Error('close failed');
			}),
		};
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array([1]));
			},
		});
		await expect(pumpReadableStreamToSink(stream, sink)).rejects.toBe(failure);
		expect(sink.close).toHaveBeenCalledTimes(1);
	});

	it('closes on abort and on a failing source read', async () => {
		const abort = new AbortController();
		const reason = new Error('aborted');
		abort.abort(reason);
		const abortedSink = {
			write: mock(async () => {}),
			close: mock(async () => {}),
		};
		await expect(
			pumpReadableStreamToSink(new ReadableStream(), abortedSink, abort.signal),
		).rejects.toBe(reason);
		expect(abortedSink.close).toHaveBeenCalledTimes(1);

		const failure = new Error('read failed');
		const failedSink = {
			write: mock(async () => {}),
			close: mock(async () => {}),
		};
		const source = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.error(failure);
			},
		});
		await expect(pumpReadableStreamToSink(source, failedSink)).rejects.toBe(
			failure,
		);
		expect(failedSink.close).toHaveBeenCalledTimes(1);
	});
});
