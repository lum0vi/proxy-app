import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import rawBody from 'fastify-raw-body';
import { ZodError } from 'zod';
import { sessionCookieName } from './auth/session.js';
import { config } from './config.js';
import { AppError } from './lib/errors.js';
import { metricsRoutes } from './observability/metrics.js';
import { nativeError } from './proxy/protocols.js';
import { proxyRoutes } from './proxy/router.js';
import { adminRoutes } from './routes/admin.js';
import { authRoutes } from './routes/auth.js';
import { healthRoutes } from './routes/health.js';
import { storeRoutes } from './routes/store.js';
import { webhookRoutes } from './routes/webhooks.js';

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: config.LOG_LEVEL, redact: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-api-key"]', 'req.headers["x-goog-api-key"]', 'body.password', 'body.apiKey'] },
    trustProxy: config.TRUST_PROXY,
    requestTimeout: 60_000,
    bodyLimit: 2 * 1024 * 1024,
  });

  await app.register(cookie);
  await app.register(cors, {
    origin: config.browserOrigins,
    credentials: true,
  });
  await app.register(helmet, {
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'same-site' },
  });
  await app.register(rateLimit, { max: 300, timeWindow: '1 minute' });
  await app.register(rawBody, { field: 'rawBody', global: false, encoding: false, runFirst: true });

  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_request, body, done) => done(null, body));

  app.addHook('onRequest', async (request) => {
    if (!request.url.startsWith('/api/') || ['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return;
    if (request.url.startsWith('/api/webhooks/')) return;
    if (!request.cookies[sessionCookieName]) return;
    const origin = request.headers.origin;
    if (origin && !config.browserOrigins.includes(origin)) {
      throw new AppError(403, 'INVALID_ORIGIN', 'Request origin is not allowed');
    }
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send(nativeError(request.url, 400, 'VALIDATION_ERROR', 'Invalid request')
        ?? { error: { code: 'VALIDATION_ERROR', message: 'Invalid request', details: error.issues } });
    }
    if (error instanceof AppError) {
      const type = error.statusCode === 429 ? 'rate_limit_error'
        : error.statusCode === 401 ? 'authentication_error' : error.statusCode >= 500 ? 'upstream_error' : 'invalid_request_error';
      return reply.code(error.statusCode).send(nativeError(request.url, error.statusCode, error.code, error.message) ?? { error: { code: error.code, message: error.message,
        ...(request.url.startsWith('/v1/') && { type }), details: error.details } });
    }
    const normalized = error instanceof Error ? error : new Error(String(error));
    request.log.error({ err: normalized }, 'Unhandled request error');
    const statusCode = 'statusCode' in normalized && typeof normalized.statusCode === 'number' ? normalized.statusCode : 500;
    const code = statusCode === 500 ? 'INTERNAL_ERROR' : 'REQUEST_ERROR';
    const message = statusCode === 500 ? 'Internal server error' : normalized.message;
    return reply.code(statusCode).send(nativeError(request.url, statusCode, code, message) ?? { error: { code, message } });
  });

  await metricsRoutes(app);
  await healthRoutes(app);
  await authRoutes(app);
  await storeRoutes(app);
  await webhookRoutes(app);
  await app.register(async (adminScope) => adminRoutes(adminScope));
  await proxyRoutes(app);

  app.get('/api/config', async () => ({
    appName: config.APP_NAME,
    paymentMethods: config.salesEnabled ? config.paymentMethods : [],
    paymentCurrencies: config.salesEnabled ? config.paymentCurrencies : [],
  }));

  return app;
}
