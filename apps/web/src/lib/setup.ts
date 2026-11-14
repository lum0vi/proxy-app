import type { ModelOption, Protocol } from './store';

export const defaultModel = 'gpt-6.1-sol';
export const exampleKey = 'pk_live_YOUR_KEY';

export const exampleModels: ModelOption[] = [
  { model: defaultModel, protocol: 'OPENAI' },
  { model: 'claude-opus-5-5', protocol: 'ANTHROPIC' },
  { model: 'gemini-3.1-pro', protocol: 'GEMINI' },
  { model: 'grok-4.7', protocol: 'OPENAI' },
  { model: 'deepseek-flash', protocol: 'OPENAI_CHAT' },
  { model: 'gpt-image-2', protocol: 'IMAGES' },
];

export function sampleRequest(origin: string, { model, protocol }: ModelOption) {
  const v1 = origin + '/v1';
  const prompt = 'Hello!';
  const messages = [{ role: 'user', content: prompt }];
  switch (protocol) {
    case 'ANTHROPIC':
      return { url: v1 + '/messages', body: { model, messages, max_tokens: 512, stream: true }, anthropic: true };
    case 'GEMINI':
      return { url: origin + '/v1beta/models/' + encodeURIComponent(model) + ':streamGenerateContent?alt=sse',
        body: { contents: [{ parts: [{ text: prompt }] }] } };
    case 'OPENAI_CHAT':
      return { url: v1 + '/chat/completions', body: { model, messages, stream: true } };
    case 'IMAGES':
      return { url: v1 + '/images/generations', body: { model, prompt: 'A green glass prism', n: 1 } };
    case 'OPENAI':
      return { url: v1 + '/responses', body: { model, input: prompt, stream: true } };
  }
}

export function connectionSnippets(origin: string, model = defaultModel, protocol: Protocol = 'OPENAI') {
  const apiBase = `${origin.replace(/\/$/, '')}/v1`;
  const quotedModel = JSON.stringify(model);
  const { url, body, anthropic } = sampleRequest(origin, { model, protocol });
  const request = JSON.stringify(body);
  const nodeRequest = protocol === 'OPENAI_CHAT'
    ? `client.chat.completions.create({ model: ${quotedModel}, messages: [{ role: "user", content: "Hello!" }] })`
    : protocol === 'IMAGES'
      ? `client.images.generate({ model: ${quotedModel}, prompt: "A green glass prism" })`
      : `client.responses.create({ model: ${quotedModel}, input: "Hello!", store: false })`;
  const packages = {
    OPENAI: '@opencode/ai/providers/openai-compatible/responses',
    OPENAI_CHAT: '@opencode/ai/providers/openai-compatible',
    ANTHROPIC: '@opencode/ai/providers/anthropic-compatible',
    GEMINI: '@opencode/ai/providers/google',
    IMAGES: '@opencode/ai/providers/openai-compatible',
  };
  const claudeSettings = {
    ANTHROPIC_BASE_URL: origin,
    ANTHROPIC_AUTH_TOKEN: exampleKey,
    ANTHROPIC_MODEL: model,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CODE_ATTRIBUTION_HEADER: '0',
  };
  return {
    codex: `model = ${quotedModel}
model_provider = "proxykey"
web_search = "disabled"

[model_providers.proxykey]
name = "ProxyKey"
base_url = "${apiBase}"
env_key = "PROXYKEY_API_KEY"
wire_api = "responses"
supports_websockets = false`,
    curl: `curl -N "${url}" \\
  -H "Authorization: Bearer $PROXYKEY_API_KEY" \\
  -H "Content-Type: application/json" \\
  ${anthropic ? '-H "anthropic-version: 2023-06-01" ' : ''}--data-binary '${request.replaceAll("'", "'\\''")}'`,
    node: `import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.PROXYKEY_API_KEY,
  baseURL: "${apiBase}",
});

const response = await ${nodeRequest};`,
    claude: JSON.stringify({ env: claudeSettings }, null, 2),
    opencode: JSON.stringify({
      '$schema': 'https://opencode.ai/config.json',
      model: `proxykey/${model}`,
      providers: {
        proxykey: {
          name: 'ProxyKey',
          env: ['PROXYKEY_API_KEY'],
          package: packages[protocol],
          settings: { baseURL: protocol === 'GEMINI' ? origin + '/v1beta' : apiBase },
          models: { [model]: { name: model } },
        },
      },
    }, null, 2),
  };
}
