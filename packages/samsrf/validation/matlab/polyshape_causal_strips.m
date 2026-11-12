function P = polyshape_causal_strips(t, g, f, angle, reversed, shift)
% Two thin filled strips touching at two vertices with an unfilled sliver of
% width g between them (polyshape_causal_cases.m); t, g in units of polyshape's
% cleaning tolerance 1e-8 * span for a unit length.
% Ring: X1, upper strip, X2, sliver apex, X1, lower strip, X2 (closing to X1).
% With unit length the tolerance is 1e-8 * span, span the larger axis range.
span = max(abs(cos(angle)), abs(sin(angle)));
tolerance = 1e-8 * span;
t = t * tolerance;
g = g * tolerance;
P = [0 0; 0.25 t; 0.75 t; 1 0; f -g; 0 0; 0.25 -g-t; 0.75 -g-t; 1 0];
R = [cos(angle) -sin(angle); sin(angle) cos(angle)];
P = P * R';
if reversed
    P = flipud(P);
end
P = circshift(P, -shift, 1);
end
