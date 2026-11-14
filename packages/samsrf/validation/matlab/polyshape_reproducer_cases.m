function [polygons, parameters] = polyshape_reproducer_cases(originalClouds, spec)
% The reduced reproducers of the four point clouds the experimental polyshape
% model regresses (#732), from polyshape-reproducers*.json (written by
% polyshape_reduce.py with both models' predictions before this recording).
% Each case takes 1-based indices into a point_clouds() cloud (0-based id), then
% flipud when reversed, circshift by -shift, and transform 1 (+[0.37 -1.21]),
% 2 (*1e-2) or 3 (*1e2), as polyshape_reduce.py's transformed() does.
% parameters: [cloud role reversed shift transform], role 0 original, 1 minimal,
% 2 chain, 3 oneDeleted, 4 order, 5 scale, 6 reproducer (the second round's
% smallest measured reproducer, polyshape-reproducers-2.json), 7 reduction (a
% compact round, polyshape-reproducers-4.json and later: spec.masks holds one
% bitmask of 1-based indices into cloud spec.cloud per case, untransformed),
% 8 perturbation (see below).
roles = {'original', 'minimal', 'chain', 'oneDeleted', 'order', 'scale', 'reproducer', 'reduction', 'perturbation'};
if isfield(spec, 'perturbations')
    % 8 perturbation (polyshape-reproducers-6.json): the reproducer spec.indices
    % of cloud spec.cloud with one coordinate replaced by an exact double, then
    % transformed.
    items = spec.perturbations;
    if ~iscell(items)
        items = num2cell(items);
    end
    polygons = cell(1, numel(items));
    parameters = zeros(numel(items), 5);
    base = originalClouds{spec.cloud + 1}(spec.indices(:), :);
    for i = 1:numel(items)
        c = items{i};
        Q = base;
        Q(c.point, c.axis + 1) = hex2num(c.value);
        switch c.transform
            case 1
                Q = Q + [0.37 -1.21];
            case 2
                Q = Q * 1e-2;
            case 3
                Q = Q * 1e2;
        end
        polygons{i} = Q;
        parameters(i, :) = [spec.cloud, find(strcmp(roles, spec.role)) - 1, 0, 0, c.transform];
    end
    return
end
if isfield(spec, 'masks')
    masks = spec.masks(:);
    assert(all(masks == floor(masks) & masks > 0 & masks < 2^53), 'invalid reduction mask');
    cases = cell(numel(masks), 1);
    for i = 1:numel(masks)
        cases{i} = struct('cloud', spec.cloud, 'role', spec.role, ...
            'indices', find(bitget(masks(i), 1:53)), 'reversed', 0, 'shift', 0, 'transform', 0);
    end
else
    cases = spec.cases;
    if ~iscell(cases)
        cases = num2cell(cases);
    end
end
polygons = cell(1, numel(cases));
parameters = zeros(numel(cases), 5);
for i = 1:numel(cases)
    c = cases{i};
    P = originalClouds{c.cloud + 1};
    Q = P(c.indices(:), :);
    if c.reversed
        Q = flipud(Q);
    end
    Q = circshift(Q, -c.shift, 1);
    switch c.transform
        case 1
            Q = Q + [0.37 -1.21];
        case 2
            Q = Q * 1e-2;
        case 3
            Q = Q * 1e2;
    end
    polygons{i} = Q;
    parameters(i, :) = [c.cloud, find(strcmp(roles, c.role)) - 1, c.reversed, c.shift, c.transform];
end
end
