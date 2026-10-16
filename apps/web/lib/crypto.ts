/**
 * AES-256-GCM encrypt/decrypt for integration credential storage.
 * Format: <iv_hex>:<auth_tag_hex>:<ciphertext_hex>
 * Compatible with apps/api/services/crypto.py.
 */

import crypto from 'crypto'

const ALGO = 'aes-256-gcm'

function getKey(): Buffer {
  const hex = process.env.LYCERT_ENCRYPTION_KEY ?? ''
  if (hex.length !== 64) throw new Error('LYCERT_ENCRYPTION_KEY must be a 64-char hex string')
  return Buffer.from(hex, 'hex')
}

export function encryptCredential(plaintext: string): string {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv(ALGO, getKey(), iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${ciphertext.toString('hex')}`
}

export function decryptCredential(encrypted: string): string {
  const parts = encrypted.split(':')
  if (parts.length !== 3) throw new Error('Invalid encrypted credential format')
  const [ivHex, authTagHex, ciphertextHex] = parts
  const iv = Buffer.from(ivHex, 'hex')
  const authTag = Buffer.from(authTagHex, 'hex')
  const ciphertext = Buffer.from(ciphertextHex, 'hex')
  const decipher = crypto.createDecipheriv(ALGO, getKey(), iv)
  decipher.setAuthTag(authTag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
}
