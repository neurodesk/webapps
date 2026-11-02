function tri = delaunay(x, y)
% delaunay  Octave's 2-D delaunay, with MATLAB's empty result for degenerate input.
%
% samsrf_cfparam_loop triangulates the unique template coordinates of the seed region
% with tri = delaunay(txy) and grows the positive subfield over those triangles. MATLAB
% returns an empty triangulation (with a warning SamSrf turns off) when there are
% fewer than 3 points or they are all collinear; Octave's qhull call errors instead.
% Degenerate input returns zeros(0, 3) here; anything else is triangulated exactly as
% Octave's delaunay does it, by delaunayn([x, y], []) (its default qhull options). samsrf_clusterroi then finds no neighbours and keeps the peak alone.

if nargin == 2
    P = [x(:) y(:)];
else
    P = x;
end
if size(P, 2) ~= 2
    error('delaunay shim: only 2-D points are supported');
end
if size(P, 1) < 3 || degenerate(P)
    tri = zeros(0, 3);
    return;
end
tri = delaunayn(P, []);
end

function tf = degenerate(P)
d = P - P(1, :);
[~, k] = max(sum(d .^ 2, 2));
cross = d(:, 1) * d(k, 2) - d(:, 2) * d(k, 1);
tf = all(cross == 0);
end
