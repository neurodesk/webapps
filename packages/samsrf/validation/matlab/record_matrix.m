function cases = record_matrix(input, output, arrayFile, writeJson)
% Exercise the public SamSrf entry points, including their final precision cast.
% Every analysis has its own directory: no source/regressor cache is reused.
manifest = jsondecode(fileread(fullfile(input, 'manifest.json')));
if isstruct(manifest.datasets)
    manifest.datasets = num2cell(manifest.datasets);
end
writeJson('matrix-input.json', manifest);
copyfile(fullfile(input, 'aps_Bars.mat'), fullfile(output, 'aps_x001_raw.mat'));
cases = {};
for precision = {'double', 'single'}
    kind = precision{1};
    defaults = jsondecode(fileread(fullfile(output, 'SamSrf_defaults.json')));
    defaults.def_64bit = strcmp(kind, 'double');
    writeJson('SamSrf_defaults.json', defaults);
    for ds = 1:numel(manifest.datasets)
        dataset = manifest.datasets{ds};
        folder = fullfile(input, dataset.id);
        files = cellfun(@(p) fullfile(folder, p), dataset.runs, 'UniformOutput', false);
        for average = [true false]
            if numel(files) == 1 && ~average
                continue
            end
            id = sprintf('preprocess_%s_%s_average%d', kind, dataset.id, average);
            Srf = samsrf_gii2srf(files, '', 1, average, true, '');
            item = struct('id', id, 'kind', 'preprocess', 'precision', kind, ...
                'dataset', dataset.id, 'average', average, ...
                'courses', arrayFile([id '_courses'], Srf.Data));
            if isfield(Srf, 'Noise_Ceiling')
                item.noiseCeiling = arrayFile([id '_ceiling'], Srf.Noise_Ceiling);
            end
            cases{end+1} = item; %#ok<AGROW>
            writeJson([id '.json'], item);

            % analyzePRF has different stimulus sequences in each run. It may
            % be concatenated, but fitting their average would be meaningless.
            if strcmp(dataset.id, 'analyzeprf_lh') && average
                continue
            end
            Srf.Hemisphere = dataset.hemisphere;
            count = 1;
            if ~average
                count = numel(files);
            end
            aperture = prepare_apertures(input, dataset, count, output);
            Model = forward_model(dataset, aperture);
            for coarse = [true false]
                Model.Coarse_Fit_Only = coarse;
                fitId = sprintf('pipeline_%s_%s_average%d_coarse%d', ...
                    kind, dataset.id, average, coarse);
                cases{end+1} = fit_case(fitId, Srf, Model, defaults, output, ...
                    arrayFile, writeJson, kind, id, 'prf'); %#ok<AGROW>
            end
            if strcmp(dataset.id, 'x001_lh') && average
                Model.Noise_Ceiling_Threshold = 0.5;
                Model.Fine_Fit_Threshold = 0.2;
                cases{end+1} = fit_case(['pipeline_' kind '_thresholds'], Srf, ...
                    Model, defaults, output, arrayFile, writeJson, kind, id, 'prf'); %#ok<AGROW>
                Model.Noise_Ceiling_Threshold = 0;
                Model.Fine_Fit_Threshold = 0.01;
                Model.Compressive_Nonlinearity = true;
                cases{end+1} = fit_case(['pipeline_' kind '_css'], Srf, ...
                    Model, defaults, output, arrayFile, writeJson, kind, id, 'prf'); %#ok<AGROW>
            end
            if startsWith(dataset.id, 'x001_') && average
                RcModel = struct('Name', 'reference', 'Aperture_File', ...
                    fullfile(output, 'aps_x001_raw'), 'Scaling_Factor', dataset.radius, ...
                    'TR', 1, 'Hrf', [], 'Rdim', 100, 'Prf_Function', 0, ...
                    'Save_Rmaps', true, 'Allow_Negative_Peaks', true);
                cases{end+1} = fit_case(['pipeline_' kind '_' dataset.id '_rc'], ...
                    Srf, RcModel, defaults, output, arrayFile, writeJson, kind, id, 'revcor'); %#ok<AGROW>
            end
        end
        if isfield(dataset, 'syntheticAnatomy')
            id = ['benson_' kind '_' dataset.hemisphere];
            work = fresh_directory(output, id, defaults, writeJson);
            previous = pwd;
            restore = onCleanup(@() cd(previous));
            cd(work);
            samsrf_benson2srf(fullfile(folder, [dataset.hemisphere '_benson']), ...
                fullfile(folder, 'surf'), '');
            result = load([dataset.hemisphere '_benson.mat']);
            cd(previous);
            clear restore
            item = struct('id', id, 'kind', 'benson', ...
                'precision', kind, 'dataset', dataset.id, ...
                'maps', arrayFile([id '_maps'], result.Srf.Data));
            cases{end+1} = item; %#ok<AGROW>
            writeJson([id '.json'], item);
        end
        writeJson('matrix.json.partial', struct('cases', {cases}));
    end
