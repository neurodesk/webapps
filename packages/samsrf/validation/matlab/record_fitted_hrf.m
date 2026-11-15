function record_fitted_hrf(source, inputDir, referenceDir, output, smoke)
% Fitted-HRF probes for #730, as fixed in fitted-hrf-predictions.md before the
% first run. This recorder only records.
%
% At the recorded parameters of every evaluation of the pinned
% fit_double_fitted_hrf traces (reference.json, recorded by record_reference
% from probe-all.mat), it records samsrf_doublegamma's stages, MATLAB's gampdf
% as a vector and per sample, and the port's gampdf algorithm evaluated with
% MATLAB's log, exp and gammaln (every other step is +, -, * or /), plus
% prf_errfun's err. Around each trace's first divergence and at evaluations
% 0-2 it also records prf_errfun's stages. Generated held-out densities follow.
%
%   source        SamSrf 41ed1e96 (prf_errfun, samsrf_doublegamma, ...)
%   inputDir      the pinned recorder inputs (probe-all.mat)
%   referenceDir  the extracted 741-case reference (reference.json)
%   output        a new directory
%   smoke         record two evaluations per trace and 3 held-out pairs
if nargin < 5
    smoke = false;
end
if exist('samsrf_doublegamma', 'file') ~= 2
    addpath(genpath(source));
end
if ~isfolder(output), mkdir(output); end
assert(~isfile(fullfile(output, 'fitted-hrf.json')), 'Use a fresh probe directory');
d = load(fullfile(inputDir, 'probe-all.mat'));
reference = jsondecode(fileread(fullfile(referenceDir, 'reference.json')));
previous = pwd;
restore = onCleanup(@() cd(previous));
cd(output);
if smoke
    environment = struct('smoke', true);
else
    environment = reference_environment('fitted-hrf');
end
cases = as_cell(reference.cases);
item = [];
for c = 1:numel(cases)
    if strcmp(cases{c}.id, 'fit_double_fitted_hrf')
        item = cases{c};
    end
