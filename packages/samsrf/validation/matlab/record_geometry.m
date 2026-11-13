function record_geometry(source, input, output, spmSource, mode)
% Record MATLAB's own polyshape, convhull, delaunay and samsrf_clusterroi on
% boundary sweeps, tie-prone point sets and real Benson V1 template coordinates.
% source is the pinned SamSrf checkout with prepare.py's declared repairs and
% input the extracted geometry-inputs.json archive. mode 'polyshape-probe'
% records only the focused polyshape probes (grid-decade sweep and bisection,
% held-out clouds, extreme grids) instead of the full geometry reference; mode
% 'polyshape-causal' records polyshape_causal_cases.m's controlled polygons;
% 'polyshape-reproducers' records the reduced reproducers in
% polyshape-reproducers.json (polyshape_reproducer_cases.m).
arguments
    source (1,:) char
    input (1,:) char
    output (1,:) char
    spmSource (1,:) char
    mode (1,:) char {mustBeMember(mode, {'full', 'polyshape-probe', 'polyshape-causal', 'polyshape-reproducers'})} = 'full'
end
assert(isfile(fullfile(output, 'source.json')), 'Run prepare.py first');
assert(~isfile(fullfile(output, 'geometry.json')), 'Use a fresh output directory');
addpath(genpath(source));
addpath(spmSource);
previous = pwd;
cleanup = onCleanup(@() cd(previous));
cd(output);
set(groot, 'defaultFigureVisible', 'off');
defaults = jsondecode(fileread(fullfile(source, 'SamSrf_defaults.json')));
defaults.def_64bit = true;
write_json('SamSrf_defaults.json', defaults);
meta = reference_environment('source-geometry');
meta.source = jsondecode(fileread('source.json'));
meta.functions = struct('polyshape', which('polyshape'), 'convhull', which('convhull'), ...
    'delaunay', which('delaunay'), 'delaunayTriangulation', which('delaunayTriangulation'), ...
    'clusterroi', which('samsrf_clusterroi'), 'cfparam', which('samsrf_cfparam_loop'), ...
    'gifti', which('gifti'));
if any(strcmp(mode, {'polyshape-probe', 'polyshape-causal', 'polyshape-reproducers'}))
    meta.mode = mode;
    write_json('environment.json', meta);
    if strcmp(mode, 'polyshape-probe')
        cases = probe_cases();
    elseif strcmp(mode, 'polyshape-causal')
        cases = causal_cases();
    else
        cases = reproducer_cases();
    end
    write_json('geometry.json', struct('mode', mode, 'cases', {cases}));
    fprintf('Recorded %d MATLAB polyshape probe cases. Port parity is not implied.\n', numel(cases));
    return
end
write_json('environment.json', meta);
cases = {};
cases = [cases, polygon_cases()];
write_json('geometry.json.partial', struct('cases', {cases}));
cases = [cases, delaunay_cases()];
cases = [cases, cluster_cases()];
write_json('geometry.json.partial', struct('cases', {cases}));
pool = gcp('nocreate');
if isempty(pool)
    pool = parpool('local', 2);
end
poolCleanup = onCleanup(@() delete(pool));
cases = [cases, template_cases(input)];
write_json('geometry.json', struct('cases', {cases}));
delete('geometry.json.partial');
fprintf('Recorded %d MATLAB geometry cases. Port parity is not implied.\n', numel(cases));
end

%% Polygons: polyshape simplification, convhull, area and centroid

function cases = polygon_cases()
cases = {};
cases{end+1} = polygon_batch('polygon_boundary_ulp', ulp_sweep());
cases{end+1} = polygon_batch('polygon_boundary_relative', relative_sweep());
cases{end+1} = polygon_batch('polygon_random_thin', random_thin());
cases{end+1} = polygon_batch('polygon_collinear_vertex', collinear_vertex());
cases{end+1} = polygon_batch('polygon_spikes', spikes());
cases{end+1} = polygon_batch('polygon_degenerate', degenerate());
cases{end+1} = polygon_batch('polygon_point_clouds', point_clouds());
end

function P = place(P, scale, offset, angle)
rotation = [cos(angle) sin(angle); -sin(angle) cos(angle)];
P = (P * rotation) * scale + offset;
end

function polygons = ulp_sweep()
% Thin triangles one ULP of the apex height apart around the relative 1e-8
% outcome change in the 741-case reference (polygon_191 to polygon_193).
polygons = {};
h0 = 2e-8;
for scale = [1e-3 1 1e3 0.37 3 2^-10 2^10 7.1e5 1.3e-6]
    for offset = [0 1e3 -37.25]
        for angle = [0 0.7 pi/2]
            for apex = [0.1 1 1.9]
                for k = -24:24
                    h = h0 + k * eps(h0);
                    polygons{end+1} = place([0 0; apex h; 2 0], scale, offset, angle); %#ok<AGROW>
                end
            end
        end
    end
end
end

