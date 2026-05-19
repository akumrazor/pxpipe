import { describe, it, expect } from 'vitest';
import { createProxy, type ProxyEvent } from '../src/core/proxy.js';

/** Tiny in-process mock upstream — accepts any request and returns whatever
 *  the test fixture configured. Lets us assert that the proxy correctly
 *  extracts Anthropic's usage block from both SSE and JSON responses without
 *  touching the network. */
function mockUpstream(handler: (req: Request) => Promise<Response> | Response) {
  // Patch globalThis.fetch for the duration of the test.
  const real = globalThis.fetch;
  globalThis.fetch = ((req: Request | string | URL, init?: RequestInit) => {
    const r = req instanceof Request ? req : new Request(String(req), init);
    return Promise.resolve(handler(r));
  }) as typeof fetch;
  return () => {
    globalThis.fetch = real;
  };
}

const SAMPLE_REQ_BODY = JSON.stringify({
  model: 'claude-3-5-haiku-latest',
  messages: [{ role: 'user', content: 'hi' }],
  system: 'short',
});

describe('proxy usage extraction', () => {
  it('extracts usage tokens from a non-stream JSON response', async () => {
    const restore = mockUpstream(
      () =>
        new Response(
          JSON.stringify({
            id: 'msg_1',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: 'hello' }],
            usage: {
              input_tokens: 123,
              output_tokens: 7,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 100,
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );

    let captured: ProxyEvent | undefined;
    const proxy = createProxy({
      transform: {},
      onRequest: (e) => {
        captured = e;
      },
    });

    const res = await proxy(
      new Request('http://localhost/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: SAMPLE_REQ_BODY,
      }),
    );
    // Drain the client-side body so the tee is forced to finish.
    await res.text();
    // Give the onRequest callback a tick to fire (it's behind a void promise).
    await new Promise((r) => setTimeout(r, 20));
    restore();

    expect(captured).toBeDefined();
    expect(captured!.usage?.input_tokens).toBe(123);
    expect(captured!.usage?.output_tokens).toBe(7);
    expect(captured!.usage?.cache_read_input_tokens).toBe(100);
    expect(captured!.firstByteMs).toBeTypeOf('number');
  });

  it('extracts usage tokens from an SSE stream (message_start event)', async () => {
    const sseBody =
      'event: message_start\n' +
      'data: ' +
      JSON.stringify({
        type: 'message_start',
        message: {
          id: 'msg_2',
          type: 'message',
          role: 'assistant',
          content: [],
          usage: {
            input_tokens: 42,
            output_tokens: 0,
            cache_creation_input_tokens: 5000,
            cache_read_input_tokens: 0,
          },
        },
      }) +
      '\n\n' +
      'event: content_block_delta\n' +
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}\n\n' +
      'event: message_stop\n' +
      'data: {"type":"message_stop"}\n\n';

    const restore = mockUpstream(
      () =>
        new Response(sseBody, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }),
    );

    let captured: ProxyEvent | undefined;
    const proxy = createProxy({
      transform: {},
      onRequest: (e) => {
        captured = e;
      },
    });

    const res = await proxy(
      new Request('http://localhost/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: SAMPLE_REQ_BODY,
      }),
    );
    await res.text();
    await new Promise((r) => setTimeout(r, 20));
    restore();

    expect(captured).toBeDefined();
    expect(captured!.usage?.input_tokens).toBe(42);
    expect(captured!.usage?.cache_creation_input_tokens).toBe(5000);
  });

  it('fires the event with undefined usage when the response is an error', async () => {
    const restore = mockUpstream(
      () =>
        new Response(JSON.stringify({ error: { type: 'overloaded_error' } }), {
          status: 529,
          headers: { 'content-type': 'application/json' },
        }),
    );

    let captured: ProxyEvent | undefined;
    const proxy = createProxy({
      transform: {},
      onRequest: (e) => {
        captured = e;
      },
    });

    const res = await proxy(
      new Request('http://localhost/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: SAMPLE_REQ_BODY,
      }),
    );
    await res.text();
    await new Promise((r) => setTimeout(r, 20));
    restore();

    expect(captured).toBeDefined();
    expect(captured!.status).toBe(529);
    expect(captured!.usage).toBeUndefined();
    // 5xx: we synthesize our own message upstream, so no errorBody capture.
    expect(captured!.errorBody).toBeUndefined();
  });

  it('captures upstream error body for 4xx responses (up to 2 KiB)', async () => {
    const upstreamErr = {
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message: 'messages.5.content.0.tool_use_id: unknown tool_use id',
      },
    };
    const restore = mockUpstream(
      () =>
        new Response(JSON.stringify(upstreamErr), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        }),
    );

    let captured: ProxyEvent | undefined;
    const proxy = createProxy({
      transform: {},
      onRequest: (e) => {
        captured = e;
      },
    });

    const res = await proxy(
      new Request('http://localhost/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: SAMPLE_REQ_BODY,
      }),
    );
    // Drain the client side so the tee can complete.
    const clientBody = await res.text();
    await new Promise((r) => setTimeout(r, 20));
    restore();

    expect(captured).toBeDefined();
    expect(captured!.status).toBe(400);
    expect(captured!.usage).toBeUndefined();
    expect(captured!.errorBody).toBe(JSON.stringify(upstreamErr));
    // Client must still receive the full body unchanged.
    expect(clientBody).toBe(JSON.stringify(upstreamErr));
  });

  it('caps the captured 4xx error body at ~2 KiB', async () => {
    const huge = 'x'.repeat(10_000);
    const restore = mockUpstream(
      () =>
        new Response(huge, {
          status: 400,
          headers: { 'content-type': 'text/plain' },
        }),
    );

    let captured: ProxyEvent | undefined;
    const proxy = createProxy({
      transform: {},
      onRequest: (e) => {
        captured = e;
      },
    });

    const res = await proxy(
      new Request('http://localhost/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: SAMPLE_REQ_BODY,
      }),
    );
    await res.text();
    await new Promise((r) => setTimeout(r, 20));
    restore();

    expect(captured).toBeDefined();
    expect(captured!.errorBody).toBeDefined();
    expect(captured!.errorBody!.length).toBe(2048);
  });

  /** Decompress a gzip Uint8Array back to bytes — mirror of proxy's gzipBytes. */
  async function gunzipBytes(buf: Uint8Array): Promise<Uint8Array> {
    const stream = new Response(buf as BufferSource).body!.pipeThrough(
      new DecompressionStream('gzip'),
    );
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  it('captures the FULL gzipped transformed body on 4xx + sets reqBodySha8', async () => {
    // Pair with errorBody so a future debugger can reconstruct
    // "we sent X, Anthropic said Y" from the JSONL alone. We gzip the body
    // so even a 170 KiB transformed payload fits inline once base64'd
    // (typical PNG-heavy bodies compress to <10% of source).
    const restore = mockUpstream(
      () =>
        new Response(JSON.stringify({ error: { type: 'bad' } }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        }),
    );

    let captured: ProxyEvent | undefined;
    const proxy = createProxy({
      transform: {},
      onRequest: (e) => {
        captured = e;
      },
    });

    const res = await proxy(
      new Request('http://localhost/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: SAMPLE_REQ_BODY,
      }),
    );
    await res.text();
    await new Promise((r) => setTimeout(r, 20));
    restore();

    expect(captured).toBeDefined();
    expect(captured!.status).toBe(400);

    // Hash lands on every event, not just 4xx.
    expect(captured!.reqBodySha8).toMatch(/^[0-9a-f]{8}$/);

    // Gzipped body is present, has the gzip magic header, and decompresses
    // back to the transformed JSON we sent upstream.
    expect(captured!.reqBodyGz).toBeDefined();
    expect(captured!.reqBodyGz![0]).toBe(0x1f);
    expect(captured!.reqBodyGz![1]).toBe(0x8b);

    const decoded = new TextDecoder().decode(
      await gunzipBytes(captured!.reqBodyGz!),
    );
    const parsed = JSON.parse(decoded);
    expect(parsed.model).toBe('claude-3-5-haiku-latest');
    expect(parsed.messages[0].role).toBe('user');
  });

  it('does NOT gzip the request body on 2xx (but still sets reqBodySha8)', async () => {
    const restore = mockUpstream(
      () =>
        new Response(JSON.stringify({
          id: 'x', type: 'message', role: 'assistant',
          content: [{ type: 'text', text: 'ok' }],
          model: 'x', stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );

    let captured: ProxyEvent | undefined;
    const proxy = createProxy({
      transform: {},
      onRequest: (e) => {
        captured = e;
      },
    });

    const res = await proxy(
      new Request('http://localhost/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: SAMPLE_REQ_BODY,
      }),
    );
    await res.text();
    await new Promise((r) => setTimeout(r, 20));
    restore();

    expect(captured).toBeDefined();
    expect(captured!.status).toBe(200);
    // Hash lands on every event.
    expect(captured!.reqBodySha8).toMatch(/^[0-9a-f]{8}$/);
    // But the gzipped body itself is only captured on 4xx.
    expect(captured!.reqBodyGz).toBeUndefined();
  });

  it('reqBodySha8 is identical across two requests with the same body', async () => {
    // Correlation use-case: spot "same payload sometimes works, sometimes
    // fails" patterns in events.jsonl.
    let restore = mockUpstream(
      () =>
        new Response('{"x":1}', {
          status: 400,
          headers: { 'content-type': 'application/json' },
        }),
    );

    const captures: ProxyEvent[] = [];
    const proxy = createProxy({
      transform: {},
      onRequest: (e) => {
        captures.push(e);
      },
    });

    for (let i = 0; i < 2; i++) {
      const res = await proxy(
        new Request('http://localhost/v1/messages', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: SAMPLE_REQ_BODY,
        }),
      );
      await res.text();
    }
    await new Promise((r) => setTimeout(r, 20));
    restore();

    expect(captures.length).toBe(2);
    expect(captures[0]!.reqBodySha8).toBeDefined();
    expect(captures[0]!.reqBodySha8).toBe(captures[1]!.reqBodySha8);
  });
});
