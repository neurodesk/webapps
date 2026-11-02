function s = nansum(x, dim)
% nansum  Sum ignoring NaN, as MATLAB's (Statistics Toolbox) nansum.
%
% The statistics package is not installed in the container. samsrf_cfparam_loop
% smooths a CF profile with nansum(sR, 2) ./ sum(Weights, 2). NaN entries count as
% zero; a slice that is all NaN sums to 0, as in MATLAB.

if nargin < 2
    dim = find(size(x) ~= 1, 1);
    if isempty(dim)
        dim = 1;
    end
end
x(isnan(x)) = 0;
s = sum(x, dim);
end