function polygons = relative_sweep()
polygons = {};
for scale = [1e-3 1 1e3 0.37 2^10]
    for offset = [0 1e3]
        for angle = [0 0.7]
            for apex = [0.1 1]
                for h = 2e-8 * (1 + [(-50:50) * 1e-6, (-30:30) * 1e-3])
                    polygons{end+1} = place([0 0; apex h; 2 0], scale, offset, angle); %#ok<AGROW>
                end
            end
        end
    end
end
end

function polygons = random_thin()
% Random scales, translations, shapes and vertex orders separate a tolerance
% relative to the bounding box, the base, the longest edge or the coordinates.
rng(7321, 'twister');
polygons = cell(1, 4000);
for i = 1:numel(polygons)
    scale = 10^(8 * rand - 4);
    offset = (rand(1, 2) - 0.5) * 10^(6 * rand - 2) * (rand > 0.3);
    angle = 2 * pi * rand;
    a = (rand(1, 2) - 0.5) * scale;
    base = (0.2 + 0.8 * rand) * scale;
    c = a + base * [cos(angle) sin(angle)];
    t = 1.4 * rand - 0.2;
    ratio = 10^(log10(3e-9) + rand);
    normal = [-sin(angle) cos(angle)] * sign(rand - 0.5);
    b = a + t * (c - a) + ratio * base * normal;
    P = [a; b; c] + offset;
    polygons{i} = P(randperm(3), :);
end
end

function polygons = collinear_vertex()
% A near-collinear vertex on a long edge: its neighbours are 1 apart, the
% polygon spans L. Decides whether the cutoff is local or global.
polygons = {};
for L = [2.5 10 1000 1e5]
    for r = [-logspace(-10, -6, 41), logspace(-10, -6, 41)]
        for scale = [1 1e3]
            polygons{end+1} = [0 0; 1 r; 2 0; L 0; L L; 0 L] * scale; %#ok<AGROW>
        end
    end
end
end

function polygons = spikes()
polygons = {};
for scale = [1e-3 1 1e3]
    for offset = [0 1e3]
        for height = [0.5 1e-3 -0.5]
            for w = [0, logspace(-11, -5, 25)]
                square = [0 0; 1 0; 1 1; 0.5 + w 1; 0.5 1 + height; 0.5 - w 1; 0 1];
                polygons{end+1} = square * scale + offset; %#ok<AGROW>
            end
        end
        % Collinear spikes along an edge, retraced and extended.
        polygons{end+1} = [0 0; 1 0; 1 1; 1.5 1; 0 1] * scale + offset; %#ok<AGROW>
        polygons{end+1} = [0 0; 1 0; 1 1; 0.5 1; 0.75 1; 0 1] * scale + offset; %#ok<AGROW>
        polygons{end+1} = [0 0; 2 0; 1 0; 1 1; 0 1] * scale + offset; %#ok<AGROW>
        polygons{end+1} = [0 0; 1 0; 1 0; 1 1; 0 1] * scale + offset; %#ok<AGROW>
        polygons{end+1} = [-1 -1; 0 0; 0 1; 1 -1; 1 0; 1 1] * scale + offset; %#ok<AGROW>
    end
end
end

function polygons = degenerate()
polygons = {zeros(0, 2), [1 2], [0 0; 1 1], [0 0; 1 1; 2 2], [0 0; 0 0; 0 0], ...
    [0 0; 1 0; 1 1; 0 1; 0 0], [0 0; 0 1; 1 1; 1 0], [0 0; 1 1; 1 0; 0 1], ...
    [0 0; 2 2; 2 0; 0 2], [0 0; 1 0; 0.5 1; 0 0; -1 0; -0.5 -1], ...
    [cos(pi/2 + (0:4)' * 4 * pi / 5), sin(pi/2 + (0:4)' * 4 * pi / 5)], ...
    [0 0; 1 0; 1 1; 0 1; 0.25 0.25; 0.75 0.25; 0.75 0.75; 0.25 0.75], ...
    [0 0; 3 0; 3 3; 0 3; 1 1; 1 2; 2 2; 2 1], [0 0; 1 0; 2 0; 3 0; 1 1e-20], ...
    [0 0; 1 0; 1 1; 0 1; 0 1; 0 1; 1 1], [5 5; 5 5; 6 5; 6 6; 6 6]};
end

function polygons = point_clouds()
% Unordered point sets as SamSrf passes them: a cluster in breadth-first order.
rng(7322, 'twister');
polygons = {};
for i = 1:2500
    n = randi([4 40]);
    switch mod(i, 5)
        case 0
            P = rand(n, 2) * 10^(4 * rand - 2) + (rand > 0.5) * 100;
        case 1
            P = randi([0 4], n, 2) * 0.5;
        case 2
            P = double(single(rand(n, 2) * 8 - 4));
        case 3
            t = rand(n, 1);
            P = [t, 2 * t + 1] + randn(n, 2) * 10^(-6 - 4 * rand);
        otherwise
            [gx, gy] = meshgrid(0:randi([2 5]), 0:randi([2 5]));
            G = [gx(:) gy(:)];
            P = G(randperm(size(G, 1), min(n, size(G, 1))), :) * 0.1 + 0.3;
    end
    polygons{end+1} = P; %#ok<AGROW>
