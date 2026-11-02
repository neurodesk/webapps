classdef polyshape
% polyshape  Minimal stand-in for MATLAB's polyshape class (one region, no holes).
%
% SamSrf uses polyshape in two places:
%   samsrf_revcor_prf:   ps = polyshape(Dt.Points(chp, :)), the closed convex hull loop,
%                        then [chx, chy] = ps.centroid.
%   samsrf_cfparam_loop: ps = polyshape(txy(pos, :)), template points in no particular
%                        order, then ps = ps.convhull, ps.area and [chx, chy] = ps.centroid.
% The constructor drops a repeated closing vertex and consecutive duplicates. With
% fewer than 3 distinct points, or when every point is collinear, the shape is empty
% (no vertices, area 0, centroid NaN NaN), as MATLAB's polyshape becomes after its
% "degenerate" warning (which SamSrf turns off).
%
% MATLAB simplifies a self-intersecting input; every extreme point of the input stays
% a vertex of that simplified shape, so its convex hull is the convex hull of the input
% points, which is what convhull returns here. area and centroid use the shoelace and
% polygon-centroid formulas on the vertex loop, which are exact for the simple polygons
% SamSrf calls them on (convex hulls); they are not MATLAB's answer for a
% self-intersecting loop, which SamSrf never measures directly.

    properties
        Vertices = zeros(0, 2);
    end

    methods
        function ps = polyshape(P)
            if nargin == 0 || isempty(P)
                return;
            end
            P = double(P);
            if size(P, 1) > 1 && isequal(P(end, :), P(1, :))
                P(end, :) = [];
            end
            keep = [true; any(diff(P, 1, 1) ~= 0, 2)];
            P = P(keep, :);
            if size(P, 1) < 3 || polyshape.collinear(P)
                return;
            end
            ps.Vertices = P;
        end

        function n = NumRegions(ps)
            n = double(~isempty(ps.Vertices));
        end

        function a = area(ps)
            a = abs(polyshape.signed_area(ps.Vertices));
        end

        function [cx, cy] = centroid(ps)
            V = ps.Vertices;
            if isempty(V)
                cx = NaN;
                cy = NaN;
                return;
            end
            x = V(:, 1);
            y = V(:, 2);
            xn = x([2:end 1]);
            yn = y([2:end 1]);
            c = x .* yn - xn .* y;
            A = sum(c) / 2;
            cx = sum((x + xn) .* c) / (6 * A);
            cy = sum((y + yn) .* c) / (6 * A);
        end

        function h = convhull(ps)
            V = ps.Vertices;
            if isempty(V)
                h = polyshape();
                return;
            end
            k = convhull(V(:, 1), V(:, 2));
            h = polyshape(V(k(1:end - 1), :));
        end
    end

    methods (Static)
        function tf = collinear(P)
            d = P - P(1, :);
            [~, k] = max(sum(d .^ 2, 2));
            cross = d(:, 1) * d(k, 2) - d(:, 2) * d(k, 1);
            tf = all(cross == 0);
        end

        function a = signed_area(V)
            if isempty(V)
                a = 0;
                return;
            end
            x = V(:, 1);
            y = V(:, 2);
            a = sum(x .* y([2:end 1]) - x([2:end 1]) .* y) / 2;
        end
    end
end
