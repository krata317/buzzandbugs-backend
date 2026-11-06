import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { env } from '../config/env.js';

export const randomToken = (bytes = 32): string => randomBytes(bytes).toString('base64url');

export const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

export const hmac = (value: string, secret = env.EMAIL_HASH_SECRET): string =>
  createHmac('sha256', secret).update(value).digest('hex');

export const hashEmail = (normalizedEmail: string): string => hmac(`email:${normalizedEmail}`);

export const hashIp = (ip: string | undefined): string =>
  ip ? hmac(`ip:${ip}`, env.SESSION_SECRET).slice(0, 32) : 'unknown';

export const safeEqual = (a: string, b: string): boolean => {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
};

export const numericOtp = (digits = 6): string => {
  const max = 10 ** digits;
  // randomBytes is uniform; modulo bias is negligible for a 6 digit code but avoid it anyway.
  const limit = Math.floor(0xffffffff / max) * max;
  let value = randomBytes(4).readUInt32BE(0);
  while (value >= limit) value = randomBytes(4).readUInt32BE(0);
  return String(value % max).padStart(digits, '0');
};

export const hashOtp = (emailNormalized: string, purpose: string, code: string): string =>
  hmac(`otp:${purpose}:${emailNormalized}:${code}`, env.SESSION_SECRET);

/** Deterministic 63-bit positive integer used for PostgreSQL advisory locks. */
export const advisoryLockKey = (value: string): bigint => {
  const digest = createHash('sha256').update(value).digest();
  const key = digest.readBigUInt64BE(0) & 0x7fffffffffffffffn;
  return key === 0n ? 1n : key;
};