end
end

function item = polygon_batch(id, polygons, keepVertices, causal)
% keepVertices (probe mode) also records the vertices of
% polyshape(P, 'KeepCollinearPoints', true), which show the rings before
% collinear points are cleaned. causal (causal mode) also records each
% boundary's ishole flag for both shapes, and the vertices of polyshape built
% again from the KeepCollinearPoints vertices, from the default vertices, and
% simplify(polyshape(P, 'Simplify', false)).
if nargin < 3
    keepVertices = false;
end
if nargin < 4
    causal = false;
end
extra = struct('defaultHoles', {cell(numel(polygons), 1)}, 'keptHoles', {cell(numel(polygons), 1)}, ...
    'fromKept', {cell(numel(polygons), 1)}, 'fromDefault', {cell(numel(polygons), 1)}, 'viaSimplify', {cell(numel(polygons), 1)});
n = numel(polygons);
kept = cell(n, 1);
counts = zeros(n, 1);
simplifiedCounts = zeros(n, 1);
hullCounts = zeros(n, 1);
collinearCounts = zeros(n, 1);
regions = zeros(n, 1);
estimate = NaN(n, 3);
polygonEstimate = NaN(n, 3);
warned = zeros(n, 1);
failed = zeros(n, 1);
warningIds = {};
errorIds = {};
total = sum(cellfun(@(P) size(P, 1), polygons));
points = zeros(total, 2);
simplified = cell(n, 1);
hulls = cell(n, 1);
row = 0;
for i = 1:n
    P = polygons{i};
    counts(i) = size(P, 1);
    points(row + (1:counts(i)), :) = P;
    row = row + counts(i);
    lastwarn('', '');
    warning('off', 'all');
    try
        shape = polyshape(P);
        [~, warningId] = lastwarn;
        if ~isempty(warningId)
            warned(i) = register(warningId);
        end
        V = shape.Vertices;
        if causal
            extra.defaultHoles{i} = causal_flags(shape);
            extra.fromDefault{i} = causal_vertices(V);
            try
                again = simplify(polyshape(P, 'Simplify', false));
                extra.viaSimplify{i} = again.Vertices;
            catch
                extra.viaSimplify{i} = [NaN NaN; NaN NaN];
            end
        end
        simplifiedCounts(i) = size(V, 1);
        simplified{i} = V;
        regions(i) = shape.NumRegions;
        [px, py] = centroid(shape);
        polygonEstimate(i, :) = [px py area(shape)];
        hull = convhull(shape);
        H = hull.Vertices;
        hullCounts(i) = size(H, 1);
        hulls{i} = H;
        [x, y] = centroid(hull);
        estimate(i, :) = [x y area(hull)];
    catch failure
        failed(i) = numel(errorIds) + 1;
        errorIds{end+1} = [failure.identifier ': ' failure.message]; %#ok<AGROW>
    end
    try
        keptShape = polyshape(P, 'KeepCollinearPoints', true);
        collinearCounts(i) = size(keptShape.Vertices, 1);
        kept{i} = keptShape.Vertices;
        if causal
            extra.keptHoles{i} = causal_flags(keptShape);
            extra.fromKept{i} = causal_vertices(keptShape.Vertices);
        end
    catch
        collinearCounts(i) = -1;
    end
    warning('on', 'all');
end
assert(row == total, 'Polygon point count');
item = struct('id', id, 'kind', 'polygon-batch', 'cases', n, ...
    'points', array_file([id '_points'], points), ...
    'counts', array_file([id '_counts'], counts), ...
    'simplified', array_file([id '_simplified'], vertcat(zeros(0, 2), simplified{:})), ...
    'simplifiedCounts', array_file([id '_simplified_counts'], simplifiedCounts), ...
    'collinearCounts', array_file([id '_collinear_counts'], collinearCounts), ...
    'regions', array_file([id '_regions'], regions), ...
    'hull', array_file([id '_hull'], vertcat(zeros(0, 2), hulls{:})), ...
    'hullCounts', array_file([id '_hull_counts'], hullCounts), ...
    'estimate', array_file([id '_estimate'], estimate), ...
    'polygonEstimate', array_file([id '_polygon_estimate'], polygonEstimate), ...
    'warning', array_file([id '_warning'], warned), ...
    'error', array_file([id '_error'], failed));
if keepVertices
    item.collinearVertices = array_file([id '_collinear_vertices'], vertcat(zeros(0, 2), kept{:}));
end
if causal
    for name = {'defaultHoles', 'keptHoles', 'fromKept', 'fromDefault', 'viaSimplify'}
        values = extra.(name{1});
        counts = cellfun(@(v) size(v, 1), values);
        width = 1 + any(strcmp(name{1}, {'fromKept', 'fromDefault', 'viaSimplify'}));
        rows = vertcat(zeros(0, width), values{:});
        item.(name{1}) = array_file([id '_' name{1}], rows);
        item.([name{1} 'Counts']) = array_file([id '_' name{1} '_counts'], counts);
    end
