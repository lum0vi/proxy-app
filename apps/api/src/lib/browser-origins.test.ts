import { describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { sessionCookieName } from '../auth/session.js';
import { config } from '../config.js';
import { browserOrigins } from './browser-origins.js';

describe('browser origin allowlist', () => {
  it('normalizes configured origins and deduplicates them', () => {
    expect(browserOrigins('http://localhost:8080/', ' http://127.0.0.1:8080/,http://LOCALHOST:8080,,http://172.20.10.4:8080 ', false))
      .toEqual(['http://localhost:8080', 'http://127.0.0.1:8080', 'http://172.20.10.4:8080']);
  });
  it('rejects wildcards, non-HTTP URLs, paths, credentials and insecure production exceptions', () => {
    for (const invalid of ['*', 'null', 'file:///tmp', 'https://*.example.test', 'https://example.test/path',
      'https://example.test/?q=1', 'https://example.test/#fragment', 'https://user:password@example.test']) {
      expect(() => browserOrigins('http://localhost:8080', invalid, false)).toThrow('ADDITIONAL_BROWSER_ORIGINS');
    }
    expect(() => browserOrigins('https://app.example.test', 'http://localhost:8080', true)).toThrow('HTTPS');
    expect(() => browserOrigins('file:///tmp', '', false)).toThrow('PUBLIC_APP_URL');
  });
  it('uses the same exact allowlist for CORS and cookie-authenticated mutations', async () => {
    const app = await buildApp();
    app.post('/api/origin-probe', async () => ({ ok: true }));
    try {
      for (const origin of config.browserOrigins) {
        const response = await app.inject({ method: 'POST', url: '/api/origin-probe',
          headers: { origin, cookie: `${sessionCookieName}=synthetic-test-session` } });
        expect(response.statusCode).toBe(200);
        expect(response.headers['access-control-allow-origin']).toBe(origin);
      }
      for (const origin of ['https://evil.example', 'http://localhost:9999', 'http://localhost:8080.evil.example', 'null']) {
        const response = await app.inject({ method: 'POST', url: '/api/origin-probe',
          headers: { origin, host: 'localhost:8080', cookie: `${sessionCookieName}=synthetic-test-session` } });
        expect(response.statusCode).toBe(403);
        expect(response.json().error.code).toBe('INVALID_ORIGIN');
        expect(response.headers['access-control-allow-origin']).toBeUndefined();
        const read = await app.inject({ url: '/api/config', headers: { origin } });
        expect(read.headers['access-control-allow-origin']).toBeUndefined();
      }
    } finally { await app.close(); }
  });
});