end
assert(~isempty(item), 'The pin has no fit_double_fitted_hrf case');
observations = read_array(referenceDir, item.observations);
assert(isequal(observations, double(d.Ys(:, 1:size(observations, 2)))), 'probe-all.mat is not the pinned observations');
hrfInput = read_array(referenceDir, item.hrf);
assert(isequal(hrfInput, -1), 'The pinned case does not fit the HRF at TR 1');
traces = as_cell(item.traces);
% First evaluation (zero-based) at which the port's objective differs from the
% pinned trace at MATLAB's own parameters, per trace (fitted-hrf-predictions.md).
firstDivergence = [16 15 15 35 16 16];
assert(numel(traces) == numel(firstDivergence), 'Expected six fitted-HRF traces');
profile = @(p, xy) prf_gaussian_rf(p(1), p(2), p(3), xy);
records = cell(1, numel(traces));
for f = 1:numel(traces)
    trace = read_array(referenceDir, traces{f});
    assert(size(trace, 2) == 10, 'A fitted-HRF trace row is 8 parameters, real and imaginary error');
    rows = 1:size(trace, 1);
    window = unique([1:3, (firstDivergence(f) - 1):(firstDivergence(f) + 3)]);
    window = window(window >= 1 & window <= size(trace, 1));
    if smoke
        rows = rows(1:2);
        window = window(1:2);
    end
    y = observations(:, f);
    n = numel(rows);
    shape = zeros(5, n);
    kernel = struct('g1', zeros(33, n), 'g2raw', zeros(33, n), 'g2', zeros(33, n), 'hrf', zeros(33, n), ...
        'g1Scalar', zeros(33, n), 'g2rawScalar', zeros(33, n));
    parts = {empty_parts(n), empty_parts(n)};
    err = zeros(1, n);
    for e = 1:n
        P = trace(rows(e), 1:8)';
        Q = P(end-4:end);
        A1 = Q(1) / Q(3);
        B1 = Q(3);
        A2 = Q(2) / Q(4);
        B2 = Q(4);
        shape(:, e) = [A1; B1; A2; B2; Q(5)];
        T = linspace(0, 32, length((0:32/1) * 16 + 1));
        assert(numel(T) == 33, 'The kernel grid of TR 1 has 33 samples');
        kernel.g1(:, e) = gampdf(T, A1, B1)';
        kernel.g2raw(:, e) = gampdf(T, A2, B2)';
        kernel.g2(:, e) = kernel.g2raw(:, e) / Q(5);
        kernel.hrf(:, e) = samsrf_doublegamma(1, Q);
        for s = 1:33
            kernel.g1Scalar(s, e) = gampdf(T(s), A1, B1);
            kernel.g2rawScalar(s, e) = gampdf(T(s), A2, B2);
        end
        parts{1} = store_parts(parts{1}, e, port_gampdf(T, A1, B1));
        parts{2} = store_parts(parts{2}, e, port_gampdf(T, A2, B2));
        err(e) = prf_errfun(profile, d.ApFrm, d.ApXY, -1, P, y, 1, false);
    end
    stages = cell(1, numel(window));
    for w = 1:numel(window)
        P = trace(window(w), 1:8)';
        Rfp = profile(P, d.ApXY);
        Yp = prf_predict_timecourse(Rfp, d.ApFrm);
        Hrf = samsrf_doublegamma(1, P(end-4:end));
        full = conv(Yp, Hrf);
        cY = prf_convolve_hrf(Yp, Hrf, 1);
        R = corr(cY, y);
        tag = sprintf('fit%d_eval%d', f - 1, window(w) - 1);
        stages{w} = struct('evaluation', window(w) - 1, ...
            'rfp', array_file([tag '_rfp'], Rfp), 'yp', array_file([tag '_yp'], Yp), ...
            'hrf', array_file([tag '_hrf'], Hrf), 'conv', array_file([tag '_conv'], full), ...
            'cy', array_file([tag '_cy'], cY), 'r', R, 'err', 1 - R.^2, ...
            'errfun', prf_errfun(profile, d.ApFrm, d.ApXY, -1, P, y, 1, false));
    end
    tag = sprintf('fit%d', f - 1);
    records{f} = struct('fit', f - 1, 'firstDivergence', firstDivergence(f), ...
        'evaluations', array_file([tag '_evaluations'], rows - 1), ...
        'parameters', array_file([tag '_parameters'], trace(rows, 1:8)'), ...
        'shape', array_file([tag '_shape'], shape), ...
        'g1', array_file([tag '_g1'], kernel.g1), 'g2raw', array_file([tag '_g2raw'], kernel.g2raw), ...
        'g2', array_file([tag '_g2'], kernel.g2), 'hrf', array_file([tag '_hrf'], kernel.hrf), ...
        'g1Scalar', array_file([tag '_g1_scalar'], kernel.g1Scalar), ...
        'g2rawScalar', array_file([tag '_g2raw_scalar'], kernel.g2rawScalar), ...
        'parts1', write_parts([tag '_parts1'], parts{1}), 'parts2', write_parts([tag '_parts2'], parts{2}), ...
        'err', array_file([tag '_err'], err), 'stages', {stages});
end
heldOut = held_out_densities(smoke);
write_json('fitted-hrf.json', struct('environment', environment, 'traces', {records}, 'heldOut', heldOut));
fprintf('Recorded %d fitted-HRF traces and %d held-out pairs\n', numel(records), heldOut.pairs.count);
end

%% The port's gampdf (matlab_math::gampdf, a >= 1), in MATLAB arithmetic

function parts = port_gampdf(x, a, b)
% Every step but log, exp and gammaln is +, -, * or / in the port's order.
assert(a >= 1 && isfinite(a) && b > 0 && isfinite(b), 'Shape below 1 is not modelled');
k = a - 1;
n = numel(x);
parts = struct('k', k, 'gammalnK1', gammaln(k + 1), 'logK', log(k), ...
    'logNorm', log(2 * pi * k), 'stirlerr', port_stirlerr(k), ...
    'z', zeros(1, n), 'bd0', zeros(1, n), 'arg', zeros(1, n), ...
    'expScalar', zeros(1, n), 'expVector', zeros(1, n), 'density', zeros(1, n));
for s = 1:n
    z = x(s) / b;
    parts.z(s) = z;
    if k == 0
        parts.bd0(s) = NaN;
        parts.arg(s) = -z;
    elseif z == 0
        parts.bd0(s) = Inf;
        parts.arg(s) = -Inf;
    else
        parts.bd0(s) = port_bd0(k, z);
        parts.arg(s) = (-0.5 * parts.logNorm - parts.stirlerr) - parts.bd0(s);
    end
    parts.expScalar(s) = exp(parts.arg(s));
    if z == 0
        if a == 1
            parts.density(s) = 1 / b;
        else
            parts.density(s) = 0;
        end
    else
        parts.density(s) = parts.expScalar(s) / b;
    end
end
parts.expVector = exp(parts.arg);
end

function s = port_stirlerr(n)
S0 = 0.0833333333333333333333;
S1 = 0.00277777777777777777778;
S2 = 0.00079365079365079365079365;
S3 = 0.000595238095238095238095238;
S4 = 0.0008417508417508417508417508;
LN_SQRT_2PI = 0.9189385332046727418;
table = hex2num({'0000000000000000','3fc3a37a020b8c22','3fb4c071bcda0a5b','3fac1098b28dcf33', ...
    '3fa52a9b923ea649','3fa0fab9626b44ff','3f9c579a268d80b3','3f9850ea113caf0e', ...
    '3f954a2662fd78a9','3f92eea2e990f134','3f910b4e513fcbed','3f8eff15b81c9cc5', ...
    '3f8c6b167bebdf36','3f8a3c5f8a1e7d1d','3f885d4d612e4a86','3f86bdfcc7fbdb0a', ...
    '3f8552805e7b3076','3f8411b75e41049c','3f82f4871b12ab64','3f81f553026fbce1', ...
    '3f810f9d4c0743a7','3f803fc2d49c8fb9','3f7f0593088014f8','3f7dac773cc5b3cd', ...
    '3f7c7018733aa9c6','3f7b4d04a067629f','3f7a40514700f36c','3f7947826547fe6c', ...
    '3f786076c002d4a7','3f7789583ffc5e8c','3f76c08f6f194a10'});
if n <= 15
    doubled = round(2 * n);
    if doubled == 2 * n
        s = table(doubled + 1);
        return;
    end
    s = gammaln(n + 1) - (n + 0.5) * log(n) + n - LN_SQRT_2PI;
    return;
end
nn = n * n;
if n > 500
    s = (S0 - S1 / nn) / n;
elseif n > 80
    s = (S0 - (S1 - S2 / nn) / nn) / n;
elseif n > 35
    s = (S0 - (S1 - (S2 - S3 / nn) / nn) / nn) / n;
else
    s = (S0 - (S1 - (S2 - (S3 - S4 / nn) / nn) / nn) / nn) / n;
end
end

function d = port_bd0(x, np)
% matlab_math::deviance for finite positive operands.
delta = x - np;
total = x + np;
v = delta / total;
if abs(delta) < 0.1 * total
    s = delta * delta / total;
    ej = 2 * x * v;
    for j = 1:1000
        ej = ej * v * v;
        next = s + ej / (2 * j + 1);
        if next == s
            d = next;
            return;
        end
        s = next;
    end
    d = NaN;
    return;
end
ratio = x / np;
if isfinite(ratio) && ratio > 0
    logRatio = log(ratio);
else
    logRatio = log(x) - log(np);
end
d = x * logRatio + np - x;
end

function parts = empty_parts(n)
parts = struct('scalars', zeros(5, n), 'z', zeros(33, n), 'bd0', zeros(33, n), 'arg', zeros(33, n), ...
    'expScalar', zeros(33, n), 'expVector', zeros(33, n), 'density', zeros(33, n));
end

function parts = store_parts(parts, e, p)
parts.scalars(:, e) = [p.k; p.gammalnK1; p.logK; p.logNorm; p.stirlerr];
for name = {'z', 'bd0', 'arg', 'expScalar', 'expVector', 'density'}
    parts.(name{1})(:, e) = p.(name{1})';
end
end

function descriptor = write_parts(tag, parts)
descriptor = struct('scalars', array_file([tag '_scalars'], parts.scalars));
for name = {'z', 'bd0', 'arg', 'expScalar', 'expVector', 'density'}
    descriptor.(name{1}) = array_file([tag '_' name{1}], parts.(name{1}));
end
end

%% Generated held-out densities

function heldOut = held_out_densities(smoke)
count = 200;
if smoke
    count = 3;
end
rng(7302, 'twister');
A = 1.5 + 18.5 * rand(1, count);
B = 0.5 + 2.5 * rand(1, count);
x = sort(40 * rand(1, 40));
k = A - 1;
assert(all(round(2 * k) ~= 2 * k), 'A held-out shape hit a stirlerr table entry');
T = 0:32;
grids = struct('kernel', T, 'random', x);
heldOut = struct('seed', 7302, 'kernelGrid', array_file('heldout_kernel_grid', T), ...
    'randomGrid', array_file('heldout_random_grid', x));
pairs = struct('shape', [A; B]);
for g = {'kernel', 'random'}
    grid = grids.(g{1});
    vector = zeros(numel(grid), count);
    scalar = zeros(numel(grid), count);
    parts = empty_parts_n(count, numel(grid));
    for p = 1:count
        vector(:, p) = gampdf(grid, A(p), B(p))';
        for s = 1:numel(grid)
            scalar(s, p) = gampdf(grid(s), A(p), B(p));
        end
        parts = store_parts(parts, p, port_gampdf(grid, A(p), B(p)));
    end
    heldOut.(g{1}) = struct('vector', array_file(['heldout_' g{1} '_vector'], vector), ...
        'scalar', array_file(['heldout_' g{1} '_scalar'], scalar), ...
        'parts', write_parts(['heldout_' g{1} '_parts'], parts));
end
heldOut.pairs = struct('count', count, 'shape', array_file('heldout_shape', pairs.shape));
end

function parts = empty_parts_n(count, samples)
parts = struct('scalars', zeros(5, count), 'z', zeros(samples, count), 'bd0', zeros(samples, count), ...
    'arg', zeros(samples, count), 'expScalar', zeros(samples, count), 'expVector', zeros(samples, count), ...
    'density', zeros(samples, count));
end

%% Files

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
cleanup = onCleanup(@() fclose(fid));
shape = reshape(double(descriptor.shape), 1, []);
value = fread(fid, prod(shape), 'double=>double');
assert(numel(value) == prod(shape), 'Short array %s', descriptor.file);
value = reshape(value, shape);
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
