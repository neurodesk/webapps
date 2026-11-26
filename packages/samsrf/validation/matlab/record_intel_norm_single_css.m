function record_intel_norm_single_css(source, matrixInput, output, spmSource, smoke)
% RECORD_INTEL_NORM_SINGLE_CSS Record pre-registered probes for:
%   1. Intel AVX512_E1 dnrm2/dznrm2 x87 80-bit identification (dnrm2-x87.json)
%   2. Intel single-precision sdot, sgemv, scorr and blind two-column QR (single-blas-qr.json)
%   3. Intel double nonnegative-clipped CSS on original signed apertures (nonnegative-css.json)
%
% See intel-norm-single-css-predictions.md for frozen hypotheses and decision rules.
if nargin < 5
    smoke = false;
end
if ~isfolder(output)
    mkdir(output);
end
assert(~isfile(fullfile(output, 'dnrm2-x87.json')), 'Use a fresh output directory');

scriptDir = fileparts(mfilename('fullpath'));
octave = exist('OCTAVE_VERSION', 'builtin') ~= 0;
blas = 'unavailable';
lapack = 'unavailable';
threads = 1;
if ~octave
    assert(startsWith(version, '23.2.0.3097123'), 'Reference requires R2023b Update 11');
    maxNumCompThreads(1);
    threads = maxNumCompThreads;
    assert(threads == 1, 'MATLAB did not honor the computational thread limit');
    blas = version('-blas');
    lapack = version('-lapack');
end
[status, cpu] = system('lscpu');
assert(status == 0, 'Cannot record CPU provenance');
names = {'MKL_CBWR', 'MKL_ENABLE_INSTRUCTIONS', 'MKL_NUM_THREADS', 'OMP_NUM_THREADS', ...
    'MKL_DYNAMIC', 'OMP_DYNAMIC', 'MKL_DEBUG_CPU_TYPE'};
variables = struct();
for k = 1:numel(names)
    variables.(names{k}) = getenv(names{k});
end
interpreter = 'MATLAB';
if octave
    interpreter = 'Octave';
end
envMeta = struct('interpreter', interpreter, 'matlab', version, ...
    'computer', computer, 'cpu', cpu, 'blas', blas, 'lapack', lapack, ...
    'maxComputationalThreads', threads, 'processEnvironment', variables, ...
    'githubRun', getenv('GITHUB_RUN_ID'), 'githubAttempt', getenv('GITHUB_RUN_ATTEMPT'), ...
    'smoke', logical(smoke));

previous = pwd;
restore = onCleanup(@() cd(previous));
cd(output);

record_dnrm2_x87(scriptDir, envMeta, smoke);
record_single_blas_qr(envMeta, octave, smoke);
record_nonnegative_css(source, matrixInput, spmSource, envMeta, octave, smoke);

fprintf('Recorded intel-norm-single-css probes (smoke=%d) in %s\n', smoke, output);
end

function record_dnrm2_x87(scriptDir, envMeta, smoke)
probePath = fullfile(scriptDir, 'intel-dnrm2-probes.json');
rawText = fileread(probePath);
spec = jsondecode(rawText);

realList = as_cell(spec.real);
complexList = as_cell(spec.complex);
extremeList = as_cell(spec.extreme);
if smoke
    realList = realList(1:min(4, numel(realList)));
    complexList = complexList(1:min(4, numel(complexList)));
    extremeList = extremeList(1:min(2, numel(extremeList)));
end

realOut = zeros(numel(realList), 1);
realIds = cell(numel(realList), 1);
realLens = zeros(numel(realList), 1);
for k = 1:numel(realList)
    item = realList{k};
    v = decode_f64_base64(item.f64Base64);
    assert(numel(v) == item.n, 'real probe length mismatch');
    realOut(k) = norm(v);
    realIds{k} = item.id;
    realLens(k) = item.n;
end

complexOut = zeros(numel(complexList), 1);
complexIds = cell(numel(complexList), 1);
complexLens = zeros(numel(complexList), 1);
for k = 1:numel(complexList)
    item = complexList{k};
    re = decode_f64_base64(item.reBase64);
    im = decode_f64_base64(item.imBase64);
    assert(numel(re) == item.n && numel(im) == item.n, 'complex probe length mismatch');
    complexOut(k) = norm(complex(re, im));
    complexIds{k} = item.id;
    complexLens(k) = item.n;
