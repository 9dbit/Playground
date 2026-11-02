'use strict';
const { RequestError } = require('./transaction');
// Decode outside SQL transactions. Limit resource usage and strip metadata by re-encoding.
const INPUT_BYTES = 500000, OUTPUT_BYTES = 500000, MAX_SIDE = 4096, MAX_PIXELS = 16777216;
let running = 0;
async function normalizeArtwork(data) {
  if (typeof data !== 'string' || data.length > 700000) throw new RequestError(413, 'Artwork exceeds upload size limit', 'IMAGE_LIMIT');
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(data);
  if (!match) throw new RequestError(400, 'Use a PNG, JPEG or WebP image', 'INVALID_IMAGE');
  const input = Buffer.from(match[2], 'base64');
  if (!input.length || input.length > INPUT_BYTES || input.toString('base64') !== match[2]) throw new RequestError(400, 'Invalid image encoding or size', 'INVALID_IMAGE');
  if (running >= 2) throw new RequestError(429, 'Image processing is busy, retry shortly', 'IMAGE_BUSY');
  running++;
  try {
    const sharp = require('sharp');
    const options = { failOn: 'warning', limitInputPixels: MAX_PIXELS, sequentialRead: true };
    const meta = await sharp(input, options).metadata();
    const expected = { 'image/png': 'png', 'image/jpeg': 'jpeg', 'image/webp': 'webp' }[match[1]];
    if (meta.format !== expected || !meta.width || !meta.height || meta.width > MAX_SIDE || meta.height > MAX_SIDE || (meta.pages || 1) !== 1) throw new RequestError(400, 'Unsupported image dimensions, format or animation', 'INVALID_IMAGE');
    const result = await sharp(input, options).timeout({ seconds: 5 }).rotate()
      .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 85 }).toBuffer({ resolveWithObject: true });
    if (result.data.length > OUTPUT_BYTES) throw new RequestError(413, 'Normalized artwork exceeds 500 KB', 'IMAGE_LIMIT');
    return { bytes: result.data, mime: 'image/webp', width: result.info.width, height: result.info.height };
  } catch (error) {
    if (error instanceof RequestError) throw error;
    throw new RequestError(400, 'Artwork is corrupt, truncated or cannot be decoded', 'INVALID_IMAGE');
  } finally { running--; }
}
module.exports = { normalizeArtwork, INPUT_BYTES, MAX_PIXELS, MAX_SIDE };
