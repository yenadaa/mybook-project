#function에 추가
# functions/utils_similarity.py
# -*- coding: utf-8 -*-
import re, hashlib
from collections import Counter

def normalize_q(s: str) -> str:
    """질문문 정규화: 공백/대소문자/연속 스페이스 정리."""
    s = (s or "").lower().strip()
    s = re.sub(r"\s+", " ", s)
    return s

def char_ngrams(s: str, n: int = 3):
    """문자 n-gram. 경계 보정을 위해 양끝에 공백을 덧댐."""
    buf = f"  {s}  "
    L = len(buf)
    return [buf[i:i+n] for i in range(max(0, L-n+1))]

def simhash64(tokens):
    """64-bit SimHash (blake2b 8바이트 해시 사용)."""
    bits = [0]*64
    cnt = Counter(tokens)
    for tok, w in cnt.items():
        h = int(hashlib.blake2b(tok.encode("utf-8"), digest_size=8).hexdigest(), 16)
        for i in range(64):
            bits[i] += w if (h >> i) & 1 else -w
    v = 0
    for i, b in enumerate(bits):
        if b > 0:
            v |= (1 << i)
    return v  # int

def simhash_bands(sim64: int, bands: int = 4, bits_per_band: int = 16):
    """64비트를 bands개로 나눠 밴드 키 생성 (LSH 인덱싱용)."""
    out = []
    mask = (1 << bits_per_band) - 1
    for b in range(bands):
        part = (sim64 >> (b*bits_per_band)) & mask
        out.append(f"b{b}:{part:04X}")
    return out

def hamming(a: int, b: int) -> int:
    return (a ^ b).bit_count()
