function run_source_cli(source, spmSource, planFile, resultsRoot)
% Run each staged SamSrfAnalysis command in source MATLAB.
% The compiled application reads SamSrf_defaults.json from its starting
% directory even after it changes folders. Source MATLAB resolves the same
% relative name in the current folder and then on the path, so each run's
% directory is placed first on the path for the duration of that run.
addpath(genpath(source));
addpath(spmSource);
set(groot, 'defaultFigureVisible', 'off');
plan = jsondecode(fileread(planFile));
runs = plan.runs;
if isstruct(runs)
    runs = num2cell(runs);
end
receipts = fullfile(resultsRoot, 'receipts');
assert(~isfolder(receipts), 'Use freshly staged result directories');
mkdir(receipts);
previous = pwd;
restore = onCleanup(@() cd(previous));
% capture_environment.py wrote the execution requests into resultsRoot.
cd(resultsRoot);
write_json(fullfile(receipts, 'environment.json'), reference_environment('source-samsrfanalysis-cli'));
cd(previous);
failures = 0;
for index = 1:numel(runs)
    item = runs{index};
    directory = fullfile(resultsRoot, item.id);
    contents = dir(directory);
    assert(isequal(sort({contents(~[contents.isdir]).name}), {'SamSrf_defaults.json'}), ...
        'Run %s was not freshly staged', item.id);
    argv = strrep(item.argv, plan.resultsToken, directory)';
    addpath(directory);
    cd(directory);
    started = tic;
    receipt = struct('id', item.id, 'execution', 'source', 'argv', {argv}, ...
        'status', 'succeeded', 'identifier', '', 'message', '');
    try
        SamSrfAnalysis(argv{:});
    catch failure
        receipt.status = 'failed';
        receipt.identifier = failure.identifier;
        receipt.message = failure.message;
        failures = failures + 1;
    end
    receipt.seconds = toc(started);
    cd(previous);
    rmpath(directory);
    write_json(fullfile(receipts, [item.id '.json']), receipt);
    fprintf('%s: %s\n', item.id, receipt.status);
end
fprintf('Ran %d SamSrfAnalysis commands in source MATLAB; %d failed.\n', numel(runs), failures);
end

function write_json(path, value)
file = fopen(path, 'w');
assert(file >= 0, 'Cannot write %s', path);
fprintf(file, '%s\n', jsonencode(value, 'PrettyPrint', true));
fclose(file);
end
