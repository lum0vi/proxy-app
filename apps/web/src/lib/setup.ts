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

export function sampleRequest(origin: string, { model, protocol, mediaOptions = {} }: ModelOption) {
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
      return { url: v1 + '/images/generations', body: { model, prompt: 'A green glass prism', n: 1, ...mediaDefaults(mediaOptions) } };
    case 'VIDEOS':
      return { url: v1 + '/videos', body: { model, prompt: 'A paper boat on a calm lake', seconds: String(mediaOptions.seconds?.[0] ?? 4), ...mediaDefaults(mediaOptions) } };
    case 'OPENAI':
      return { url: v1 + '/responses', body: { model, input: prompt, stream: true } };
  }
}

function mediaDefaults(options: NonNullable<ModelOption['mediaOptions']>) {
  return Object.fromEntries(Object.entries(options).filter(([name, values]) => !['operations', 'seconds'].includes(name) && values.length).map(([name, values]) => [name, values[0]]));
}

export function connectionSnippets(origin: string, model = defaultModel, protocol: Protocol = 'OPENAI', mediaOptions: ModelOption['mediaOptions'] = {}) {
  const apiBase = `${origin.replace(/\/$/, '')}/v1`;
  const quotedModel = JSON.stringify(model);
  const { url, body, anthropic } = sampleRequest(origin, { model, protocol, mediaOptions });
  const request = JSON.stringify(body);
  const nodeRequest = protocol === 'OPENAI_CHAT'
    ? `client.chat.completions.create({ model: ${quotedModel}, messages: [{ role: "user", content: "Hello!" }] })`
    : protocol === 'IMAGES'
      ? `client.images.generate(${JSON.stringify(body, null, 2)})`
      : `client.responses.create({ model: ${quotedModel}, input: "Hello!", store: false })`;
  const packages = {
    OPENAI: '@opencode/ai/providers/openai-compatible/responses',
    OPENAI_CHAT: '@opencode/ai/providers/openai-compatible',
    ANTHROPIC: '@opencode/ai/providers/anthropic-compatible',
    GEMINI: '@opencode/ai/providers/google',
    IMAGES: '@opencode/ai/providers/openai-compatible',
    VIDEOS: '@opencode/ai/providers/openai-compatible',
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
model_provider = "ksapi"
web_search = "disabled"

[model_providers.ksapi]
name = "Ksapi"
base_url = "${apiBase}"
env_key = "KSAPI_API_KEY"
wire_api = "responses"
supports_websockets = false`,
    curl: `curl -N "${url}" \\
  -H "Authorization: Bearer $KSAPI_API_KEY" \\
  -H "Content-Type: application/json" \\
  ${anthropic ? '-H "anthropic-version: 2023-06-01" ' : ''}--data-binary '${request.replaceAll("'", "'\\''")}'`,
    node: protocol === 'ANTHROPIC' ? `import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({ apiKey: process.env.KSAPI_API_KEY, baseURL: "${origin}" });
const response = await client.messages.create({
  model: ${quotedModel}, max_tokens: 512,
  messages: [{ role: "user", content: "Hello!" }],
});
console.log(response.content);`
      : protocol === 'GEMINI' ? `import { GoogleGenAI } from "@google/genai";

const client = new GoogleGenAI({
  apiKey: process.env.KSAPI_API_KEY,
  httpOptions: { baseUrl: "${origin}", apiVersion: "v1beta" },
});
const response = await client.models.generateContent({ model: ${quotedModel}, contents: "Hello!" });
console.log(response.text);`
      : protocol === 'VIDEOS' ? `import OpenAI from "openai";
import { writeFile } from "node:fs/promises";

const client = new OpenAI({ apiKey: process.env.KSAPI_API_KEY, baseURL: "${apiBase}" });
let video = await client.videos.create(${JSON.stringify(body, null, 2)}, { headers: { "Idempotency-Key": crypto.randomUUID() } });
while (video.status === "queued" || video.status === "in_progress") {
  if ((video as unknown as { billing_status: string }).billing_status === "review_required") {
    throw new Error("Keep this video ID and contact support: " + video.id);
  }
  await new Promise(resolve => setTimeout(resolve, 10000));
  video = await client.videos.retrieve(video.id);
}
if (video.status !== "completed") throw new Error("Video generation failed");
const content = await client.videos.downloadContent(video.id);
await writeFile("video.mp4", Buffer.from(await content.arrayBuffer()));`
      : `import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.KSAPI_API_KEY,
  baseURL: "${apiBase}",
});

const response = await ${nodeRequest};`,
    claude: JSON.stringify({ env: claudeSettings }, null, 2),
    opencode: JSON.stringify({
      '$schema': 'https://opencode.ai/config.json',
      model: `ksapi/${model}`,
      providers: {
        ksapi: {
          name: 'Ksapi',
          env: ['KSAPI_API_KEY'],
          package: packages[protocol],
          settings: { baseURL: protocol === 'GEMINI' ? origin + '/v1beta' : apiBase },
          models: { [model]: { name: model } },
        },
      },
    }, null, 2),
  };
}
