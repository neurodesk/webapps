function cases = record_revcor_matrix(input, output, arrayFile, writeJson, smoke)
% Raw GIfTI -> preprocessing -> RC/CF, on the pinned participant subsets.
% The synthetic meshes exercise smoothing; they are not anatomical references.
% Global correction uses every vertex in each subset, not the original cortex.
manifest = jsondecode(fileread(fullfile(input, 'manifest.json')));
datasets = manifest.datasets;
if isstruct(datasets)
    datasets = num2cell(datasets);
end
writeJson('matrix-input.json', manifest);
cases = {};
precisions = {'double', 'single'};
if smoke
    precisions = {'single'};
end
for precision = precisions
    kind = precision{1};
    defaults = jsondecode(fileread(fullfile(output, 'SamSrf_defaults.json')));
    defaults.def_64bit = strcmp(kind, 'double');
    writeJson('SamSrf_defaults.json', defaults);
    for ds = 1:numel(datasets)
        dataset = datasets{ds};
        if ~startsWith(dataset.id, 'x001_') || (smoke && ~strcmp(dataset.id, 'x001_lh'))
            continue
        end
        folder = fullfile(input, dataset.id);
        files = cellfun(@(name) fullfile(folder, name), dataset.runs, 'UniformOutput', false);
        averages = [true false];
        if numel(files) == 1 || smoke
            averages = true;
        end
        for average = averages
            id = sprintf('revcor_%s_%s_average%d', kind, dataset.id, average);
            work = fresh_directory(output, id, defaults, writeJson);
            previous = pwd;
            restore = onCleanup(@() cd(previous));
            cd(work);
            Srf = samsrf_gii2srf(files, fullfile(folder, 'surf', dataset.hemisphere), ...
                1, average, true, '');
            assert(strcmp(class(Srf.Data), kind), 'Processed precision was not honored');
            count = size(Srf.Data, 2);
            roi = unique([1:12 25 count-7:count]);
            if smoke
                roi = [2 25 count];
            end
            seed = 2:2:18;
            assert(count >= 26 && all(seed <= count));
            assert(any(ismember(seed,roi)) && any(~ismember(seed,roi)));
            samsrf_srf2label(Srf, 'roi', 1, roi);
            samsrf_srf2label(Srf, 'seed', 1, seed);
            samsrf_benson2srf(fullfile(folder, [dataset.hemisphere '_benson']), ...
                fullfile(folder, 'surf'), '');
            templatePath = fullfile(work, [dataset.hemisphere '_benson.mat']);
            template = load(templatePath);
            cd(previous);
            clear restore

            item = struct('id', id, 'kind', 'preprocess', 'precision', kind, ...
                'dataset', dataset.id, 'average', average, 'syntheticAnatomy', true, ...
                'globalSignalDomain', 'all vertices of the pinned participant subset', ...
                'courses', arrayFile([id '_courses'], Srf.Data), ...
                'vertices', arrayFile([id '_vertices'], Srf.Vertices), ...
                'faces', arrayFile([id '_faces'], Srf.Faces), ...
                'area', arrayFile([id '_area'], Srf.Area), ...
                'roi', arrayFile([id '_roi'], roi), ...
                'seedVertices', arrayFile([id '_seed'], seed));
            if isfield(Srf, 'Noise_Ceiling')
                item.noiseCeiling = arrayFile([id '_ceiling'], Srf.Noise_Ceiling);
            end
            cases{end+1} = item; %#ok<AGROW>
            writeJson([id '.json'], item);
            templateItem = struct('id', [id '_template'], 'kind', 'benson', ...
                'precision', kind, 'dataset', dataset.id, ...
                'maps', arrayFile([id '_template'], template.Srf.Data));
            cases{end+1} = templateItem; %#ok<AGROW>
            writeJson([templateItem.id '.json'], templateItem);

            % Three estimation methods, before and after smoothing and global
            % regression. The ROI overlaps only part of the seed: the source
            % regresses the ROI before selecting the seed courses.
            globalSignal = nanmean(Srf.Data, 2);
            for correctGlobal = [false true]
                corrected = Srf;
                if correctGlobal
                    previous = pwd;
                    restore = onCleanup(@() cd(previous));
                    cd(work);
                    corrected = samsrf_removenoise(Srf, globalSignal, roi);
                    cd(previous);
                    clear restore
                end
                for smoothing = [0 1]
                    for mode = [0 -1 1]
                        fitId = sprintf('%s_cf_mode%d_smooth%d_global%d', ...
                            id, mode, smoothing, correctGlobal);
                        Model = struct('Name', fitId, 'Template', templatePath, ...
                            'SeedRoi', fullfile(work, 'seed'), ...
                            'Fit_pRF', mode, 'Smoothing', smoothing, ...
                            'Global_Signal_Correction', correctGlobal, 'Save_Rmaps', true);
                        item = run_case(fitId, 'cf', Srf, Model, fullfile(work, 'roi'), ...
                            defaults, output, arrayFile, writeJson, id, kind);
                        item.template = templateItem.id;
                        item.globalSignal = arrayFile([fitId '_global'], globalSignal);
                        item.recomputedCorrectedCourses = arrayFile([fitId '_corrected'], corrected.Data);
                        item.seedCourses = arrayFile([fitId '_seed_courses'], corrected.Data(:,seed));
                        cases{end+1} = item; %#ok<AGROW>
                        writeJson([fitId '.json'], item);
                        writeJson('revcor-matrix.json.partial', struct('cases', {cases}));
                    end
                end
            end

            % Keep Rdim equal to the actual aperture width: the pinned source
            % cannot reshape its coordinate grids when those dimensions differ.
            aperture = load(fullfile(input, dataset.apertures));
            % The original 100-pixel hull cases remain in the 741-case pin.
            % Sample these additional cases on a declared 20-pixel grid to
            % bound archive size, particularly for six concatenated runs.
            ApFrm = aperture.ApFrm(1:5:end, 1:5:end, :);
            if ~average
                ApFrm = repmat(ApFrm, 1, 1, numel(files));
            end
            aperturePath = fullfile(work, 'apertures.mat');
            save(aperturePath, 'ApFrm', '-v7');
            assert(size(ApFrm, 1) == size(ApFrm, 2));
            assert(size(ApFrm, 3) == size(Srf.Data, 1));
            apertureArray = arrayFile([id '_apertures'], ApFrm);
            customHrf = samsrf_doublegamma(dataset.tr, [5 15 1.2 0.9 5 1 30]);
            configurations = {'hull', 0, 0, false; 'custom_hrf', customHrf(:), 0, true; ...
                'gaussian', 0, '@(P,ApWidth)prf_gaussian_rf(P(1),P(2),P(3),ApWidth)', false};
            for config = 1:size(configurations, 1)
                fitId = [id '_rc_' configurations{config, 1}];
                Model = struct('Name', fitId, 'Aperture_File', aperturePath, ...
                    'Scaling_Factor', dataset.radius, 'TR', dataset.tr, ...
                    'Hrf', configurations{config, 2}, 'Rdim', size(ApFrm, 1), ...
                    'Prf_Function', configurations{config, 3}, 'Save_Rmaps', true, ...
                    'Allow_Negative_Peaks', configurations{config, 4});
                if ischar(Model.Prf_Function)
                    Model.Param_Names = {'x0', 'y0', 'Sigma'};
                    Model.Scaled_Param = [1 1 1];
                    Model.SeedPar_Function = '@(V)[V(2:3);V(4)/(2*sqrt(2*log(2)))]';
                    Model.R2_Threshold = 0.1;
                end
                item = run_case(fitId, 'revcor', Srf, Model, fullfile(work, 'roi'), ...
                    defaults, output, arrayFile, writeJson, id, kind);
                item.apertures = apertureArray;
                item.aperturePreparation = 'Every fifth row and column of pinned aps_Bars; concatenate frames in run order';
                cases{end+1} = item; %#ok<AGROW>
                writeJson([fitId '.json'], item);
                writeJson('revcor-matrix.json.partial', struct('cases', {cases}));
            end
        end
    end
