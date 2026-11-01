'use strict';
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const scrypt = promisify(crypto.scrypt);
const KDF = Object.freeze({ N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 });
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const equal = (a, b) => crypto.timingSafeEqual(Buffer.from(sha(String(a))), Buffer.from(sha(String(b))));
const passwordValid = p => typeof p === 'string' && [...p].length >= 15 && p.length <= 128;
async function passwordHash(password) {
  if (!passwordValid(password)) throw new Error('Password must contain 15 to 128 characters');
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = await scrypt(password, salt, 64, KDF);
  return ['scrypt', KDF.N, KDF.r, KDF.p, salt, hash.toString('hex')].join('$');
}
async function passwordVerify(password, encoded) {
  if (typeof password !== 'string' || password.length > 128) return false;
  const v = String(encoded).split('$');
  if (v.length !== 6 || v[0] !== 'scrypt' || Number(v[1]) !== KDF.N || Number(v[2]) !== KDF.r || Number(v[3]) !== KDF.p || !/^[0-9a-f]{32}$/.test(v[4]) || !/^[0-9a-f]{128}$/.test(v[5])) return false;
  const actual = await scrypt(password, v[4], 64, KDF);
  return crypto.timingSafeEqual(actual, Buffer.from(v[5], 'hex'));
}
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32(bytes) {
  let bits = 0, value = 0, out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += alphabet[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits) out += alphabet[(value << (5 - bits)) & 31];
  return out;
}
function fromBase32(encoded) {
  if (!/^[A-Z2-7]{16,128}$/.test(encoded)) throw new Error('Invalid TOTP secret');
  let bits = 0, value = 0; const bytes = [];
  for (const ch of encoded) {
    value = (value << 5) | alphabet.indexOf(ch); bits += 5;
    if (bits >= 8) { bytes.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(bytes);
}
function totp(secret, step, digits = 6) {
  if (!Number.isSafeInteger(step) || step < 0 || ![6, 8].includes(digits)) throw new Error('Invalid TOTP parameters');
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac('sha1', fromBase32(secret)).update(counter).digest();
  const offset = h[h.length - 1] & 15;
  return String((h.readUInt32BE(offset) & 0x7fffffff) % (10 ** digits)).padStart(digits, '0');
}
function matchTotp(secret, code, lastStep = -1, now = Date.now()) {
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) return null;
  const current = Math.floor(now / 30000);
  for (const step of [current, current - 1, current + 1]) {
    if (step > Number(lastStep) && step >= 0 && equal(totp(secret, step), code)) return step;
  }
  return null;
}
function encryption(master) {
  if (typeof master !== 'string' || master.length < 32) throw new Error('Encryption master must be at least 32 characters');
  const key = Buffer.from(crypto.hkdfSync('sha256', master, 'playground-cp08', 'totp-encryption-v1', 32));
  return {
    seal(plain, accountId) {
      const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(Buffer.from(accountId));
      const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
      return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), body.toString('base64url')].join('.');
    },
    open(box, accountId) {
      const [version, iv, tag, body] = String(box).split('.');
      if (version !== 'v1') throw new Error('Unknown encrypted secret version');
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
      decipher.setAAD(Buffer.from(accountId)); decipher.setAuthTag(Buffer.from(tag, 'base64url'));
      return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8');
    }
  };
}
function recoveryHash(master, accountId, code) {
  const normalized = String(code).replace(/[\s-]/g, '').toUpperCase();
  return crypto.createHmac('sha256', master).update('cp08:recovery:' + accountId + ':' + normalized).digest('hex');
}
function recoveryCodes() {
  return Array.from({ length: 8 }, () => crypto.randomBytes(16).toString('hex').toUpperCase().match(/.{8}/g).join('-'));
}
module.exports = { KDF, sha, equal, passwordValid, passwordHash, passwordVerify, base32, fromBase32, totp, matchTotp, encryption, recoveryHash, recoveryCodes };
