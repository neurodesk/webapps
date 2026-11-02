function [chp, cha] = convexHull(Dt)
% convexHull  Stand-in for the convexHull method of MATLAB's delaunayTriangulation.
%
% Returns the closed loop of indices into Dt.Points that forms the convex hull, and its
% area, from Octave's convhull (qhull). Like MATLAB's method it errors when the points
% do not span an area (fewer than 3 points, or all collinear): qhull fails, and
% samsrf_revcor_prf catches the error and zeroes the vertex. Only the hull's area and
% centroid are used downstream, so the loop's orientation and start do not matter.

P = Dt.Points;
if size(P, 1) < 3
    error('convexHull shim: the triangulation is empty (%d points)', size(P, 1));
end
[chp, cha] = convhull(P(:, 1), P(:, 2));
end
