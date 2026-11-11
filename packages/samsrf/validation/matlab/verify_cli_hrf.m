function verify_cli_hrf(source, spmSource, planFile, resultsRoot, directRoot)
% Check the subject-HRF file route of the repaired CLI (prepare.py --cli).
% For each custom-HRF run, the saved Model.Hrf must be the column that
% samsrf_doublegamma returns for the staged parameters, and the saved maps must
% equal a direct call of the same analysis with that column passed as Model.Hrf.
addpath(genpath(source));
addpath(spmSource);
set(groot, 'defaultFigureVisible', 'off');
plan = jsondecode(fileread(planFile));
runs = plan.runs;
if isstruct(runs)
    runs = num2cell(runs);
end
assert(~isfolder(directRoot), 'Use a new directory for the direct calls');
mkdir(directRoot);
parameters = load(fullfile(plan.input, 'hrf_custom.mat'));
fP = parameters.fP;
previous = pwd;
restore = onCleanup(@() cd(previous));
checks = {};
for index = 1:numel(runs)
    item = runs{index};
    if ~isfield(item.model, 'Hrf') || ~ischar(item.model.Hrf) || ~strcmp(item.model.Hrf, 'hrf_custom')
        continue
    end
    expected = samsrf_doublegamma(item.model.TR, [fP(1:2) 1 1 fP(3) 0 32]) * fP(4);
    assert(iscolumn(expected), 'samsrf_doublegamma no longer returns a column');
    cli = load(result_file(fullfile(resultsRoot, item.id)));
    assert(iscolumn(cli.Model.Hrf), '%s saved a %s HRF', item.id, mat2str(size(cli.Model.Hrf)));
    assert(isequal(cli.Model.Hrf, expected), '%s saved a different HRF', item.id);

    % The same analysis called directly, with the column given in the model.
    work = fullfile(directRoot, item.id);
    mkdir(work);
    copyfile(fullfile(resultsRoot, item.id, 'SamSrf_defaults.json'), work);
    addpath(work);
    Model = LoadModelJson(item.argv{2});
    Model.Hrf = expected;
    [folder, name, extension] = fileparts(item.argv{3});
    cd(folder);
    Srf = samsrf_gii2srf(strrep(lower([name extension]), '.gii', ''), ...
        [plan.input '/' item.dataset '/surf/' plan.datasets.(item.dataset).hemisphere], ...
        1, option(item.argv, '-aver='), true, '');
    cd(work);
    roi = [plan.input '/' item.dataset '/roi'];
    switch item.algorithm
        case 'prf'
            samsrf_fit_prf(Model, Srf, roi);
        case 'rc'
            samsrf_revcor_prf(Model, Srf, roi);
    end
    cd(previous);
    rmpath(work);
    direct = load(result_file(work));
    same = isequaln(direct.Srf.Data, cli.Srf.Data) && strcmp(class(direct.Srf.Data), class(cli.Srf.Data));
    checks{end+1} = struct('id', item.id, 'hrfLength', numel(expected), ...
        'savedHrfIsColumn', true, 'savedHrfEqualsExpected', true, ...
        'mapsEqualDirectCall', same, 'class', class(cli.Srf.Data), ...
        'size', size(cli.Srf.Data)); %#ok<AGROW>
    assert(same, '%s maps differ from the direct call with a column HRF', item.id);
    fprintf('%s: HRF column and maps equal the direct call\n', item.id);
end
assert(numel(checks) == 4, 'Expected four custom-HRF runs, found %d', numel(checks));
file = fopen(fullfile(directRoot, 'hrf-check.json'), 'w');
fprintf(file, '%s\n', jsonencode(struct('fP', fP, 'checks', {checks}), 'PrettyPrint', true));
fclose(file);
end

function value = option(argv, name)
% The numeric value SamSrfAnalysis parses from NAME (str2double, as InputParams).
match = argv(startsWith(argv, name));
assert(numel(match) == 1, 'Missing %s', name);
value = str2double(match{1}(numel(name)+1:end));
end

function path = result_file(directory)
% The analysis result, not the search-space, regressor or staged HRF files.
files = dir(fullfile(directory, '*.mat'));
names = {files.name};
names = names(~startsWith(names, {'src_', 'reg_', 'hrf_'}));
assert(numel(names) == 1, 'Expected one result file in %s', directory);
path = fullfile(directory, names{1});
end
