#!/usr/bin/env python3
import sys, json, math, struct, itertools, hashlib, os
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from chain import cr_nrm2, ref_nrm2
P = Path(os.environ['SAMSRF_QR_PROBE_PINS'])

def arr(root, d):

    def read(name):
        b = (root / name).read_bytes()
        return list(struct.unpack('<' + 'd' * (len(b) // 8), b))
    re = read(d['file'])
    im = read(d['imaginary']) if d.get('imaginary') else [0.0] * len(re)
    return [complex(r, i) for r, i in zip(re, im)]

def eq(a, b):
    return struct.pack('<dd', a.real, a.imag) == struct.pack('<dd', b.real, b.imag)

def mul(a, b, re, im):
    r = a.real * b.real - a.imag * b.imag if re == 0 else math.fma(a.real, b.real, -a.imag * b.imag) if re == 1 else math.fma(-a.imag, b.imag, a.real * b.real)
    i = a.real * b.imag + a.imag * b.real if im == 0 else math.fma(a.real, b.imag, a.imag * b.real) if im == 1 else math.fma(a.imag, b.real, a.real * b.imag)
    return complex(r, i)

def ladiv1(a, b, c, d):
    r = d / c
    t = 1.0 / (c + d * r)

    def part(a, b):
        if r != 0.0:
            br = b * r
            return (a + br) * t if br != 0.0 else a * t + b * t * r
        return (a + d * (b / c)) * t
    return (part(a, b), part(b, -a))

def reciprocal(z):
    a, b, c, d = (1.0, 0.0, z.real, z.imag)
    unit = 2 ** (-53)
    tiny = sys.float_info.min * 2 / unit
    blowup = 2 / (unit * unit)
    s = 1.0
    ab = max(abs(a), abs(b))
    cd = max(abs(c), abs(d))
    if ab >= 0.5 * sys.float_info.max:
        a *= 0.5
        b *= 0.5
        s *= 2
    if cd >= 0.5 * sys.float_info.max:
        c *= 0.5
        d *= 0.5
        s *= 0.5
    if ab <= tiny:
        a *= blowup
        b *= blowup
        s /= blowup
    if cd <= tiny:
        c *= blowup
        d *= blowup
        s *= blowup
    if abs(z.imag) <= abs(z.real):
        p, q = ladiv1(a, b, c, d)
    else:
        p, q = ladiv1(b, a, d, c)
        q = -q
    return complex(p * s, q * s)

def reflector(column, norm, scale):
    alpha = column[0]
    x = column[1:]
    nrm = lambda x: norm([p for z in x for p in (z.real, z.imag)])
    xn = nrm(x)
    if xn == 0 and alpha.imag == 0:
        return (alpha, 0j, x)

    def beta(alpha, xn):
        a, b, c = (abs(alpha.real), abs(alpha.imag), abs(xn))
        w = max(a, b, c)
        return -math.copysign(w * math.sqrt(a / w * (a / w) + b / w * (b / w) + c / w * (c / w)), alpha.real)
    b = beta(alpha, xn)
    rescale = sys.float_info.min / 2 ** (-53)
    rescaled = 0
    if abs(b) < rescale:
        inv = 1 / rescale
        while abs(b) < rescale and rescaled < 20:
            rescaled += 1
            x = [mul(z, complex(inv, 0), 0, 0) for z in x]
            alpha = complex(alpha.real * inv, alpha.imag * inv)
            b *= inv
        xn = nrm(x)
        b = beta(alpha, xn)
    half = 1.0 if math.isfinite(b - alpha.real) else 0.5
    bh = b * half
    ah = complex(alpha.real * half, alpha.imag * half)
    tau = complex((bh - ah.real) / bh, -ah.imag / bh)
    inverse = reciprocal(complex(ah.real - bh, ah.imag))
    inverse = complex(inverse.real * half, inverse.imag * half)
    v = [mul(z, inverse, *scale) for z in x]
    for _ in range(rescaled):
        b *= rescale
    return (complex(b, 0), tau, v)

def cases(host):
    dr = P / 'qr-reference/ubuntu-24.04/compatible'
    meta = {c['id']: c for c in json.loads((dr / 'qr.json').read_text())['cases']}
    root = P / 'qr-kernels' / host
    for c in json.loads((root / 'kernels.json').read_text())['cases']:
        if c['precision'] != 'double':
            continue
        d = meta[c['id']]
        x = arr(dr, d['x'])
        if not any((z.imag for z in x)):
            continue
        chain = next((ch for ch in c['chains'] if ch['variant'] == 'complex'))
        ones = [1 + 0j] * len(x)
        cols = [ones, x] if c['order'] == 'ones-first' else [x, ones]
        pivot = [int(z.real) - 1 for z in arr(root, chain['pivot'])]
        factor = arr(root, chain['factor'])
        tau = arr(root, chain['tau'])
        yield {'id': c['id'], 'columns': cols, 'pivot': pivot, 'factor': [factor[:len(x)], factor[len(x):]], 'tau': tau, 'qty': arr(root, chain['qty']), 'beta': arr(root, chain['beta']), 'y': arr(dr, d['y'])}
if __name__ == '__main__':
    out = {}
    for host in ['ubuntu-22.04-1', 'ubuntu-22.04-3']:
        cs = list(cases(host))
        models = {}
        for normname, scale in itertools.product(['ref', 'cr'], itertools.product(range(3), repeat=2)):
            norm = ref_nrm2 if normname == 'ref' else cr_nrm2
            counts = {'pivot': 0, 'R11': 0, 'tau1': 0, 'v1': 0}
            misses = []
            for c in cs:
                norms = [norm([p for z in col for p in (z.real, z.imag)]) for col in c['columns']]
                pivot = 0 if norms[0] >= norms[1] else 1
                b, tau, v = reflector(c['columns'][c['pivot'][0]], norm, scale)
                checks = [pivot == c['pivot'][0], eq(b, c['factor'][0][0]), eq(tau, c['tau'][0]), all((eq(a, b) for a, b in zip(v, c['factor'][0][1:])))]
                for k, ok in zip(counts, checks):
                    counts[k] += ok
                if not all(checks):
                    misses.append({'id': c['id'], 'checks': checks})
            models[f'{normname}/{scale}'] = {'counts': counts, 'misses': misses}
        out[host] = {'cases': len(cs), 'models': models}
        best = sorted(models.items(), key=lambda kv: (kv[1]['counts']['v1'], kv[1]['counts']['R11']), reverse=True)[:3]
        print(host, len(cs), [(n, r['counts'], r['misses'][:3]) for n, r in best])
    Path(sys.argv[1]).write_text(json.dumps(out, indent=2) + '\n')
