function m = nanmedian(x, dim)
% nanmedian  Median ignoring NaN, as MATLAB's (Statistics Toolbox) nanmedian.
%
% The statistics package is not installed in the container. samsrf_cfparam_loop's
% summary-statistics branch (Fit_pRF = -1) takes nanmedian of the template x0 and y0
% columns. Octave 9's median takes the 'omitnan' flag; a slice that is all NaN gives
% NaN, as in MATLAB.

if nargin < 2
    dim = find(size(x) ~= 1, 1);
    if isempty(dim)
        dim = 1;
    end
end
m = median(x, dim, 'omitnan');
end
