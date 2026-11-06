"""Integer-only synthetic smFISH image, reproduced exactly by src/synthetic.js."""
import numpy as np

BINOMIAL = [1, 6, 15, 20, 15, 6, 1]


def xorshift32(state):
    while True:
        state ^= (state << 13) & 0xFFFFFFFF
        state ^= state >> 17
        state ^= (state << 5) & 0xFFFFFFFF
        yield state


def synthetic_image(shape, n_spots, seed):
    rng = xorshift32(seed)
    size = int(np.prod(shape))
    flat = np.array([200 + next(rng) % 64 for _ in range(size)], dtype=np.int64)
    image = flat.reshape(shape)
    ndim = len(shape)
    norm = 20 ** ndim
    for _ in range(n_spots):
        centre = [next(rng) % s for s in shape]
        amplitude = 200 + next(rng) % 800
        for offset in np.ndindex(*(7,) * ndim):
            weight = 1
            for o in offset:
                weight *= BINOMIAL[o]
            point = tuple(c + o - 3 for c, o in zip(centre, offset))
            if all(0 <= p < s for p, s in zip(point, shape)):
                image[point] += amplitude * weight // norm
    return np.clip(image, 0, 65535).astype(np.uint16)