end
item.warningIds = warningIds;
item.errors = errorIds;
fprintf('Recorded %s (%d polygons)\n', id, n);

    function index = register(name)
        index = find(strcmp(warningIds, name), 1);
        if isempty(index)
            warningIds{end+1} = name;
            index = numel(warningIds);
        end
    end
end

%% Focused polyshape probes: the grid decade and held-out clouds

function cases = probe_cases()
cases = {};
[polygons, parameters] = grid_sweep();
cases{end+1} = with_parameters(polygon_batch('probe_grid_sweep', polygons, true), parameters);
[polygons, parameters] = grid_bisection();
cases{end+1} = with_parameters(polygon_batch('probe_grid_bisection', polygons, true), parameters);
cases{end+1} = polygon_batch('probe_heldout_collinear', heldout_collinear(), true);
cases{end+1} = polygon_batch('probe_heldout_clouds', heldout_clouds(), true);
cases{end+1} = polygon_batch('probe_extreme_grids', extreme_grids(), true);
% The original point clouds again, with their collinear-kept rings.
cases{end+1} = polygon_batch('probe_point_clouds', point_clouds(), true);
end

function cases = causal_cases()
families = polyshape_causal_cases(point_clouds(), heldout_clouds());
cases = {};
for k = 1:numel(families)
    family = families(k);
    if strcmp(family.id, 'causal_gap_bisection')
        [polygons, parameters] = gap_bisection(family.parameters);
    else
        polygons = family.polygons;
        parameters = family.parameters;
    end
    cases{end+1} = with_parameters(polygon_batch(family.id, polygons, true, true), parameters); %#ok<AGROW>
end
end

function cases = reproducer_cases()
% Every round: the earlier ones again (exact repeats across runs) and the latest.
here = fileparts(mfilename('fullpath'));
clouds = point_clouds();
cases = {};
for item = {{'reproducer_cases', 'polyshape-reproducers.json'}, {'reproducer_round2', 'polyshape-reproducers-2.json'}, ...
        {'reproducer_round3', 'polyshape-reproducers-3.json'}}
    spec = jsondecode(fileread(fullfile(here, item{1}{2})));
    [polygons, parameters] = polyshape_reproducer_cases(clouds, spec);
    cases{end+1} = with_parameters(polygon_batch(item{1}{1}, polygons, true, true), parameters); %#ok<AGROW>
end
end

function [polygons, parameters] = gap_bisection(combinations)
% For each [t f angle reversed], bisect the sliver width g (in tolerance units)
% between 0.1 and 30 on MATLAB's default polyshape: merged when NumRegions is 1.
% Every evaluated polygon is recorded; rows add [low high atLow atHigh] with
% verdicts 1 merged, 0 separate, -1 neither (an error or other region count).
polygons = {};
parameters = zeros(0, 8);
for c = 1:size(combinations, 1)
    t = combinations(c, 1);
    f = combinations(c, 2);
    angle = combinations(c, 3);
    reversed = combinations(c, 4);
    low = 0.1;
    high = 30;
    P = polyshape_causal_strips(t, low, f, angle, reversed, 0);
    polygons{end+1} = P; %#ok<AGROW>
    atLow = merged(P);
    P = polyshape_causal_strips(t, high, f, angle, reversed, 0);
    polygons{end+1} = P; %#ok<AGROW>
    atHigh = merged(P);
    if atLow == 1 && atHigh == 0
        for iteration = 1:45
            middle = sqrt(low * high);
            if middle <= low || middle >= high
                break
            end
            P = polyshape_causal_strips(t, middle, f, angle, reversed, 0);
            polygons{end+1} = P; %#ok<AGROW>
            verdict = merged(P);
            if verdict == 1
                low = middle;
            elseif verdict == 0
                high = middle;
            else
                break
            end
        end
    end
    parameters(end+1, :) = [combinations(c, :) low high atLow atHigh]; %#ok<AGROW>
end
end

function verdict = merged(P)
verdict = -1;
warning('off', 'all');
restore = onCleanup(@() warning('on', 'all'));
try
    shape = polyshape(P);
catch
    return
end
if shape.NumRegions == 1
    verdict = 1;
elseif shape.NumRegions == 2
    verdict = 0;
end
end

function item = with_parameters(item, parameters)
item.parameters = array_file([item.id '_parameters'], parameters);
end

function shapes = probe_shapes()
% Self-intersecting shapes with several crossings, normalised so the largest
% centred coordinate is 1: a {5/2} and a {7/3} star and four random 9-gons.
shapes = {};
for step = [2 3]
    n = 2 * step + 1;
    angle = 2 * pi * step * (0:n-1)' / n + 0.1234;
    shapes{end+1} = [cos(angle) sin(angle)]; %#ok<AGROW>
end
rng(73211, 'twister');
for s = 1:4
    shapes{end+1} = rand(9, 2) * 2 - 1; %#ok<AGROW>
end
for s = 1:numel(shapes)
    P = shapes{s};
    P = P - (min(P) + max(P)) / 2;
    shapes{s} = P / max(abs(P(:)));
