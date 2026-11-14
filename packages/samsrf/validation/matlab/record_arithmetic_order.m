function record_arithmetic_order(numerics2Dir, output, smoke)
% Arithmetic-order probes for #729/#730. The competing predictions and the
% holdout design are fixed in arithmetic-order-predictions.md before the first
% run; this recorder only records.
%   dot-order    real x'*y: FPRev pair fingerprints for every length 2-80 and
%                sampled pairs at longer held-out lengths, random products
%                (draws 1-25 to identify, 26-50 held out), and Statistics
%                Toolbox corr(x, y) on short time-course-like vectors.
%   conv-weighted conv(y, kernel) of the pinned sparse complex courses longer
%                than 800 samples (numerics2-reference.json): the original
%                values, and random complex values on exactly the same nonzero
%                positions with the same kernel (draws 1-16 to identify, 17-24
%                held out); and generated held-out courses of other lengths
%                and tap counts. Full outputs are recorded.
% smoke shortens every section (Octave check of the recorder only).
if nargin < 3
    smoke = false;
end
if ~isfolder(output), mkdir(output); end
assert(~isfile(fullfile(output, 'arithmetic-order.json')), 'Use a fresh probe directory');
previous = pwd;
restore = onCleanup(@() cd(previous));
cd(output);
if smoke
    environment = struct('smoke', true);
else
    environment = reference_environment('arithmetic-order');
end
cases = [dot_order_cases(smoke), corr_cases(smoke), conv_weighted_cases(numerics2Dir, smoke)];
write_json('arithmetic-order.json', struct('environment', environment, 'cases', {cases}));
fprintf('Recorded %d arithmetic-order cases\n', numel(cases));
end

%% Real x'*y

function cases = dot_order_cases(smoke)
big = 2^60;
lengths = 2:80;
heldOut = [96 100 127 128 129 200 250 256 1000];
draws = 50;
sampled = 300;
if smoke
    lengths = [2 25 40];
    heldOut = 96;
    draws = 4;
    sampled = 10;
end
rng(7301, 'twister');
cases = {};
for n = [lengths heldOut]
    pairs = nchoosek(1:n, 2);
    exhaustive = n <= 80;
    if ~exhaustive
        pairs = pairs(sort(randperm(size(pairs, 1), sampled)), :);
    end
    counts = zeros(size(pairs, 1), 1);
    for p = 1:size(pairs, 1)
        x = ones(n, 1);
        y = ones(n, 1);
        y(pairs(p, 1)) = big;
        y(pairs(p, 2)) = -big;
        counts(p) = x' * y;
    end
    X = randn(n, draws) .* exp(3 * randn(n, draws));
    Y = randn(n, draws);
    dots = zeros(draws, 1);
    for d = 1:draws
        dots(d) = X(:, d)' * Y(:, d);
    end
    id = sprintf('dot_n%d', n);
    cases{end+1} = struct('id', id, 'kind', 'dot-order', 'n', n, 'exhaustive', exhaustive, ...
        'pairs', array_file([id '_pairs'], pairs), 'counts', array_file([id '_counts'], counts), ...
        'x', array_file([id '_x'], X), 'y', array_file([id '_y'], Y), ...
        'dots', array_file([id '_dots'], dots)); %#ok<AGROW>
end
end

function cases = corr_cases(smoke)
% corr as SamSrf's CSS objective calls it on a predicted and an observed course.
lengths = [25:80 96 100 128 250];
draws = 20;
if smoke
    lengths = [25 40];
    draws = 3;
end
rng(7302, 'twister');
cases = {};
for n = lengths
    t = (0:n - 1)';
    X = zeros(n, draws);
    Y = zeros(n, draws);
    for d = 1:draws
        predicted = max(0, sin(2 * pi * t / (8 + 24 * rand) + 2 * pi * rand) + 0.3 * randn(n, 1)) .^ (0.2 + rand);
        X(:, d) = predicted;
        Y(:, d) = (0.5 + rand) * predicted + randn(n, 1) * (0.1 + rand);
    end
    r = zeros(draws, 1);
    e = zeros(draws, 1);
    for d = 1:draws
        r(d) = corr(X(:, d), Y(:, d));
        e(d) = 1 - r(d)^2;
    end
    id = sprintf('corr_n%d', n);
    cases{end+1} = struct('id', id, 'kind', 'corr', 'n', n, ...
        'x', array_file([id '_x'], X), 'y', array_file([id '_y'], Y), ...
        'r', array_file([id '_r'], r), 'objective', array_file([id '_objective'], e)); %#ok<AGROW>
