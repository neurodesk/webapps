function V = samsrf_loadlabel(Roi)
% samsrf_loadlabel  SamSrf's samsrf_loadlabel without Read_FreeSurfer's textscan.
%
% SamSrf's version returns Read_FreeSurfer([Roi '.label'])(:, 1) + 1. Read_FreeSurfer
% uses textscan with six '%n' fields on five-column files, which in Octave runs the
% values on across lines (README, "Octave versus MATLAB caveats"). This reads the same
% file directly: two header lines (a comment and the row count), then one row per
% vertex whose first column is the 0-based vertex index. It returns those indices + 1
% as a column, in file order: the analyses keep that order (mver, Srf.SeedVx), and
% find(..., 1) on seed profiles depends on it.

fid = fopen([Roi '.label'], 'r');
if fid < 0
    error('samsrf_loadlabel shim: cannot open %s.label', Roi);
end
fgetl(fid);
count = str2double(fgetl(fid));
values = fscanf(fid, '%f');
fclose(fid);
if isnan(count) || count < 1 || mod(numel(values), count) ~= 0
    error('samsrf_loadlabel shim: %s.label has %d values for %g rows', Roi, numel(values), count);
end
values = reshape(values, numel(values) / count, count)';
V = values(:, 1) + 1;
end
