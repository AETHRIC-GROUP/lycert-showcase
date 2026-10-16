"""Tests for services/crypto.py — AES-256-GCM credential storage."""

import os
import pytest

os.environ.setdefault("LYCERT_ENCRYPTION_KEY", "a" * 64)


def test_decrypt_roundtrip():
    from services.crypto import decrypt_credential
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    key = bytes.fromhex("a" * 64)
    iv = bytes.fromhex("0" * 24)
    plaintext = b"sk_test_credential"
    combined = AESGCM(key).encrypt(iv, plaintext, None)
    ciphertext, auth_tag = combined[:-16], combined[-16:]
    encrypted = f"{'0' * 24}:{auth_tag.hex()}:{ciphertext.hex()}"
    assert decrypt_credential(encrypted) == "sk_test_credential"


def test_decrypt_bad_format_raises():
    from services.crypto import decrypt_credential
    with pytest.raises(ValueError):
        decrypt_credential("notvalidformat")
