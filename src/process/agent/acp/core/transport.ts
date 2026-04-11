import type { AnyMessage } from '@agentclientprotocol/sdk';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Typed stream pair for ACP JSON-RPC messages over ndjson. */
export type AcpMessageStream = {
  readable: ReadableStream<AnyMessage>;
  writable: WritableStream<AnyMessage>;
};

export type NdJsonStreamOptions = {
  /**
   * Optional filter for non-JSON lines from agent stdout.
   * Return `true` to skip the line (don't attempt JSON.parse).
   *
   * Example: filter known non-JSON noise from specific agents (Qoder, etc.)
   */
  ignoreLine?: (trimmedLine: string) => boolean;

  /**
   * Called when a line fails to parse as JSON.
   * Defaults to `console.error`.
   */
  onParseError?: (line: string, error: unknown) => void;
};

export type MessageObserver = (direction: 'inbound' | 'outbound', message: AnyMessage) => void;

// ---------------------------------------------------------------------------
// ndjson message stream
// ---------------------------------------------------------------------------

/**
 * Converts raw byte streams (child process stdio) into a typed ndjson
 * ACP message stream pair that can be handed directly to the SDK's
 * `ClientSideConnection`.
 *
 * ```
 * child process stdin  ← writable (outbound JSON-RPC)
 * child process stdout → readable (inbound  JSON-RPC)
 * ```
 *
 * Caller is responsible for converting Node streams to Web streams:
 * ```ts
 * import { Writable, Readable } from "node:stream";
 * const output = Writable.toWeb(child.stdin);
 * const input  = Readable.toWeb(child.stdout);
 * const stream = createNdJsonMessageStream(output, input);
 * ```
 *
 * @param output  Writable byte stream connected to agent stdin
 * @param input   Readable byte stream connected to agent stdout
 * @param options Optional configuration (line filter, parse error handler)
 */
export function createNdJsonMessageStream(
  output: WritableStream<Uint8Array>,
  input: ReadableStream<Uint8Array>,
  options?: NdJsonStreamOptions
): AcpMessageStream {
  const ignoreLine = options?.ignoreLine;
  const onParseError = options?.onParseError ?? defaultOnParseError;

  const textDecoder = new TextDecoder();
  const textEncoder = new TextEncoder();

  const readable = new ReadableStream<AnyMessage>({
    async start(controller) {
      let buffer = '';
      const reader = input.getReader();
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (!value) continue;

          buffer += textDecoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            if (ignoreLine?.(trimmed)) continue;

            try {
              controller.enqueue(JSON.parse(trimmed) as AnyMessage);
            } catch (err) {
              onParseError(trimmed, err);
            }
          }
        }
      } finally {
        reader.releaseLock();
        controller.close();
      }
    },
  });

  const writable = new WritableStream<AnyMessage>({
    async write(message) {
      const payload = JSON.stringify(message) + '\n';
      const writer = output.getWriter();
      try {
        await writer.write(textEncoder.encode(payload));
      } finally {
        writer.releaseLock();
      }
    },
  });

  return { readable, writable };
}

// ---------------------------------------------------------------------------
// Tapped stream (message observer)
// ---------------------------------------------------------------------------

/**
 * Wraps an `AcpMessageStream` with an observer that sees every inbound
 * and outbound message without modifying the stream.
 *
 * Useful for debug logging, performance tracing, metrics, etc.
 *
 * Based on acpx's `createTappedStream` pattern.
 */
export function createTappedStream(base: AcpMessageStream, observer: MessageObserver): AcpMessageStream {
  const readable = new ReadableStream<AnyMessage>({
    async start(controller) {
      const reader = base.readable.getReader();
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value) {
            observer('inbound', value);
            controller.enqueue(value);
          }
        }
      } finally {
        reader.releaseLock();
        controller.close();
      }
    },
  });

  const writable = new WritableStream<AnyMessage>({
    async write(message) {
      observer('outbound', message);
      const writer = base.writable.getWriter();
      try {
        await writer.write(message);
      } finally {
        writer.releaseLock();
      }
    },
  });

  return { readable, writable };
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

function defaultOnParseError(line: string, error: unknown): void {
  console.error('Failed to parse JSON message:', line, error);
}
