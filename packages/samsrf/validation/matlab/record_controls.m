function record_controls(output, request)
% Record the MKL controls in effect in this MATLAB process, as pre-registered
% in controls-preregistration.md. request names the environment the
% workflow set ('documented', 'none' or 'contrast'). Nothing here changes
% MKL's settings: mkl_controls.c only reads them.
if ~isfolder(output), mkdir(output); end
assert(~isfile(fullfile(output,'controls.json')), 'Use a fresh output directory');
assert(startsWith(version, '23.2.0.3097123'), 'Reference requires R2023b Update 11');
here = fileparts(mfilename('fullpath'));
previous = pwd;
restore = onCleanup(@() cd(previous));
cd(output);
mex('-outdir',output,fullfile(here,'mkl_controls.c'),'-ldl');
mex('-outdir',output,fullfile(here,'qr_kernels.c'),'-lmwlapack','-lmwblas');
addpath(output);
names = {'MKL_CBWR','MKL_NUM_THREADS','OMP_NUM_THREADS','MKL_DYNAMIC','OMP_DYNAMIC'};
requested = struct();
for k = 1:numel(names)
    requested.(names{k}) = getenv(names{k});
end
mklPath = fullfile(matlabroot,'bin',computer('arch'),'mkl.so');
[status, cpu] = system('lscpu');
assert(status == 0, 'Cannot record CPU provenance');
maps = fileread('/proc/self/maps');
lines = splitlines(maps);
libraries = unique(regexp(strjoin(lines(contains(lines, {'mkl','iomp','gomp','blas','lapack'})), newline), '/\S+', 'match'));
partial = struct('request',request,'requested',requested,'matlab',version, ...
    'blas',version('-blas'),'lapack',version('-lapack'),'mklPath',mklPath, ...
    'libraries',{libraries},'cpu',cpu, ...
    'githubRun',getenv('GITHUB_RUN_ID'),'githubAttempt',getenv('GITHUB_RUN_ATTEMPT'), ...
    'receipts',struct());
% Each control is read by its own MEX call, and the partial receipt is
% written before every call: a crash leaves what was observed and names the
% call that failed (lastControl).
threadsBefore = maxNumCompThreads;
partial.maxNumCompThreadsBefore = threadsBefore;
partial.receipts.atStart = read_controls(mklPath, 'atStart', partial);
maxNumCompThreads(1);
threadsAfter = maxNumCompThreads;
partial.maxNumCompThreadsAfter = threadsAfter;
partial.receipts.afterThreadLimit = read_controls(mklPath, 'afterThreadLimit', partial);
% One BLAS call, so a lazily initialised MKL has initialised.
x = ones(64,1); %#ok<NASGU>
y = x' * x; %#ok<NASGU>
partial.receipts.afterBlasCall = read_controls(mklPath, 'afterBlasCall', partial);
receipts = partial.receipts;
probes = {};
big = 2^70;
for cls = {'double','single'}
    for m = [64 250]
        S = qr_kernels('probe', cls{1}, 0, m, 0, 0, big);
        id = sprintf('probe_%s_m%d', cls{1}, m);
        write_array([id '.f64'], double(S));
        probes{end+1} = struct('id',id,'class',cls{1},'part',0,'length',m,'alignA',0,'alignX',0,'big',big, ...
            'results',struct('file',[id '.f64'],'shape',size(S))); %#ok<AGROW>
    end
end
result = struct('request',request,'requested',requested,'matlab',version, ...
    'blas',version('-blas'),'lapack',version('-lapack'),'mklPath',mklPath, ...
    'maxNumCompThreadsBefore',threadsBefore,'maxNumCompThreadsAfter',threadsAfter, ...
    'receipts',receipts,'libraries',{libraries},'cpu',cpu, ...
    'githubRun',getenv('GITHUB_RUN_ID'),'githubAttempt',getenv('GITHUB_RUN_ATTEMPT'), ...
    'probes',{probes});
file = fopen('controls.json','w');
fprintf(file, '%s\n', jsonencode(result, 'PrettyPrint', true));
fclose(file);
fprintf('Recorded MKL controls under request %s\n', request);
end

function out = read_controls(mklPath, stage, partial)
controls = {'cbwrBranch','cbwrAutoBranch','mklMaxThreads','mklDynamic','ompMaxThreads','ompDynamic','version'};
out = struct();
for k = 1:numel(controls)
    partial.receipts.(stage) = out;
    partial.lastControl = [stage '.' controls{k}];
    write_json('controls-partial.json', partial);
    [value, symbol] = mkl_controls(mklPath, controls{k});
    out.(controls{k}) = struct('value', value, 'symbol', symbol);
end
end

function write_json(name, value)
file = fopen(name, 'w');
fprintf(file, '%s\n', jsonencode(value, 'PrettyPrint', true));
fclose(file);
end

function write_array(name, value)
file = fopen(name, 'w', 'ieee-le');
fwrite(file, value(:), 'double');
fclose(file);
end
