function record_focused_probes(source, revcorDir, numerics2Dir, trigDir, output, smoke)
% Focused probes for the open single-precision and numerics questions (#729,
% #730). Each section answers one question whose competing predictions are
% written in focused-probes-predictions.md before the run:
%   hooke-jeeves  samsrf_fit2dprf with Hooke_Jeeves_Steps on the pinned single
%                 RC 2D profiles (revcor-reference.json): do the parameters stay
%                 single, and what does MATLAB return? A Nelder-Mead control on
%                 the same inputs must reproduce the pinned saved maps.
%   conv-512      the summation tree of sparse complex conv outputs near
%                 multiples of 512, by FPRev's pair method, on the nonzero
%                 patterns of the pinned courses (numerics2-reference.json).
%   trig-position single sin and cos at recorded exception and control inputs
%                 (single-trig-reference.json) as scalars, at every offset of a
%                 33-element array, and in one array.
%   dot-short     the summation tree of real x'*y for 2-24 elements, by the pair
%                 method, with held-out random products.
% The pinned inputs are read, never modified. smoke shortens every section.
if nargin < 6
    smoke = false;
end
if exist('samsrf_fit2dprf', 'file') ~= 2
    addpath(genpath(source));
end
if ~isfolder(output), mkdir(output); end
assert(~isfile(fullfile(output, 'focused.json')), 'Use a fresh probe directory');
previous = pwd;
restore = onCleanup(@() cd(previous));
cd(output);
environment = reference_environment('focused-probes');
cases = [hooke_jeeves_cases(revcorDir, smoke), conv_boundary_cases(numerics2Dir, smoke), ...
    {trig_position_case(trigDir, smoke)}, {dot_short_case(smoke)}];
write_json('focused.json', struct('environment', environment, 'cases', {cases}));
fprintf('Recorded %d focused probe cases\n', numel(cases));
end

%% Hooke-Jeeves on the pinned single RC 2D profiles

function cases = hooke_jeeves_cases(revcorDir, smoke)
cases = {};
stepSets = {[0.1 0.1 0.1], [0.05 0.05 0.02]};
for host = {'ubuntu-22.04', 'ubuntu-24.04'}
    root = fullfile(revcorDir, host{1});
    matrix = jsondecode(fileread(fullfile(root, 'revcor-matrix.json')));
    list = as_cell(matrix.cases);
    for c = 1:numel(list)
        item = list{c};
        if ~strcmp(item.kind, 'pipeline') || ~strcmp(item.analysis, 'revcor') || ~strcmp(item.precision, 'single')
            continue;
        end
        model = item.mapReplayModel;
        if ~isfield(model, 'Prf_Function') || ~ischar(model.Prf_Function) || isempty(model.Prf_Function)
            continue;
        end
        prf = str2func(model.Prf_Function);
        seedFunction = str2func(model.SeedPar_Function);
        profiles = single(read_array(root, item.profiles));
        raw = single(read_array(root, item.rawMaps));
        ApFrm = read_array(root, item.apertures);
        width = round(sqrt(size(profiles, 1)));
        assert(width^2 == size(profiles, 1), 'Profiles are not square');
        gof = find(raw(1, :) > model.R2_Threshold);
        if smoke
            gof = gof(1:min(2, numel(gof)));
        end
        scaling = [model.Scaling_Factor reshape(model.Scaled_Param, 1, [])];
        % samsrf_revcor_prf's pixel grid and double raw maps (fXimg, fYimg,
        % fSimg are double arrays); the pinned rawMaps are their single copies.
        [xc, yc] = meshgrid(linspace(-model.Scaling_Factor, model.Scaling_Factor, size(ApFrm, 2)), ...
            linspace(-model.Scaling_Factor, model.Scaling_Factor, size(ApFrm, 1)));
        yc = flipud(yc);
        loopRaw = NaN(5, size(raw, 2));
        for v = 1:size(raw, 2)
            cM = profiles(:, v);
            mM = max(cM);
            gp = cM > mM / 2;
            m = find(cM == mM, 1);
            loopRaw(:, v) = [double(raw(1, v)); xc(m); yc(m); sqrt(mean(gp) * (model.Scaling_Factor * 2)^2); double(raw(5, v))];
            assert(isequal(single(loopRaw(:, v)), raw(:, v)), 'Rebuilt raw row %d does not round to the pinned one', v);
        end
        for s = 0:numel(stepSets)
            if s == 0
                algorithm = NaN;
                label = 'nelder-mead-control';
            else
                algorithm = stepSets{s};
                label = sprintf('hooke-jeeves-%d', s);
            end
            parameters = NaN(numel(model.Param_Names) + 2, numel(gof));
            r2 = NaN(1, numel(gof));
            classes = cell(1, numel(gof));
            traces = {};
            for g = 1:numel(gof)
                v = gof(g);
                Rmap = reshape(profiles(:, v), width, width);
                if model.Allow_Negative_Peaks && abs(max(Rmap(:))) < abs(min(Rmap(:)))
                    Rmap = -Rmap;
                end
                seeds = seedFunction(loopRaw(:, v));
                [fP, fR] = samsrf_fit2dprf(Rmap, prf, seeds, scaling, ApFrm, algorithm);
                parameters(:, g) = double(fP(:));
                r2(g) = double(fR);
                classes{g} = [class(fP) ',' class(fR) ',' class(seeds)];
                if s > 0 && g <= 2
                    traces{end+1} = hooke_jeeves_trace(Rmap, prf, seeds, scaling, ApFrm, algorithm, fP, fR); %#ok<AGROW>
                end
            end
            id = sprintf('hj_%s_%s_%s', strrep(host{1}, '.', ''), item.id, label);
            cases{end+1} = struct('id', id, 'kind', 'hooke-jeeves', 'host', host{1}, ...
                'pipeline', item.id, 'algorithm', label, 'steps', algorithm, ...
                'vertices', gof, 'classes', {classes}, 'loopRaw', array_file([id '_loop_raw'], loopRaw(:, gof)), ...
                'parameters', array_file([id '_parameters'], parameters), ...
                'r2', array_file([id '_r2'], r2), 'traces', {traces}); %#ok<AGROW>
        end
    end
