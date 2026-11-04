function Dt = delaunayTriangulation(P)
% delaunayTriangulation  Minimal stand-in for MATLAB's delaunayTriangulation class.
%
% samsrf_revcor_prf's convex hull branch only reads Dt.Points and passes Dt to
% convexHull, so this returns a struct with the field Points (the input, N x 2).
% MATLAB's constructor does not error on too few or collinear points (it builds an
% empty triangulation and warns); its convexHull then errors, and SamSrf catches that.
% MATLAB also merges duplicate points; reverse-correlation pixel coordinates have
% none, and convexHull here indexes the same Points either way.

Dt.Points = P;
end
