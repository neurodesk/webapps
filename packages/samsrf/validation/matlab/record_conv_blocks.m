function record_conv_blocks(output, smoke)
% Block length of MATLAB's sparse conv against kernel length and element type,
% for #730: the second recording of conv-boundary-predictions.md, whose rules,
% designs and decision criteria are committed before it runs. Discovery courses go
% to conv-blocks-discovery.json (d2_ arrays), held-out courses to
% conv-blocks-heldout.json (h2_ arrays), which stays unopened until the law is
% frozen in a commit.
% smoke shortens both sets (Octave check of the recorder only).
if nargin < 2
    smoke = false;
end
if ~isfolder(output), mkdir(output); end
assert(~isfile(fullfile(output, 'conv-blocks-discovery.json')), 'Use a fresh probe directory');
previous = pwd;
restore = onCleanup(@() cd(previous));
cd(output);
if smoke
    environment = struct('smoke', true);
else
    environment = reference_environment('conv-blocks');
end
draws = 12;
% Rows: n, taps, kind (1 sparse complex, 2 sparse real).
discovery = [ ...
    [4096 * ones(12, 1), (120:131)', ones(12, 1)]; ...
    4096 65 1; 4096 97 1; 4096 105 1; 4096 113 1; 4096 145 1; 4096 193 1; ...
    4096 255 1; 4096 256 1; 4096 257 1; 4096 258 1; ...
    1900 129 1; 1920 129 1; 2000 129 1; ...
    4096 17 2; 4096 33 2; 4096 65 2; 4096 129 2; 4096 257 2; ...
    2010 33 2; 2016 33 2; 2040 33 2; ...
    1100 3 1; 1100 5 1; 1100 8 1; 2100 3 2; 2100 5 2; 2100 8 2];
heldOut = [ ...
    3000 100 1; 5000 140 1; 4500 200 1; 6000 300 1; 2600 129 1; 6000 25 1; 900 13 1; ...
    3000 21 2; 4100 49 2; 5000 97 2; 6000 140 2; 1500 13 2];
if smoke
    discovery = discovery([1 33], :);
    heldOut = heldOut(1, :);
    draws = 2;
end
rng(7306, 'twister');
cases = record_set('d2', discovery, draws);
write_json('conv-blocks-discovery.json', struct('environment', environment, 'cases', {cases}));
rng(7307, 'twister');
cases = record_set('h2', heldOut, draws);
write_json('conv-blocks-heldout.json', struct('environment', environment, 'cases', {cases}));
fprintf('Recorded the conv-block probes\n');
end

function cases = record_set(prefix, rows, draws)
% kind 1: sparse complex course (24% nonzero); 2: sparse real course.
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
