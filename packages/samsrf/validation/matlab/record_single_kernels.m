function record_single_kernels(source, input, output, spmSource, smoke)
% MATLAB's single-precision kernels behind SamSrf's reverse-correlation
% connective fields, recorded so the port can match each one alone:
%   exp on generated single inputs, in the call shapes SamSrf uses;
%   corr(Y, X) and its pieces on real single courses;
%   every evaluation of the single CF Gaussian fit (samsrf_fit2dprf), with its
%   parameters, model, objective and result, next to the full pipeline's maps.
% input is the pinned participant matrix (inputs.json); spmSource holds SPM's
% GIfTI readers. smoke shortens the recording for plumbing checks.
if nargin < 5
    smoke = false;
end
if exist('samsrf_revcor_cf', 'file') ~= 2
    addpath(genpath(source));
end
if nargin >= 4 && ~isempty(spmSource)
    addpath(spmSource);
end
if ~isfolder(output), mkdir(output); end
assert(~isfile(fullfile(output, 'kernels.json')), 'Use a fresh kernel directory');
previous = pwd;
restore = onCleanup(@() cd(previous));
cd(output);
environment = reference_environment('single-kernels');
cases = {};

% exp on generated single inputs.
rng(729, 'twister');
mantissa = (0:4095) / 4096;
if smoke
    mantissa = (0:63) / 64;
end
x = [];
for e = -30:7
    x = [x, -(1 + mantissa) * 2^e, (1 + mantissa) * 2^e]; %#ok<AGROW>
end
count = 200000;
if smoke
    count = 2000;
end
x = [x, -104 * rand(1, count), -20 * rand(1, count)];
x = single([x, 0, -0, -87.33655, -103.97207, -103.97208, -104, 88.72283, 88.72284, Inf, -Inf, NaN])';
cases{end+1} = struct('id', 'exp_single', 'kind', 'exp', ...
    'input', array_file('exp_single_input', x), ...
    'whole', array_file('exp_single_whole', exp(x)), ...
    'chunk1', array_file('exp_single_chunk1', chunked(x, 1, min(numel(x), 20000))), ...
    'chunk9', array_file('exp_single_chunk9', chunked(x, 9, numel(x))), ...
    'chunk81', array_file('exp_single_chunk81', chunked(x, 81, numel(x))), ...
    'chunk400', array_file('exp_single_chunk400', chunked(x, 400, numel(x))));

% The participant subsets, preprocessed in single as record_revcor_matrix.m does.
manifest = jsondecode(fileread(fullfile(input, 'manifest.json')));
datasets = manifest.datasets;
if isstruct(datasets)
    datasets = num2cell(datasets);
end
defaults = jsondecode(fileread(fullfile(source, 'SamSrf_defaults.json')));
defaults.def_64bit = false;
write_json('SamSrf_defaults.json', defaults);
selected = {'x001_lh', 'x001_rh'};
if smoke
    selected = {'x001_lh'};
