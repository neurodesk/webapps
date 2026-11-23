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
% Hash the effective /input tree that MATLAB's argv reads, before and after the matrix.
[inputBeforePaths, inputBeforeHashes] = hash_tree(plan.input);
stagedRunIds = cell(1, numel(runs));
stagedRunEntries = cell(1, numel(runs));
failures = 0;
for index = 1:numel(runs)
    item = runs{index};
    directory = fullfile(resultsRoot, item.id);
    contents = dir(directory);
    names = sort({contents(~[contents.isdir]).name});
    expectedStaged = {'SamSrf_defaults.json'};
    if isfield(item.model, 'Hrf') && ischar(item.model.Hrf) && strcmp(item.model.Hrf, 'hrf_custom')
        expectedStaged = sort({'SamSrf_defaults.json', 'hrf_custom.mat'});
    end
    assert(isequal(names, expectedStaged), ...
        'Run %s was not freshly staged with its expected inputs', item.id);
    [stagedBeforeNames, stagedBeforeHashes] = hash_named_files(directory, expectedStaged);
    argv = strrep(item.argv, plan.resultsToken, directory)';
    addpath(directory);
    cd(directory);
    started = tic;
    receipt = struct('id', item.id, 'execution', 'source', 'argv', {argv}, ...
        'status', 'succeeded', 'identifier', '', 'message', '');
    try
        % The model as SamSrf reads it; a JSON vector's orientation decides how an HRF is used.
        model = LoadModelJson(argv{2});
        if isfield(model, 'Hrf')
            receipt.modelHrfSize = size(model.Hrf);
        end
        SamSrfAnalysis(argv{:});
    catch failure
        receipt.status = 'failed';
        receipt.identifier = failure.identifier;
        receipt.message = failure.message;
        receipt.stack = failure.stack;
        failures = failures + 1;
    end
    receipt.seconds = toc(started);
    cd(previous);
    rmpath(directory);
    [stagedAfterNames, stagedAfterHashes] = hash_named_files(directory, expectedStaged);
    assert(isequal(stagedBeforeNames, stagedAfterNames) && isequal(stagedBeforeHashes, stagedAfterHashes), ...
        'Run %s modified its staged input files', item.id);
    receipt.stagedInputs = containers.Map(stagedBeforeNames, stagedBeforeHashes);
    stagedRunIds{index} = item.id;
    stagedRunEntries{index} = struct('names', {stagedBeforeNames}, 'hashes', {stagedBeforeHashes});
    write_json(fullfile(receipts, [item.id '.json']), receipt);
    fprintf('%s: %s\n', item.id, receipt.status);
end
[inputAfterPaths, inputAfterHashes] = hash_tree(plan.input);
assert(isequal(inputBeforePaths, inputAfterPaths) && isequal(inputBeforeHashes, inputAfterHashes), ...
    'The source runs changed the effective input tree %s', plan.input);
write_inputs_json(fullfile(receipts, 'inputs.json'), inputBeforePaths, inputBeforeHashes, stagedRunIds, stagedRunEntries);
fprintf('Ran %d SamSrfAnalysis commands in source MATLAB; %d failed.\n', numel(runs), failures);
end

function write_json(path, value)
file = fopen(path, 'w');
assert(file >= 0, 'Cannot write %s', path);
cleanup = onCleanup(@() fclose(file));
fprintf(file, '%s\n', jsonencode(value, 'PrettyPrint', true));
end

function hex = sha256_file(path)
jpath = java.nio.file.Paths.get(path, javaArray('java.lang.String', 0));
assert(~java.nio.file.Files.isSymbolicLink(jpath), 'Symbolic links are not allowed: %s', path);
bytes = java.nio.file.Files.readAllBytes(jpath);
digest = java.security.MessageDigest.getInstance('SHA-256');
digest.update(bytes);
raw = typecast(digest.digest(), 'uint8');
hex = lower(reshape(dec2hex(raw, 2)', 1, []));
end

function [names, hashes] = hash_named_files(directory, names)
names = sort(names);
hashes = cell(1, numel(names));
for i = 1:numel(names)
    hashes{i} = sha256_file(fullfile(directory, names{i}));
end
end

function [relPaths, hashes] = hash_tree(root)
rootFile = java.io.File(root);
assert(rootFile.isDirectory(), 'Missing input root %s', root);
canonical = char(rootFile.getCanonicalPath());
relPaths = {};
hashes = {};
[relPaths, hashes] = walk_tree(canonical, '', relPaths, hashes);
[relPaths, order] = sort(relPaths);
hashes = hashes(order);
end

function [relPaths, hashes] = walk_tree(root, prefix, relPaths, hashes)
current = root;
if ~isempty(prefix)
    current = fullfile(root, prefix);
end
entries = dir(current);
for i = 1:numel(entries)
    name = entries(i).name;
    if strcmp(name, '.') || strcmp(name, '..')
        continue;
    end
    full = fullfile(current, name);
    jpath = java.nio.file.Paths.get(full, javaArray('java.lang.String', 0));
    assert(~java.nio.file.Files.isSymbolicLink(jpath), 'Symbolic links are not allowed in a pinned tree: %s', full);
    if isempty(prefix)
        rel = name;
    else
        rel = [prefix '/' name];
    end
    if entries(i).isdir
        [relPaths, hashes] = walk_tree(root, rel, relPaths, hashes);
    else
        relPaths{end+1} = rel; %#ok<AGROW>
        hashes{end+1} = sha256_file(full); %#ok<AGROW>
    end
end
end

function escaped = json_string(value)
escaped = strrep(value, '\', '\\');
escaped = strrep(escaped, '"', '\"');
escaped = ['"' escaped '"'];
end

function write_inputs_json(path, inputPaths, inputHashes, stagedRunIds, stagedRunEntries)
file = fopen(path, 'w');
assert(file >= 0, 'Cannot write %s', path);
cleanup = onCleanup(@() fclose(file));
fprintf(file, '{\n  "sha256": {\n');
for i = 1:numel(inputPaths)
    sep = ',';
    if i == numel(inputPaths), sep = ''; end
    fprintf(file, '    %s: %s%s\n', json_string(inputPaths{i}), json_string(inputHashes{i}), sep);
end
fprintf(file, '  },\n  "staged": {\n');
for i = 1:numel(stagedRunIds)
    entry = stagedRunEntries{i};
    sepRun = ',';
    if i == numel(stagedRunIds), sepRun = ''; end
    fprintf(file, '    %s: {\n', json_string(stagedRunIds{i}));
    for j = 1:numel(entry.names)
        sepFile = ',';
        if j == numel(entry.names), sepFile = ''; end
        fprintf(file, '      %s: %s%s\n', json_string(entry.names{j}), json_string(entry.hashes{j}), sepFile);
    end
    fprintf(file, '    }%s\n', sepRun);
end
fprintf(file, '  },\n  "unchanged": true\n}\n');
end
