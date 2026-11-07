function record_reference(source, input, output, matrixInput, spmSource)
% Record actual MATLAB arithmetic before deciding how to emulate it in WASM.
% source is the pinned checkout with prepare.py's three declared repairs.
arguments
    source (1,:) char
    input (1,:) char
    output (1,:) char
    matrixInput (1,:) char = ''
    spmSource (1,:) char = ''
end
assert(isfile(fullfile(output, 'source.json')), 'Run prepare.py first');
assert(~isfile(fullfile(output, 'reference.json')), 'Use a fresh output directory');
addpath(genpath(source));
if ~isempty(spmSource)
    addpath(spmSource);
end
previous = pwd;
cleanup = onCleanup(@() cd(previous));
cd(output);
set(groot, 'defaultFigureVisible', 'off');
defaults = jsondecode(fileread(fullfile(source, 'SamSrf_defaults.json')));
meta = reference_environment('source-matrix');
meta.source = jsondecode(fileread('source.json'));
meta.input = jsondecode(fileread(fullfile(input, 'manifest.json')));
write_json('environment.json', meta);
d = load(fullfile(input, 'probe-all.mat'));
cases = {};
for precision = {'double', 'single'}
    kind = precision{1};
    defaults.def_64bit = strcmp(kind, 'double');
    write_json('SamSrf_defaults.json', defaults);
    converted = samsrf_32bit_srf(struct('Data', [pi 1/3]));
    assert(strcmp(class(converted.Data), kind), 'Precision setting was not honored');
    cases = [cases, correlation_cases(kind)]; %#ok<AGROW>
    cases = [cases, complex_correlation_cases(d, kind)]; %#ok<AGROW>
    cases = [cases, fit_cases(d, kind)]; %#ok<AGROW>
    write_json('reference.json.partial', struct('cases', {cases}));
end
cases = [cases, css_cases(d)];
pool = gcp('nocreate');
if isempty(pool)
    pool = parpool('local', 2);
end
poolCleanup = onCleanup(@() delete(pool));
cases = [cases, cf_cases()];
cases = [cases, polygon_cases()];
write_json('reference.json.partial', struct('cases', {cases}));
if ~isempty(matrixInput)
    cases = [cases, record_matrix(matrixInput, output, @array_file, @write_json)];
end
write_json('reference.json', struct('cases', {cases}));
fprintf('Recorded %d actual MATLAB cases. No WASM equivalence claim is implied.\n', numel(cases));
end

function cases = correlation_cases(kind)
cases = {};
for n = [3 7 8 9 15 16 17 31:65 127:129 249:251 511:513 1023:1025 2048]
    t = (1:n)';
    for offset = [0 100]
        x = offset + sin(t * sqrt(2)) .* (1 + mod(t, 7)) * 0.1;
        y = cast(0.3 * cos(t * sqrt(3)) + 0.7 * sin(t * sqrt(2)), kind);
        xc = x - mean(x);
        yc = y - mean(y);
        id = sprintf('corr_%s_n%d_offset%d', kind, n, offset);
        r = corr(x, y);
        values = {x, y, xc, yc, mean(y), norm(xc), norm(yc), ...
            xc' * yc, r, 1-r.^2, sum(y), sum(y.^2), single(xc)' * single(yc)};
        names = {'x', 'y', 'xc', 'yc', 'meanY', 'normX', 'normY', ...
            'mixedDot', 'correlation', 'objective', 'sumY', 'sumSquaresY', 'singleDot'};
        item = struct('id', id, 'kind', 'correlation', 'precision', kind);
        for i = 1:numel(names)
            item.(names{i}) = array_file([id '_' names{i}], values{i});
        end
        cases{end+1} = item; %#ok<AGROW>
    end
end
end

