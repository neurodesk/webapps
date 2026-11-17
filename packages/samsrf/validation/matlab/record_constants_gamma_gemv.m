function record_constants_gamma_gemv(source, runs, output, spmSource)
% Held-out probes pre-registered in constants-gamma-gemv-predictions.md before
% the first run; this recorder only records.
%   constants-direct.json    detrend and zscore of 250 x V run matrices (and 1-, 2-, 3-
%                            and 37-volume ones) with one edited course at every position.
%   constants-pipeline.json  samsrf_gii2srf on the first two X001 runs, truncated
%                            to 134,257-134,260 vertices, with edited courses, in
%                            both precisions.
%   gamma.json               gampdf at shapes below 1 never recorded before.
%   gemv.json                FPRev pair fingerprints of double y' * A and random
%                            double products of the same shapes.
% runs: folder holding lh_uBars1.gii and lh_uBars2.gii (examples.json pins).
% Every edited value is exact in single precision and every gampdf input is
% built from exact operations, so the tests regenerate the inputs bit for bit.
addpath(genpath(source));
addpath(spmSource);
if ~isfolder(output), mkdir(output); end
assert(~isfile(fullfile(output, 'constants-direct.json')), 'Use a fresh probe directory');
previous = pwd;
restore = onCleanup(@() cd(previous));
cd(output);
environment = reference_environment('constants-gamma-gemv');
raw = cell(1, 2);
for r = 1:2
    run = gifti(fullfile(runs, sprintf('lh_uBars%d.gii', r)));
    raw{r} = run.cdata';
    assert(isa(raw{r}, 'single') && isequal(size(raw{r}), [250 134260]), 'Unexpected X001 run');
end
direct = direct_set(raw{1});
write_json('constants-direct.json', struct('environment', environment, 'cases', {direct}));
pipeline = pipeline_set(raw, output, source);
write_json('constants-pipeline.json', struct('environment', environment, 'cases', {pipeline}));
write_json('gamma.json', struct('environment', environment, 'cases', {gamma_set()}));
write_json('gemv.json', struct('environment', environment, 'cases', {gemv_set()}));
fprintf('Recorded %d direct, %d pipeline cases\n', numel(direct), numel(pipeline));
end

function course = edited(kind, n, donor)
% One edited course of n volumes; donor is the float32 course of vertex 6379
% (1-based) of the same run, used by the realistic near-constant kind.
i = (1:n)';
switch kind
    case 1, course = zeros(n, 1, 'single');
    case 2, course = repmat(single(3), n, 1);
    case 3, course = repmat(single(0.25), n, 1);
    case 4, course = repmat(single(-7.5), n, 1);
    case 5, course = repmat(single(100), n, 1);
    case 6, course = repmat(single(852), n, 1);
    case 7, course = repmat(single(1234.5), n, 1);
    case 8, course = repmat(single(10000), n, 1);
    case 9, course = single(2 * (i - 1) - 100);
    case 10, course = single(0.5 * (i - 1) + 3);
    case 11
        course = repmat(single(852), n, 1);
        course(max(1, floor(n / 2))) = 853;
    case 12
        course = repmat(single(1000), n, 1);
        course(1) = single(1000 + 2^-14);
    case 13
        course = repmat(single(852), n, 1);
        course(n) = single(852 - 2^-14);
    case 14, course = single(4382) + (donor(1:n) - single(4382)) / single(65536);
    case 15, course = repmat(single(4382), n, 1);
end
end

function cases = direct_set(run)
% Real courses of twelve low-variance X001 vertices fill the other columns.
fill = [6379 6356 7142 6357 49923 6378 6336 4954 10019 10880 24936 54070];
donor = run(:, 6379);
cases = {};
for n = [250 3 37 2 1]
    switch n
        case 250, widths = [1 2 3 5 6 7 9 10 11 12];
        case {3, 37}, widths = [5 8];
        case 2, widths = [1 5];
        case 1, widths = 1;
    end
    for kind = 1:15
        for V = widths
            for j = 1:V
                X = run(1:n, fill(1:V));
                X(:, j) = edited(kind, n, donor);
                X = double(X);
                D = detrend(X);
                Z = zscore(D);
                id = sprintf('direct_n%d_k%02d_V%02d_j%02d', n, kind, V, j);
                cases{end+1} = struct('id', id, 'n', n, 'kind', kind, 'V', V, 'j', j, ...
                    'input', hash(single(X)), 'detrend', array_file([id '_detrend'], D(:, j)), ...
                    'zscore', array_file([id '_zscore'], Z(:, j))); %#ok<AGROW>
            end
        end
    end
end
end

