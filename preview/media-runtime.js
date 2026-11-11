import { encodePng } from './image-codec.js';

// Loaded only into the simulator's in-memory VFS, before the application's
// original app.js. No project or installed SDK files are changed.
if (typeof Canvas === 'function') {
  Canvas.prototype.convertToBlob = async function() {
    const pixels = this.getContext('2d').getImageData(0, 0, this.width, this.height);
    return new Blob([encodePng(this.width, this.height, pixels.data)], { type: 'image/png' });
  };
}
if (typeof ImageCapture === 'function' && typeof Canvas === 'function') {
  ImageCapture.prototype.takePhoto = async function() {
    const frame = await this.grabFrame();
    try {
      const canvas = new Canvas(frame.width, frame.height);
      canvas.getContext('2d').drawImage(frame, 0, 0);
      return await canvas.convertToBlob({ type: 'image/png' });
    } finally { frame.close(); }
  };
}
console.info('WORKBENCH_MEDIA_POLYFILLS', JSON.stringify({ encoding: 'image/png', photoSource: 'preview-frame' }));
