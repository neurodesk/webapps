function record_conv_boundary(output, smoke)
% Sparse complex conv near multiples of 512 for #730. The competing rules, the
% discovery and held-out designs and the decision criteria are fixed in
% conv-boundary-predictions.md before the first run; this recorder only records.
% Discovery courses go to conv-boundary-discovery.json, held-out courses to
% conv-boundary-heldout.json, each with its own .f64 arrays (prefix d_ or h_), so
% the held-out file can stay unopened until the rule is frozen in a commit.
% smoke shortens both sets (Octave check of the recorder only).
if nargin < 2
    smoke = false;
end
if ~isfolder(output), mkdir(output); end
assert(~isfile(fullfile(output, 'conv-boundary-discovery.json')), 'Use a fresh probe directory');
previous = pwd;
restore = onCleanup(@() cd(previous));
cd(output);
if smoke
    environment = struct('smoke', true);
else
    environment = reference_environment('conv-boundary');
end
draws = 12;
% Discovery: the length threshold (course length or full output length), short
% kernels, and courses that end just below a multiple of 512. Rows: n, taps, kind.
discovery = [ ...
    820 17 1; 820 33 1; 850 17 1; 850 33 1; 880 17 1; 880 33 1; 900 17 1; 900 33 1; ...
    925 17 1; 925 33 1; 950 17 1; 950 33 1; 970 17 1; 970 33 1; 980 17 1; 980 33 1; ...
    990 17 1; 990 33 1; 995 17 1; 995 33 1; 1000 17 1; 1000 33 1; 1010 17 1; 1010 33 1; ...
    1100 9 1; 1100 11 1; 1100 12 1; 1100 15 1; 1020 33 1; 1530 33 1; ...
    2048 33 2; 1100 33 3];
% Held out: other tap counts, lengths and draws. Never used to choose a rule.
heldOut = [ ...
    845 13 1; 915 25 1; 960 13 1; 1005 25 1; 1015 13 1; 1300 13 1; 1536 21 1; ...
    2100 49 1; 2600 41 1; 3100 97 1; 4096 129 1; 3072 33 1; 2560 10 1; 1700 16 1];
if smoke
    discovery = discovery([1 30], :);
    heldOut = heldOut(1, :);
    draws = 2;
end
rng(7304, 'twister');
cases = record_set('d', discovery, draws);
write_json('conv-boundary-discovery.json', struct('environment', environment, 'cases', {cases}));
rng(7305, 'twister');
cases = record_set('h', heldOut, draws);
write_json('conv-boundary-heldout.json', struct('environment', environment, 'cases', {cases}));
fprintf('Recorded the conv-boundary probes\n');
end

function cases = record_set(prefix, rows, draws)
% kind 1: sparse complex course (24% nonzero); 2: sparse real course (control);
% 3: dense complex course (60% nonzero, control).
cases = cell(1, size(rows, 1));
for r = 1:size(rows, 1)
    n = rows(r, 1);
    taps = rows(r, 2);
    kind = rows(r, 3);
    density = 0.24;
    if kind == 3
        density = 0.6;
    end
    nonzero = sort(randperm(n, round(density * n)))';
    kernel = exp(-(0:taps - 1)' / (taps / 4)) .* (1 + 0.5 * rand(taps, 1));
    labels = {'complex', 'real', 'dense'};
    id = sprintf('%s_%s_n%d_t%d', prefix, labels{kind}, n, taps);
    m = numel(nonzero);
    total = n + taps - 1;
    re = zeros(total, draws);
    im = zeros(total, draws);
    valuesRe = zeros(m, draws);
    valuesIm = zeros(m, draws);
    for d = 1:draws
        y = complex(zeros(n, 1));
        if kind == 2
            y = zeros(n, 1);
            y(nonzero) = randn(m, 1);
        else
            y(nonzero) = randn(m, 1) + 1i * randn(m, 1);
        end
        result = conv(y, kernel);
        re(:, d) = builtin('real', result);
        im(:, d) = imag(result);
        valuesRe(:, d) = builtin('real', y(nonzero));
        valuesIm(:, d) = imag(y(nonzero));
    end
    cases{r} = struct('id', id, 'kind', labels{kind}, 'n', n, 'taps', taps, 'draws', draws, ...
        'kernel', array_file([id '_kernel'], kernel), ...
        'nonzero', array_file([id '_nonzero'], nonzero - 1), ...
        'valuesReal', array_file([id '_values_real'], valuesRe), ...
        'valuesImaginary', array_file([id '_values_imaginary'], valuesIm), ...
        'real', array_file([id '_real'], re), 'imaginary', array_file([id '_imaginary'], im));
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