end

extremeOut = zeros(numel(extremeList), 1);
extremeIds = cell(numel(extremeList), 1);
extremeLens = zeros(numel(extremeList), 1);
for k = 1:numel(extremeList)
    item = extremeList{k};
    v = decode_f64_base64(item.f64Base64);
    assert(numel(v) == item.n, 'extreme probe length mismatch');
    extremeOut(k) = norm(v);
    extremeIds{k} = item.id;
    extremeLens(k) = item.n;
end

payload = struct( ...
    'environment', envMeta, ...
    'seed', spec.seed, ...
    'real', struct('ids', {realIds}, 'lengths', realLens, 'norms', write_f64_desc('dnrm2_real_norms', realOut)), ...
    'complex', struct('ids', {complexIds}, 'lengths', complexLens, 'norms', write_f64_desc('dnrm2_complex_norms', complexOut)), ...
    'extreme', struct('ids', {extremeIds}, 'lengths', extremeLens, 'norms', write_f64_desc('dnrm2_extreme_norms', extremeOut)));
write_json_file('dnrm2-x87.json', payload);
end

function record_single_blas_qr(envMeta, octave, smoke)
big = single(2^40);

% 1. Single sdot (x' * y)
if smoke
    dotLengths = [5 16];
    dotDraws = 4;
else
    dotLengths = [2:80, 96, 100, 127, 128, 129, 200, 250, 256, 1000];
    dotDraws = 50;
end
sdotCases = cell(numel(dotLengths), 1);
for idx = 1:numel(dotLengths)
    n = dotLengths(idx);
    if n <= 80
        pairs = nchoosek(1:n, 2);
    else
        seed_rng(73100 + n, octave);
        pairs = sample_pairs(n, 300);
    end
    xOnes = ones(n, 1, 'single');
    counts = zeros(size(pairs, 1), 1);
    for p = 1:size(pairs, 1)
        y = ones(n, 1, 'single');
        y(pairs(p, 1)) = big;
        y(pairs(p, 2)) = -big;
        counts(p) = double(xOnes' * y);
    end
    seed_rng(7310 + idx, octave);
    xs = single(randn(n, dotDraws) .* exp(randn(n, dotDraws)));
    ys = single(randn(n, dotDraws) .* exp(randn(n, dotDraws)));
    dots = zeros(dotDraws, 1);
    for d = 1:dotDraws
        dots(d) = double(xs(:, d)' * ys(:, d));
    end
    prefix = sprintf('sdot_n%d', n);
    sdotCases{idx} = struct( ...
        'id', prefix, 'n', n, ...
        'pairs', write_f64_desc([prefix '_pairs'], double(pairs)), ...
        'counts', write_f64_desc([prefix '_counts'], counts), ...
        'x', write_f64_desc([prefix '_x'], double(xs)), ...
        'y', write_f64_desc([prefix '_y'], double(ys)), ...
        'dots', write_f64_desc([prefix '_dots'], dots));
end

% 2. Single sgemv (y' * A)
if smoke
    gemvShapes = [17 3];
    gemvDraws = 4;
else
    gemvShapes = [250 9; 250 8; 250 7; 250 5; 61 9; 128 9; 97 5; 17 3];
    gemvDraws = 100;
end
sgemvCases = cell(size(gemvShapes, 1), 1);
for s = 1:size(gemvShapes, 1)
    n = gemvShapes(s, 1);
    m = gemvShapes(s, 2);
    yOnes = ones(n, 1, 'single');
    pairs = nchoosek(1:n, 2);
    counts = zeros(size(pairs, 1), m);
    for p = 1:size(pairs, 1)
        A = ones(n, m, 'single');
        A(pairs(p, 1), :) = big;
        A(pairs(p, 2), :) = -big;
        counts(p, :) = double(yOnes' * A);
    end
    seed_rng(73110 + s, octave);
    ys = single(randn(n, gemvDraws) .* exp(randn(n, gemvDraws)));
    As = single(randn(n, m * gemvDraws) .* exp(randn(n, m * gemvDraws)));
    products = zeros(gemvDraws, m);
    for d = 1:gemvDraws
        products(d, :) = double(ys(:, d)' * As(:, (d - 1) * m + (1:m)));
    end
    prefix = sprintf('sgemv_n%d_m%d', n, m);
    sgemvCases{s} = struct( ...
        'id', prefix, 'n', n, 'm', m, ...
        'pairs', write_f64_desc([prefix '_pairs'], double(pairs)), ...
        'counts', write_f64_desc([prefix '_counts'], counts), ...
        'ys', write_f64_desc([prefix '_ys'], double(ys)), ...
        'As', write_f64_desc([prefix '_As'], double(As)), ...
        'products', write_f64_desc([prefix '_products'], products));
end

% 3. Single corr(x, y) held-out
if smoke
    corrLengths = [16];
    corrDraws = 4;
else
    corrLengths = [16 25 36 50 64 100 250];
    corrDraws = 20;
end
scorrCases = cell(numel(corrLengths), 1);
for k = 1:numel(corrLengths)
    n = corrLengths(k);
    seed_rng(73120 + k, octave);
    xs = single(randn(n, corrDraws) .* exp(randn(n, corrDraws)));
    ys = single(randn(n, corrDraws) .* exp(randn(n, corrDraws)));
    rs = zeros(corrDraws, 1);
    for d = 1:corrDraws
        if octave
            xc = xs(:, d) - mean(xs(:, d));
            yc = ys(:, d) - mean(ys(:, d));
            r = (xc' * yc) / norm(xc) / norm(yc);
            if abs(r) > single(1), r = r / abs(r); end
            rs(d) = double(r);
        else
            rs(d) = double(corr(xs(:, d), ys(:, d)));
        end
    end
    prefix = sprintf('scorr_n%d', n);
    scorrCases{k} = struct( ...
        'id', prefix, 'n', n, ...
        'x', write_f64_desc([prefix '_x'], double(xs)), ...
        'y', write_f64_desc([prefix '_y'], double(ys)), ...
        'r', write_f64_desc([prefix '_r'], rs));
end

% 4. Blind held-out single real & complex two-column QR solves (1 RHS and 8 RHS)
if smoke
    qrLengths = [16];
    qrDraws = 2;
else
    qrLengths = [16 37 65 250];
    qrDraws = 20;
end
sqrCases = {};
for k = 1:numel(qrLengths)
    m = qrLengths(k);
    for isComplex = [false true]
        for onesFirst = [false true]
            seed_rng(73130 + 10 * k + 2 * double(isComplex) + double(onesFirst), octave);
            if isComplex
                xs = single(randn(m, qrDraws) .* exp(randn(m, qrDraws))) + ...
                     1i * single(randn(m, qrDraws) .* exp(randn(m, qrDraws)));
                variant = 'complex';
            else
                xs = single(randn(m, qrDraws) .* exp(randn(m, qrDraws)));
                variant = 'real';
            end
            ys1 = single(randn(m, qrDraws) .* exp(randn(m, qrDraws)));
            ys8 = single(randn(m, 8 * qrDraws) .* exp(randn(m, 8 * qrDraws)));
            beta1 = zeros(2, qrDraws);
            beta8 = zeros(2, 8 * qrDraws);
            if isComplex
                beta1 = complex(beta1, 0);
                beta8 = complex(beta8, 0);
            end
            onesCol = ones(m, 1, 'single');
            if isComplex
                onesCol = complex(onesCol, single(0));
            end
            for d = 1:qrDraws
                if onesFirst
                    A = [onesCol, xs(:, d)];
                    orderLabel = 'ones-first';
                else
                    A = [xs(:, d), onesCol];
                    orderLabel = 'x-first';
                end
                b1 = A \ ys1(:, d);
                b8 = A \ ys8(:, (d - 1) * 8 + (1:8));
                beta1(:, d) = double(b1);
                beta8(:, (d - 1) * 8 + (1:8)) = double(b8);
            end
            prefix = sprintf('sqr_%s_%s_m%d', variant, strrep(orderLabel, '-', '_'), m);
            sqrCases{end + 1} = struct( ... %#ok<AGROW>
                'id', prefix, 'm', m, 'variant', variant, 'order', orderLabel, 'draws', qrDraws, ...
                'x', write_f64_desc([prefix '_x'], double(xs)), ...
                'y1', write_f64_desc([prefix '_y1'], double(ys1)), ...
                'y8', write_f64_desc([prefix '_y8'], double(ys8)), ...
                'beta1', write_f64_desc([prefix '_beta1'], beta1), ...
                'beta8', write_f64_desc([prefix '_beta8'], beta8));
        end
    end
end

payload = struct( ...
    'environment', envMeta, ...
    'sdot', {sdotCases}, ...
    'sgemv', {sgemvCases}, ...
    'scorr', {scorrCases}, ...
    'sqr', {sqrCases});
write_json_file('single-blas-qr.json', payload);
end

function record_nonnegative_css(source, matrixInput, spmSource, envMeta, octave, smoke)
if smoke
    % Synthetic signed-aperture smoke (no SPM/GIfTI dependency in Octave smoke)
    seed_rng(73099, octave);
    nFrames = 40;
    nPix = 25;
    ApFrm = randn(nPix, nFrames);
    ApFrm(1:5, 1:10) = -abs(ApFrm(1:5, 1:10)) - 0.1; % guarantee negative ringing
    Rfp = abs(randn(nPix, 1)) + 0.05;
    Hrf = [0; 0.25; 0.75; 1.0; 0.5; 0.1; -0.05];
    Y = randn(nFrames, 2);
    exponents = [0.3, 0.7];
    evalCases = {};
    for v = 1:2
        for ei = 1:numel(exponents)
            pExp = exponents(ei);
            rawYp = ApFrm' * Rfp;
            assert(any(rawYp < 0), 'smoke must exercise negative rawYp');
            clipped = max(rawYp, 0) .^ pExp;
            pred = conv(clipped, Hrf);
            pred = pred(1:nFrames);
            if octave
                xc = pred - mean(pred);
                yc = Y(:, v) - mean(Y(:, v));
                r = (xc' * yc) / norm(xc) / norm(yc);
            else
                r = corr(pred, Y(:, v));
            end
            beta = [ones(nFrames, 1), pred] \ Y(:, v);
            prefix = sprintf('nn_css_smoke_v%d_e%d', v, ei);
            evalCases{end + 1} = struct( ... %#ok<AGROW>
                'id', prefix, 'vertex', v, 'exponent', pExp, ...
                'negativeCount', sum(rawYp < 0), ...
                'rawYp', write_f64_desc([prefix '_raw'], rawYp), ...
                'clipped', write_f64_desc([prefix '_clipped'], clipped), ...
                'predicted', write_f64_desc([prefix '_pred'], pred), ...
                'scalars', write_f64_desc([prefix '_scalars'], [r, 1 - r^2]), ...
                'beta', write_f64_desc([prefix '_beta'], beta));
        end
    end
    payload = struct( ...
        'environment', envMeta, ...
        'hrf', write_f64_desc('nn_css_smoke_hrf', Hrf), ...
        'courses', write_f64_desc('nn_css_smoke_courses', Y), ...
        'evals', {evalCases}, ...
        'fits', {{}});
    write_json_file('nonnegative-css.json', payload);
    return;
end

addpath(genpath(source));
addpath(spmSource);
set(groot, 'defaultFigureVisible', 'off');
defaults = jsondecode(fileread(fullfile(source, 'SamSrf_defaults.json')));
defaults.def_64bit = true;
write_json_file('SamSrf_defaults.json', defaults);

manifest = jsondecode(fileread(fullfile(matrixInput, 'manifest.json')));
datasets = as_cell(manifest.datasets);
dataset = [];
for k = 1:numel(datasets)
    if strcmp(datasets{k}.id, 'x001_lh')
        dataset = datasets{k};
    end
end
assert(~isempty(dataset), 'Missing x001_lh dataset');

folder = fullfile(matrixInput, dataset.id);
files = cellfun(@(p) fullfile(folder, p), as_cell(dataset.runs), 'UniformOutput', false);
Srf = samsrf_gii2srf(files, '', 1, true, true, '');

data = load(fullfile(matrixInput, dataset.apertures));
aperture = fullfile(pwd, 'aps_x001_lh_signed');
save([aperture '.mat'], '-struct', 'data', '-v7');
VectoriseApertures(aperture);
movefile([aperture '_vec.mat'], [aperture '.mat']);
ap = load([aperture '.mat']);
ApFrm = double(ap.ApFrm);
ApXY = double(ap.ApXY) / max(abs(double(ap.ApXY(:)))) * dataset.radius;
Hrf = double(samsrf_hrf(dataset.tr));
downsampling = dataset.downsample;

% Evaluate nonnegative-clipped CSS (compress(Yp, Exponent)) at 12 vertices x 4 exponents
% using parameter seeds whose raw ApFrm' * Rfp contains both negative and positive entries
% on the original signed apertures (every seed verified to exercise clipping).
testVertices = [1, 4, 8, 12, 20, 31, 42, 47, 55, 60, 69, 88];
exponents = [0.3, 0.5, 0.7, 0.85];
seedParams = [ ...
    -2.5, -1.5, 0.4; ...
     1.5, -2.5, 0.4; ...
     2.5,  1.5, 0.4; ...
     4.0,  0.0, 0.5; ...
    -0.5, -4.0, 0.5; ...
    -3.5,  2.0, 0.5; ...
     5.0, -5.0, 0.6; ...
    -5.0,  5.0, 0.6; ...
     0.0,  3.5, 0.6; ...
    -0.5,  3.0, 0.7; ...
    -3.0, -0.5, 0.7; ...
    -2.0,  5.0, 0.8];

evalCases = {};
fitCases = {};
for vi = 1:numel(testVertices)
    v = testVertices(vi);
    y = double(Srf.Data(:, v));
    p0 = seedParams(vi, :);
    rfp = double(prf_gaussian_rf(p0(1), p0(2), p0(3), ApXY));
    rawYp = double(prf_predict_timecourse(rfp, ApFrm));
    negCount = sum(rawYp < 0);
    posCount = sum(rawYp > 0);
    assert(negCount > 0 && posCount > 0, ...
        sprintf('Seed %d (vertex %d) must produce both negative and positive rawYp entries', vi, v));
    for ei = 1:numel(exponents)
        pExp = exponents(ei);
        clipped = nn_css_compress(rawYp, pExp);
        pred = double(prf_convolve_hrf(clipped, Hrf, downsampling));
        r = corr(pred, y);
        obj = 1 - r^2;
        beta = [ones(numel(y), 1), pred] \ y;
        prefix = sprintf('nn_css_v%d_e%d', v, ei);
        evalCases{end + 1} = struct( ... %#ok<AGROW>
            'id', prefix, 'vertex', v, 'params', [p0, pExp], ...
            'negativeCount', negCount, ...
            'positiveCount', posCount, ...
            'rawYp', write_f64_desc([prefix '_raw'], rawYp), ...
            'predicted', write_f64_desc([prefix '_pred'], pred), ...
            'scalars', write_f64_desc([prefix '_scalars'], [r, obj]), ...
            'beta', write_f64_desc([prefix '_beta'], beta));
    end

    % Full Nelder-Mead fine fit under the exact unconstrained nonnegative-clipped CSS
    % objective matching prf::errfun_with_reference + optim::fminsearch (stop on non-finite).
    errfun = @(P) nn_css_objective(P, ApFrm, ApXY, Hrf, downsampling, y);
    opts = optimset('Display', 'off', 'OutputFcn', @nn_css_stop_nonfinite);
    [pFit, fval, exitflag, output] = fminsearch(errfun, [p0, 0.5], opts);
    rfpFit = double(prf_gaussian_rf(pFit(1), pFit(2), pFit(3), ApXY));
    rawFit = double(prf_predict_timecourse(rfpFit, ApFrm));
    predFit = double(prf_convolve_hrf(nn_css_compress(rawFit, pFit(4)), Hrf, downsampling));
    rFit = corr(predFit, y);
    betaFit = [ones(numel(y), 1), predFit] \ y;
    prefix = sprintf('nn_css_fit_v%d', v);
    fitCases{end + 1} = struct( ... %#ok<AGROW>
        'id', prefix, 'vertex', v, 'seed', [p0, 0.5], ...
        'fitted', write_f64_desc([prefix '_fitted'], pFit), ...
        'scalars', write_f64_desc([prefix '_scalars'], [fval, 1 - fval, rFit, rFit^2]), ...
        'exitflag', exitflag, ...
        'funcCount', output.funcCount, ...
        'iterations', output.iterations, ...
        'negativeCountAtFit', sum(rawFit < 0), ...
        'beta', write_f64_desc([prefix '_beta'], betaFit));
end

payload = struct( ...
    'environment', envMeta, ...
    'radius', dataset.radius, ...
    'tr', dataset.tr, ...
    'downsample', downsampling, ...
    'hrf', write_f64_desc('nn_css_hrf', Hrf), ...
    'courses', write_f64_desc('nn_css_courses', double(Srf.Data)), ...
    'evals', {evalCases}, ...
    'fits', {fitCases});
write_json_file('nonnegative-css.json', payload);
end

function clipped = nn_css_compress(rawYp, pExp)
clipped = zeros(size(rawYp));
pos = rawYp > 0;
clipped(pos) = rawYp(pos) .^ pExp;
end

function stop = nn_css_stop_nonfinite(~, optimValues, ~)
stop = ~isfinite(optimValues.fval);
end

function obj = nn_css_objective(P, ApFrm, ApXY, Hrf, downsampling, y)
rfp = double(prf_gaussian_rf(P(1), P(2), P(3), ApXY));
rawYp = double(prf_predict_timecourse(rfp, ApFrm));
pred = double(prf_convolve_hrf(nn_css_compress(rawYp, P(4)), Hrf, downsampling));
r = corr(pred, y);
obj = 1 - r^2;
end

function seed_rng(seed, octave)
if octave
    rand('twister', seed); %#ok<RAND>
    randn('state', seed); %#ok<RAND>
else
    rng(seed, 'twister');
end
end

function pairs = sample_pairs(n, count)
pairs = zeros(count, 2);
used = false(n, n);
got = 0;
while got < count
    a = randi(n);
    b = randi(n);
    if a == b
        continue;
    end
    if a > b
        t = a; a = b; b = t;
    end
    if ~used(a, b)
        used(a, b) = true;
        got = got + 1;
        pairs(got, :) = [a, b];
    end
end
[~, ord] = sortrows(pairs);
pairs = pairs(ord, :);
end

function out = as_cell(x)
if iscell(x)
    out = x;
elseif isstruct(x)
    out = cell(numel(x), 1);
    for i = 1:numel(x)
        out{i} = x(i);
    end
else
    out = {x};
end
end

function vals = decode_f64_base64(b64)
alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
lut = -ones(1, 256);
for k = 1:64
    lut(double(alphabet(k)) + 1) = k - 1;
end
s = b64(b64 ~= 10 & b64 ~= 13 & b64 ~= ' ');
pad = sum(s == '=');
nGroups = numel(s) / 4;
bytes = zeros(1, nGroups * 3, 'uint8');
pos = 1;
for g = 1:nGroups
    c1 = lut(double(s(4 * g - 3)) + 1);
    c2 = lut(double(s(4 * g - 2)) + 1);
    ch3 = s(4 * g - 1);
    ch4 = s(4 * g);
    c3 = 0; if ch3 ~= '=', c3 = lut(double(ch3) + 1); end
    c4 = 0; if ch4 ~= '=', c4 = lut(double(ch4) + 1); end
    bytes(pos) = uint8(bitshift(c1, 2) + bitshift(c2, -4));
    bytes(pos + 1) = uint8(bitand(bitshift(c2, 4), 255) + bitshift(c3, -2));
    bytes(pos + 2) = uint8(bitand(bitshift(c3, 6), 255) + c4);
    pos = pos + 3;
end
if pad > 0
    bytes = bytes(1:end - pad);
end
vals = typecast(bytes, 'double');
vals = vals(:);
end

function desc = write_f64_desc(name, value)
desc = struct('file', [name '.f64'], 'shape', size(value), 'class', class(value), 'imaginary', '');
write_f64_array(desc.file, real(value));
if ~isreal(value)
    desc.imaginary = [name '.imag.f64'];
    write_f64_array(desc.imaginary, imag(value));
end
end

function write_f64_array(path, value)
fid = fopen(path, 'w', 'ieee-le');
assert(fid ~= -1, 'Could not open output file');
cleanup = onCleanup(@() fclose(fid));
assert(fwrite(fid, double(value), 'double') == numel(value), 'Short write');
end

function write_json_file(path, value)
fid = fopen(path, 'w');
assert(fid ~= -1, 'Could not open JSON file');
cleanup = onCleanup(@() fclose(fid));
fwrite(fid, jsonencode(value));
end