end
expected = 102;
if smoke
    expected = 17;
end
assert(numel(cases) == expected, 'Incomplete reverse-correlation matrix');
writeJson('revcor-matrix.json', struct('smoke', smoke, 'cases', {cases}));
end

function item = run_case(id, analysis, Srf, model, roiPath, defaults, output, arrayFile, writeJson, preprocessing, kind)
work = fresh_directory(output, id, defaults, writeJson);
previous = pwd;
restore = onCleanup(@() cd(previous));
cd(work);
Model = model;
if strcmp(analysis, 'cf')
    filename = samsrf_revcor_cf(Model, Srf, roiPath);
else
    if ischar(Model.Prf_Function)
        Model.Prf_Function = str2func(Model.Prf_Function);
        Model.SeedPar_Function = str2func(Model.SeedPar_Function);
    end
    filename = samsrf_revcor_prf(Model, Srf, roiPath);
end
result = load([filename '.mat']);
saved = result.Srf;
vertices = 1:size(saved.Data, 2);
if isfield(saved, 'Roi')
    vertices = saved.Roi;
end
expanded = samsrf_expand_srf(saved);
if strcmp(analysis, 'revcor')
    regressors = load(fullfile(work, 'reg_apertures.mat'));
end
cd(previous);
clear restore
for field = {'Template', 'SeedRoi', 'Aperture_File'}
    if isfield(model, field{1})
        model.(field{1}) = erase(model.(field{1}), [output filesep]);
    end
end
item = struct('id', id, 'kind', 'pipeline', 'analysis', analysis, ...
    'precision', kind, 'preprocessing', preprocessing, 'model', model, ...
    'values', {saved.Values}, 'maps', arrayFile([id '_maps'], expanded.Data), ...
    'savedMaps', arrayFile([id '_saved_maps'], saved.Data), ...
    'savedVertices', arrayFile([id '_saved_vertices'], vertices), ...
    'savedCourses', arrayFile([id '_saved_courses'], saved.Y));
% Save_Rmaps only controls storage in the pinned source. The port currently
% rejects it; a map replay must disable it while retaining source profiles.
item.mapReplayModel = model;
item.mapReplayModel.Save_Rmaps = false;
item.mapReplayModel.Data_Precision = kind;
if strcmp(analysis, 'cf')
    item.profiles = arrayFile([id '_profiles'], saved.ConFlds);
else
    item.profiles = arrayFile([id '_profiles'], saved.Rmaps);
    item.rawMaps = arrayFile([id '_raw_maps'], saved.Raw_Data);
    % Read the actual pre-compression cache; saved.Regs is rounded to single.
    item.regressors = arrayFile([id '_regressors'], regressors.X);
    item.savedRegressors = arrayFile([id '_saved_regressors'], saved.Regs);
    item.hrf = arrayFile([id '_hrf'], result.Model.Hrf);
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
