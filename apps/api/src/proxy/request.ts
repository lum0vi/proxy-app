import type { FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { sha256 } from '../lib/crypto.js';
import { AppError } from '../lib/errors.js';

const methods = new Map([
  ['/v1/models', 'GET'],
  ['/v1/responses', 'POST'],
  ['/v1/responses/compact', 'POST'],
  ['/v1/chat/completions', 'POST'],
  ['/v1/images/generations', 'POST'],
  ['/v1/images/edits', 'POST'],
  ['/v1/videos', 'POST'],
  ['/v1/messages', 'POST'],
  ['/v1/messages/count_tokens', 'POST'],
  ['/v1beta/models', 'GET'],
  ['/v1/models/:model', 'GET'],
  ['/v1beta/models/:model', 'GET'],
  ['/v1beta/generateContent', 'POST'],
  ['/v1beta/streamGenerateContent', 'POST'],
  ['/v1beta/countTokens', 'POST'],
]);

function geminiRoute(path: string) {
  return /^\/v1(?:beta)?\/models\/([A-Za-z0-9_.-]{1,200}):(generateContent|streamGenerateContent|countTokens)$/.exec(path);
}

export function enabledEndpoint(request: FastifyRequest): string {
  const [url, ...queryParts] = request.url.split('?');
  const query = queryParts.length ? queryParts.join('?') : undefined;
  const gemini = geminiRoute(url!);
  const model = /^\/(v1|v1beta)\/models\/([A-Za-z0-9_.-]{1,200})$/.exec(url!);
  const path = gemini ? `/v1beta/${gemini[2]}` : model ? `/${model[1]}/models/:model` : url!;
  const enabled = config.proxyAllowedPaths.includes(path)
    || (model && config.proxyAllowedPaths.includes(`/${model[1]}/models`))
    || (path === '/v1/images/generations' && config.proxyAllowedPaths.includes('/v1/images'));
  if (!methods.has(path) || !enabled || (!gemini && path.startsWith('/v1beta/') && !path.startsWith('/v1beta/models'))) {
    throw new AppError(404, 'ENDPOINT_NOT_ALLOWED', 'This API endpoint is not enabled');
  }
  if (methods.get(path) !== request.method) throw new AppError(405, 'METHOD_NOT_ALLOWED', 'This HTTP method is not enabled for the endpoint');
  if (query !== undefined && path !== '/v1/models' && !(path === '/v1beta/streamGenerateContent' && query === 'alt=sse')
    && !(path.startsWith('/v1/messages') && query === 'beta=true')
    && !(path === '/v1beta/models' && query.split('&').every(part => /^(pageSize=\d{1,4}|pageToken=[A-Za-z0-9_.-]+)$/.test(part)))) {
    throw new AppError(400, 'QUERY_NOT_SUPPORTED', 'Use the JSON request body instead of query parameters');
  }
  return path;
}

function scopedId(keyId: string, value: string): string {
  const digest = sha256(`${keyId}\0${value}`);
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

const cacheHeaders = ['session_id', 'session-id', 'x-session-id', 'prompt_cache_key', 'x-prompt-cache-key', 'x-grok-conv-id'];

export function upstreamHeaders(request: FastifyRequest, keyId: string, upstreamKey: string, requestId: string): Headers {
  const headers = new Headers({ authorization: `Bearer ${upstreamKey}`, 'content-type': 'application/json', 'x-proxy-request-id': requestId });
  for (const name of ['accept', 'user-agent', 'openai-beta', 'originator']) {
    const value = request.headers[name];
    if (typeof value === 'string') headers.set(name, value);
  }
  for (const name of cacheHeaders) {
    const value = request.headers[name];
    if (typeof value === 'string' && value) headers.set(name, scopedId(keyId, value));
  }
  return headers;
}

export function nativeHeaders(headers: Headers, request: FastifyRequest, endpoint: string, secret: string) {
  if (endpoint.startsWith('/v1/messages')) {
    const version = request.headers['anthropic-version'];
    headers.set('x-api-key', secret);
    headers.set('anthropic-version', typeof version === 'string' ? version : '2023-06-01');
    const beta = request.headers['anthropic-beta'];
    if (typeof beta === 'string') headers.set('anthropic-beta', beta);
  }
  if (endpoint.startsWith('/v1beta/')) {
    headers.delete('authorization');
    headers.set('x-goog-api-key', secret);
  }
  return headers;
}

function boundedInt(value: unknown, name: string, maximum: number, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new AppError(400, 'INVALID_REQUEST_LIMIT', `${name} must be an integer from 1 to ${maximum}`);
  }
  return value;
}

export interface PreparedInference {
  model: string;
  buffer: Buffer;
  upstreamPath: string;
  outputBudget: number;
  images: number;
  cacheWrite: boolean;
  countOnly: boolean;
  contentType: string;
  videoSeconds?: number;
  media?: Record<string, unknown>;
  inputHash?: string;
}

export function prepareInference(request: FastifyRequest, endpoint: string, keyId: string): PreparedInference {
  if (request.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json'
    || !request.body || typeof request.body !== 'object' || Array.isArray(request.body) || Buffer.isBuffer(request.body)) {
    throw new AppError(415, 'JSON_REQUIRED', 'This endpoint requires a JSON object');
  }
  const json = { ...request.body } as Record<string, unknown>;
  const gemini = geminiRoute(request.url.split('?', 1)[0]!);
  const isAnthropic = endpoint.startsWith('/v1/messages');
  const countOnly = endpoint.endsWith('/count_tokens') || endpoint.endsWith('/countTokens');
  const model = gemini?.[1] ?? json.model;
  if (typeof model !== 'string' || !model.trim() || model.length > 200) throw new AppError(400, 'MODEL_REQUIRED', 'A model is required for this endpoint');
  if (gemini && countOnly && json.generateContentRequest != null) {
    const nested = json.generateContentRequest;
    if (!nested || typeof nested !== 'object' || Array.isArray(nested)) throw new AppError(400, 'INVALID_REQUEST', 'generateContentRequest must be an object');
    const contents = nested as Record<string, unknown>;
    if (contents.model !== undefined && contents.model !== model && contents.model !== `models/${model}`) {
      throw new AppError(400, 'MODEL_MISMATCH', 'The counted model must match the URL');
    }
    assertStatelessInputs(contents);
    if (contents.cachedContent != null || contents.cached_content != null) throw new AppError(400, 'STORED_RESOURCE_NOT_SUPPORTED', 'Use inline content');
  }

  const isImage = endpoint === '/v1/images/generations';
  const isChat = endpoint === '/v1/chat/completions';
  if (json.previous_response_id != null || json.conversation != null || json.background === true) {
    throw new AppError(400, 'STATEFUL_REQUEST_NOT_SUPPORTED', 'Send full history or a stateless compacted input; stored conversations and background requests are not supported');
  }
  if (!isImage && !isAnthropic && !gemini && endpoint !== '/v1/responses/compact') json.store = false;
  if (endpoint === '/v1/responses/compact' && json.store === true) {
    throw new AppError(400, 'STATEFUL_REQUEST_NOT_SUPPORTED', 'This compact endpoint requires stateless requests');
  }
  if (isImage && json.stream === true) throw new AppError(400, 'IMAGE_STREAM_NOT_SUPPORTED', 'Use non-streaming image generation');

  // Prices only cover standard text generation. A caller must not select a
  // different upstream billing tier or audio pricing through pass-through fields.
  if (endpoint === '/v1/responses' || isChat) {
    if (json.service_tier != null && !['auto', 'default'].includes(String(json.service_tier))) {
      throw new AppError(400, 'UNPRICED_REQUEST_OPTION', 'Use the default service tier for this model');
    }
    json.service_tier = 'default';
  }
  if (isChat && (json.audio != null || (json.modalities != null
    && (!Array.isArray(json.modalities) || json.modalities.some(value => value !== 'text'))))) {
    throw new AppError(400, 'UNPRICED_REQUEST_OPTION', 'Audio generation is not priced by this gateway');
  }
  if (endpoint.startsWith('/v1/responses') && json.prompt != null) {
    throw new AppError(400, 'STORED_RESOURCE_NOT_SUPPORTED', 'Send inline instructions instead of an upstream prompt template');
  }

  // Shared upstream accounts cannot safely use tools or attachments referencing
  // resources stored on that account. Client-side tools and stateless compaction work.
  const tools = json.tools;
  const allowedTool = gemini ? localGeminiTool : isAnthropic ? localAnthropicTool : localTool;
  if (tools != null && (!Array.isArray(tools) || !tools.every(allowedTool))) {
    throw new AppError(400, 'HOSTED_TOOLS_NOT_SUPPORTED', 'This gateway accepts client-side function and custom tools only');
  }
  if (json.web_search_options != null) throw new AppError(400, 'HOSTED_TOOLS_NOT_SUPPORTED', 'Provider-side web search is not supported');
  if (gemini && (json.cachedContent != null || json.cached_content != null || json.model != null)) {
    throw new AppError(400, 'STATEFUL_REQUEST_NOT_SUPPORTED', 'Use inline content and select the model in the URL');
  }
  if (isAnthropic && (json.container != null || json.context_management != null || json.mcp_servers != null || json.fallbacks != null)) {
    throw new AppError(400, 'STATEFUL_REQUEST_NOT_SUPPORTED', 'Send an independent request with client-side tools');
  }
  if (isAnthropic && json.speed != null && json.speed !== 'standard') {
    throw new AppError(400, 'UNPRICED_REQUEST_OPTION', 'Use the standard speed for this model');
  }
  assertStatelessInputs(json.input, json.messages, json.system, json.contents);
  const cacheWrite = isAnthropic;

  for (const field of ['session_id', 'prompt_cache_key'] as const) {
    if (typeof json[field] === 'string' && json[field]) json[field] = scopedId(keyId, json[field]);
  }
  if (isChat && config.FORCE_STREAM_USAGE && json.stream === true) {
    const options = json.stream_options;
    json.stream_options = { ...(options && typeof options === 'object' && !Array.isArray(options) ? options : {}), include_usage: true };
  }

  const outputCeiling = config.PROXY_ASSUMED_MAX_OUTPUT_TOKENS;
  const generation = json.generationConfig ?? json.generation_config;
  const options = (generation && typeof generation === 'object' ? generation : {}) as Record<string, unknown>;
  const modalities = options.responseModalities ?? options.response_modalities;
  if (gemini && (options.routingConfig != null || options.routing_config != null || options.modelSelectionConfig != null
    || options.model_selection_config != null || (modalities != null && (!Array.isArray(modalities) || modalities.some((item) => item !== 'TEXT'))))) {
    throw new AppError(400, 'UNPRICED_REQUEST_OPTION', 'Use the model in the URL and request text output');
  }
  const candidates = isChat ? boundedInt(json.n, 'n', 8, 1)
    : gemini ? boundedInt(options.candidateCount ?? options.candidate_count, 'candidateCount', 8, 1) : 1;
  const outputBudget = isImage || countOnly ? 0 : (gemini
    ? geminiOutputBudget(options, outputCeiling)
    : isAnthropic ? boundedInt(json.max_tokens, 'max_tokens', outputCeiling, outputCeiling)
    : isChat
    ? Math.max(boundedInt(json.max_tokens, 'max_tokens', outputCeiling, 0),
      boundedInt(json.max_completion_tokens, 'max_completion_tokens', outputCeiling, 0)) || outputCeiling
    : boundedInt(json.max_output_tokens, 'max_output_tokens', outputCeiling, outputCeiling)) * candidates;
  const images = isImage ? boundedInt(json.n, 'n', 10, 1) : 0;
  const upstreamPath = gemini ? `/v1beta/models/${model}:${gemini[2]}${endpoint.endsWith('/streamGenerateContent') ? '?alt=sse' : ''}`
    : isAnthropic && request.url.endsWith('?beta=true') ? `${endpoint}?beta=true` : endpoint;
  return { model, images, outputBudget, cacheWrite, countOnly, contentType: 'application/json', upstreamPath, buffer: Buffer.from(JSON.stringify(json)) };
}

function geminiOutputBudget(options: Record<string, unknown>, maximum: number): number {
  const output = boundedInt(options.maxOutputTokens ?? options.max_output_tokens, 'maxOutputTokens', maximum, maximum);
  const config = (options.thinkingConfig ?? options.thinking_config) as Record<string, unknown> | undefined;
  const budget = config?.thinkingBudget ?? config?.thinking_budget;
  // Dynamic thinking may use tokens beyond the requested visible output.
  if (budget == null || budget === -1) return maximum;
  return Math.min(maximum, output + (budget === 0 ? 0 : boundedInt(budget, 'thinkingBudget', maximum, 0)));
}

function localAnthropicTool(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const tool = value as Record<string, unknown>;
  return (tool.type === undefined || tool.type === 'custom') && typeof tool.name === 'string' && !!tool.input_schema;
}

function localGeminiTool(value: unknown): boolean {
  return !!value && typeof value === 'object' && Object.keys(value).length === 1
    && (('functionDeclarations' in value && Array.isArray(value.functionDeclarations))
      || ('function_declarations' in value && Array.isArray(value.function_declarations)));
}

function localTool(value: unknown): boolean {
  if (!value || typeof value !== 'object' || !('type' in value)) return false;
  if (value.type === 'function' || value.type === 'custom') return true;
  // A namespace is a client-side grouping of function/custom definitions.
  return value.type === 'namespace' && 'tools' in value && Array.isArray(value.tools) && value.tools.every((tool: unknown) => {
    return !!tool && typeof tool === 'object' && 'type' in tool && (tool.type === 'function' || tool.type === 'custom');
  });
}

function assertStatelessInputs(...inputs: unknown[]): void {
  // Traverse nested content; function arguments serialized as strings stay opaque.
  const queue = [...inputs];
  while (queue.length > 0) {
    const value = queue.pop();
    if (!value || typeof value !== 'object') continue;
    if (Array.isArray(value)) {
      for (const item of value) queue.push(item);
      continue;
    }
    const item = value as Record<string, unknown>;
    if (item.type === 'input_audio' || item.type === 'audio') {
      throw new AppError(400, 'UNPRICED_REQUEST_OPTION', 'Audio input is not priced by this gateway');
    }
    if (item.type === 'item_reference' || item.file_id != null || item.type === 'file_id' || item.fileData != null || item.file_data != null
      || (item.type === 'tool_reference') || item.type === 'container_upload') {
      throw new AppError(400, 'STORED_RESOURCE_NOT_SUPPORTED', 'Provide inline inputs instead of an upstream file or item ID');
    }
    for (const nested of Object.values(item)) queue.push(nested);
  }
}
