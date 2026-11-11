function record_qr_backends(output, label, diagnostics)
% Record MATLAB's least-squares solves under one MKL configuration.
% Each call runs in a fresh MATLAB process whose MKL variables were set
% before startup. The comparison of several calls shows which coefficient
% bits depend on the BLAS backend rather than on the algorithm.
if nargin < 3, diagnostics = ''; end
if ~isfolder(output), mkdir(output); end
assert(~isfile(fullfile(output,'qr.json')), 'Use a fresh output directory');
previous = pwd;
restore = onCleanup(@() cd(previous));
cd(output);
% Octave runs only check the recorder's plumbing; compare-qr-backends.mjs
% rejects them as references.
octave = exist('OCTAVE_VERSION','builtin') ~= 0;
blas = 'unavailable';
lapack = 'unavailable';
threads = 1;
if ~octave
    assert(startsWith(version, '23.2.0.3097123'), 'Reference requires R2023b Update 11');
    maxNumCompThreads(1);
    threads = maxNumCompThreads;
    assert(threads == 1, 'MATLAB did not honor the computational thread limit');
    blas = version('-blas');
    lapack = version('-lapack');
end
[status, cpu] = system('lscpu');
assert(status == 0, 'Cannot record CPU provenance');
names = {'MKL_CBWR','MKL_ENABLE_INSTRUCTIONS','MKL_NUM_THREADS','OMP_NUM_THREADS', ...
    'MKL_DYNAMIC','OMP_DYNAMIC','MKL_DEBUG_CPU_TYPE'};
variables = struct();
for k = 1:numel(names)
    variables.(names{k}) = getenv(names{k});
end
interpreter = 'MATLAB';
if octave, interpreter = 'Octave'; end
environment = struct('label',label,'interpreter',interpreter,'matlab',version, ...
    'computer',computer,'cpu',cpu,'blas',blas,'lapack',lapack, ...
    'maxComputationalThreads',threads,'processEnvironment',variables, ...
    'githubRun',getenv('GITHUB_RUN_ID'),'githubAttempt',getenv('GITHUB_RUN_ATTEMPT'));
designs = synthetic_designs();
if ~isempty(diagnostics)
    designs = [designs recorded_designs(diagnostics)];
end
cases = cell(1, numel(designs));
for k = 1:numel(designs)
    cases{k} = record_case(designs{k});
end
write_json('qr.json',struct('environment',environment,'cases',{cases}));
fprintf('Recorded %d least-squares cases (%s)\n', numel(cases), label);
end

function designs = synthetic_designs()
designs = {};
kinds = {'single','double'};
t = (1:250)';
% The original scale and complexity sweep of record_css_diagnostics.
for kind = kinds
    for scale = 10.^(-10:2:10)
        for imaginary = [0 1e-50 0.3]
            designs{end+1} = design(sprintf('glm_%s_%g_%g',kind{1},scale,imaginary), ... %#ok<AGROW>
                kind{1},'ones-first',scale*(sin(t)+1i*imaginary*cos(t)),2*sin(t)+3);
        end
    end
end
% The rank boundary sweep at both run lengths.
for kind = kinds
    if strcmp(kind{1},'single')
        exponents = [-4 -3.5 -3 -2.5 -2 2 2.5 3 3.5 4];
    else
        exponents = [-10 -9 -8 -7 -6 6 7 8 9 10];
    end
    for volumes = [16 250]
        s = (1:volumes)';
        for exponent = exponents
            for imaginary = [0 0.3]
                designs{end+1} = design(sprintf('rank_%s_n%d_e%g_i%g',kind{1},volumes,exponent,imaginary), ... %#ok<AGROW>
                    kind{1},'ones-first',10^exponent*(sin(s)+1i*imaginary*cos(s)),2*sin(s)+3);
            end
        end
    end
end
% Constant, nearly constant and zero predictions.
for kind = kinds
    for level = [0 1e-3 1 1e3]
        designs{end+1} = design(sprintf('constant_%s_%g',kind{1},level), ... %#ok<AGROW>
            kind{1},'ones-first',level*ones(size(t)),2*sin(t)+3);
    end
    for spread = [1e-12 1e-9 1e-7 1e-5 1e-3]
        designs{end+1} = design(sprintf('nearly_constant_%s_%g',kind{1},spread), ... %#ok<AGROW>
            kind{1},'ones-first',1+spread*sin(t),2*sin(t)+3);
    end
end
% Imaginary parts that are subnormal or vanish in one class only.
for kind = kinds
    for imaginary = [1e-40 1e-46 1e-310]
        designs{end+1} = design(sprintf('imaginary_%s_%g',kind{1},imaginary), ... %#ok<AGROW>
            kind{1},'ones-first',sin(t)+1i*imaginary*cos(t),2*sin(t)+3);
    end
end
% Scales whose squares overflow or underflow, and the reverse column order.
extremes = struct('single',[1e-30 1e-20 1e20 1e30],'double',[1e-300 1e-160 1e155 1e300]);
for kind = kinds
    for scale = extremes.(kind{1})
        for imaginary = [0 0.3]
            designs{end+1} = design(sprintf('extreme_%s_%g_%g',kind{1},scale,imaginary), ... %#ok<AGROW>
                kind{1},'ones-first',scale*(sin(t)+1i*imaginary*cos(t)),2*sin(t)+3);
        end
    end
    for scale = [1e-4 1 1e4]
        designs{end+1} = design(sprintf('ones_last_%s_%g',kind{1},scale), ... %#ok<AGROW>
            kind{1},'ones-last',scale*sin(t),2*sin(t)+3);
    end
