// Grant video only to the local runtime iframe in the workbench window.
// Selecting the computer-camera source is handled inside the simulator.
function previewRequest(webContents, expected, permission, origin, requestingUrl) {
  if (!expected || webContents !== expected || permission !== 'media') return false;
  try { const url = new URL(requestingUrl); return url.origin === origin && url.pathname === '/runtime/preview/index.html'; }
  catch { return false; }
}
function installMediaPermissions(session, { getWebContents, origin }) {
  session.setPermissionCheckHandler((contents, permission, requestingOrigin, details) =>
    requestingOrigin === origin && details.mediaType === 'video' &&
    previewRequest(contents, getWebContents(), permission, origin, details.requestingUrl));
  session.setPermissionRequestHandler((contents, permission, callback, details) => callback(
    previewRequest(contents, getWebContents(), permission, origin, details.requestingUrl) &&
    details.mediaTypes?.length > 0 && details.mediaTypes.every(type => type === 'video')));
}
module.exports = { installMediaPermissions };
