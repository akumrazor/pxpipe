import { describe, it, expect } from 'vitest';
import { toTrackEvent, JsonLogTracker, noopTracker, type TrackEvent } from '../src/core/tracker.js';
import type { ProxyEvent } from '../src/core/proxy.js';

describe('toTrackEvent', () => {
  it('flattens ProxyEvent + TransformInfo + Usage into a single record', () => {
    const ev: ProxyEvent = {
      method: 'POST',
      path: '/v1/messages',
      status: 200,
      durationMs: 1234,
      firstByteMs: 200,
      info: {
        compressed: true,
        origChars: 16000,
        imageCount: 1,
        imageBytes: 2103,
        staticChars: 14000,
        dynamicChars: 500,
        dynamicBlockCount: 2,
        systemSha8: 'a1b2c3d4',
        claudeMdSha8: 'cafebabe',
        firstUserSha8: 'deadbeef',
        unknownStaticTags: ['recent_files'],
        env: {
          cwd: '/Users/me/code/pp',
          isGitRepo: true,
          gitBranch: 'main',
          platform: 'darwin',
          osVersion: 'Darwin 25.0.0',
          today: '2026-05-18',
        },
      },
      usage: {
        input_tokens: 42,
        output_tokens: 7,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 100,
      },
    };
    const out = toTrackEvent(ev);
    // Spot-check every category of field made it across with the right
    // snake_case names.
    expect(out.method).toBe('POST');
    expect(out.path).toBe('/v1/messages');
    expect(out.status).toBe(200);
    expect(out.duration_ms).toBe(1234);
    expect(out.first_byte_ms).toBe(200);
    expect(out.compressed).toBe(true);
    expect(out.orig_chars).toBe(16000);
    expect(out.static_chars).toBe(14000);
    expect(out.dynamic_chars).toBe(500);
    expect(out.dynamic_block_count).toBe(2);
    expect(out.system_sha8).toBe('a1b2c3d4');
    expect(out.claude_md_sha8).toBe('cafebabe');
    expect(out.first_user_sha8).toBe('deadbeef');
    expect(out.unknown_static_tags).toEqual(['recent_files']);
    expect(out.cwd).toBe('/Users/me/code/pp');
    expect(out.git_branch).toBe('main');
    expect(out.is_git_repo).toBe(true);
    expect(out.input_tokens).toBe(42);
    expect(out.cache_read_tokens).toBe(100);
    expect(out.cache_create_tokens).toBe(0);
    // ts is ISO8601
    expect(out.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('handles a minimal ProxyEvent (no info, no usage) without throwing', () => {
    const out = toTrackEvent({
      method: 'GET',
      path: '/health',
      status: 200,
      durationMs: 4,
    });
    expect(out.method).toBe('GET');
    expect(out.compressed).toBeUndefined();
    expect(out.cwd).toBeUndefined();
    expect(out.input_tokens).toBeUndefined();
  });
});

describe('JsonLogTracker', () => {
  it('emits one JSON line per event to the sink', () => {
    const lines: string[] = [];
    const t = new JsonLogTracker((s) => lines.push(s));
    t.emit({ ts: '2026-05-18T00:00:00Z', method: 'POST', path: '/v1/messages', status: 200, duration_ms: 1 } as TrackEvent);
    t.emit({ ts: '2026-05-18T00:00:01Z', method: 'POST', path: '/v1/messages', status: 200, duration_ms: 2 } as TrackEvent);
    expect(lines).toHaveLength(2);
    const parsed = lines.map((l) => JSON.parse(l));
    expect(parsed[0].duration_ms).toBe(1);
    expect(parsed[1].duration_ms).toBe(2);
  });

  it('swallows sink errors — tracker must never break a request', () => {
    const t = new JsonLogTracker(() => {
      throw new Error('disk full');
    });
    expect(() =>
      t.emit({ ts: 'x', method: 'POST', path: '/v1/messages', status: 200, duration_ms: 1 } as TrackEvent),
    ).not.toThrow();
  });
});

describe('noopTracker', () => {
  it('discards events silently', () => {
    expect(() =>
      noopTracker.emit({ ts: 'x', method: 'POST', path: '/v1/messages', status: 200, duration_ms: 1 } as TrackEvent),
    ).not.toThrow();
  });
});

describe('toTrackEvent body-sample mapping', () => {
  const baseEv = {
    method: 'POST',
    path: '/v1/messages',
    status: 400,
    durationMs: 100,
  };

  it('inlines small gzipped bodies as req_body_sample_b64', () => {
    const small = new Uint8Array(64).fill(0x1f);
    const out = toTrackEvent({
      ...baseEv,
      reqBodySha8: 'deadbeef',
      reqBodyGz: small,
    } as ProxyEvent);
    expect(out.req_body_sha8).toBe('deadbeef');
    expect(out.req_body_sample_b64).toBeDefined();
    expect(out.req_body_sample_b64!.length).toBeLessThanOrEqual(128);
    expect(out.req_body_sample_path).toBeUndefined();
  });

  it('drops oversized gzipped bodies that lack a sidecar path', () => {
    // 40 KiB of gz bytes → ~53 KiB base64 → exceeds the 32 KiB cap, and we
    // didn't pre-write a sidecar → must silently drop the inline body
    // (Workers path). req_body_sha8 still lands.
    const big = new Uint8Array(40 * 1024).fill(0x42);
    const out = toTrackEvent({
      ...baseEv,
      reqBodySha8: 'cafef00d',
      reqBodyGz: big,
    } as ProxyEvent);
    expect(out.req_body_sha8).toBe('cafef00d');
    expect(out.req_body_sample_b64).toBeUndefined();
    expect(out.req_body_sample_path).toBeUndefined();
  });

  it('prefers reqBodySamplePath over inlining when both are set', () => {
    const someGz = new Uint8Array(64).fill(0x1f);
    const out = toTrackEvent({
      ...baseEv,
      reqBodySha8: 'feedface',
      reqBodyGz: someGz,
      reqBodySamplePath: '/tmp/4xx-bodies/x.json.gz',
    } as ProxyEvent);
    // Sidecar path wins; we don't double-encode inline.
    expect(out.req_body_sample_path).toBe('/tmp/4xx-bodies/x.json.gz');
    expect(out.req_body_sample_b64).toBeUndefined();
  });

  it('sets req_body_sha8 on 2xx events too (correlation across statuses)', () => {
    const out = toTrackEvent({
      ...baseEv,
      status: 200,
      reqBodySha8: '01234567',
    } as ProxyEvent);
    expect(out.req_body_sha8).toBe('01234567');
    // No body sample fields for 2xx.
    expect(out.req_body_sample_b64).toBeUndefined();
    expect(out.req_body_sample_path).toBeUndefined();
  });
});