end
end

%% conv on weighted sparse complex courses

function cases = conv_weighted_cases(numerics2Dir, smoke)
hosts = dir(fullfile(numerics2Dir, 'ubuntu-*'));
assert(~isempty(hosts), 'No host folder in %s', numerics2Dir);
folder = fullfile(numerics2Dir, hosts(1).name, 'compatible');
recording = jsondecode(fileread(fullfile(folder, 'numerics.json')));
list = as_cell(recording.cases);
draws = 24;
if smoke
    draws = 2;
end
rng(7303, 'twister');
cases = {};
for c = 1:numel(list)
    item = list{c};
    if ~strcmp(item.kind, 'conv') || item.isreal
        continue;
    end
    y = read_array(folder, item.y);
    n = numel(y);
    if ~(4 * nnz(y) < n && n > 800)
        continue;
    end
    kernel = read_array(folder, item.kernel);
    cases{end+1} = conv_weighted_case(['convw_' item.id], item.id, y, kernel, draws); %#ok<AGROW>
    if smoke
        break;
    end
end
% Held-out courses: other lengths, densities and tap counts, generated here.
heldOut = [1100 33 0.22; 1536 33 0.24; 2048 33 0.20; 2600 33 0.24; 1600 17 0.24; 1600 65 0.24];
if smoke
    heldOut = heldOut(1, :);
end
for h = 1:size(heldOut, 1)
    n = heldOut(h, 1);
    taps = heldOut(h, 2);
    y = complex(zeros(n, 1));
    where = sort(randperm(n, round(heldOut(h, 3) * n)));
    y(where) = randn(numel(where), 1) + 1i * randn(numel(where), 1);
    kernel = exp(-(0:taps - 1)' / (taps / 4)) .* (1 + 0.5 * rand(taps, 1));
    id = sprintf('convw_heldout_n%d_t%d', n, taps);
    cases{end+1} = conv_weighted_case(id, '', y, kernel, min(draws, 8)); %#ok<AGROW>
end
end

function item = conv_weighted_case(id, source, y, kernel, draws)
% Draw 0 is the course itself; draws 1.. put random complex values on exactly
% its nonzero positions, with the same kernel.
n = numel(y);
nonzero = find(y ~= 0);
total = n + numel(kernel) - 1;
re = zeros(total, draws + 1);
im = zeros(total, draws + 1);
values = zeros(numel(nonzero), draws + 1);
valuesIm = zeros(numel(nonzero), draws + 1);
for d = 0:draws
    v = y;
    if d > 0
        v(nonzero) = randn(numel(nonzero), 1) + 1i * randn(numel(nonzero), 1);
    end
    r = conv(v, kernel);
    re(:, d + 1) = builtin('real', r);
    im(:, d + 1) = imag(r);
    values(:, d + 1) = builtin('real', v(nonzero));
    valuesIm(:, d + 1) = imag(v(nonzero));
end
item = struct('id', id, 'kind', 'conv-weighted', 'source', source, 'n', n, ...
    'taps', numel(kernel), 'draws', draws, ...
    'kernel', array_file([id '_kernel'], kernel), ...
    'nonzero', array_file([id '_nonzero'], nonzero - 1), ...
    'valuesReal', array_file([id '_values_real'], values), ...
    'valuesImaginary', array_file([id '_values_imaginary'], valuesIm), ...
    'real', array_file([id '_real'], re), 'imaginary', array_file([id '_imaginary'], im));
end

%% Helpers (as record_focused_probes.m)

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
    assert(fid ~= -1, 'Missing %s', descriptor.imaginary);
    imaginary = fread(fid, Inf, 'double');
    fclose(fid);
    assert(numel(imaginary) == prod(shape), 'Size of %s', descriptor.imaginary);
    value = complex(value, reshape(imaginary, shape));
end
end

function descriptor = array_file(name, value)
assert(isreal(value), 'array_file writes real arrays only');
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
