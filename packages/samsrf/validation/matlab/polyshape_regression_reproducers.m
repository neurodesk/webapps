function reproducers = polyshape_regression_reproducers()
% The smallest recorded 1-minimal reproducers of the four point clouds on which
% the experimental Clipper polyshape model regresses (#732), as exact doubles.
% Run it in MATLAB R2023b to print, for each, polyshape(P)'s regions and holes
% and convhull's vertices as row indices into P. Recorded in run 43564536819
% (polyshape-reproducers-reference.json, both hosts identical), MATLAB's hull is
% the rows in matlabHull; the experimental model's is experimentalHull (0 marks
% a vertex that is not an input point). Every one-point deletion of each was
% recorded and no longer separates the models from MATLAB that way.
reproducers = struct('cloud', {}, 'indices', {}, 'P', {}, 'matlabHull', {}, 'experimentalHull', {});
reproducers(end+1) = struct('cloud', 177, 'indices', [1 2 3 4 5 6], 'P', hex2num([ ...
    '3fc61b867e25e555'; '3ff586e1e1f4090a'
    '3f7e8291db1879e9'; '3ff03d052257e33e'
    '3fc645b8de03165b'; '3ff5916df0818184'
    '3fb216433170f82f'; '3ff242c8b04793d7'
    '3fb96adb601da37a'; '3ff32d5b940c38ba'
    '3feb9255526a94da'; '4005c92aadef63fb'
    ]), 'matlabHull', [2 3 6 1], 'experimentalHull', [2 3 6 4]);
reproducers(end).P = reshape(reproducers(end).P, 2, [])';
reproducers(end+1) = struct('cloud', 932, 'indices', [1 2 3 4 5 6 7 8 9 11 17], 'P', hex2num([ ...
    '3fdebe313081a1fd'; '3fff5f18a88a510f'
    '3fef71f08949ebea'; '4007b8f832286565'
    '3fcb2b230dfee26e'; '3ff6cac8cef88ddf'
    '3fbc25f41d2ae8db'; '3ff384be6db8c07a'
    '3fdaf301bd05ebce'; '3ffd7980f7ef209b'
    '3fc984b841b6de96'; '3ff6612e081db962'
    '3fea8bcc53a9f102'; '400545e630830a27'
    '3fe066ccb4af8649'; '4000336651aa32d7'
    '3fefcd0c26f2d468'; '4007e685f8081d4b'
    '3fe62f149f4f8dfd'; '4003178a4beed330'
    '3fc6ac36511f389e'; '3ff5ab0db32a9679'
    ]), 'matlabHull', [4 9 7 3], 'experimentalHull', [4 9 3]);
reproducers(end).P = reshape(reproducers(end).P, 2, [])';
reproducers(end+1) = struct('cloud', 1607, 'indices', [3 4 5 13 15 17 19 20], 'P', hex2num([ ...
    '3fd4ace0c19a7ea0'; '3ffa5670cb1132bd'
    '3fa1ddd5524e7ad7'; '3ff11ddd6894aac7'
    '3fd9e8d9ea0b09d7'; '3ffcf46cf6aecfd2'
    '3fd4c325e8edbb1e'; '3ffa61931c747bfe'
    '3fa8481759a7c226'; '3ff184818c0ea162'
    '3fe5ad38b03da001'; '4002d69c467795ae'
    '3fa6c9ff97ff466d'; '3ff16ca04e6dfffc'
    '3fe17cbd0dd62f4f'; '4000be5e62a74bb8'
    ]), 'matlabHull', [2 8 6 1 7], 'experimentalHull', [7 5 8 6 1]);
reproducers(end).P = reshape(reproducers(end).P, 2, [])';
reproducers(end+1) = struct('cloud', 1937, 'indices', [2 3 13 14 15 16 17 18], 'P', hex2num([ ...
    '3fe89b125c2f6a4e'; '40044d8928e88e46'
    '3fd8e1daa5823168'; '3ffc70ed4e5ea6de'
    '3fe52e48ec55c7fc'; '40029724749b1478'
    '3fca609ef78400fa'; '3ff69827b56e7017'
    '3fe09baa1c1f083f'; '40004dd4fe63711d'
    '3feffd0038b800f6'; '4007fe8018c5d974'
    '3f32fcd3ddc625a3'; '3ff0025f89903b35'
    '3fdaa60fa23966ec'; '3ffd5307dd32838d'
    ]), 'matlabHull', [7 5 6 8], 'experimentalHull', [7 5 0 8]);
reproducers(end).P = reshape(reproducers(end).P, 2, [])';
if nargout == 0
    for r = reproducers
        shape = polyshape(r.P);
        hull = convhull(shape);
        [~, rows] = ismember(hull.Vertices, r.P, 'rows');
        fprintf('cloud %d (%d points): %d regions, %d holes, hull rows %s (recorded %s)\n', r.cloud, size(r.P, 1), ...
            shape.NumRegions, shape.NumHoles, mat2str(sort(rows')), mat2str(sort(r.matlabHull)));
    end
end
end
