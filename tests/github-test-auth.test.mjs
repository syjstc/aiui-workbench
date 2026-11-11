import test from 'node:test';
import assert from 'node:assert/strict';
import { githubTestFetcher } from '../scripts/github-test-auth.mjs';

test('CI GitHub credentials stay on the intended HTTPS repository API and never reach download redirects', async () => {
  const requests = [], headers = { Accept: 'application/json' };
  const fetcher = githubTestFetcher('owner/repo', 'test-only-credential', async (url, options) => { requests.push({ url, headers: new Headers(options.headers) }); return new Response('{}'); });
  for (const url of ['https://api.github.com/repos/owner/repo/releases/latest', 'https://api.github.com/repos/other/repo/releases/latest', 'https://github.com/owner/repo/releases/download/v1.0.0/app.zip', 'https://release-assets.githubusercontent.com/installer.zip', 'http://api.github.com/repos/owner/repo/releases/latest']) await fetcher(url, { headers });
  assert.equal(requests[0].headers.get('Authorization'), 'Bearer test-only-credential');
  for (const request of requests.slice(1)) assert.equal(request.headers.get('Authorization'), null);
  assert.deepEqual(headers, { Accept: 'application/json' });
});