end
end

function aperture = prepare_apertures(input, dataset, count, output)
name = sprintf('aps_%s_%d', dataset.id, count);
aperture = fullfile(output, name);
if isfile([aperture '.mat'])
    return
end
if ischar(dataset.apertures)
    data = load(fullfile(input, dataset.apertures));
    if isfield(data, 'ApXY')
        data.ApFrm = repmat(data.ApFrm, 1, count);
    else
        data.ApFrm = repmat(data.ApFrm, 1, 1, count);
    end
    save([aperture '.mat'], '-struct', 'data', '-v7');
    if ~isfield(data, 'ApXY')
        VectoriseApertures(aperture);
        movefile([aperture '_vec.mat'], [aperture '.mat']);
    end
else
    frames = cell(1, count);
    for i = 1:count
        data = load(fullfile(input, dataset.id, dataset.apertures{i}));
        frames{i} = data.ApFrm;
    end
    ApFrm = cat(3, frames{:});
    save([aperture '.mat'], 'ApFrm', '-v7');
    VectoriseApertures(aperture);
    movefile([aperture '_vec.mat'], [aperture '.mat']);
end
end

function Model = forward_model(dataset, aperture)
radius = dataset.radius;
Model = struct('Name', 'reference', ...
    'Prf_Function', '@(P,XY)prf_gaussian_rf(P(1),P(2),P(3),XY)', ...
    'Param_Names', {{'x0', 'y0', 'Sigma'}}, 'Scaled_Param', [1 1 1], ...
    'Only_Positive', [0 0 1], 'Scaling_Factor', radius, ...
    'TR', dataset.tr, 'Downsample_Predictions', dataset.downsample, ...
    'Hrf', [], 'Aperture_File', aperture, ...
    'Param1', [-0.6 0 0.6] * radius, 'Param2', [-0.6 0 0.6] * radius, ...
    'Param3', [0.125 0.333] * radius, 'Replace_Bad_Fits', false, ...
    'Fine_Fit_Threshold', 0.01, 'Noise_Ceiling_Threshold', 0);
end

function item = fit_case(id, Srf, Model, defaults, output, arrayFile, writeJson, kind, preprocessing, analysis)
Model.Name = id;
work = fresh_directory(output, id, defaults, writeJson);
previous = pwd;
restore = onCleanup(@() cd(previous));
cd(work);
modelJson = Model;
if strcmp(analysis, 'prf')
    Model.Prf_Function = str2func(Model.Prf_Function);
    filename = samsrf_fit_prf(Model, Srf);
else
    filename = samsrf_revcor_prf(Model, Srf);
end
result = load([filename '.mat']);
savedMaps = result.Srf.Data;
savedVertices = 1:size(savedMaps, 2);
if isfield(result.Srf, 'Roi')
    savedVertices = result.Srf.Roi;
end
% SamSrf 10.4's expand_srf discards imaginary parts. Preserve the saved MAT
% values separately so exporting real maps cannot hide complex CSS fits.
result.Srf = samsrf_expand_srf(result.Srf);
samsrf_export_giis(result.Srf, 'export', false, result.Srf.Values);
cd(previous);
clear restore
modelJson.Aperture_File = erase(modelJson.Aperture_File, [output filesep]);
item = struct('id', id, 'kind', 'pipeline', 'analysis', analysis, ...
    'precision', kind, 'preprocessing', preprocessing, 'model', modelJson, ...
    'values', {result.Srf.Values}, 'maps', arrayFile([id '_maps'], result.Srf.Data), ...
    'savedMaps', arrayFile([id '_saved_maps'], savedMaps), ...
    'savedVertices', arrayFile([id '_saved_vertices'], savedVertices));
if strcmp(analysis, 'prf')
    search = load(fullfile(work, ['src_' id '.mat']));
    item.grid = arrayFile([id '_grid'], search.S);
    item.predictions = arrayFile([id '_predictions'], search.X);
    convolved = zeros(size(Srf.Data, 1), size(search.X, 2));
    for i = 1:size(search.X, 2)
        convolved(:, i) = prf_convolve_hrf(search.X(:, i), result.Model.Hrf, ...
            Model.Downsample_Predictions);
    end
    item.hrf = arrayFile([id '_hrf'], result.Model.Hrf);
    item.coarseCorrelations = arrayFile([id '_coarse_correlations'], corr(Srf.Data, convolved));
else
    item.profiles = arrayFile([id '_profiles'], result.Srf.Rmaps);
    item.regressors = arrayFile([id '_regressors'], result.Srf.Regs);
end
writeJson([id '.json'], item);
fprintf('Recorded %s\n', id);
end

function work = fresh_directory(output, id, defaults, writeJson)
work = fullfile(output, 'work', id);
assert(~isfolder(work), 'Use fresh analysis directories');
mkdir(work);
writeJson(fullfile(work, 'SamSrf_defaults.json'), defaults);
end
