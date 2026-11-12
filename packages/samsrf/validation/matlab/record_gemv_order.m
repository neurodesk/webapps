function record_gemv_order(output)
% RECORD_GEMV_ORDER Fingerprint the summation order of single y' * A, the
% product samsrf_cfparam_loop's corr(y, X) computes, by the pair method of
% FPRev (Xie et al. 2025): A's column j holds 2^40 at row i, -2^40 at row k
% and ones elsewhere, y is ones. Every partial sum of ones is absorbed into
% +-2^40 until the two cancel, so y' * A(:, j) counts the ones outside the
% smallest subtree that contains rows i and k. Over all pairs i < k the counts
% give the reduction tree of every output column.
%
% Random single products of the same shapes are recorded as held-out checks
% for an algorithm reconstructed from the trees.
if ~exist(output, 'dir')
    mkdir(output);
end
environment = struct('matlab', version, 'computer', computer, ...
    'blas', version('-blas'), 'maxComputationalThreads', maxNumCompThreads, ...
    'mklCbwr', getenv('MKL_CBWR'));
shapes = [250 9; 61 9; 128 9; 97 5];
cases = cell(1, size(shapes, 1));
big = single(2^40);
for s = 1:size(shapes, 1)
    n = shapes(s, 1);
    m = shapes(s, 2);
    y = ones(n, 1, 'single');
    pairs = nchoosek(1:n, 2);
    counts = zeros(size(pairs, 1), m);
    for p = 1:size(pairs, 1)
        A = ones(n, m, 'single');
        A(pairs(p, 1), :) = big;
        A(pairs(p, 2), :) = -big;
        counts(p, :) = double(y' * A);
    end
    % The same call with the probe stored as a single column (A(:, j) copied),
    % which is a vector dot product: a control for the column layout.
    column = zeros(size(pairs, 1), 1);
    for p = 1:size(pairs, 1)
        a = ones(n, 1, 'single');
        a(pairs(p, 1)) = big;
        a(pairs(p, 2)) = -big;
        column(p) = double(y' * a);
    end
    rng(s, 'twister');
    draws = 100;
    ys = single(randn(n, draws) .* exp(randn(n, draws)));
    As = single(randn(n, m * draws) .* exp(randn(n, m * draws)));
    products = zeros(draws, m);
    for d = 1:draws
        products(d, :) = double(ys(:, d)' * As(:, (d - 1) * m + (1:m)));
    end
    cases{s} = struct('n', n, 'm', m, 'pairs', pairs, 'counts', counts, 'column', column, ...
        'ys', double(ys), 'As', double(As), 'products', products);
end
fid = fopen(fullfile(output, 'gemv-order.json'), 'w');
fwrite(fid, jsonencode(struct('environment', environment, 'cases', {cases})));
fclose(fid);
fprintf('Recorded %d gemv order fingerprints\n', numel(cases));
end
