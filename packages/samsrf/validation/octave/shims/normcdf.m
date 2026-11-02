function p = normcdf(x, mu, sigma)
% normcdf  Normal cumulative distribution, as MATLAB's normcdf: 0.5 * erfc(-z / sqrt(2)).
%
% Octave 9.2 ships normcdf only in the statistics package. prf_skewgauss_rf calls
% it with one argument (standard normal).

if nargin < 2
    mu = 0;
end
if nargin < 3
    sigma = 1;
end
p = 0.5 * erfc(-(x - mu) ./ (sigma * sqrt(2)));
end
