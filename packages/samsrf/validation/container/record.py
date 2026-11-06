#!/usr/bin/env python3
"""Prepare GUI models that run the compiled optimizer on the recorded inputs.

Usage: python record.py REFERENCE_DIRECTORY STOCK_GAUSSIAN.mod
Mount REFERENCE_DIRECTORY as /work, then load probe-single.mod and probe-double.mod
in the unmodified SamSrfX GUI. Requires scipy. No MATLAB source is patched.
"""
from pathlib import Path
import io
import struct
import sys
import zlib
from scipy.io import loadmat, savemat


def element(data, offset=0):
    kind, size = struct.unpack_from('<II', data, offset)
    if kind >> 16:
        return kind & 65535, data[offset + 4:offset + 4 + (kind >> 16)], offset + 8
    return kind, data[offset + 8:offset + 8 + size], offset + 8 + ((size + 7) // 8) * 8


def pack(kind, data):
    return struct.pack('<II', kind, len(data)) + data + b'\0' * ((-len(data)) % 8)


def parts(matrix):
    _, data, _ = element(matrix)
    result, offset = [], 0
    while offset < len(data):
        start = offset
        kind, value, offset = element(data, offset)
        result.append((kind, value, data[start:offset]))
    return result


def fields(matrix):
    items = parts(matrix)
    width = int.from_bytes(items[3][1], 'little')
    names = [items[4][1][i:i + width].split(b'\0')[0].decode() for i in range(0, len(items[4][1]), width)]
    return dict(zip(names, (item[2] for item in items[5:])))


def name(matrix):
    return parts(matrix)[2][1].decode()


def read_variables(path):
    data, offset, result = path.read_bytes(), 128, []
    while offset < len(data):
        kind, size = struct.unpack_from('<II', data, offset)
        if kind == 15:
            result.append(zlib.decompress(data[offset + 8:offset + 8 + size]))
            offset += 8 + size
        else:
            _, _, end = element(data, offset)
            result.append(data[offset:end])
            offset = end
    return data[:128], result


def replace_function(matrix, expression):
    items = parts(matrix)
    array_class = int.from_bytes(items[0][1][:4], 'little') & 255
    if array_class == 4 and len(items) > 3 and items[3][1].startswith(b'sf%0@'):
        value = ('sf%0' + expression).encode()
        return pack(14, items[0][2] + pack(5, struct.pack('<ii', 1, len(value))) + items[2][2] + pack(16, value))
    return pack(14, b''.join(replace_function(raw, expression) if kind == 14 else raw for kind, _, raw in items))


def write_probe(base, output, expression):
    header, variables = read_variables(base)
    original = fields(next(value for value in variables if name(value) == 'Model'))
    model = loadmat(base, simplify_cells=True)['Model']
    handles = [key for key, value in model.items() if type(value).__name__ == 'MatlabFunction']
    model.update(Name='Precision_probe', Scaling_Factor=1.0)
    for key in handles:
        model[key] = 0.0
    buffer = io.BytesIO()
    savemat(buffer, {'Model': model})
    generated = buffer.getvalue()[128:]
    new_fields = fields(generated)
    for key in handles:
        new_fields[key] = original[key]
    generated = pack(14, b''.join(item[2] for item in parts(generated)[:5]) + b''.join(new_fields.values()))
    generated = replace_function(generated, expression)
    variables = [generated if name(value) == 'Model' else value for value in variables]
    # MATLAB's unnamed function workspace is a subsystem; its absolute offset is
    # stored in header bytes 116:124 and must follow the resized Model record.
    variables.sort(key=lambda value: name(value) == '')
    offset, subsystem, blocks = 128, 0, []
    for value in variables:
        if name(value) == '':
            subsystem = offset
        compressed = zlib.compress(value)
        block = struct.pack('<II', 15, len(compressed)) + compressed
        blocks.append(block)
        offset += len(block)
    output.write_bytes(header[:116] + struct.pack('<Q', subsystem) + header[124:] + b''.join(blocks))


def main():
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    directory, base = map(Path, sys.argv[1:])
    for precision in ['single', 'double']:
        observed = 'd.Ys(:,i)' if precision == 'single' else 'double(d.Ys(:,i))'
        fit = ("fminsearch(@(p)prf_errfun(@(q,a)prf_gaussian_rf(q(1),q(2),q(3),a),"
               f"d.ApFrm,d.ApXY,d.Hrf,p,{observed},1,false),d.Seeds(:,i),optimset('Display','off'))")
        prediction = "prf_convolve_hrf(prf_predict_timecourse(prf_gaussian_rf(p(1),p(2),p(3),d.ApXY),d.ApFrm),d.Hrf,1)"
        maps = ("feval(@(p)feval(@(x,y)[p;double(corr(x,y).^2);"
                "double(flipud([ones(length(y),1) x]\\y))],"
                + prediction + ',' + observed + '),' + fit + ')')
        value = f"cell2mat(arrayfun(@(i){maps},1:size(d.Ys,2),'UniformOutput',false))'"
        expression = ("@(P,ApWidth)feval(@(d)feval(@(fid)[fprintf(fid,'%s',jsonencode("
                      + value + ")),fclose(fid)],fopen('/work/fits-" + precision
                      + ".json','w')),load('/work/probe-all.mat'))")
        write_probe(base, directory / f'probe-{precision}.mod', expression)
        print(f'Load /work/probe-{precision}.mod in SamSrfX to write fits-{precision}.json')


if __name__ == '__main__':
    main()
