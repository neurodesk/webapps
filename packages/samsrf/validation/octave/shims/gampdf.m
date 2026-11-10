function y = gampdf(x, a, b)
% gampdf  MATLAB-compatible gamma density with shape a and scale b.
%
% Octave 9.2 ships gampdf only in the statistics package, which the reference
% container lacks. MATLAB semantics: 0 for x < 0; at x == 0 the density is Inf
% for a < 1, 1 / b for a == 1 and 0 for a > 1 (samsrf_doublegamma evaluates
% x == 0 with its onset of 0); elsewhere exp((a - 1) * log(x / b) - x / b - gammaln(a)) / b.
% NaN for a <= 0 or b <= 0. a and b may be scalars or arrays of the size of x.

if nargin < 3
    b = 1;
end
a = a + zeros(size(x));
b = b + zeros(size(x));
z = x ./ b;
y = exp((a - 1) .* log(z) - z - gammaln(a)) ./ b;
y(z < 0) = 0;
at_zero = z == 0;
y(at_zero & a < 1) = Inf;
y(at_zero & a == 1) = 1 ./ b(at_zero & a == 1);
y(at_zero & a > 1) = 0;
y(a <= 0 | b <= 0) = NaN;
end
