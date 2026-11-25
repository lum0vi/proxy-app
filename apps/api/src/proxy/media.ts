import type { FastifyRequest } from 'fastify';
import { sha256 } from '../lib/crypto.js';
import { AppError } from '../lib/errors.js';
import type { PreparedInference } from './request.js';

export type MediaOptions = Record<string, (string | number | boolean)[]>;
const pricedOptions = ['size', 'quality', 'background', 'input_fidelity', 'resolution', 'aspect_ratio', 'audio'] as const;
const imageFields = new Set(['model', 'prompt', 'n', 'image', 'images', 'mask', 'size', 'quality', 'background', 'response_format',
  'output_format', 'output_compression', 'input_fidelity', 'moderation', 'user']);
const videoFields = new Set(['model', 'prompt', 'seconds', 'size', 'input_reference', 'resolution', 'aspect_ratio', 'audio']);

const invalid = (message: string) => new AppError(400, 'INVALID_MEDIA_REQUEST', message);

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, sorted(v)]));
  return value;
}

function imageReference(value: unknown): boolean {
  if (typeof value === 'string') {
    if (/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=\r\n]+$/.test(value)) return true;
    try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password; } catch { return false; }
  }
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === 1 && 'image_url' in value && imageReference(value.image_url);
}

// Keep uploaded bytes intact. Parse once to enforce the same model, limits and
// price options for JSON and SDK multipart uploads before reserving any money.
export async function prepareMedia(request: FastifyRequest, video = false): Promise<PreparedInference> {
  const contentType = request.headers['content-type'] ?? '';
  const json: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  const fileHashes: Record<string, string[]> = {};
  let buffer: Buffer;
  if (contentType.toLowerCase().startsWith('multipart/form-data;') && Buffer.isBuffer(request.body)) {
    let form: FormData;
    try {
      form = await new Request('http://upload.invalid', { method: 'POST', headers: { 'content-type': contentType }, body: new Uint8Array(request.body) }).formData();
    } catch { throw invalid('Malformed multipart form'); }
    const entries = [...form.entries()];
    if (entries.length > 40) throw invalid('Too many form fields');
    for (const [name, value] of entries) {
      const field = name === 'image[]' ? 'image' : name;
      if (typeof value === 'string') {
        if (field in json || field in fileHashes) throw invalid(`Duplicate ${field}`);
        json[field] = ['n', 'seconds', 'output_compression'].includes(field) ? Number(value) : value;
      } else {
        if (!(video ? ['input_reference'] : ['image', 'mask']).includes(field) || field in json
          || !['image/png', 'image/jpeg', 'image/webp'].includes(value.type) || !value.size) throw invalid('Use PNG, JPEG or WebP image files');
        (fileHashes[field] ??= []).push(sha256(Buffer.from(await value.arrayBuffer())));
        if (fileHashes[field]!.length > (field === 'image' ? 16 : 1)) throw invalid('Too many images');
      }
    }
    buffer = request.body;
  } else if (contentType.split(';')[0]?.trim().toLowerCase() === 'application/json'
    && request.body && typeof request.body === 'object' && !Array.isArray(request.body) && !Buffer.isBuffer(request.body)) {
    Object.assign(json, request.body);
    buffer = Buffer.from(JSON.stringify(json));
  } else throw new AppError(415, 'MEDIA_BODY_REQUIRED', 'Use a JSON object or multipart/form-data');

  const allowed = video ? videoFields : imageFields;
  for (const field of Object.keys(json)) if (!allowed.has(field)) throw invalid(`Unsupported media option: ${field}`);
  if (typeof json.model !== 'string' || !json.model.trim() || json.model.length > 200) throw invalid('Specify a model');
  if (typeof json.prompt !== 'string' || !json.prompt.trim() || json.prompt.length > 32_000) throw invalid('Specify a prompt of 1 to 32000 characters');
  const edit = request.url.split('?')[0] === '/v1/images/edits';
  for (const name of ['image', 'mask', 'input_reference']) {
    const value = json[name];
    if (value !== undefined && !(Array.isArray(value) && name === 'image'
      ? value.length > 0 && value.length <= 16 && value.every(imageReference) : imageReference(value))) throw invalid(`Invalid ${name}; use image bytes or an HTTPS image URL`);
  }
  if (json.images !== undefined && (!Array.isArray(json.images) || !json.images.length || json.images.length > 16 || !json.images.every(imageReference))) throw invalid('Invalid images');
  if (edit && json.image === undefined && json.images === undefined && !fileHashes.image) throw invalid('Image editing requires an image');
  if (!video && !edit && (json.image !== undefined || json.images !== undefined || json.mask !== undefined || Object.keys(fileHashes).length)) throw invalid('Use /v1/images/edits for image input');
  if (json.response_format !== undefined && !['url', 'b64_json'].includes(String(json.response_format))) throw invalid('Invalid response_format');
  if (json.output_format !== undefined && !['png', 'jpeg', 'webp'].includes(String(json.output_format))) throw invalid('Invalid output_format');
  if (json.output_compression !== undefined && (!Number.isInteger(json.output_compression) || Number(json.output_compression) < 0 || Number(json.output_compression) > 100)) throw invalid('Invalid output_compression');
  const images = video ? 0 : json.n === undefined ? 1 : Number(json.n);
  const seconds = video ? Number(json.seconds) : 0;
  if (!video && (!Number.isInteger(images) || images < 1 || images > 10)) throw invalid('n must be an integer from 1 to 10');
  if (video && (!Number.isInteger(seconds) || seconds < 1 || seconds > 120)) throw invalid('seconds must be an integer from 1 to 120');
  return { model: json.model, images, videoSeconds: seconds, outputBudget: 0, cacheWrite: false, countOnly: false,
    contentType, buffer, upstreamPath: video ? '/v1/videos' : edit ? '/v1/images/edits' : '/v1/images/generations', media: json,
    inputHash: sha256(JSON.stringify(sorted({ json: { ...json, ...(video ? { seconds } : { n: images }) }, fileHashes }))) };
}

export function validateMediaRate(body: PreparedInference, options: MediaOptions) {
  if (!body.media) return;
  if (body.upstreamPath === '/v1/images/edits' && !options.operations?.includes('edit')) {
    throw new AppError(400, 'UNPRICED_MEDIA_OPTION', 'Image editing is not enabled at this model price');
  }
  if (body.videoSeconds && (!options.seconds?.includes(body.videoSeconds))) {
    throw new AppError(400, 'UNPRICED_MEDIA_OPTION', 'This duration is not configured for this model');
  }
  for (const name of pricedOptions) {
    const value = body.media[name];
    if ((options[name] && value === undefined) || (value !== undefined && (!['string', 'number', 'boolean'].includes(typeof value) || !options[name]?.includes(value as string | number | boolean)))) {
      throw new AppError(400, 'UNPRICED_MEDIA_OPTION', `${name} is not included in the configured model price`);
    }
  }
}
