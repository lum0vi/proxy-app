export const protocols = ['OPENAI', 'OPENAI_CHAT', 'ANTHROPIC', 'GEMINI', 'IMAGES'] as const;
export type Protocol = (typeof protocols)[number];

export const inferenceProtocols: Record<string, Protocol[]> = {
  '/v1/responses': ['OPENAI'],
  '/v1/responses/compact': ['OPENAI'],
  '/v1/chat/completions': ['OPENAI', 'OPENAI_CHAT'],
  '/v1/images/generations': ['IMAGES', 'OPENAI'],
  '/v1/messages': ['ANTHROPIC'],
  '/v1beta/generateContent': ['GEMINI'],
  '/v1beta/streamGenerateContent': ['GEMINI'],
};

export function catalogHeaders(protocol: Protocol, secret: string): Headers {
  const headers = new Headers({ accept: 'application/json' });
  if (protocol === 'GEMINI') headers.set('x-goog-api-key', secret);
  else headers.set('authorization', `Bearer ${secret}`);
  if (protocol === 'ANTHROPIC') {
    headers.set('anthropic-version', '2023-06-01');
    headers.set('x-api-key', secret);
  }
  return headers;
}

export function nativeError(path: string, status: number, code: string, message: string) {
  if (path.split('?', 1)[0] === '/v1/messages') {
    const type = status === 429 ? 'rate_limit_error' : status === 401 ? 'authentication_error'
      : status === 403 ? 'permission_error' : status === 404 ? 'not_found_error'
      : status === 413 ? 'request_too_large' : status === 529 ? 'overloaded_error'
      : status >= 500 ? 'api_error' : 'invalid_request_error';
    return { type: 'error', error: { type, message }, code };
  }
  if (path.startsWith('/v1beta/')) {
    const reason = status === 401 ? 'UNAUTHENTICATED' : status === 402 || status === 429 ? 'RESOURCE_EXHAUSTED'
      : status === 403 ? 'PERMISSION_DENIED' : status === 404 ? 'NOT_FOUND'
      : status === 504 ? 'DEADLINE_EXCEEDED' : status >= 500 ? 'UNAVAILABLE' : 'INVALID_ARGUMENT';
    return { error: { code: status, message, status: reason, details: [{ reason: code }] } };
  }
}