end
end

function trace = hooke_jeeves_trace(Rmap, prf, seeds, scaling, ApFrm, steps, fP, fR)
% samsrf_fit2dprf's Hooke-Jeeves call, made with MATLAB's own samsrf_hookejeeves
% and a logging copy of its errfun. Its result must equal samsrf_fit2dprf's.
width = size(Rmap, 1);
Scaled = NaN(width, width, size(ApFrm, 3));
for i = 1:size(ApFrm, 3)
    Scaled(:, :, i) = imresize(ApFrm(:, :, i), [width width]);
end
Mask = sum(Scaled ~= 0, 3) ~= 0;
seeds = reshape(seeds, 1, []);
for p = 1:length(seeds) - 2
    if scaling(p + 1)
        seeds(p) = seeds(p) / scaling(1);
    end
end
evaluations = zeros(0, numel(seeds) + 4);
    function R = logged(P)
        ModelRfp = prf(P(1:end-2), size(Mask, 1)) * P(end-1) + P(end);
        Ds = Rmap - ModelRfp .* Mask;
        R = sum(Ds(:).^2);
        evaluations(end+1, :) = [double(P) double(R) double(isa(R, 'single'))];
    end
[P, R] = samsrf_hookejeeves(@logged, [seeds 1 0], [steps .1 .01], false(1, length(seeds) + 2));
fitted = P;
% samsrf_fit2dprf then rescales each scaled parameter to visual space.
for p = 1:length(fitted) - 2
    if scaling(p + 1)
        fitted(p) = fitted(p) * scaling(1) / 2;
    end
end
Resid = (Rmap - mean(Rmap(:))).^2;
trace = struct('evaluations', evaluations, 'equalsFit2dprf', isequal(fitted, fP) && isequal(1 - R / sum(Resid(:)), fR), ...
    'parameterClass', class(P), 'errorClass', class(R));
end

%% Sparse complex conv near multiples of 512, by FPRev's pair method

