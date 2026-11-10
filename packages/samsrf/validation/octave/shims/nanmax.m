function [m, i] = nanmax(x, y, dim)
% nanmax  Maximum ignoring NaN, as MATLAB's (Statistics Toolbox) nanmax.
%
% The statistics package is not installed in the container. samsrf_cfparam_loop picks
% the best of its five sigma starts with find(fR == nanmax(fR), 1). Octave's max,
% like MATLAB's, already ignores NaN (and returns NaN only when every value is NaN),
% so this forwards to max with the same arguments.

if nargin == 1
    [m, i] = max(x);
elseif nargin == 2
    m = max(x, y);
else
    [m, i] = max(x, y, dim);
end
end