function cases = fit_cases(d, kind)
cases = {};
profile = @(p, xy) prf_gaussian_rf(p(1), p(2), p(3), xy);
custom = samsrf_doublegamma(1, [5 15 1.2 0.9 5 1 30]);
configs = {
    'gaussian', false, d.Hrf, 20;
    'custom_hrf', false, custom, 6;
    'fitted_hrf', false, -1, 6;
    'css', true, d.Hrf, 6;
    'css_fitted_hrf', true, -1, 6;
    'css_nonnegative', true, d.Hrf, 6;
    'css_nonnegative_fitted_hrf', true, -1, 6;
};
for k = 1:size(configs, 1)
    name = configs{k, 1};
    css = configs{k, 2};
    hrf = configs{k, 3};
    count = configs{k, 4};
    frames = d.ApFrm;
    if contains(name, 'nonnegative')
        frames = max(frames, 0);
    end
    id = ['fit_' kind '_' name];
    observations = cast(d.Ys(:, 1:count), kind);
    seeds = double(d.Seeds(:, 1:count));
    if css
        seeds = [seeds; ones(1, count)]; %#ok<AGROW>
    end
    fittingHrf = isscalar(hrf) && hrf < 0;
    if fittingHrf
        seeds = [seeds; repmat([6; 16; 1; 1; 6], 1, count)]; %#ok<AGROW>
    end
    fits = zeros(size(seeds));
    objectives = zeros(1, count);
    betas = zeros(2, count);
    correctedBetas = zeros(2, count);
    traces = cell(1, count);
    predictions = zeros(size(observations));
    for v = 1:count
        trace = [];
        y = observations(:, v);
        [p, err] = fminsearch(@objective, seeds(:, v), optimset('Display', 'off'));
        fits(:, v) = p;
        objectives(v) = err;
        traces{v} = array_file(sprintf('%s_trace_%d', id, v), trace);
        kernel = hrf;
        if fittingHrf
            kernel = samsrf_doublegamma(1, p(end-4:end));
        end
        prediction = prf_predict_timecourse(profile(p, d.ApXY), frames);
        corrected = prediction;
        if css
            % Preserve the pinned post-fit bug as evidence, alongside its correction.
            prediction = prediction .^ p(end);
            corrected = corrected .^ p(4);
        end
        prediction = prf_convolve_hrf(prediction, kernel, 1);
        corrected = prf_convolve_hrf(corrected, kernel, 1);
        predictions(:, v) = prediction;
        betas(:, v) = flipud([ones(length(y), 1) prediction] \ y);
        correctedBetas(:, v) = flipud([ones(length(y), 1) corrected] \ y);
    end
    cases{end+1} = struct('id', id, 'kind', 'fit', 'precision', kind, ...
        'css', css, 'nonnegativeApertures', contains(name, 'nonnegative'), ...
        'hrf', array_file([id '_hrf'], hrf), ...
        'observations', array_file([id '_y'], observations), ...
        'seeds', array_file([id '_seeds'], seeds), ...
        'parameters', array_file([id '_parameters'], fits), ...
        'objective', array_file([id '_objective'], objectives), ...
        'prediction', array_file([id '_prediction'], predictions), ...
        'betas', array_file([id '_betas'], betas), ...
        'correctedBetas', array_file([id '_corrected_betas'], correctedBetas), ...
        'traces', {traces}); %#ok<AGROW>
    fprintf('Recorded %s\n', id);
