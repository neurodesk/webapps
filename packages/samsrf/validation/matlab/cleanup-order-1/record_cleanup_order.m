function record_cleanup_order(outputDirectory, repeat)
% One invocation is one fresh MATLAB process. Workflow calls this twice.
assert(isequal(repeat, 1) || isequal(repeat, 2));
here = fileparts(mfilename('fullpath'));
repo = fileparts(fileparts(fileparts(fileparts(fileparts(here)))));
context = jsondecode(fileread(fullfile(outputDirectory, 'context.json')));
assert(strcmp(context.contract_sha256, fileHash(fullfile(here, 'contract.json'))));
for i = 1:numel(context.source_files)
    entry = context.source_files(i);
    assert(strcmp(entry.sha256, fileHash(fullfile(repo, entry.path))));
end
inputFile = fullfile(here, 'inputs.tsv');
assert(strcmp(context.input_sha256, fileHash(inputFile)));
fid = fopen(inputFile, 'r');
assert(fid >= 0);
closeInput = onCleanup(@() fclose(fid));
inputs = {};
line = fgetl(fid);
while ischar(line)
    fields = strsplit(line, sprintf('\t'));
    assert(numel(fields) == 2);
    hex = strsplit(strtrim(fields{2}));
    assert(mod(numel(hex), 2) == 0);
    values = hex2num(char(hex));
    inputs{end + 1} = struct('id', fields{1}, 'P', reshape(values, 2, []).'); %#ok<AGROW>
    line = fgetl(fid);
end
assert(numel(inputs) == 7);
ids = cellfun(@(x) x.id, inputs, 'UniformOutput', false);
assert(numel(unique(ids)) == 7);
[cpuStatus, cpuReport] = system('LC_ALL=C lscpu');
assert(cpuStatus == 0);
keys = {'MKL_CBWR', 'MKL_NUM_THREADS', 'OMP_NUM_THREADS', 'MKL_DYNAMIC', 'OMP_DYNAMIC'};
environment = struct();
for i = 1:numel(keys)
    environment.(keys{i}) = getenv(keys{i});
end
metadata = struct('matlab_version', version, 'release', version('-release'), ...
    'computer', computer, 'blas', strtrim(version('-blas')), ...
    'threads', maxNumCompThreads, 'environment', environment, ...
    'cpu_report', cpuReport, 'process_id', feature('getpid'), ...
    'process_nonce', char(java.util.UUID.randomUUID()));
results = {};
for i = 1:numel(inputs)
    item = inputs{i};
    lastwarn('', '');
    shape = polyshape(item.P);
    hull = convhull(shape);
    [cx, cy] = centroid(hull);
    [warningMessage, warningId] = lastwarn;
    results{end + 1} = struct('id', item.id, 'points', arrayBits(item.P), ...
        'shape', arrayBits(shape.Vertices), 'hull', arrayBits(hull.Vertices), ...
        'estimate', arrayBits([cx cy area(hull)]), ...
        'warning_id', warningId, 'warning_message', warningMessage); %#ok<AGROW>
end
recording = struct('schema', 1, 'repeat', repeat, 'context', context, ...
    'metadata', metadata, 'cases', {results});
outputFile = fullfile(outputDirectory, sprintf('record-%d.json', repeat));
assert(~isfile(outputFile), 'Never overwrite a prior process recording');
fidOut = fopen(outputFile, 'w');
assert(fidOut >= 0);
closeOutput = onCleanup(@() fclose(fidOut));
fprintf(fidOut, '%s\n', jsonencode(recording));
end

function out = arrayBits(A)
assert(isa(A, 'double') && isreal(A) && ismatrix(A));
out = struct('class', 'double', 'shape', size(A), ...
    'bits', {cellstr(num2hex(A(:)))});
end

function hex = fileHash(path)
fid = fopen(path, 'rb');
assert(fid >= 0);
closeFile = onCleanup(@() fclose(fid));
bytes = fread(fid, Inf, '*uint8');
md = java.security.MessageDigest.getInstance('SHA-256');
md.update(bytes);
value = typecast(md.digest(), 'uint8');
hex = lower(reshape(dec2hex(value, 2).', 1, []));
end
