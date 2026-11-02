'use strict';
const sharp = require('sharp');
const { HttpError } = require('./database-unit');
const MAX_BYTES = 500000, MAX_SIDE = 4096, MAX_PIXELS = 16000000;
const formats = { 'image/png': 'png', 'image/jpeg': 'jpeg', 'image/webp': 'webp' };
let processing = 0;
async function normalizeArtwork(dataUrl) {
  if (typeof dataUrl !== 'string' || dataUrl.length > 670000) {
    throw new HttpError(400, 'Artwork must be a PNG, JPEG or WebP up to 500 KB', 'INVALID_ARTWORK');
  }
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  if (!match) throw new HttpError(400, 'Unsupported artwork type or encoding', 'INVALID_ARTWORK');
  const bytes = Buffer.from(match[2], 'base64');
  if (bytes.length > MAX_BYTES || bytes.length < 12 || bytes.toString('base64') !== match[2]) {
    throw new HttpError(400, 'Artwork is empty, oversized or incorrectly encoded', 'INVALID_ARTWORK');
  }
  if (processing >= 2) throw new HttpError(429, 'Image processing is busy. Retry shortly.', 'ARTWORK_BUSY');
  processing++;
  try {
    const options = { failOn: 'warning', limitInputPixels: MAX_PIXELS, sequentialRead: true };
    const meta = await sharp(bytes, options).metadata();
    if (meta.format !== formats[match[1]] || !meta.width || !meta.height ||
        meta.width > MAX_SIDE || meta.height > MAX_SIDE || (meta.pages || 1) !== 1) {
      throw new HttpError(400, 'Artwork type mismatch, animation or dimensions over 4096 pixels', 'INVALID_ARTWORK');
    }
    // toBuffer forces a full pixel decode. Do not accept metadata-only validation.
    // Re-encoding strips EXIF/XMP/ICC and trailing payload, while respecting rotation.
    const output = await sharp(bytes, options).rotate()
      .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 82, effort: 3 }).timeout({ seconds: 5 }).toBuffer({ resolveWithObject: true });
    if (output.data.length > MAX_BYTES) throw new HttpError(400, 'Normalized artwork exceeds 500 KB', 'INVALID_ARTWORK');
    return { bytes: output.data, mime: 'image/webp', width: output.info.width, height: output.info.height };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, 'Artwork could not be fully decoded; use an intact PNG, JPEG or WebP', 'INVALID_ARTWORK');
  } finally { processing--; }
}
module.exports = { normalizeArtwork, MAX_BYTES, MAX_SIDE, MAX_PIXELS };
