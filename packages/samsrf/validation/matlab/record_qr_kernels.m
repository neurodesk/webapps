function record_qr_kernels(output, recording, smoke)
% Record the steps of MATLAB's least-squares solve through the BLAS and
% LAPACK it links. qr_kernels.c calls ?geqp3, ?ormqr/?unmqr and ?trsv
% directly, so each recorded design shows whether mldivide equals that
% chain and every intermediate the port must reproduce. The probes record
% ?gemv's summation tree (FPRev: +M and -M at two positions among ones) for
% the lengths and memory alignments the reflectors use.
%
% recording is one setting of the pinned qr-reference archive (its qr.json
% names each design's x, y, class and column order). smoke shortens the run
% for Octave plumbing checks, which are never references.
if nargin < 3, smoke = false; end
if ~isfolder(output), mkdir(output); end
assert(~isfile(fullfile(output,'kernels.json')), 'Use a fresh output directory');
here = fileparts(mfilename('fullpath'));
octave = exist('OCTAVE_VERSION','builtin') ~= 0;
previous = pwd;
restore = onCleanup(@() cd(previous));
cd(output);
if octave
    mkoctfile('--mex','-DBI=int','-o',fullfile(output,'qr_kernels.mex'),fullfile(here,'qr_kernels.c'),'-llapack','-lblas');
    interpreter = 'Octave';
    blas = 'unavailable';
else
    assert(startsWith(version, '23.2.0.3097123'), 'Reference requires R2023b Update 11');
    maxNumCompThreads(1);
    assert(maxNumCompThreads == 1, 'MATLAB did not honor the computational thread limit');
    mex('-outdir',output,fullfile(here,'qr_kernels.c'),'-lmwlapack','-lmwblas');
    interpreter = 'MATLAB';
    blas = version('-blas');
end
addpath(output);
[status, cpu] = system('lscpu');
assert(status == 0, 'Cannot record CPU provenance');
integerBytes = qr_kernels('int');
if ~octave
    assert(integerBytes == 8, 'MATLAB links the ILP64 BLAS interface');
end
environment = struct('interpreter',interpreter,'matlab',version,'computer',computer, ...
    'cpu',cpu,'blas',blas,'blasIntegerBytes',integerBytes, ...
    'githubRun',getenv('GITHUB_RUN_ID'),'githubAttempt',getenv('GITHUB_RUN_ATTEMPT'));

metadata = jsondecode(fileread(fullfile(recording,'qr.json')));
designs = metadata.cases;
if ~iscell(designs), designs = num2cell(designs); end
if smoke, designs = designs(1:min(12,numel(designs))); end
cases = cell(1,numel(designs));
for k = 1:numel(designs)
    cases{k} = record_design(recording, designs{k});
end
% Several right-hand sides in one solve, as reverse correlation's
% [Y ones] \ X and the global regression [X ones] \ Y do. Every design is
% replayed in both column orders.
multi = {};
for k = 1:numel(designs)
    for order = {'ones-first','ones-last'}
        multi{end+1} = record_multiple(recording, designs{k}, order{1}); %#ok<AGROW>
    end
end

% Summation trees of the reflector inner product. Lengths cover the
% recorded designs (250, 16) and their second steps, plus a sweep that
% exposes block sizes, peeling and tails; offsets cover 64-byte alignment.
if smoke
    lengths = [5 9];
    offsets = 0:1;
else
    lengths = [1:40 47 48 49 63 64 65 127 128 129 249 250];
    offsets = 0:7;
end
% M must exceed every partial sum of ones by more than half its spacing,
% including 250 ones added in sequence in double.
big = 2^70;
probes = {};
kinds = {'single',0; 'double',0; 'csingle',0; 'csingle',1; 'cdouble',0; 'cdouble',1};
for kk = 1:size(kinds,1)
    cls = kinds{kk,1};
    part = kinds{kk,2};
    for m = lengths
        if m < 2, continue; end
        for oa = offsets
            for ox = offsets
                if (startsWith(cls,'c') || strcmp(cls,'double')) && (oa > 3 || ox > 3)
                    continue
                end
                S = qr_kernels('probe',cls,part,m,oa,ox,big);
                id = sprintf('probe_%s_part%d_m%d_a%d_x%d',cls,part,m,oa,ox);
                probes{end+1} = struct('id',id,'class',cls,'part',part,'length',m, ... %#ok<AGROW>
                    'alignA',oa,'alignX',ox,'big',big, ...
                    'results',int_file(id,S));
            end
        end
    end
end
% ?ormqr applies the reflectors to the right-hand sides; record its tree
% for one and for several columns (reverse correlation and the global
% regression solve many at once).
ormqr = {};
if smoke
    ormqrLengths = [5 9];
    ormqrColumns = [1 3];
else
    ormqrLengths = [2:40 63 64 65 249 250];
    ormqrColumns = [1 2 3 4 8 16 33 300];
end
for kk = 1:size(kinds,1)
    cls = kinds{kk,1};
    part = kinds{kk,2};
    for m = ormqrLengths
        for nrhs = ormqrColumns
            if m > 65 || ismember(nrhs, [1 8]) || m == 16 || m == 17
                cols = unique([0 min(1,nrhs-1) nrhs-1]);
                S = qr_kernels('ormqr',cls,part,m,nrhs,cols,big);
                id = sprintf('ormqr_%s_part%d_m%d_n%d',cls,part,m,nrhs);
                ormqr{end+1} = struct('id',id,'class',cls,'part',part,'length',m, ... %#ok<AGROW>
                    'columns',nrhs,'recordedColumns',cols,'big',big,'results',int_file(id,S));
            end
        end
    end
end
write_json('kernels.json',struct('environment',environment,'smoke',smoke, ...
    'cases',{cases},'multiple',{multi},'probes',{probes},'ormqr',{ormqr}));
fprintf('Recorded %d least-squares chains and %d gemv probes (%s)\n',numel(cases),numel(probes),interpreter);
end

function item = record_design(root, d)
x = read_array(root, d.x);
y = read_array(root, d.y);
if strcmp(d.order,'ones-first')
    A = [ones(size(x)) x];
else
    A = [x ones(size(x))];
end
precision = d.precision;
y = cast(y, precision);
mldivide = A \ y;
Ac = cast(A, precision);
[~, R0, p0] = qr(Ac, 0);
item = struct('id',d.id,'precision',precision,'order',d.order, ...
    'mldivide',array_file([d.id '_mldivide'],mldivide), ...
    'qrR',array_file([d.id '_qr_r'],R0),'qrPivot',array_file([d.id '_qr_pivot'],p0));
% The chain in the class MATLAB would choose (complex when the converted
% design is complex) and, for complex-typed designs, also as real.
variants = {};
if isreal(Ac)
    variants{end+1} = 'real';
else
    variants{end+1} = 'complex';
    if ~any(imag(Ac(:)))
        variants{end+1} = 'real';
    end
end
item.chains = {};
for v = variants
    if strcmp(v{1},'complex')
        cls = ['c' precision];
    else
        cls = precision;
    end
    chain = run_chain(cls, double(real(Ac)), double(imag(Ac)), double(real(y)), double(imag(y)), precision, ~strcmp(v{1},'real'));
    tag = [d.id '_' v{1}];
    beta = complex(chain.beta, chain.betai);
    item.chains{end+1} = struct('variant',v{1},'rank',chain.rank,'tolerance',chain.tolerance, ...
        'factor',array_file([tag '_factor'],complex(chain.F,chain.Fi)), ...
        'tau',array_file([tag '_tau'],complex(chain.tau,chain.taui)), ...
        'pivot',array_file([tag '_pivot'],chain.jpvt), ...
        'qty',array_file([tag '_qty'],complex(chain.c,chain.ci)), ...
        'beta',array_file([tag '_beta'],beta), ...
        'matchesMldivide',same_values(beta,mldivide,precision), ...
        'rMatchesQr',same_values(complex(triu(chain.F(1:2,:)),triu(chain.Fi(1:2,:))),R0,precision));
end
end

function item = record_multiple(root, d, order)
x = read_array(root, d.x);
y = read_array(root, d.y);
if strcmp(order,'ones-first')
    A = [ones(size(x)) x];
else
    A = [x ones(size(x))];
end
precision = d.precision;
m = numel(y);
t = (1:m)';
columns = 8;
B = zeros(m, columns);
for j = 1:columns
    B(:,j) = y .* cos(0.37*j) + 0.25*j*sin(j*t/7);
end
B = cast(B, precision);
together = A \ B;
separately = zeros(size(together), 'like', together);
for j = 1:columns
    separately(:,j) = A \ B(:,j);
end
Ac = cast(A, precision);
complexDesign = ~isreal(Ac) && any(imag(Ac(:)));
if complexDesign
    cls = ['c' precision];
else
    cls = precision;
end
chain = run_chain(cls, double(real(Ac)), double(imag(Ac)), double(B), zeros(size(B)), precision, complexDesign);
chainTogether = complex(chain.beta, chain.betai);
chainSeparately = zeros(size(chainTogether));
for j = 1:columns
    one = run_chain(cls, double(real(Ac)), double(imag(Ac)), double(B(:,j)), zeros(m,1), precision, complexDesign);
    chainSeparately(:,j) = complex(one.beta, one.betai);
end
id = sprintf('%s_multi_%s', d.id, order);
item = struct('id',id,'design',d.id,'precision',precision,'order',order,'complex',complexDesign, ...
    'rhs',array_file([id '_rhs'],B), ...
    'together',array_file([id '_together'],together), ...
    'separately',array_file([id '_separately'],separately), ...
    'qty',array_file([id '_qty'],complex(chain.c,chain.ci)), ...
    'togetherEqualsSeparately',same_values(together,separately,precision), ...
    'chainTogetherMatches',same_values(chainTogether,together,precision), ...
    'chainSeparatelyMatches',same_values(chainSeparately,separately,precision));
end

function chain = run_chain(cls, Are, Aim, bre, bim, precision, complexDesign)
[F, Fi, tau, taui, jpvt, c, ci] = qr_kernels('factor', cls, Are, Aim, bre, bim);
[m, n] = size(Are);
R = complex(F(1:min(m,n),:), Fi(1:min(m,n),:));
factor = 1;
if complexDesign, factor = 10; end
tolerance = factor * max(m,n) * double(eps(precision)) * abs(R(1,1));
tolerance = double(cast(tolerance, precision));
rank = sum(abs(diag(R)) > tolerance);
columns = size(c,2);
x = zeros(rank,columns);
xi = zeros(rank,columns);
if rank > 0 && columns == 1
    [x, xi] = qr_kernels('trsv', cls, real(R(1:rank,1:rank)), imag(R(1:rank,1:rank)), c(1:rank), ci(1:rank));
elseif rank > 0
    [x, xi] = qr_kernels('trsm', cls, real(R(1:rank,1:rank)), imag(R(1:rank,1:rank)), c(1:rank,:), ci(1:rank,:));
end
beta = zeros(n,columns);
betai = zeros(n,columns);
beta(jpvt(1:rank),:) = x;
betai(jpvt(1:rank),:) = xi;
chain = struct('F',F,'Fi',Fi,'tau',tau,'taui',taui,'jpvt',jpvt,'c',c,'ci',ci, ...
    'beta',beta,'betai',betai,'rank',rank,'tolerance',tolerance);
end

function same = same_values(a, b, precision)
a = cast(a, precision);
b = cast(b, precision);
same = isequal(size(a),size(b)) && ...
    isequal(typecast(real(a(:)),'uint8'),typecast(real(b(:)),'uint8')) && ...
    isequal(typecast(imag(a(:)),'uint8'),typecast(imag(b(:)),'uint8'));
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
write_array(descriptor.file,real(value),'double');
if ~isreal(value)
    descriptor.imaginary = [name '.imag.f64'];
    write_array(descriptor.imaginary,imag(value),'double');
end
end

function descriptor = int_file(name,value)
% Small integer results are the FPRev counts. Anything else is kept as is,
% so the analysis can see a probe that did not behave as a tree.
if all(value(:) == round(value(:))) && all(abs(value(:)) < 32768)
    descriptor = struct('file',[name '.i16'],'shape',size(value),'class','int16');
    write_array(descriptor.file,value,'int16');
else
    descriptor = struct('file',[name '.f64'],'shape',size(value),'class','double');
    write_array(descriptor.file,value,'double');
end
end

function write_array(path,value,precision)
fid = fopen(path,'w','ieee-le');
assert(fid~=-1);
cleanup = onCleanup(@() fclose(fid));
assert(fwrite(fid,value,precision)==numel(value));
end

function write_json(file,value)
fid = fopen(file,'w');
assert(fid~=-1);
cleanup = onCleanup(@() fclose(fid));
fprintf(fid,'%s\n',jsonencode(value));
end