end
end

function P = probe_instance(shape, magnitude, offset, swapped)
if swapped
    shape = shape(:, [2 1]);
end
P = shape * magnitude + offset * magnitude;
end

function [polygons, parameters] = grid_sweep()
% Centred magnitudes 6.150 to 6.350 times 10^k in steps of 0.001, so that
% m * 10^p crosses 6.2e13 to 6.3e13 densely, translated and with the extreme
% coordinate on either axis. Rows: shape, mantissa, k, offset index, swapped.
shapes = probe_shapes();
offsets = [0 0; 1.7 -0.9];
mantissas = 6.15:0.001:6.35;
polygons = {};
parameters = zeros(0, 5);
for s = 1:numel(shapes)
    for k = [-4 -2 0 1 3]
        for o = 1:size(offsets, 1)
            for swapped = 0:1
                for mantissa = mantissas
                    polygons{end+1} = probe_instance(shapes{s}, mantissa * 10^k, offsets(o, :), swapped); %#ok<AGROW>
                    parameters(end+1, :) = [s mantissa k o swapped]; %#ok<AGROW>
                end
            end
        end
    end
end
end

function [polygons, parameters] = grid_bisection()
% Bisect the mantissa between 6.18 and 6.30 on MATLAB's own result: the coarser
% decade is taken when every new vertex lies on it. Every evaluated polygon is
% recorded; rows give shape, k, offset index, swapped, the final bracket and the
% classification at both ends (1 coarse, 0 fine, -1 undetermined).
shapes = probe_shapes();
offsets = [0 0; 1.7 -0.9];
polygons = {};
parameters = zeros(0, 8);
for s = 1:numel(shapes)
    for k = [-3 0 2]
        for o = 1:size(offsets, 1)
            for swapped = 0:1
                low = 6.18;
                high = 6.30;
                P = probe_instance(shapes{s}, low * 10^k, offsets(o, :), swapped);
                polygons{end+1} = P; %#ok<AGROW>
                atLow = coarse_grid(P);
                P = probe_instance(shapes{s}, high * 10^k, offsets(o, :), swapped);
                polygons{end+1} = P; %#ok<AGROW>
                atHigh = coarse_grid(P);
                if atLow == 0 && atHigh == 1
                    for iteration = 1:60
                        middle = (low + high) / 2;
                        if middle <= low || middle >= high
                            break
                        end
                        P = probe_instance(shapes{s}, middle * 10^k, offsets(o, :), swapped);
                        polygons{end+1} = P; %#ok<AGROW>
                        verdict = coarse_grid(P);
                        if verdict == 1
                            high = middle;
                        elseif verdict == 0
                            low = middle;
                        else
                            break
                        end
                    end
                end
                parameters(end+1, :) = [s k o swapped low high atLow atHigh]; %#ok<AGROW>
            end
        end
    end
end
end

function verdict = coarse_grid(P)
% 1 when every new polyshape vertex lies on the grid one decade coarser than
% 10^(13 - floor(log10(m))), 0 when one does not, -1 without three new vertices.
verdict = -1;
warning('off', 'all');
restore = onCleanup(@() warning('on', 'all'));
try
    shape = polyshape(P);
catch
    return
end
V = shape.Vertices;
V = V(all(isfinite(V), 2), :);
V = V(~ismember(V, P, 'rows'), :);
if size(V, 1) < 3
    return
end
centre = (min(P) + max(P)) / 2;
magnitude = max(max(abs(P - centre)));
K = round((V - centre) * 10^(13 - floor(log10(magnitude))));
verdict = double(all(mod(K(:), 10) == 0));
end

function polygons = heldout_collinear()
% Held-out near-collinear clouds (point_clouds kind 3, another seed).
rng(73202, 'twister');
polygons = cell(1, 1500);
for i = 1:numel(polygons)
    n = randi([4 40]);
    t = rand(n, 1);
    polygons{i} = [t, 2 * t + 1] + randn(n, 2) * 10^(-6 - 4 * rand);
end
end

function polygons = heldout_clouds()
% Held-out clouds of every point_clouds kind (another seed); random-order
% clouds give outer rings with touching holes.
rng(73203, 'twister');
polygons = cell(1, 1500);
for i = 1:numel(polygons)
    n = randi([4 40]);
    switch mod(i, 5)
        case 0
            P = rand(n, 2) * 10^(4 * rand - 2) + (rand > 0.5) * 100;
        case 1
            P = randi([0 4], n, 2) * 0.5;
        case 2
            P = double(single(rand(n, 2) * 8 - 4));
        case 3
            t = rand(n, 1);
            P = [t, 2 * t + 1] + randn(n, 2) * 10^(-6 - 4 * rand);
        otherwise
            [gx, gy] = meshgrid(0:randi([2 5]), 0:randi([2 5]));
            G = [gx(:) gy(:)];
            P = G(randperm(size(G, 1), min(n, size(G, 1))), :) * 0.1 + 0.3;
    end
    polygons{i} = P;
end
end

