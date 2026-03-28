import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const KEY_FILE = join(__dirname, '..', '.qw_key');

let _key = null;

export function getEncryptionKey() {
  if (_key) return _key;

  if (process.env.QW_ENCRYPTION_KEY) {
    _key = Buffer.from(process.env.QW_ENCRYPTION_KEY, 'hex');
    return _key;
  }

  if (existsSync(KEY_FILE)) {
    _key = Buffer.from(readFileSync(KEY_FILE, 'utf8').trim(), 'hex');
    return _key;
  }

  // Generate and persist
  _key = randomBytes(32);
  const hex = _key.toString('hex');
  writeFileSync(KEY_FILE, hex, 'utf8');
  console.warn(`[crypto] Generated encryption key. Set QW_ENCRYPTION_KEY=${hex} or keep .qw_key safe.`);
  return _key;
}

export function encrypt(text) {
  const key = getEncryptionKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');
  return `${iv.toString('hex')}:${authTag}:${encrypted}`;
}

export function decrypt(encryptedText) {
  const key = getEncryptionKey();
  const parts = encryptedText.split(':');
  if (parts.length !== 3) throw new Error('Invalid encrypted format');
  const [ivHex, authTagHex, data] = parts;
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  let decrypted = decipher.update(data, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}