function cases = conv_boundary_cases(numerics2Dir, smoke)
% jsondecode rewrites host names such as ubuntu-22.04, so list the folders. The
% generated inputs are the same on every host; the first folder is read.
hosts = dir(fullfile(numerics2Dir, 'ubuntu-*'));
assert(~isempty(hosts), 'No host folder in %s', numerics2Dir);
folder = fullfile(numerics2Dir, hosts(1).name, 'compatible');
recording = jsondecode(fileread(fullfile(folder, 'numerics.json')));
list = as_cell(recording.cases);
big = 2^60;
cases = {};
for c = 1:numel(list)
    item = list{c};
    if ~strcmp(item.kind, 'conv') || item.isreal
        continue;
    end
    y = read_array(folder, item.y);
    n = numel(y);
    nonzero = y ~= 0;
    if ~(4 * nnz(nonzero) < n && n > 800)
        continue;
    end
    taps = numel(read_array(folder, item.kernel));
    % 0-based boundaries B, and a control region centred on 256.
    centres = [256, 512:512:n - 1];
    if smoke
        centres = centres(1:2);
    end
    for centre = centres
        first = centre - 15;
        last = min(centre + 14, n - 1);
        positions = find(nonzero) - 1;
        positions = positions(positions >= first - (taps - 1) & positions <= last);
        pairs = zeros(0, 2);
        for a = 1:numel(positions)
            for b = a + 1:numel(positions)
                if positions(b) - positions(a) <= taps - 1
                    pairs(end+1, :) = positions([a b]); %#ok<AGROW>
                end
            end
        end
        outputs = first:last;
        realParts = zeros(size(pairs, 1), numel(outputs));
        imaginary = zeros(size(pairs, 1), numel(outputs));
        for p = 1:size(pairs, 1)
            for part = 1:2
                v = complex(double(nonzero), double(nonzero));
                if part == 1
                    v(pairs(p, 1) + 1) = complex(big, 1);
                    v(pairs(p, 2) + 1) = complex(-big, 1);
                else
                    v(pairs(p, 1) + 1) = complex(1, big);
                    v(pairs(p, 2) + 1) = complex(1, -big);
                end
                r = conv(v, ones(taps, 1));
                if part == 1
                    realParts(p, :) = builtin('real', r(outputs + 1));
                else
                    imaginary(p, :) = imag(r(outputs + 1));
                end
            end
        end
        id = sprintf('conv512_%s_c%d', item.id, centre);
        cases{end+1} = struct('id', id, 'kind', 'conv-512', 'source', item.id, ...
            'n', n, 'taps', taps, 'centre', centre, 'outputs', outputs, ...
            'nonzero', array_file([id '_nonzero'], find(nonzero) - 1), ...
            'pairs', array_file([id '_pairs'], pairs), ...
            'real', array_file([id '_real'], realParts), ...
            'imaginary', array_file([id '_imaginary'], imaginary)); %#ok<AGROW>
    end
end
end

%% Single sin and cos by position

function item = trig_position_case(trigDir, smoke)
folder = fullfile(trigDir, 'ubuntu-22.04', 'compatible');
recording = jsondecode(fileread(fullfile(folder, 'numerics.json')));
list = as_cell(recording.cases);
trig = [];
for c = 1:numel(list)
    if strcmp(list{c}.id, 'single_trig')
        trig = list{c};
    end
end
assert(~isempty(trig), 'single_trig case missing');
sinTable = read_array(folder, trig.sinExceptions);
cosTable = read_array(folder, trig.cosExceptions);
count = 256;
if smoke
    count = 8;