end

    function err = objective(p)
        err = prf_errfun(profile, frames, d.ApXY, hrf, p, y, 1, css);
        % Concatenating a single err would otherwise round the double p values.
        trace(end+1, :) = [p(:)' double(real(err)) double(imag(err))];
    end
end

function cases = complex_correlation_cases(d, kind)
cases = {};
for n = [50 64 250 600]
    t = (1:n)';
    y = cast(0.3*cos(t*sqrt(3)) + 0.7*sin(t*sqrt(2)), kind);
    for scale = [0 1e-8 0.3]
        x = sin(t*sqrt(2)).*(1+mod(t,7))*0.1 + 1i*scale*cos(t*sqrt(5));
        id = sprintf('complex_corr_%s_n%d_scale%g', kind, n, scale);
        cases{end+1} = complex_case(id, kind, x, y); %#ok<AGROW>
    end
end
for vertex = 1:2
    p = double(d.Seeds(:,vertex));
    raw = prf_predict_timecourse(prf_gaussian_rf(p(1),p(2),p(3),d.ApXY), d.ApFrm);
    y = cast(d.Ys(:,vertex), kind);
    for exponent = [0.55 1 1.05]
        x = prf_convolve_hrf(raw.^exponent, d.Hrf, 1);
        id = sprintf('complex_css_%s_v%d_exponent%g', kind, vertex, exponent);
        cases{end+1} = complex_case(id, kind, x, y); %#ok<AGROW>
    end
end
end

function item = complex_case(id, kind, x, y)
xc = x - mean(x);
yc = y - mean(y);
product = xc' * yc;
first = product / norm(xc);
r = corr(x,y);
values = {x, y, xc, yc, mean(x), mean(y), norm(xc), norm(yc), ...
    product, first, first/norm(yc), r, 1-r.^2, ...
    corr(single(x),single(y)), (xc/norm(xc))'*(yc/norm(yc))};
names = {'x', 'y', 'xc', 'yc', 'meanX', 'meanY', 'normX', 'normY', ...
    'mixedDot', 'firstDivision', 'secondDivision', 'correlation', 'objective', ...
    'singleCorrelation', 'normalizedDot'};
item = struct('id', id, 'kind', 'complex_correlation', 'precision', kind, 'realInput', isreal(x));
for i = 1:numel(names)
    item.(names{i}) = array_file([id '_' names{i}], values{i});
end
end

function cases = css_cases(d)
cases = {};
profile = @(p, xy) prf_gaussian_rf(p(1), p(2), p(3), xy);
frames = d.ApFrm;
frames(:, 1:3:end) = -frames(:, 1:3:end);
p = double(d.Seeds(:, 1));
y = double(d.Ys(:, 1));
raw = prf_predict_timecourse(profile(p, d.ApXY), frames);
for exponent = [0.25 0.5 0.75 1 2]
    id = sprintf('css_signed_%g', exponent);
    compressed = raw .^ exponent;
    predicted = prf_convolve_hrf(compressed, d.Hrf, 1);
    err = prf_errfun(profile, frames, d.ApXY, d.Hrf, [p; exponent], y, 1, true);
    cases{end+1} = struct('id', id, 'kind', 'css_signed', ...
        'exponent', exponent, 'raw', array_file([id '_raw'], raw), ...
        'compressed', array_file([id '_compressed'], compressed), ...
        'prediction', array_file([id '_prediction'], predicted), ...
        'objective', array_file([id '_objective'], err)); %#ok<AGROW>
end
end

function cases = cf_cases()
cases = {};
[gx, gy] = meshgrid(-1:1, -1:1);
grid = [gx(:) gy(:)];
almost = grid;
almost(5, 1) = almost(5, 1) + 1e-7;
line = [(0:8)' (mod((0:8)', 2) - 0.5) * 1e-9];
duplicate = grid;
duplicate(9, :) = duplicate(8, :);
coordinates = {grid, almost, line, duplicate};
names = {'cocircular', 'almost_cocircular', 'almost_collinear', 'duplicate'};
t = (1:64)';
X = sin(2*pi*t*(1:9)/64);
peaks = nchoosek(1:9, 3);
R = repmat(-0.2, size(peaks, 1), 9);
for i = 1:size(peaks, 1)
    R(i, peaks(i, :)) = [1 0.9 0.8];