function cases = pipeline_set(raw, output, source)
grouped = 2000 + (0:59);
controls = [6379 6356 1 2 3 4 2061 2062];
tails = {[6 2 15 9], 6, [2 15], [1 12 14]};
counts = [134260 134257 134258 134259];
cases = {};
for variant = 1:numel(counts)
    V = counts(variant);
    tail = tails{variant};
    last = V - numel(tail) + (1:numel(tail));
    positions = [grouped last controls];
    files = cell(1, 2);
    work = fullfile(output, sprintf('pipeline_V%d', V));
    mkdir(work);
    hashes = cell(1, 2);
    for r = 1:2
        data = raw{r}(:, 1:V);
        donor = raw{r}(:, 6379);
        for q = 0:59
            data(:, grouped(q + 1)) = edited(floor(q / 4) + 1, 250, donor);
        end
        for t = 1:numel(tail)
            data(:, last(t)) = edited(tail(t), 250, donor);
        end
        hashes{r} = hash(data);
        files{r} = fullfile(work, sprintf('run%d.gii', r));
        save(gifti(struct('cdata', data')), files{r}, 'GZipBase64Binary');
        back = gifti(files{r});
        assert(isequal(back.cdata', data), 'The written GIfTI does not read back exactly');
    end
    for precision = {'double', 'single'}
        kind = precision{1};
        defaults = jsondecode(fileread(fullfile(source, 'SamSrf_defaults.json')));
        defaults.def_64bit = strcmp(kind, 'double');
        cd(work);
        write_json('SamSrf_defaults.json', defaults);
        Srf = samsrf_gii2srf(files, '', 1, true, true, '');
        cd(output);
        assert(strcmp(class(Srf.Data), kind), 'Processed precision was not honored');
        id = sprintf('pipeline_V%d_%s', V, kind);
        cases{end+1} = struct('id', id, 'vertices', V, 'precision', kind, ...
            'positions', positions, 'kinds', [floor((0:59) / 4) + 1, tail], ...
            'inputs', {hashes}, ...
            'courses', array_file([id '_courses'], Srf.Data(:, positions)), ...
            'noiseCeiling', array_file([id '_ceiling'], Srf.Noise_Ceiling(positions)), ...
            'globalSignal', array_file([id '_global'], nanmean(Srf.Data, 2))); %#ok<AGROW>
    end
    rmdir(work, 's');
end
end

function cases = gamma_set()
shapes = [0.05 0.2 0.3 0.5 0.55 0.85 0.9 0.95 0.999];
scales = [1 0.75 1.5 3];
cases = {};
for a = shapes
    for b = scales
        near = (a * b) * (64 + (-6:6)) / 64;
        x = [(1:640) / 16, 2 .^ -(1:60), 2^-1074, 3 * 2^-1074, 2^-1022, (1:100) * 8, near, 0, -1, Inf];
        id = strrep(sprintf('gamma_a%g_b%g', a, b), '.', 'p');
        cases{end+1} = struct('id', id, 'a', a, 'b', b, ...
            'x', array_file([id '_x'], x), 'gampdf', array_file([id '_gampdf'], gampdf(x, a, b))); %#ok<AGROW>
    end
end
end

function cases = gemv_set()
% FPRev pairs (Xie et al. 2025): column j of A holds 2^70 at row i, -2^70 at row k
% and ones elsewhere, y is ones; y' * A(:, j) counts the ones outside the smallest
% subtree that holds rows i and k. 2^70 absorbs every partial sum of ones.
shapes = [250 5; 250 6; 250 7; 250 3; 250 8; 61 7; 128 6; 97 5; 17 3];
big = 2^70;
cases = cell(1, size(shapes, 1));
for s = 1:size(shapes, 1)
    n = shapes(s, 1);
    m = shapes(s, 2);
    y = ones(n, 1);
    pairs = nchoosek(1:n, 2);
    counts = zeros(size(pairs, 1), m);
    for p = 1:size(pairs, 1)
        A = ones(n, m);
        A(pairs(p, 1), :) = big;
        A(pairs(p, 2), :) = -big;
        counts(p, :) = y' * A;
    end
    rng(7400 + s, 'twister');
    draws = 100;
    ys = randn(n, draws) .* exp(randn(n, draws));
    As = randn(n, m * draws) .* exp(randn(n, m * draws));
    products = zeros(draws, m);
    for d = 1:draws
        products(d, :) = ys(:, d)' * As(:, (d - 1) * m + (1:m));
    end
    id = sprintf('gemv_n%d_m%d', n, m);
    cases{s} = struct('id', id, 'n', n, 'm', m, ...
        'pairs', array_file([id '_pairs'], pairs), 'counts', array_file([id '_counts'], counts), ...
        'ys', array_file([id '_ys'], ys), 'As', array_file([id '_As'], As), ...
        'products', array_file([id '_products'], products));
end
end

function hex = hash(value)
% SHA-256 of a single matrix's little-endian bytes in column-major order.
assert(isa(value, 'single'));
digest = java.security.MessageDigest.getInstance('SHA-256');
digest.update(typecast(value(:), 'uint8'));
hex = lower(reshape(dec2hex(typecast(digest.digest(), 'uint8'), 2)', 1, []));
end

function descriptor = array_file(name, value)
descriptor = struct('file', [name '.f64'], 'shape', size(value), 'class', class(value), 'imaginary', '');
assert(isreal(value), [name ' is complex']);
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
