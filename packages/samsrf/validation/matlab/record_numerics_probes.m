function record_numerics_probes(source, output, sections, branch)
% Record MATLAB's results for the operations inside SamSrf's double CSS
% objective and HRF, on generated inputs, so each can be compared alone.
% sections: cell array of 'elementary','power','conv','hrf','blas','gampdf',
% 'conv-short' (default all).
% branch: the MKL_CBWR value requested before MATLAB started (default COMPATIBLE).
if nargin < 3 || isempty(sections)
    sections = {'elementary','power','conv','hrf','blas','gampdf','conv-short'};
end
if nargin < 4
    branch = 'COMPATIBLE';
end
addpath(genpath(source));
if ~isfolder(output), mkdir(output); end
assert(~isfile(fullfile(output,'numerics.json')), 'Use a fresh probe directory');
previous = pwd;
restore = onCleanup(@() cd(previous));
cd(output);
environment = reference_environment('numerics-probes', branch);
cases = {};
if any(strcmp(sections,'elementary'))
    rng(730,'twister');
    x = [linspace(-745,709,4001)'; -50*rand(4000,1); 1e-9*(rand(500,1)-0.5); -1e3*abs(randn(1000,1))];
    cases{end+1} = unary_case('exp_double', x, exp(x));
    x = [exp(linspace(-740,700,4001))'; 0.5 + 1.5*rand(4000,1); 1e-300*rand(500,1); realmin*rand(200,1)];
    cases{end+1} = unary_case('log_double', x, log(x));
    x = [linspace(-10,10,4001)'; pi*(2*rand(4000,1)-1); 1e6*(2*rand(500,1)-1)];
    cases{end+1} = unary_case('sin_double', x, sin(x));
    cases{end+1} = unary_case('cos_double', x, cos(x));
    base = exp(600*(rand(4000,1)-0.5));
    exponent = [10*(rand(2000,1)-0.5); 400*(rand(2000,1)-0.5)];
    cases{end+1} = struct('id','pow_double','kind','binary', ...
        'base',array_file('pow_double_base',base), ...
        'exponent',array_file('pow_double_exponent',exponent), ...
        'result',array_file('pow_double_result',base.^exponent));
end
if any(strcmp(sections,'power'))
    rng(731,'twister');
    % SamSrf raises a vector of responses to one scalar exponent.
    bases = -[exp(linspace(-745,60,300))'; rand(100,1); 1e-300*rand(50,1); 4.9406564584124654e-324*(1:20)'];
    exponents = [0.5 0.0352 0.2187 -0.0176 0.999 1.3442 1.9249 2.2059 2.5 3.0008 3.4762 4.0329 ...
        5.5 7.25 15.3 168.389 177.79 -0.5 -1.5 -2.75 -3.25 -10.4 2 3 4 7 -2 -3];
    for k = 1:numel(exponents)
        id = sprintf('power_%02d',k);
        values = [bases; abs(bases(1:20)); 0; NaN] .^ exponents(k);
        cases{end+1} = struct('id',id,'kind','power','exponent',exponents(k), ...
            'base',array_file([id '_base'],[bases; abs(bases(1:20)); 0; NaN]), ...
            'isreal',isreal(values),'result',array_file([id '_result'],values)); %#ok<AGROW>
    end
end
if any(strcmp(sections,'conv'))
    rng(732,'twister');
    lengths = [16 33 64 100 249 250 251 400 1000];
    taps = [1 2 5 8 9 17 24 25 33 49 65 129];
    for n = lengths
        for h = taps
            kernel = randn(h,1);
            y = randn(n,1);
            cases{end+1} = conv_case(sprintf('conv_real_n%d_h%d',n,h), y, kernel); %#ok<AGROW>
            z = randn(n,1) + 1i*randn(n,1);
            cases{end+1} = conv_case(sprintf('conv_complex_n%d_h%d',n,h), z, kernel); %#ok<AGROW>
        end
    end
    % Sparse inputs: nonzero counts around a quarter of the samples.
    for n = [100 250 1000]
        kernel = randn(33,1);
        for nonzero = unique(round(n/4) + (-6:6))
            for kind = {'real','complex'}
                y = zeros(n,1);
                where = randperm(n,nonzero);
                if strcmp(kind{1},'real')
                    y(where) = randn(nonzero,1);
                else
                    y = complex(y);
                    y(where) = randn(nonzero,1) + 1i*randn(nonzero,1);
                end
                cases{end+1} = conv_case(sprintf('conv_%s_n%d_nnz%d',kind{1},n,nonzero), y, kernel); %#ok<AGROW>
            end
        end
    end
end
if any(strcmp(sections,'hrf'))
    shapes = [6 16 5.5278 16.8621 6/1.0205 16.8621/1.466 0.5 1 1.5 2 3.7 12 12.5 25 171.6];
    cases{end+1} = struct('id','gammaln_double','kind','unary', ...
        'input',array_file('gammaln_double_input',shapes'), ...
        'result',array_file('gammaln_double_result',gammaln(shapes')));
    for tr = [0.5 1 1.5 2 2.5 3]
        id = strrep(sprintf('hrf_tr%g',tr),'.','p');
        p = [6 16 1 1 6 0 32];
        L = length((p(6):p(7)/tr) * 16 + 1);
        T = linspace(p(6), p(7), L);
        canonical = samsrf_doublegamma(tr, p);
        params = [5.5278, 16.8621, 1.0205, 1.466];
        haas = samsrf_doublegamma(tr, [params(1:2) 1 1 params(3) 0 32]);
        cases{end+1} = struct('id',id,'kind','hrf','tr',tr, ...
            'time',array_file([id '_time'],T), ...
            'canonicalG1',array_file([id '_canonical_g1'],gampdf(T,6,1)), ...
            'canonicalG2',array_file([id '_canonical_g2'],gampdf(T,16,1)), ...
            'haasG1',array_file([id '_haas_g1'],gampdf(T,params(1),1)), ...
            'haasG2',array_file([id '_haas_g2'],gampdf(T,params(2),1)), ...
            'canonical',array_file([id '_canonical'],canonical), ...
            'canonicalSum',array_file([id '_canonical_sum'],sum(canonical)), ...
            'haas',array_file([id '_haas'],haas), ...
            'samsrfHrf',array_file([id '_samsrf_hrf'],samsrf_hrf(tr))); %#ok<AGROW>
    end
end
if any(strcmp(sections,'gampdf'))
    % gampdf beside candidate formulas evaluated by MATLAB itself, so a
    % formula is identified by bitwise equality rather than by a port.
    rng(734,'twister');
    shapes = [6 16 5.5278 16.8621 2.5 1 0.7 30.3 100.1];
    scales = [1 1.0205 0.5 2];
    x = unique([linspace(0,32,33) linspace(0,32,65) linspace(0,32,22) 40*rand(1,200) 1e-3*rand(1,20)]);
    for a = shapes
        for b = scales
            id = strrep(sprintf('gampdf_a%g_b%g',a,b),'.','p');
            z = x ./ b;
            cases{end+1} = struct('id',id,'kind','gampdf','a',a,'b',b, ...
                'x',array_file([id '_x'],x), ...
                'gampdf',array_file([id '_gampdf'],gampdf(x,a,b)), ...
                'pdf',array_file([id '_pdf'],pdf('Gamma',x,a,b)), ...
                'logz',array_file([id '_logz'],log(z)), ...
                'gammaln',array_file([id '_gammaln'],gammaln(a)), ...
                'gamma',array_file([id '_gamma'],gamma(a)), ...
                'c1',array_file([id '_c1'],exp((a-1).*log(z) - z - gammaln(a)) ./ b), ...
                'c2',array_file([id '_c2'],exp(-gammaln(a) + (a-1).*log(z) - z) ./ b), ...
                'c3',array_file([id '_c3'],z.^(a-1) .* exp(-z) ./ gamma(a) ./ b), ...
                'c4',array_file([id '_c4'],exp((a-1).*log(x) - x./b - gammaln(a) - a.*log(b))), ...
                'c5',array_file([id '_c5'],exp(-gammaln(a) - z + (a-1).*log(z)) ./ b), ...
                'c6',array_file([id '_c6'],exp((a-1).*log(z) - z - gammaln(a) - log(b)))); %#ok<AGROW>
        end
    end
end
if any(strcmp(sections,'conv-short'))
    % Short courses and kernels around the kernel switches.
    rng(735,'twister');
    for n = [9:40 48 63 64 65]
        for h = [2:12 16 24 33]
            kernel = randn(h,1);
            y = randn(n,1);
            cases{end+1} = conv_case(sprintf('convs_real_n%d_h%d',n,h), y, kernel); %#ok<AGROW>
            z = randn(n,1) + 1i*randn(n,1);
            cases{end+1} = conv_case(sprintf('convs_complex_n%d_h%d',n,h), z, kernel); %#ok<AGROW>
        end
    end
    % Sparse complex courses of several lengths.
    for n = [300 500 600 800 1000 1032 1200 2000]
        kernel = randn(33,1);
        nonzero = floor(n/5);
        z = complex(zeros(n,1));
        where = randperm(n,nonzero);
        z(where) = randn(nonzero,1) + 1i*randn(nonzero,1);
        cases{end+1} = conv_case(sprintf('convs_sparse_complex_n%d',n), z, kernel); %#ok<AGROW>
        y = zeros(n,1);
        y(where) = randn(nonzero,1);
        cases{end+1} = conv_case(sprintf('convs_sparse_real_n%d',n), y, kernel); %#ok<AGROW>
    end
end
if any(strcmp(sections,'blas'))
    rng(733,'twister');
    for n = [1:20 33 64 250 1000]
        x = randn(n,1) .* exp(3*randn(n,1));
        y = randn(n,1);
        z = x + 1i*randn(n,1);
        id = sprintf('blas_n%d',n);
        cases{end+1} = struct('id',id,'kind','blas', ...
            'x',array_file([id '_x'],x),'y',array_file([id '_y'],y),'z',array_file([id '_z'],z), ...
            'dot',array_file([id '_dot'],x'*y),'complexDot',array_file([id '_complex_dot'],z'*y), ...
            'norm',array_file([id '_norm'],norm(x)),'complexNorm',array_file([id '_complex_norm'],norm(z)), ...
            'corr',array_file([id '_corr'],corr(z,y))); %#ok<AGROW>
    end
end
write_json('numerics.json',struct('environment',environment,'sections',{sections},'cases',{cases}));
fprintf('Recorded %d numerical probe cases\n', numel(cases));
end

function item = unary_case(id, input, result)
item = struct('id',id,'kind','unary','input',array_file([id '_input'],input), ...
    'result',array_file([id '_result'],result));
end

function item = conv_case(id, y, kernel)
item = struct('id',id,'kind','conv','isreal',isreal(y), ...
    'y',array_file([id '_y'],y),'kernel',array_file([id '_kernel'],kernel), ...
    'result',array_file([id '_result'],conv(y,kernel)));
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