end
Tc = X * R';
for precision = {'double', 'single'}
    kind = precision{1};
    for c = 1:numel(coordinates)
        Temp = cast([ones(1, 9); coordinates{c}'; zeros(2, 9)], kind);
        id = ['cf_' kind '_' names{c}];
        cases{end+1} = cf_case(id, kind, X, Tc, Temp, [], []); %#ok<AGROW>
    end
    Temp = cast([ones(1, 9); grid'; zeros(2, 9)], kind);
    cases{end+1} = cf_case(['cf_' kind '_summary'], kind, X, Tc, Temp, [], Inf); %#ok<AGROW>
    cases{end+1} = cf_case(['cf_' kind '_fit'], kind, X, Tc(:, 1:3), Temp, [], NaN); %#ok<AGROW>
    weights = exp(-pdist2(grid, grid).^2 / 2);
    cases{end+1} = cf_case(['cf_' kind '_smooth'], kind, X, Tc, Temp, weights, []); %#ok<AGROW>
    faces = [1 2 4; 2 4 5; 2 3 5; 3 5 6; 4 5 7; 5 7 8; 5 6 8; 6 8 9];
    vertices = [grid zeros(9, 1)];
    distances = samsrf_geomatrix(vertices, faces, 1:9, 20);
    weights = exp(-(distances.^2) / (2 * 1.5^2));
    for fit = {[], NaN}
        suffix = 'hull';
        courses = Tc;
        if ~isempty(fit{1})
            suffix = 'fit';
            courses = Tc(:, 1:3);
        end
        id = ['cf_' kind '_mesh_' suffix];
        item = cf_case(id, kind, X, courses, Temp, weights, fit{1});
        item.vertices = array_file([id '_vertices'], vertices);
        item.faces = array_file([id '_faces'], faces);
        item.distances = array_file([id '_distances'], distances);
        item.smoothingSigma = 1.5;
        cases{end+1} = item; %#ok<AGROW>
    end
end
end

function cases = polygon_cases()
cases = {};
points = {[-1 -1; 0 0; 0 1; 1 -1; 1 0; 1 1], ...
    [0 0; 1 1; 0 1; 1 0], [0 0; 1 0; 1 0; 1 1; 0 1], ...
    [0 0; 2 0; 1 0; 1 1; 0 1]};
for scale = [1 1e-3 1e3]
    for offset = [0 1e3]
        for height = 10.^(-16:0)
            points{end+1} = [0 0; 1 height; 2 0] * scale + offset; %#ok<AGROW>
        end
    end
end
% Distinguish a relative distance tolerance from angle-rounding collapse.
for height = 2.^(-29:-21)
    for apex = [0.1 1 1.9]
        triangle = [0 0; apex height; 2 0];
        points{end+1} = triangle; %#ok<AGROW>
        rotation = [cos(0.7) -sin(0.7); sin(0.7) cos(0.7)];
        points{end+1} = triangle * rotation; %#ok<AGROW>
    end
end
for height = (1.5:0.05:3) * 1e-8
    for scale = [1e-3 1 1e3]
        points{end+1} = [0 0; 1 height; 2 0] * scale; %#ok<AGROW>
    end
end
for i = 1:numel(points)
    id = sprintf('polygon_%d', i);
    polygon = polyshape(points{i});
    hull = convhull(polygon);
    [x, y] = centroid(hull);
    cases{end+1} = struct('id', id, 'kind', 'polygon', ...
        'points', array_file([id '_points'], points{i}), ...
        'simplified', array_file([id '_simplified'], polygon.Vertices), ...
        'hull', array_file([id '_hull'], hull.Vertices), ...
        'estimate', array_file([id '_estimate'], [x y area(hull)])); %#ok<AGROW>
end
end

function item = cf_case(id, kind, X, Tc, Temp, weights, fit)
X = cast(X, kind);
Tc = cast(Tc, kind);
[vx, x, y, w, r, s, b, profiles] = samsrf_cfparam_loop( ...
    Tc, X, ones(1, 9), 1:9, Temp, weights, fit, true);
item = struct('id', id, 'kind', 'cf', 'precision', kind, ...
    'seedCourses', array_file([id '_X'], X), ...
    'courses', array_file([id '_Y'], Tc), ...
    'template', array_file([id '_template'], Temp), ...
    'weights', array_file([id '_weights'], weights), ...
    'fit', array_file([id '_fit'], fit), ...
    'maps', array_file([id '_maps'], [vx; x; y; w; r; s; b]), ...
    'profiles', array_file([id '_profiles'], profiles));
fprintf('Recorded %s\n', id);
end

function description = array_file(name, value)
description = struct('file', [name '.f64'], 'shape', size(value), ...
    'class', class(value), 'imaginary', '');
write_array(description.file, real(value));
if ~isreal(value)
    description.imaginary = [name '.imag.f64'];
    write_array(description.imaginary, imag(value));
end
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