end
for ds = 1:numel(datasets)
    dataset = datasets{ds};
    if ~any(strcmp(dataset.id, selected))
        continue
    end
    id = sprintf('kernels_%s', dataset.id);
    work = fullfile(output, 'work', id);
    mkdir(work);
    write_json(fullfile(work, 'SamSrf_defaults.json'), defaults);
    cd(work);
    folder = fullfile(input, dataset.id);
    files = cellfun(@(name) fullfile(folder, name), dataset.runs, 'UniformOutput', false);
    Srf = samsrf_gii2srf(files, fullfile(folder, 'surf', dataset.hemisphere), 1, true, true, '');
    assert(isa(Srf.Data, 'single'));
    count = size(Srf.Data, 2);
    roi = unique([1:12 25 count-7:count]);
    seed = 2:2:18;
    samsrf_srf2label(Srf, 'roi', 1, roi);
    samsrf_srf2label(Srf, 'seed', 1, seed);
    samsrf_benson2srf(fullfile(folder, [dataset.hemisphere '_benson']), fullfile(folder, 'surf'), '');
    templatePath = fullfile(work, [dataset.hemisphere '_benson.mat']);
    template = load(templatePath);
    Temp = samsrf_expand_srf(template.Srf);
    Temp = Temp.Data;
    cd(output);

    % corr(Y, X) and its pieces, Y a single ROI course and X the seed courses.
    X = Srf.Data(:, seed);
    Y = Srf.Data(:, roi);
    n = size(X, 1);
    Xc = X - mean(X, 1);
    pieces = struct('id', [id '_corr'], 'kind', 'corr', 'dataset', dataset.id, ...
        'roi', array_file([id '_corr_roi'], roi), 'seed', array_file([id '_corr_seed'], seed), ...
        'courses', array_file([id '_corr_courses'], Y), 'seedCourses', array_file([id '_corr_seed_courses'], X), ...
        'meanSeed', array_file([id '_corr_mean_seed'], mean(X, 1)), ...
        'sumSeed', array_file([id '_corr_sum_seed'], sum(X, 1)), ...
        'normSeed', array_file([id '_corr_norm_seed'], vecnorm(Xc, 2, 1)));
    r = zeros(numel(roi), numel(seed), 'single');
    product = r;
    columns = r;
    normY = zeros(numel(roi), 1, 'single');
    meanY = normY;
    for v = 1:numel(roi)
        y = Y(:, v);
        r(v, :) = corr(y, X);
        meanY(v) = mean(y, 1);
        yc = y - mean(y, 1);
        product(v, :) = yc' * Xc;
        for j = 1:numel(seed)
            columns(v, j) = yc' * Xc(:, j);
        end
        normY(v) = vecnorm(yc, 2, 1);
    end
    pieces.corr = array_file([id '_corr_corr'], r);
    pieces.meanCourse = array_file([id '_corr_mean_course'], meanY);
    pieces.normCourse = array_file([id '_corr_norm_course'], normY);
    pieces.product = array_file([id '_corr_product'], product);
    pieces.columnProducts = array_file([id '_corr_column_products'], columns);
    candidates = {(product ./ normY) ./ vecnorm(Xc, 2, 1), product ./ (normY * vecnorm(Xc, 2, 1)), ...
        (columns ./ normY) ./ vecnorm(Xc, 2, 1)};
    pieces.candidateEqual = cellfun(@(c) isequaln(c, r), candidates);
    cases{end+1} = pieces; %#ok<AGROW>

    % The single CF Gaussian fit, unsmoothed and smoothed, without global
    % regression: the full pipeline, then a logged replica on its profiles.
    for smoothing = [0 1]
        fitId = sprintf('%s_gaussian_smooth%d', id, smoothing);
        caseWork = fullfile(output, 'work', fitId);
        mkdir(caseWork);
        write_json(fullfile(caseWork, 'SamSrf_defaults.json'), defaults);
        cd(caseWork);
        Model = struct('Name', fitId, 'Template', templatePath, 'SeedRoi', fullfile(work, 'seed'), ...
            'Fit_pRF', 1, 'Smoothing', smoothing, 'Global_Signal_Correction', false, 'Save_Rmaps', true);
        filename = samsrf_revcor_cf(Model, Srf, fullfile(work, 'roi'));
        result = load([filename '.mat']);
        cd(output);
        saved = result.Srf;
        profiles = saved.ConFlds(:, roi);
        coordinates = Temp(2:3, seed)';
        [traces, parameters, fits] = replica(profiles, coordinates, Temp, seed, smoothing > 0);
        item = struct('id', fitId, 'kind', 'gaussian', 'dataset', dataset.id, 'smoothing', smoothing, ...
            'values', {saved.Values}, 'savedMaps', array_file([fitId '_saved_maps'], saved.Data), ...
            'profiles', array_file([fitId '_profiles'], profiles), ...
            'coordinates', array_file([fitId '_coordinates'], coordinates), ...
            'replicaParameters', array_file([fitId '_replica_parameters'], parameters), ...
            'replicaR2', array_file([fitId '_replica_r2'], fits), ...
            'evaluations', array_file([fitId '_evaluations'], traces.parameters), ...
            'evaluationVertex', array_file([fitId '_evaluation_vertex'], traces.vertex), ...
            'evaluationStart', array_file([fitId '_evaluation_start'], traces.start), ...
            'models', array_file([fitId '_models'], traces.models), ...
            'exponents', array_file([fitId '_exponents'], traces.exponents), ...
            'objectives', array_file([fitId '_objectives'], traces.objectives));
        % The replica is the pipeline: its parameters and R^2 must equal the saved
        % maps (rows R^2, x0, y0, Sigma, Beta, Baseline) wherever it fitted.
        fitted = ~isnan(fits);
        assert(isequaln(single(parameters(:, fitted)), single(saved.Data(2:6, fitted))), 'Replica parameters differ');
        assert(isequaln(single(fits(fitted)), single(saved.Data(1, fitted))), 'Replica R^2 differs');
        cases{end+1} = item; %#ok<AGROW>
        write_json('kernels.json.partial', struct('cases', {cases}));
    end