end
pick = @(table) table(round(linspace(1, size(table, 1), count)), 1);
rng(7291, 'twister');
controls = uint32(randi([0, hex2dec('4016CBE3')], count, 1));
controls = controls(~ismember(double(controls), [sinTable(:, 1); cosTable(:, 1)]));
bits = uint32([pick(sinTable); pick(cosTable); double(controls)]);
x = typecast(bits, 'single');
filler = single(0.5);
offsets = 33;
scalarSin = zeros(numel(x), 1, 'uint32');
scalarCos = zeros(numel(x), 1, 'uint32');
offsetSin = zeros(numel(x), offsets, 'uint32');
offsetCos = zeros(numel(x), offsets, 'uint32');
for i = 1:numel(x)
    scalarSin(i) = typecast(sin(x(i)), 'uint32');
    scalarCos(i) = typecast(cos(x(i)), 'uint32');
    for o = 1:offsets
        a = repmat(filler, offsets, 1);
        a(o) = x(i);
        s = sin(a);
        k = cos(a);
        offsetSin(i, o) = typecast(s(o), 'uint32');
        offsetCos(i, o) = typecast(k(o), 'uint32');
    end
end
item = struct('id', 'trig_position', 'kind', 'trig-position', ...
    'groups', struct('sinExceptions', count, 'cosExceptions', count, 'controls', numel(controls)), ...
    'input', array_file('trig_position_input', bits), ...
    'scalarSin', array_file('trig_position_scalar_sin', scalarSin), ...
    'scalarCos', array_file('trig_position_scalar_cos', scalarCos), ...
    'offsetSin', array_file('trig_position_offset_sin', offsetSin), ...
    'offsetCos', array_file('trig_position_offset_cos', offsetCos), ...
    'arraySin', array_file('trig_position_array_sin', typecast(sin(x), 'uint32')), ...
    'arrayCos', array_file('trig_position_array_cos', typecast(cos(x), 'uint32')));
end

%% Real x'*y for 2-24 elements, by the pair method

function item = dot_short_case(smoke)
big = 2^60;
lengths = 2:24;
if smoke
    lengths = [2 8 19];
end
fingerprints = {};
rng(7292, 'twister');
heldOut = {};
for n = lengths
    pairs = nchoosek(1:n, 2);
    counts = zeros(size(pairs, 1), 1);
    for p = 1:size(pairs, 1)
        x = ones(n, 1);
        y = ones(n, 1);
        y(pairs(p, 1)) = big;
        y(pairs(p, 2)) = -big;
        counts(p) = x' * y;
    end
    fingerprints{end+1} = struct('n', n, 'pairs', pairs, 'counts', counts); %#ok<AGROW>
    draws = 50;
    X = randn(n, draws) .* exp(3 * randn(n, draws));
    Y = randn(n, draws);
    dots = zeros(draws, 1);
    for d = 1:draws
        dots(d) = X(:, d)' * Y(:, d);
    end
    heldOut{end+1} = struct('n', n, 'x', X, 'y', Y, 'dots', dots); %#ok<AGROW>
end
item = struct('id', 'dot_short', 'kind', 'dot-short', 'fingerprints', {fingerprints}, 'heldOut', {heldOut});
end

%% Helpers

function list = as_cell(value)
if iscell(value)
    list = value;
else
    list = num2cell(value);
end
end

function value = read_array(root, descriptor)
fid = fopen(fullfile(root, descriptor.file), 'r', 'ieee-le');
assert(fid ~= -1, 'Missing %s', descriptor.file);
data = fread(fid, Inf, 'double');
fclose(fid);
shape = reshape(descriptor.shape, 1, []);
assert(numel(data) == prod(shape), 'Size of %s', descriptor.file);
value = reshape(data, shape);
if isfield(descriptor, 'imaginary') && ~isempty(descriptor.imaginary)
    fid = fopen(fullfile(root, descriptor.imaginary), 'r', 'ieee-le');
    imaginary = fread(fid, Inf, 'double');
    fclose(fid);
    value = complex(value, reshape(imaginary, shape));
end
end

function descriptor = array_file(name, value)
descriptor = struct('file', [name '.f64'], 'shape', size(value), 'class', class(value), 'imaginary', '');
fid = fopen(descriptor.file, 'w', 'ieee-le');
assert(fid ~= -1);
cleanup = onCleanup(@() fclose(fid));
assert(fwrite(fid, double(builtin('real', value)), 'double') == numel(value));
end

function write_json(file, value)
fid = fopen(file, 'w');
assert(fid ~= -1);
cleanup = onCleanup(@() fclose(fid));
fprintf(fid, '%s\n', jsonencode(value, 'PrettyPrint', true));
end
