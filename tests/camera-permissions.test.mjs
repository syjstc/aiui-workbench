import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { installMediaPermissions } = createRequire(import.meta.url)('../electron/media-permissions.cjs');

test('camera permission is limited to video in the workbench runtime frame', () => {
  const contents = {}, origin = 'http://127.0.0.1:12345', handlers = {};
  installMediaPermissions({ setPermissionCheckHandler: fn => handlers.check = fn, setPermissionRequestHandler: fn => handlers.request = fn }, { getWebContents: () => contents, origin });
  const details = { requestingUrl: origin + '/runtime/preview/index.html?session=test', mediaType: 'video', mediaTypes: ['video'] };
  assert.equal(handlers.check(contents, 'media', origin, details), true);
  const request = (sender, permission, value) => { let result; handlers.request(sender, permission, r => result = r, value); return result; };
  assert.equal(request(contents, 'media', details), true);
  for (const override of [{ mediaTypes: ['audio'] }, { mediaTypes: ['audio', 'video'] }, { mediaTypes: [] }, { requestingUrl: 'https://example.com/runtime/preview/index.html' }, { requestingUrl: origin + '/sdk/test/index.js' }])
    assert.equal(request(contents, 'media', { ...details, ...override }), false);
  assert.equal(request({}, 'media', details), false);
  assert.equal(request(contents, 'display-capture', details), false);
  assert.equal(handlers.check(contents, 'media', origin, { ...details, mediaType: 'audio' }), false);
  assert.equal(handlers.check(contents, 'media', 'https://example.com', details), false);
});