function polygons = extreme_grids()
% Coordinates outside the port's fixed-point grid, and degenerate sets.
polygons = {[0 0; 1e-300 0; 0 1e-300], [0 0; realmin * eps 0; 0 realmin * eps], ...
    [1e308 0; 1.1e308 0; 1e308 1], [-1e308 0; 1e308 0; 0 1], ...
    [1e12 1e12; 1e12 + 1e-3 1e12; 1e12 1e12 + 1e-3], [2 3; 2 3; 2 3], [0 0; 1 1; 2 2]};
end

function flags = causal_flags(shape)
% One row per boundary: 1 for a hole, 0 for a solid boundary.
if shape.NumRegions == 0 && shape.NumHoles == 0
    flags = zeros(0, 1);
else
    flags = double(ishole(shape));
    flags = flags(:);
end
end

function V = causal_vertices(vertices)
% The vertices of polyshape built again from recorded vertices (NaN-separated
% boundaries); [NaN NaN; NaN NaN] when that fails.
V = zeros(0, 2);
if isempty(vertices)
    return
end
try
    again = polyshape(vertices);
    V = again.Vertices;
catch
    V = [NaN NaN; NaN NaN];
end
end

%% Delaunay triangulations with exact and near ties

function cases = delaunay_cases()
cases = {};
for nx = 2:6
    for ny = 2:6
        [gx, gy] = meshgrid(0:nx-1, 0:ny-1);
        G = [gx(:) gy(:)];
        cases{end+1} = delaunay_case(sprintf('grid_%dx%d', nx, ny), G); %#ok<AGROW>
        cases{end+1} = delaunay_case(sprintf('grid_%dx%d_scaled', nx, ny), G * 0.1 + 100.3); %#ok<AGROW>
        cases{end+1} = delaunay_case(sprintf('grid_%dx%d_rotated', nx, ny), [-G(:, 2) G(:, 1)]); %#ok<AGROW>
    end
end
rng(7323, 'twister');
for n = 3:5
    [gx, gy] = meshgrid(0:n-1, 0:n-1);
    G = [gx(:) gy(:)];
    for p = 1:3
        cases{end+1} = delaunay_case(sprintf('grid_%dx%d_shuffled%d', n, n, p), G(randperm(n * n), :)); %#ok<AGROW>
    end
    cases{end+1} = delaunay_case(sprintf('grid_%dx%d_single', n, n), double(single(G * 0.1 - 0.35))); %#ok<AGROW>
end
pythagorean = {[5 0; 4 3; 3 4], [25 0; 24 7; 20 15; 15 20; 7 24], [65 0; 63 16; 60 25; 56 33; 52 39; 39 52; 33 56; 25 60; 16 63]};
for k = 1:numel(pythagorean)
    Q = pythagorean{k};
    C = unique([Q; -Q; [-Q(:, 1) Q(:, 2)]; [Q(:, 1) -Q(:, 2)]; Q(:, [2 1]); -Q(:, [2 1]); [-Q(:, 2) Q(:, 1)]; [Q(:, 2) -Q(:, 1)]], 'rows');
    r = Q(1, 1);
    cases{end+1} = delaunay_case(sprintf('circle_r%d', r), C); %#ok<AGROW>
    cases{end+1} = delaunay_case(sprintf('circle_r%d_centre', r), [C; 0 0]); %#ok<AGROW>
    cases{end+1} = delaunay_case(sprintf('circle_r%d_interior', r), [C; round((rand(6, 2) - 0.5) * r)]); %#ok<AGROW>
    cases{end+1} = delaunay_case(sprintf('circle_r%d_shuffled', r), C(randperm(size(C, 1)), :)); %#ok<AGROW>
end
for n = 4:12
    t = (0:n-1)' * 2 * pi / n;
    R = [cos(t) sin(t)];
    cases{end+1} = delaunay_case(sprintf('regular_%d', n), R); %#ok<AGROW>
    cases{end+1} = delaunay_case(sprintf('regular_%d_centre', n), [R; 0 0] * 3.7 + 2); %#ok<AGROW>
end
[hx, hy] = meshgrid(0:4, 0:4);
hx = hx + 0.5 * mod(hy, 2);
cases{end+1} = delaunay_case('hexagonal', [hx(:) hy(:) * sqrt(3) / 2]);
[gx, gy] = meshgrid(-1:1, -1:1);
grid = [gx(:) gy(:)];
for delta = [1e-15 1e-12 1e-9 1e-7]
    for direction = {[1 0], [0 1], [1 1], [-1 0]}
        P = grid;
        P(5, :) = P(5, :) + delta * direction{1};
        cases{end+1} = delaunay_case(sprintf('grid_centre_%g_%d_%d', delta, direction{1}), P); %#ok<AGROW>
    end
    P = grid;
    P(9, :) = P(9, :) + delta;
    cases{end+1} = delaunay_case(sprintf('grid_corner_%g', delta), P); %#ok<AGROW>
end
[gx, gy] = meshgrid(0:3, 0:3);
for delta = [1e-15 1e-13 1e-10]
    P = [gx(:) gy(:)] + delta * sign(rand(16, 2) - 0.5);
    cases{end+1} = delaunay_case(sprintf('grid_4x4_jitter_%g', delta), P); %#ok<AGROW>
