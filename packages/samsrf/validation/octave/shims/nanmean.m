function m = nanmean(x, dim)
% nanmean  Mean ignoring NaN along dim, as MATLAB's (statistics toolbox) nanmean.
%
% Octave 9.2 has no nanmean. samsrf_gii2srf averages runs with nanmean(Data, 3)
% and samsrf_revcor_cf takes the global signal with nanmean(Data, 2). A slice
% with no finite value gives NaN (0 / 0), as in MATLAB.

if nargin < 2
    dim = find(size(x) ~= 1, 1);
    if isempty(dim)
        dim = 1;
    end
end
nans = isnan(x);
x(nans) = 0;
m = sum(x, dim) ./ sum(~nans, dim);
end