end
write_json('kernels.json', struct('environment', environment, 'smoke', smoke, 'cases', {cases}));
fprintf('Recorded %d single-kernel cases\n', numel(cases));
end

function out = chunked(x, size, limit)
out = zeros(limit, 1, 'single');
for start = 1:size:limit
    stop = min(start + size - 1, limit);
    out(start:stop) = exp(x(start:stop));
end
end

% samsrf_cfparam_loop's Fit_pRF = 1 branch and samsrf_fit2dprf's Nelder-Mead
% path, serially, logging each objective evaluation. Every line that touches a
% number is the source's.
function [traces, parameters, fits] = replica(profiles, coordinates, Temp, seed, smoothed)
global KernelLog
KernelLog = struct('parameters', zeros(0, 5), 'models', zeros(0, size(coordinates, 1), 'single'), ...
    'exponents', zeros(0, size(coordinates, 1), 'single'), 'objectives', zeros(0, 1, 'single'));
vertex = zeros(0, 1);
start = zeros(0, 1);
parameters = NaN(5, size(profiles, 2));
fits = NaN(1, size(profiles, 2));
for v = 1:size(profiles, 2)
    % corr gives a single row; smoothing turns it into a column.
    R = single(profiles(:, v));
    if ~smoothed
        R = R';
    end
    if all(isnan(R))
        continue
    end
    mR = max(R);
    mR = mR(1);
    m = find(R == mR, 1);
    if isnan(mR) || mR <= 0
        continue
    end
    R = R - mR/2;
    R(R < 0) = 0;
    fP = [];
    fR = [];
    for s = 10.^(-2:2)
        before = size(KernelLog.parameters, 1);
        [cP, cR] = fit(R, coordinates, [Temp(2:3, seed(m))' s]);
        added = size(KernelLog.parameters, 1) - before;
        vertex = [vertex; repmat(v, added, 1)]; %#ok<AGROW>
        start = [start; repmat(s, added, 1)]; %#ok<AGROW>
        fP = [fP; cP]; %#ok<AGROW>
        fR = [fR; cR]; %#ok<AGROW>
    end
    ms = find(fR == nanmax(fR), 1);
    parameters(:, v) = fP(ms, :)';
    fits(v) = fR(ms);
end
traces = KernelLog;
traces.vertex = vertex;
traces.start = start;
end

function [fParams, R2] = fit(Rmap, coordinates, SeedParams)
OptimOpts = optimset('Display', 'off');
[fParams, R] = fminsearch(@(P) errfun(Rmap, coordinates, P), double([SeedParams 1 0]), OptimOpts);
Resid = (Rmap - mean(Rmap(:))).^2;
R2 = 1 - R/sum(Resid(:));
end

function R = errfun(ObsRfp, coordinates, P)
global KernelLog
X = coordinates(:, 1);
Y = coordinates(:, 2);
exponent = -((X - P(1)).^2 + (Y - P(2)).^2) ./ (2*P(3).^2);
Rfp = prf_gaussian_rf(P(1), P(2), P(3), coordinates);
assert(isequaln(Rfp, exp(exponent)), 'prf_gaussian_rf is not exp of the logged exponent');
ModelRfp = Rfp * P(4) + P(5);
Ds = ObsRfp - ModelRfp.*1;
R = sum(Ds(:).^2);
KernelLog.parameters(end+1, :) = P;
KernelLog.models(end+1, :) = ModelRfp';
KernelLog.exponents(end+1, :) = exponent';
KernelLog.objectives(end+1, 1) = R;
end

function descriptor = array_file(name, value)
descriptor = struct('file', [name '.f64'], 'shape', size(value), 'class', class(value), 'imaginary', '');
fid = fopen(descriptor.file, 'w', 'ieee-le');
assert(fid ~= -1);
cleanup = onCleanup(@() fclose(fid));
assert(fwrite(fid, double(value), 'double') == numel(value));
end

function write_json(file, value)
fid = fopen(file, 'w');
assert(fid ~= -1);
cleanup = onCleanup(@() fclose(fid));
fprintf(fid, '%s\n', jsonencode(value, 'PrettyPrint', true));
end
