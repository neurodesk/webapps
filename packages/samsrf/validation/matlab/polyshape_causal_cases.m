function families = polyshape_causal_cases(originalClouds, heldoutClouds)
% Controlled polygons that separate hypotheses about how MATLAB's polyshape
% cleans touching thin regions (#732). Pure arithmetic, so Octave can check the
% generators; record_geometry(..., 'polyshape-causal') records them in MATLAB.
% originalClouds and heldoutClouds are record_geometry's point_clouds() and the
% probe's held-out clouds, from which the real cases are taken.
%
% Families (each with one parameter row per polygon):
%   causal_gap_sweep      two thin filled strips touching at two vertices, with
%                         an unfilled sliver of width g between them, thickness
%                         t, sliver apex at fraction f, along x or the clouds'
%                         slope, as drawn or reversed, at every cyclic start.
%                         [t/tol g/tol f angle reversed shift]
%   causal_gap_bisection  the sliver width at which MATLAB's default polyshape
%                         stops merging the strips into one region, bisected per
%                         [t/tol f angle reversed]: [... low high atLow atHigh]
%   causal_hole_contact   a unit square with a triangular hole whose apex is at
%                         distance d from the bottom edge (d = 0: one contact),
%                         drawn through a retraced bridge. [d/tol reversed shift]
%   causal_real           point clouds 7, 177, 932, 1607, 1937, 1090 and held-out
%                         cloud 1125 (0-based), reversed, at every cyclic start,
%                         translated and scaled by 1e-2 and 1e2.
%                         [source index shift reversed transform]
%   causal_heldout        random instances of the strip pair (seed 73221).
%                         [t/tol g/tol f angle reversed shift]
families = struct('id', {}, 'polygons', {}, 'parameters', {});
families(end+1) = gap_sweep();
families(end+1) = gap_bisection_seed();
families(end+1) = hole_contact();
families(end+1) = real_cases(originalClouds, heldoutClouds);
families(end+1) = heldout();
end

function family = gap_sweep()
polygons = {};
parameters = zeros(0, 6);
for t = [1 4 30]
    for g = 10 .^ linspace(-1, 1.5, 26)
        for f = [0.3 0.5 0.7]
            for angle = [0 atan(2)]
                for reversed = 0:1
                    for shift = 0:8
                        polygons{end+1} = polyshape_causal_strips(t, g, f, angle, reversed, shift); %#ok<AGROW>
                        parameters(end+1, :) = [t g f angle reversed shift]; %#ok<AGROW>
                    end
                end
            end
        end
    end
end
family = struct('id', 'causal_gap_sweep', 'polygons', {polygons}, 'parameters', parameters);
end

function family = gap_bisection_seed()
% The recorder bisects; here only the combinations, low 0.1 and high 30.
parameters = zeros(0, 4);
for t = [1 4 30]
    for f = [0.3 0.5 0.7]
        for angle = [0 atan(2)]
            for reversed = 0:1
                parameters(end+1, :) = [t f angle reversed]; %#ok<AGROW>
            end
        end
    end
end
family = struct('id', 'causal_gap_bisection', 'polygons', {{}}, 'parameters', parameters);
end

function family = hole_contact()
polygons = {};
parameters = zeros(0, 3);
for d = [0 10 .^ linspace(-1, 1.5, 16)]
    for reversed = 0:1
        for shift = 0:2:8
            tolerance = 1e-8;
            v = [0.5 0];
            apex = [0.5 d * tolerance];
            P = [v; 1 0; 1 1; 0 1; 0 0; v; apex; 0.6 0.3; 0.4 0.3; apex];
            if reversed
                P = flipud(P);
            end
            P = circshift(P, -shift, 1);
            polygons{end+1} = P; %#ok<AGROW>
            parameters(end+1, :) = [d reversed shift]; %#ok<AGROW>
        end
    end
end
family = struct('id', 'causal_hole_contact', 'polygons', {polygons}, 'parameters', parameters);
end

function family = real_cases(originalClouds, heldoutClouds)
sources = {originalClouds{8}, originalClouds{178}, originalClouds{933}, originalClouds{1608}, ...
    originalClouds{1938}, originalClouds{1091}, heldoutClouds{1126}};
polygons = {};
parameters = zeros(0, 5);
for s = 1:numel(sources)
    P = sources{s};
    n = size(P, 1);
    for reversed = 0:1
        for shift = 0:n-1
            Q = P;
            if reversed
                Q = flipud(Q);
            end
            polygons{end+1} = circshift(Q, -shift, 1); %#ok<AGROW>
            parameters(end+1, :) = [s 0 shift reversed 0]; %#ok<AGROW>
        end
    end
    % transform 1: translated; 2, 3: scaled by 1e-2 and 1e2 about the origin.
    polygons{end+1} = P + [0.37 -1.21];
    parameters(end+1, :) = [s 0 0 0 1];
    polygons{end+1} = P * 1e-2;
    parameters(end+1, :) = [s 0 0 0 2];
    polygons{end+1} = P * 1e2;
    parameters(end+1, :) = [s 0 0 0 3];
end
family = struct('id', 'causal_real', 'polygons', {polygons}, 'parameters', parameters);
end

function family = heldout()
rng(73221, 'twister');
polygons = cell(1, 600);
parameters = zeros(600, 6);
for i = 1:600
    t = 10 ^ (rand * 2 - 0.3);
    g = 10 ^ (rand * 2.5 - 1);
    f = 0.2 + 0.6 * rand;
    angle = rand * pi;
    reversed = double(rand > 0.5);
    shift = floor(rand * 9);
    polygons{i} = polyshape_causal_strips(t, g, f, angle, reversed, shift) + [rand rand] * 3;
    parameters(i, :) = [t g f angle reversed shift];
end
family = struct('id', 'causal_heldout', 'polygons', {polygons}, 'parameters', parameters);
end
