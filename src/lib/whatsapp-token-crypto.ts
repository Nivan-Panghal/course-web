// src/lib/whatsapp-token-crypto.ts
//
// Encrypts the Meta access token (and registration PIN) of a creator's own WhatsApp number.
// Same format as lib/creator-secrets.ts (AES-256-GCM, iv + tag + ciphertext, base64), but with its
// OWN key, WHATSAPP_TOKENS_KEY. It is shared only with the WhatsApp bot, so the key that protects
// payment gateway credentials never has to leave this app.
//
// Make a key with:  openssl rand -base64 32
// Never change it once creators have connected: every saved token would stop working.
import crypto from 'crypto'

const ALGO = 'aes-256-gcm'

function getKey(): Buffer {
  const raw = process.env.WHATSAPP_TOKENS_KEY
  if (!raw) throw new Error('WHATSAPP_TOKENS_KEY is not configured')
  const key = Buffer.from(raw, 'base64')
  if (key.length !== 32) throw new Error('WHATSAPP_TOKENS_KEY must decode to exactly 32 bytes (base64)')
  return key
}

export function encryptWhatsappSecret(plaintext: string): string {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv(ALGO, getKey(), iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64')
}

export function decryptWhatsappSecret(encoded: string): string {
  const raw = Buffer.from(encoded, 'base64')
  const decipher = crypto.createDecipheriv(ALGO, getKey(), raw.subarray(0, 12))
  decipher.setAuthTag(raw.subarray(12, 28))
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8')
}
