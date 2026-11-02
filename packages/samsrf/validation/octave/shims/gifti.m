function g = gifti(name)
% gifti  Stand-in for SPM's gifti class: a struct whose cdata is read from sidecar files.
%
% The container has no SPM. dump_gifti.py writes, for a GIFTI <name>, the files
% <name>.f32 (every DataArray's float32 values in order, little-endian) and
% <name>.json ({"arrays", "vertices"}). cdata is vertices x arrays in single,
% as SPM's gifti returns it, so samsrf_gii2srf's run.cdata' is volumes x vertices.

meta = jsondecode(fileread([name '.json']));
fid = fopen([name '.f32'], 'r');
if fid < 0
    error('gifti shim: no sidecar %s.f32', name);
end
data = fread(fid, meta.vertices * meta.arrays, 'float32=>single', 0, 'ieee-le');
fclose(fid);
if numel(data) ~= meta.vertices * meta.arrays
    error('gifti shim: %s.f32 holds %d values, expected %d', name, numel(data), meta.vertices * meta.arrays);
end
g.cdata = reshape(data, meta.vertices, meta.arrays);
end
