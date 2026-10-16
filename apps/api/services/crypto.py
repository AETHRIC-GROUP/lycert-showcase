"""AES-256-GCM encrypt/decrypt for credential storage.

Format stored in DB: <iv_hex>:<auth_tag_hex>:<ciphertext_hex>
This format is compatible with the Node.js crypto module used in apps/web/lib/crypto.ts.
"""

import os
from cryptography.hazmat.primitives.ciphers.aead import AESGCM


def _get_key() -> bytes:
    raw = os.environ.get("LYCERT_ENCRYPTION_KEY", "")
    if len(raw) != 64:
        raise RuntimeError("LYCERT_ENCRYPTION_KEY must be a 64-char hex string (32 bytes)")
    return bytes.fromhex(raw)


def decrypt_credential(encrypted: str) -> str:
    """Decrypt a credential stored by the Next.js API layer."""
    parts = encrypted.split(":")
    if len(parts) != 3:
        raise ValueError("Invalid encrypted credential format")
    iv_hex, auth_tag_hex, ciphertext_hex = parts
    iv = bytes.fromhex(iv_hex)
    auth_tag = bytes.fromhex(auth_tag_hex)
    ciphertext = bytes.fromhex(ciphertext_hex)
    # Python AESGCM expects ciphertext || auth_tag
    aesgcm = AESGCM(_get_key())
    return aesgcm.decrypt(iv, ciphertext + auth_tag, None).decode("utf-8")
