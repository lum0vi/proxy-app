import type { Protocol } from './protocols.js';

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheWrite5mTokens?: number;
  cacheWrite1hTokens?: number;
  imageCount: number;
  videoSeconds?: number;
  estimated: boolean;
}

const emptyUsage = (): Usage => ({
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
  imageCount: 0,
  estimated: false,
});

function numberAt(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function anthropicUsage(value: Record<string, unknown>): Usage | null {
  const input = numberAt(value.input_tokens);
  const output = numberAt(value.output_tokens);
  if (input === null || output === null) return null;
  const reads = numberAt(value.cache_read_input_tokens) ?? 0;
  const durations = value.cache_creation as Record<string, unknown> | undefined;
  const hour = numberAt(durations?.ephemeral_1h_input_tokens);
  const short = numberAt(durations?.ephemeral_5m_input_tokens);
  const writes = Math.max(numberAt(value.cache_creation_input_tokens) ?? 0, (hour ?? 0) + (short ?? 0));
  const hourWrites = hour ?? (short === null ? writes : Math.max(0, writes - short));
  return {
    ...emptyUsage(), inputTokens: input + reads + writes, outputTokens: output, cachedInputTokens: reads,
    cacheWrite5mTokens: Math.max(0, writes - hourWrites), cacheWrite1hTokens: hourWrites,
  };
}

export function extractUsage(payload: unknown, protocol?: Protocol): Usage | null {
  if (!payload || typeof payload !== 'object') return null;
  const root = payload as Record<string, unknown>;
  if (protocol === 'GEMINI') {
    const value = root.usageMetadata as Record<string, unknown> | undefined;
    if (!value) return null;
    const prompt = numberAt(value.promptTokenCount);
    if (prompt === null) return null;
    return { ...emptyUsage(), inputTokens: prompt + (numberAt(value.toolUsePromptTokenCount) ?? 0),
      cachedInputTokens: numberAt(value.cachedContentTokenCount) ?? 0,
      outputTokens: (numberAt(value.candidatesTokenCount) ?? 0) + (numberAt(value.thoughtsTokenCount) ?? 0) };
  }
  const response = root.response && typeof root.response === 'object' ? root.response as Record<string, unknown> : root;
  const usage = response.usage;
  if (!usage || typeof usage !== 'object') return null;
  const value = usage as Record<string, unknown>;
  if (protocol === 'ANTHROPIC') return anthropicUsage(value);
  const inputDetails = (value.input_tokens_details ?? value.prompt_tokens_details) as Record<string, unknown> | undefined;
  const inputTokens = numberAt(value.input_tokens ?? value.prompt_tokens);
  const outputTokens = numberAt(value.output_tokens ?? value.completion_tokens);
  if (inputTokens === null || outputTokens === null) return null;
  return {
    inputTokens, outputTokens,
    cachedInputTokens: numberAt(inputDetails?.cached_tokens) ?? numberAt(value.prompt_cache_hit_tokens) ?? 0,
    imageCount: 0,
    estimated: false,
  };
}

export class StreamUsageTracker {
  private decoder = new TextDecoder();
  private buffer = '';
  private usage: Usage | null = null;
  private data: string[] = [];
  private dataLength = 0;
  private event = '';
  private anthropic: Record<string, unknown> = {};
  private skipFrame = false;
  private skipLine = false;
  terminal: 'completed' | 'failed' | 'incomplete' | null = null;
  outputBytes = 0;

  constructor(private protocol?: Protocol) {}

  push(chunk: Uint8Array): void {
    this.outputBytes += chunk.byteLength;
    const lines = (this.buffer + this.decoder.decode(chunk, { stream: true })).split(/\r?\n/);
    this.buffer = lines.pop()!;
    for (const line of lines) {
      if (this.skipLine) { this.skipLine = false; continue; }
      this.line(line);
    }
    if (this.buffer.length > 1024 * 1024) {
      this.skipLine = this.skipFrame = true;
      this.buffer = '';
    }
  }

  private line(line: string): void {
    if (line === '') {
      if (!this.skipFrame && this.data.length) this.frame(this.data.join('\n'));
      this.data = [];
      this.dataLength = 0;
      this.event = '';
      this.skipFrame = false;
    } else if (!this.skipFrame && line.startsWith('data:')) {
      this.dataLength += line.length;
      if (this.dataLength <= 1024 * 1024) this.data.push(line.slice(5).replace(/^ /, ''));
      else this.skipFrame = true;
    } else if (!this.skipFrame && line.startsWith('event:')) {
      this.event = line.slice(6).trim();
    }
  }

  private frame(data: string): void {
    if (data.trim() === '[DONE]') {
      this.terminal ??= 'completed';
      return;
    }
    try {
      const body = JSON.parse(data) as { type?: string; error?: unknown; message?: { usage?: Record<string, unknown> }; usage?: Record<string, unknown>;
        candidates?: { finishReason?: string }[]; promptFeedback?: { blockReason?: string } } | null;
      const type = body?.type ?? this.event;
      if (type === 'response.completed') this.terminal ??= 'completed';
      if (type === 'response.failed' || type === 'error' || body?.error) this.terminal = 'failed';
      if (type === 'response.incomplete') this.terminal ??= 'incomplete';
      if (type === 'message_stop') this.terminal ??= 'completed';
      if (this.protocol === 'GEMINI' && (body?.promptFeedback?.blockReason
        || (Array.isArray(body?.candidates) && body.candidates.some((item) => item?.finishReason)))) {
        this.terminal ??= 'completed';
      }
      if (this.protocol === 'ANTHROPIC') {
        const partial = type === 'message_start' ? body?.message?.usage : body?.usage;
        if (partial) this.anthropic = { ...this.anthropic, ...partial };
      }
      const candidate = this.protocol === 'ANTHROPIC' ? anthropicUsage(this.anthropic) : extractUsage(body, this.protocol);
      if (candidate) this.usage = candidate;
    } catch { /* Ignore frames without JSON; preserve all bytes on the wire. */ }
  }

  observedUsage(): Usage | null { return this.usage; }

  result(inputBytes: number, imageCount = 0): Usage {
    if (this.usage) return { ...this.usage, imageCount };
    return {
      ...emptyUsage(),
      inputTokens: Math.ceil(inputBytes / 4),
      outputTokens: Math.ceil(this.outputBytes / 4),
      imageCount,
      estimated: true,
    };
  }
}

export function usageFromBody(payload: unknown, inputBytes: number, outputBytes: number, imageCount = 0): Usage {
  return extractUsage(payload) ?? {
    inputTokens: Math.ceil(inputBytes / 4),
    outputTokens: Math.ceil(outputBytes / 4),
    cachedInputTokens: 0,
    imageCount,
    estimated: true,
  };
}
