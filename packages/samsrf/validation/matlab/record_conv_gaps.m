function record_conv_gaps(output, smoke)
% The remaining sparse conv questions of #730, pre-registered in
% conv-gaps-predictions.md before the first run; this recorder only records.
%   conv-gaps-replay.json    the 12 held-out courses of conv-blocks-reference.json,
%                            regenerated exactly (rng 7307), for a host GitHub did
%                            not assign then (an AMD one).
%   conv-gaps-boundary.json  the complex threshold (full output 1,022-1,026) and
%                            exact 8-block lengths, decided on one kernel length and
%                            confirmed on another, with controls.
%   conv-gaps-short.json     held-out courses for kernels of fewer than 9 taps.
% Sections B and C draw every position, kernel tap and value from a Park-Miller
% stream (integers below 2^53, IEEE division), so the inputs are known exactly
% before the run and the tests regenerate them.
if nargin < 2
    smoke = false;
end
if ~isfolder(output), mkdir(output); end
assert(~isfile(fullfile(output, 'conv-gaps-replay.json')), 'Use a fresh probe directory');
previous = pwd;
restore = onCleanup(@() cd(previous));
cd(output);
if smoke
    environment = struct('smoke', true);
else
    environment = reference_environment('conv-gaps');
end
% A: the conv-blocks held-out table and generator, unchanged.
heldOut = [ ...
    3000 100 1; 5000 140 1; 4500 200 1; 6000 300 1; 2600 129 1; 6000 25 1; 900 13 1; ...
    3000 21 2; 4100 49 2; 5000 97 2; 6000 140 2; 1500 13 2];
draws = 12;
if smoke
    heldOut = heldOut(7, :);
    draws = 2;
end
rng(7307, 'twister');
cases = replay_set('h2', heldOut, draws);
write_json('conv-gaps-replay.json', struct('environment', environment, 'cases', {cases}));
% B and C: rows are {section, n, taps, kind, density, seed}.
boundary = {};
for n = 990:994
    boundary(end+1, :) = {'threshold-decide', n, 33, 'complex', 0.20, 1000 + n}; %#ok<AGROW>
end
for n = 1006:1010
    boundary(end+1, :) = {'threshold-confirm', n, 17, 'complex', 0.20, 2000 + n}; %#ok<AGROW>
end
for n = [2016 2017]
    boundary(end+1, :) = {'threshold-real', n, 33, 'real', 0.20, 3000 + n}; %#ok<AGROW>
end
for n = 4063:4065
    boundary(end+1, :) = {'blocks-decide', n, 33, 'complex', 0.20, 4000 + n}; %#ok<AGROW>
end
for n = 4031:4033
    boundary(end+1, :) = {'blocks-confirm', n, 65, 'complex', 0.20, 5000 + n}; %#ok<AGROW>
end
for n = 8159:8161
    boundary(end+1, :) = {'blocks-confirm', n, 33, 'real', 0.20, 6000 + n}; %#ok<AGROW>
end
boundary(end+1, :) = {'control', 2048, 33, 'complex', 0.20, 7001};
boundary(end+1, :) = {'control', 4096, 17, 'real', 0.20, 7002};
short = {};
for t = [2 4 6 7]
    short(end+1, :) = {'short-heldout', 1300, t, 'complex', 0.20, 8000 + t}; %#ok<AGROW>
end
for t = [2 4 6 7]
    short(end+1, :) = {'short-heldout', 2500, t, 'real', 0.20, 8100 + t}; %#ok<AGROW>
end
short(end+1, :) = {'short-heldout', 300, 6, 'complex', 0.20, 8201};
short(end+1, :) = {'short-heldout', 250, 7, 'real', 0.20, 8202};
short(end+1, :) = {'short-heldout', 400, 5, 'real', 0.20, 8203};
short(end+1, :) = {'short-heldout', 40, 4, 'real', 0.15, 8204};
short(end+1, :) = {'short-dense', 1100, 4, 'complex', 0.60, 8301};
short(end+1, :) = {'short-dense', 900, 7, 'real', 0.60, 8302};
if smoke
    boundary = boundary(1, :);
    short = short([12 13], :);
end
write_json('conv-gaps-boundary.json', struct('environment', environment, 'cases', {generated_set('b', boundary, draws)}));
write_json('conv-gaps-short.json', struct('environment', environment, 'cases', {generated_set('s', short, draws)}));
fprintf('Recorded the conv-gap probes\n');
end

function cases = replay_set(prefix, rows, draws)
% record_conv_blocks.m's record_set, statement for statement.
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

function cases = generated_set(prefix, rows, draws)
cases = cell(1, size(rows, 1));
for r = 1:size(rows, 1)
    [section, n, taps, kind, density, seed] = rows{r, :};
    state = seed;
    u = zeros(n, 1);
    for i = 1:n
        state = mod(state * 48271, 2147483647);
        u(i) = state / 2147483647;
    end
    nonzero = find(u < density);
    kernel = zeros(taps, 1);
    for t = 1:taps
        state = mod(state * 48271, 2147483647);
        kernel(t) = (1 + 0.5 * (state / 2147483647)) / t;
    end
    m = numel(nonzero);
    valuesRe = zeros(m, draws);
    valuesIm = zeros(m, draws);
    for d = 1:draws
        for j = 1:m
            state = mod(state * 48271, 2147483647);
            valuesRe(j, d) = 2 * (state / 2147483647) - 1;
            if strcmp(kind, 'complex')
                state = mod(state * 48271, 2147483647);
                valuesIm(j, d) = 2 * (state / 2147483647) - 1;
            end
        end
    end
    total = n + taps - 1;
    re = zeros(total, draws);
    im = zeros(total, draws);
    for d = 1:draws
        if strcmp(kind, 'complex')
            y = complex(zeros(n, 1));
            y(nonzero) = complex(valuesRe(:, d), valuesIm(:, d));
        else
            y = zeros(n, 1);
            y(nonzero) = valuesRe(:, d);
        end
        result = conv(y, kernel);
        re(:, d) = builtin('real', result);
        im(:, d) = imag(result);
    end
    id = sprintf('%s_%s_%s_n%d_t%d', prefix, section, kind, n, taps);
    cases{r} = struct('id', id, 'section', section, 'kind', kind, 'n', n, 'taps', taps, ...
        'density', density, 'seed', seed, 'draws', draws, ...
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