end
duplicate = grid;
duplicate(9, :) = duplicate(8, :);
cases{end+1} = delaunay_case('grid_duplicate', duplicate);
cases{end+1} = delaunay_case('collinear', [(0:4)' 2 * (0:4)']);
cases{end+1} = delaunay_case('two_points', [0 0; 1 1]);
cases{end+1} = delaunay_case('collinear_then_apex', [(0:4)' zeros(5, 1); 2 1]);
cases{end+1} = delaunay_case('collinear_hull', [0 0; 1 0; 2 0; 3 0; 0 1; 3 1; 1.5 2]);
for i = 1:20
    n = randi([5 60]);
    cases{end+1} = delaunay_case(sprintf('integer_cloud_%d', i), randi([0 6], n, 2)); %#ok<AGROW>
end
end

function item = delaunay_case(id, P)
id = ['delaunay_' regexprep(id, '[^A-Za-z0-9_]', '_')];
item = struct('id', id, 'kind', 'delaunay', 'points', array_file([id '_points'], P));
lastwarn('', '');
warning('off', 'all');
try
    triangles = delaunay(P);
    [~, warningId] = lastwarn;
    item.triangles = array_file([id '_triangles'], triangles);
    item.warning = warningId;
    item.error = '';
catch failure
    item.triangles = array_file([id '_triangles'], zeros(0, 3));
    item.warning = '';
    item.error = [failure.identifier ': ' failure.message];
end
warning('on', 'all');
end

%% Region growing over the triangulation

function cases = cluster_cases()
cases = {};
rng(7324, 'twister');
lattices = {};
for n = 3:6
    [gx, gy] = meshgrid(0:n-1, 0:n-1);
    lattices{end+1} = {sprintf('grid%d', n), [gx(:) gy(:)]}; %#ok<AGROW>
end
[hx, hy] = meshgrid(0:4, 0:4);
lattices{end+1} = {'hexagonal', [hx(:) + 0.5 * mod(hy(:), 2), hy(:) * sqrt(3) / 2]};
C = [5 0; 4 3; 3 4; 0 5; -3 4; -4 3; -5 0; -4 -3; -3 -4; 0 -5; 3 -4; 4 -3];
lattices{end+1} = {'circle_r5', [C; 0 0; 1 1; -2 1]};
for l = 1:numel(lattices)
    name = lattices{l}{1};
    P = lattices{l}{2};
    tri = delaunay(P);
    for s = 1:12
        statistic = round(rand(size(P, 1), 1) * 10) / 10;
        statistic(randi(size(P, 1))) = 1.1;
        if s > 6
            statistic = -statistic;
            statistic(randi(size(P, 1))) = 1.1;
        end
        seed = find(statistic == max(statistic), 1);
        threshold = max(statistic) / 2;
        id = sprintf('cluster_%s_%d', name, s);
        selected = samsrf_clusterroi(seed, statistic, threshold, tri);
        cases{end+1} = struct('id', id, 'kind', 'cluster', ...
            'points', array_file([id '_points'], P), ...
            'triangles', array_file([id '_triangles'], tri), ...
            'statistic', array_file([id '_statistic'], statistic), ...
            'seed', seed, 'threshold', threshold, ...
            'selected', array_file([id '_selected'], selected(:))); %#ok<AGROW>
    end
end
end

%% Real Benson V1 template coordinates, both hemispheres

function cases = template_cases(input)
cases = {};
label = read_label(fullfile(input, 'V123.label'));
lhVertices = 134260;
for hemisphere = {'lh', 'rh'}
    hemi = hemisphere{1};
    D = gifti(fullfile(input, [hemi '_benson.gii']));
    D = D.cdata;
    assert(isa(D, 'single') && size(D, 2) == 3, 'Unexpected Benson GIfTI');
    % samsrf_benson2srf's conversion, verbatim.
    D(:,1) = -D(:,1) + 90;
    x0 = D(:,2) .* cos(D(:,1)/180*pi);
    y0 = D(:,2) .* sin(D(:,1)/180*pi);
    rois = D(:,3);
    if strcmp(hemi, 'rh')
        x0 = -x0;
        rows = label(label >= lhVertices) - lhVertices + 1;
    else
        rows = label(label < lhVertices) + 1;
    end
    inRoi = false(size(rois));
    inRoi(rows) = true;
    seed = find(inRoi & abs(rois) == 1);
    Template = [ones(1, numel(seed)); x0(seed)'; y0(seed)'; NaN(1, numel(seed)); rois(seed)'];
    txy = unique(double(Template(2:3, :))', 'rows');
    cases{end+1} = delaunay_case(['benson_' hemi '_v1'], txy); %#ok<AGROW>
    rng(7325 + strcmp(hemi, 'rh'), 'twister');
    T = 160;
    K = 12;
    nver = 40;
    centres = txy(randperm(size(txy, 1), K), :);
    widths = 0.3 + 2 * rand(1, K);
    distance2 = (double(Template(2, :))' - centres(:, 1)').^2 + (double(Template(3, :))' - centres(:, 2)').^2;
    basis = exp(-distance2 ./ (2 * widths.^2));
    A = randn(T, K);
    X = A * basis' + 0.2 * randn(T, numel(seed));
    weights = zeros(K, nver);
    for v = 1:nver
        pair = randperm(K, 2);
        weights(pair, v) = [1; -0.6];
    end
    Tc = A * weights + 0.5 * randn(T, nver);
    % A compact patch keeps the quadratic Gaussian residual affordable.
    [~, near] = sort(sum((double(Template(2:3, :))' - centres(1, :)).^2, 2));
    patch = sort(near(1:120))';
    for precision = {'double', 'single'}
        kind = precision{1};
        Temp = cast(Template, kind);
        for mode = {'hull', 'summary', 'gaussian'}
            switch mode{1}
                case 'hull'
                    fit = [];
                    seedVx = 1:numel(seed);
                    courses = Tc;
                case 'summary'
                    fit = Inf;
                    seedVx = 1:numel(seed);
                    courses = Tc;
                otherwise
                    fit = NaN;
                    seedVx = patch;
                    courses = Tc(:, 1:6);
            end
            id = sprintf('template_%s_%s_%s', hemi, kind, mode{1});
            seedCourses = cast(X(:, seedVx), kind);
            courses = cast(courses, kind);
            [vx, x, y, w, r, s, b, profiles] = samsrf_cfparam_loop(courses, seedCourses, ...
                ones(1, numel(seedVx)), seedVx, Temp, [], fit, true);
            item = struct('id', id, 'kind', 'template-cf', 'hemisphere', hemi, ...
                'precision', kind, 'mode', mode{1}, ...
                'seedVertices', array_file([id '_seed_vertices'], seed(seedVx) - 1), ...
                'template', array_file([id '_template'], Temp(:, seedVx)), ...
                'profiles', array_file([id '_profiles'], profiles), ...
                'maps', array_file([id '_maps'], [vx; x; y; w; r; s; b]));
            if strcmp(mode{1}, 'hull')
                item.clusters = hull_clusters(id, Temp, profiles);
            end
            cases{end+1} = item; %#ok<AGROW>
            fprintf('Recorded %s\n', id);
        end
    end
end
end

function clusters = hull_clusters(id, Temp, profiles)
% Intermediates of samsrf_cfparam_loop's convex-hull branch, recomputed with
% the same calls so a differing map can be traced to the operation.
txy = double(Temp(2:3, :))';
[txy, u] = unique(txy, 'rows');
tri = delaunay(txy);
selected = cell(size(profiles, 2), 1);
vertices = cell(size(profiles, 2), 1);
selectedCounts = zeros(size(profiles, 2), 1);
vertexCounts = zeros(size(profiles, 2), 1);
for v = 1:size(profiles, 2)
    peak = max(profiles(:, v));
    if isnan(peak) || peak <= 0
        continue
    end
    R = profiles(u, v);
    mR = max(R);
    pos = samsrf_clusterroi(find(R == mR, 1), R, mR / 2, tri);
    selected{v} = pos(:);
    selectedCounts(v) = numel(pos);
    warning('off', 'all');
    shape = polyshape(txy(pos, :));
    warning('on', 'all');
    vertices{v} = shape.Vertices;
    vertexCounts(v) = size(shape.Vertices, 1);
end
clusters = struct('unique', array_file([id '_unique'], u), ...
    'triangles', array_file([id '_triangles'], tri), ...
    'selected', array_file([id '_selected'], vertcat(zeros(0, 1), selected{:})), ...
    'selectedCounts', array_file([id '_selected_counts'], selectedCounts), ...
    'polygon', array_file([id '_polygon'], vertcat(zeros(0, 2), vertices{:})), ...
    'polygonCounts', array_file([id '_polygon_counts'], vertexCounts));
end

function vertices = read_label(file)
fid = fopen(file, 'r');
assert(fid ~= -1, 'Cannot read label');
closer = onCleanup(@() fclose(fid));
fgetl(fid);
count = str2double(fgetl(fid));
rows = fscanf(fid, '%f', [5 count]);
assert(size(rows, 2) == count, 'Short label');
vertices = rows(1, :)';
end

%% Output

function description = array_file(name, value)
description = struct('file', [name '.f64'], 'shape', size(value), ...
    'class', class(value), 'imaginary', '');
write_array(description.file, value);
end

function write_array(path, value)
[fid, message] = fopen(path, 'w', 'ieee-le');
assert(fid ~= -1, message);
cleanup = onCleanup(@() fclose(fid));
assert(fwrite(fid, double(value), 'double') == numel(value), 'Short array write');
end

function write_json(path, value)
[fid, message] = fopen(path, 'w');
assert(fid ~= -1, message);
cleanup = onCleanup(@() fclose(fid));
assert(fprintf(fid, '%s\n', jsonencode(value, 'PrettyPrint', true)) > 0, 'Short JSON write');
end
