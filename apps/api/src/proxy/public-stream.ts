const publicError = { code: 'MODEL_RESPONSE_FAILED', message: 'The model could not complete the request' };
const frameBoundary = /\r?\n\r?\n/g;

function publicFrame(frame: string, protocol?: Protocol) {
  const lines = frame.split(/\r?\n/);
  const event = lines.find((line) => line.startsWith('event:'))?.slice(6).trim();
  const data = lines.filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
  let body: Record<string, unknown> | null = null;
  if (data.startsWith('{')) {
    try { body = JSON.parse(data) as Record<string, unknown>; } catch { /* Preserve frames without JSON. */ }
  }
  const sequence = typeof body?.sequence_number === 'number' ? { sequence_number: body.sequence_number } : {};
  if (event === 'error' || body?.type === 'error' || body?.error) {
    if (protocol === 'ANTHROPIC') return `event: error\ndata: ${JSON.stringify(nativeError('/v1/messages', 502, publicError.code, publicError.message))}`;
    if (protocol === 'GEMINI') return `data: ${JSON.stringify(nativeError('/v1beta/models', 502, publicError.code, publicError.message))}`;
  }
  if (event === 'response.failed' || body?.type === 'response.failed') {
    const response = body?.response as Record<string, unknown> | undefined;
    return `event: response.failed\ndata: ${JSON.stringify({
      type: 'response.failed', ...sequence,
      response: { id: response?.id, object: 'response', model: response?.model, status: 'failed', error: publicError, usage: response?.usage },
    })}`;
  }
  if (event === 'error' || body?.type === 'error') {
    return `event: error\ndata: ${JSON.stringify({ type: 'error', ...sequence, ...publicError, param: null })}`;
  }
  if (body?.error) return `data: ${JSON.stringify({ error: { ...publicError, type: 'upstream_error', param: null } })}`;
  return frame;
}

export class PublicEventStream {
  private decoder = new TextDecoder();
  private pending = '';
  private scanFrom = 0;

  constructor(private protocol?: Protocol) {}

  push(chunk: Uint8Array): string[] {
    this.pending += this.decoder.decode(chunk, { stream: true });
    const output = [];
    let start = 0;
    frameBoundary.lastIndex = this.scanFrom;
    for (let match = frameBoundary.exec(this.pending); match; match = frameBoundary.exec(this.pending)) {
      output.push(publicFrame(this.pending.slice(start, match.index), this.protocol) + match[0]);
      start = frameBoundary.lastIndex;
    }
    this.pending = this.pending.slice(start);
    this.scanFrom = Math.max(0, this.pending.length - 3);
    if (this.pending.length > 32 * 1024 * 1024) throw new Error('Response event exceeds the gateway limit');
    return output;
  }

  finish(): string {
    this.pending += this.decoder.decode();
    return this.pending ? publicFrame(this.pending, this.protocol) : '';
  }
}
import { nativeError, type Protocol } from './protocols.js';
