#!/usr/bin/env python3
"""Candidate MKL AVX512_E1 ddot: 32 lanes over whole blocks of 32, then chunks of 16 and
8 from lane 0, the rest (< 8) masked from lane 0, folds 8, 16, 4, 2, 1."""
import math

def ddot(x, y, fused=True, lanes=32, chunks=(16, 8), strides=(8, 16, 4, 2, 1)):
    n = len(x)
    acc = [None] * lanes
    def add(k, i):
        p = x[i] * y[i]
        if acc[k] is None:
            acc[k] = p
        else:
            acc[k] = math.fma(x[i], y[i], acc[k]) if fused else acc[k] + p
    blocked = n // lanes * lanes
    for i in range(blocked):
        add(i % lanes, i)
    rest = list(range(blocked, n))
    for c in chunks:
        if len(rest) >= c:
            for k, i in enumerate(rest[:c]):
                add(k, i)
            rest = rest[c:]
    for k, i in enumerate(rest):
        add(k, i)
    consumed = set()
    for stride in strides:
        for k in range(lanes):
            if (k // stride) % 2 == 0 and k + stride < lanes and k not in consumed and k + stride not in consumed:
                if acc[k] is not None and acc[k + stride] is not None:
                    acc[k] = acc[k] + acc[k + stride]
                elif acc[k] is None:
                    acc[k] = acc[k + stride]
                consumed.add(k + stride)
    return 0.0 if acc[0] is None else acc[0]
