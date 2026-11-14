import { describe, expect, it } from 'vitest';
import { extractUsage, StreamUsageTracker, usageFromBody } from './usage.js';

describe('usage extraction', () => {
  it('reads Responses API usage', () => {
    expect(extractUsage({
      usage: {
        input_tokens: 120,
        output_tokens: 30,
        input_tokens_details: { cached_tokens: 80 },
      },
    })).toEqual({
      inputTokens: 120,
      outputTokens: 30,
      cachedInputTokens: 80,
      imageCount: 0,
      estimated: false,
    });
  });

  it('reads Chat Completions usage', () => {
    expect(extractUsage({
      usage: {
        prompt_tokens: 90,
        completion_tokens: 10,
        prompt_tokens_details: { cached_tokens: 50 },
      },
    })?.cachedInputTokens).toBe(50);
  });

  it('tracks a fragmented Responses SSE completion event', () => {
    const tracker = new StreamUsageTracker();
    const event = 'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":77,"output_tokens":11,"input_tokens_details":{"cached_tokens":55}}}}\n\ndata: [DONE]\n\n';
    const bytes = Buffer.from(event);
    tracker.push(bytes.subarray(0, 37));
    tracker.push(bytes.subarray(37, 91));
    tracker.push(bytes.subarray(91));

    expect(tracker.result(999)).toEqual({
      inputTokens: 77,
      outputTokens: 11,
      cachedInputTokens: 55,
      imageCount: 0,
      estimated: false,
    });
  });

  it('uses a conservative byte estimate when the provider omits usage', () => {
    expect(usageFromBody({ ok: true }, 9, 17)).toEqual({
      inputTokens: 3,
      outputTokens: 5,
      cachedInputTokens: 0,
      imageCount: 0,
      estimated: true,
    });
  });
});