end
% Irregular full-rank designs. The recorded x and y, not these formulas,
% are the inputs of every comparison.
for kind = kinds
    for k = 1:24
        scale = 10^(mod(0.7*k,4)-2);
        x = scale*(sin(sqrt(2)*k*t) + 0.5*cos(sqrt(3)*t/k));
        if mod(k,3) == 0
            x = x + 1i*scale*0.2*sin(sqrt(7)*k*t);
        end
        y = 0.5*sin(sqrt(5)*k*t + k) + 0.3*abs(x).^2/scale^2 + mod(1.3*k,3) - 1;
        designs{end+1} = design(sprintf('random_%s_%d',kind{1},k), ... %#ok<AGROW>
            kind{1},'ones-first',x,y);
    end
end
end

function designs = recorded_designs(root)
% Replay the full-pipeline CSS regressions already pinned with MATLAB's own
% predictions and observations.
metadata = jsondecode(fileread(fullfile(root,'diagnostics.json')));
designs = {};
for k = 1:numel(metadata.cases)
    item = metadata.cases{k};
    if ~strcmp(item.kind,'css-trace') || ~strcmp(item.regressionStatus,'recorded')
        continue
    end
    designs{end+1} = design(['trace_' item.id(numel('css_pipeline_')+1:end)], ... %#ok<AGROW>
        item.precision,'ones-first',read_array(root,item.prediction),read_array(root,item.observations));
end
end

function value = design(id, kind, order, x, y)
value = struct('id',id,'precision',kind,'order',order,'x',x,'y',y);
end

function item = record_case(d)
y = cast(d.y, d.precision);
if strcmp(d.order,'ones-first')
    A = [ones(size(d.x)) d.x];
else
    A = [d.x ones(size(d.x))];
end
% The rank warning reports MATLAB's tolerance; keep it enabled so
% lastwarn records it.
lastwarn('');
beta = A \ y;
[warningMessage, warningId] = lastwarn;
uniform = cast(A, d.precision) \ y;
% Q'*y as qr applies the reflectors, without forming Q. Not every
% interpreter accepts a right-hand side for a full matrix.
try
    [C, R, p] = qr(cast(A, d.precision), y, 0);
    rhsError = '';
catch failure
    C = [];
    R = [];
    p = [];
    rhsError = failure.message;
end
[~, R0, p0] = qr(cast(A, d.precision), 0);
id = d.id;
item = struct('id',id,'precision',d.precision,'order',d.order, ...
    'x',array_file([id '_x'],d.x), ...
    'y',array_file([id '_y'],y), ...
    'beta',array_file([id '_beta'],beta), ...
    'uniformMatches',same_bytes(beta,uniform), ...
    'c',array_file([id '_c'],C), ...
    'r',array_file([id '_r'],R), ...
    'pivot',array_file([id '_pivot'],p), ...
    'rhsError',rhsError, ...
    'rWithoutRhs',array_file([id '_r0'],R0), ...
    'pivotWithoutRhs',array_file([id '_pivot0'],p0), ...
    'warning',warningMessage,'warningId',warningId);
end

function value = read_array(root, descriptor)
fid = fopen(fullfile(root,descriptor.file),'r','ieee-le');
assert(fid~=-1);
cleanup = onCleanup(@() fclose(fid));
value = reshape(fread(fid,Inf,'double'),descriptor.shape(:)');
if isfield(descriptor,'imaginary') && ~isempty(descriptor.imaginary)
    fid2 = fopen(fullfile(root,descriptor.imaginary),'r','ieee-le');
    assert(fid2~=-1);
    cleanup2 = onCleanup(@() fclose(fid2));
    value = complex(value, reshape(fread(fid2,Inf,'double'),descriptor.shape(:)'));
end
end

function descriptor = array_file(name,value)
descriptor = struct('file',[name '.f64'],'shape',size(value),'class',class(value),'imaginary','');
write_array(descriptor.file,real(value));
if ~isreal(value)
    descriptor.imaginary = [name '.imag.f64'];
    write_array(descriptor.imaginary,imag(value));
end
end

function write_array(path,value)
fid = fopen(path,'w','ieee-le');
assert(fid~=-1);
cleanup = onCleanup(@() fclose(fid));
assert(fwrite(fid,double(value),'double')==numel(value));
end

function write_json(file,value)
fid = fopen(file,'w');
assert(fid~=-1);
cleanup = onCleanup(@() fclose(fid));
fprintf(fid,'%s\n',jsonencode(value,'PrettyPrint',true));
end

function same = same_bytes(a,b)
same = strcmp(class(a),class(b)) && isequal(size(a),size(b)) && ...
    isreal(a) == isreal(b) && ...
    isequal(typecast(real(a(:)),'uint8'),typecast(real(b(:)),'uint8')) && ...
    isequal(typecast(imag(a(:)),'uint8'),typecast(imag(b(:)),'uint8'));
end
