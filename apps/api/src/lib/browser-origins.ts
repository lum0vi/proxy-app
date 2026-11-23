export function browserOrigins(publicAppUrl: string, additionalOrigins: string, production: boolean): string[] {
  const primary = new URL(publicAppUrl);
  if (!['http:', 'https:'].includes(primary.protocol) || primary.username || primary.password) {
    throw new Error('PUBLIC_APP_URL must be an HTTP(S) URL without credentials');
  }
  const origins = [primary.origin];
  for (const entry of additionalOrigins.split(',').map(value => value.trim()).filter(Boolean)) {
    let url: URL;
    try { url = new URL(entry); }
    catch { throw new Error('ADDITIONAL_BROWSER_ORIGINS must contain HTTP(S) origins separated by commas'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
      || url.pathname !== '/' || url.search || url.hash || url.hostname.includes('*')) {
      throw new Error('ADDITIONAL_BROWSER_ORIGINS must contain exact HTTP(S) origins without paths or credentials');
    }
    if (production && url.protocol !== 'https:') {
      throw new Error('ADDITIONAL_BROWSER_ORIGINS must use HTTPS in production');
    }
    origins.push(url.origin);
  }
  return [...new Set(origins)];
}
