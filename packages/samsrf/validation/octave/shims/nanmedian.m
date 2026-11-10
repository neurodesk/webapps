function m = nanmedian(x, dim)
% nanmedian  Median ignoring NaN, as MATLAB's (Statistics Toolbox) nanmedian.
%
% The statistics package is not installed in the container. samsrf_cfparam_loop's
% summary-statistics branch (Fit_pRF = -1) takes nanmedian of the template x0 and y0
% columns. Remove NaNs before calling median so this also runs on Octave 8.4.

if nargin < 2
    dim = find(size(x) ~= 1, 1);
    if isempty(dim)
        dim = 1;
    end
end
if ~any(isnan(x(:))) && ~isempty(x)
    m = median(x, dim);
    return
end
shape = size(x);
shape(end+1:dim) = 1;
order = [dim 1:dim-1 dim+1:numel(shape)];
columns = prod(shape(order(2:end)));
values = reshape(permute(x, order), shape(dim), columns);
result = NaN(1, columns, class(x));
for i = 1:columns
    slice = values(:,i);
    slice = sort(slice(~isnan(slice)));
    if ~isempty(slice)
        middle = floor((numel(slice)+1)/2);
        result(i) = slice(middle);
        if mod(numel(slice),2) == 0
            % Match the old omitnan path's addition before division.
            result(i) = (slice(middle) + slice(middle+1)) / 2;
        end
    end
end
shape(dim) = 1;
m = ipermute(reshape(result, shape(order)), order);
end
