function prepare_cli_bundle(source, spmSource, matrixInput, bundle, planFile)
% Build the read-only inputs that source MATLAB and the compiled CLI share.
% Every derived input (labels, Benson templates, vectorised apertures, the
% custom HRF parameters) is computed once here, so neither execution writes beside its
% inputs. cli_plan.py models then writes the model JSON files.
assert(~isfolder(bundle), 'Use a new bundle directory');
mkdir(bundle);
addpath(genpath(source));
addpath(spmSource);
plan = jsondecode(fileread(planFile));
manifest = jsondecode(fileread(fullfile(matrixInput, 'manifest.json')));
datasets = manifest.datasets;
if isstruct(datasets)
    datasets = num2cell(datasets);
end
defaults = jsondecode(fileread(fullfile(source, 'SamSrf_defaults.json')));
copyfile(fullfile(source, 'SamSrf_defaults.json'), fullfile(bundle, 'SamSrf_defaults.json'));
work = [bundle '-work'];
assert(~isfolder(work), 'Use a new bundle directory');
mkdir(work);
previous = pwd;
restore = onCleanup(@() cd(previous));
for name = fieldnames(plan.datasets)'
    id = name{1};
    dataset = datasets{cellfun(@(item) strcmp(item.id, id), datasets)};
    hemisphere = plan.datasets.(id).hemisphere;
    assert(strcmp(dataset.hemisphere, hemisphere), 'Plan and input hemispheres differ');
    from = fullfile(matrixInput, id);
    to = fullfile(bundle, id);
    mkdir(to);
    files = cell(1, numel(dataset.runs));
    for run = 1:numel(dataset.runs)
        % SamSrfAnalysis lowercases its data wildcard before listing files.
        files{run} = fullfile(to, lower(dataset.runs{run}));
        copyfile(fullfile(from, dataset.runs{run}), files{run});
    end
    copyfile(fullfile(from, 'surf'), fullfile(to, 'surf'));
    copyfile(fullfile(from, [hemisphere '_benson.gii']), fullfile(to, [hemisphere '_benson.gii']));
    for precision = {'double', 'single'}
        kind = precision{1};
        defaults.def_64bit = strcmp(kind, 'double');
        write_json(fullfile(work, 'SamSrf_defaults.json'), defaults);
        cd(work);
        if strcmp(kind, 'double')
            % Same ROI and seed rule as record_revcor_matrix.m.
            Srf = samsrf_gii2srf(files, fullfile(to, 'surf', hemisphere), 1, true, true, '');
            count = size(Srf.Data, 2);
            roi = unique([1:12 25 count-7:count]);
            seed = 2:2:18;
            assert(any(ismember(seed, roi)) && any(~ismember(seed, roi)));
            samsrf_srf2label(Srf, fullfile(to, 'roi'), 1, roi);
            samsrf_srf2label(Srf, fullfile(to, 'seed'), 1, seed);
        end
        samsrf_benson2srf(fullfile(to, [hemisphere '_benson']), fullfile(to, 'surf'), '');
        template = load(fullfile(work, [hemisphere '_benson.mat']));
        assert(strcmp(class(template.Srf.Data), kind), 'Template precision was not honored');
        movefile(fullfile(work, [hemisphere '_benson.mat']), ...
            fullfile(to, sprintf('%s_benson_%s.mat', hemisphere, kind)));
        cd(previous);
    end
end
apertures = fullfile(bundle, 'apertures');
mkdir(apertures);
original = load(fullfile(matrixInput, 'aps_Bars.mat'));
ApFrm = original.ApFrm;
save(fullfile(apertures, 'aps_bars.mat'), 'ApFrm', '-v7');
VectoriseApertures(fullfile(apertures, 'aps_bars'));
ApFrm = repmat(original.ApFrm, 1, 1, plan.datasets.x001_lh.runs);
save(fullfile(work, 'aps_bars6.mat'), 'ApFrm', '-v7');
VectoriseApertures(fullfile(work, 'aps_bars6'));
movefile(fullfile(work, 'aps_bars6_vec.mat'), fullfile(apertures, 'aps_bars6_vec.mat'));
% SamSrf's subject-HRF file: doublegamma(TR, [fP(1:2) 1 1 fP(3) 0 32]) * fP(4).
% Latencies, ratio and scale differ from the SPM canonical [6 16 1 1 6 0 32].
fP = [5 15 5 0.9];
save(fullfile(bundle, 'hrf_custom.mat'), 'fP', '-v7');
rmdir(work, 's');
fprintf('Prepared the SamSrfAnalysis bundle in %s\n', bundle);
end

function write_json(path, value)
file = fopen(path, 'w');
assert(file >= 0, 'Cannot write %s', path);
fprintf(file, '%s\n', jsonencode(value, 'PrettyPrint', true));
fclose(file);
end
