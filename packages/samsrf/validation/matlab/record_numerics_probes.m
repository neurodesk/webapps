function record_numerics_probes(source, output, sections, branch)
% Record MATLAB's results for the operations inside SamSrf's double CSS
% objective and HRF, on generated inputs, so each can be compared alone.
% sections: cell array of 'elementary','power','conv','hrf','blas','gampdf',
% 'conv-short','single-trig' (default all).
% branch: the MKL_CBWR value requested before MATLAB started (default COMPATIBLE).
if nargin < 3 || isempty(sections)
    sections = {'elementary','power','conv','hrf','blas','gampdf','conv-short','single-trig'};
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
if any(strcmp(sections,'single-trig'))
    cases{end+1} = single_trig_case();
end
write_json('numerics.json',struct('environment',environment,'sections',{sections},'cases',{cases}));
fprintf('Recorded %d numerical probe cases\n', numel(cases));
end

function item = single_trig_case()
% Single sin and cos, the functions samsrf_benson2srf applies to single polar
% angles, on every single x with |x| <= 2^7 pi/2 (bits 0x43490F80, the end of
% fdlibm's medium reduction), both signs: a SHA-256 of the little-endian output
% bits per 2^24 consecutive inputs, and every input where the output differs from
% the candidate (trig_candidate), with MATLAB's output. Above that range, a
% random sample and the special values are recorded whole.
last = 0x43490F80u32;
step = 0x100000u32;
blocks = struct('sign',{},'first',{},'count',{},'sin',{},'cos',{});
exceptions = struct('sin',zeros(0,2,'uint32'),'cos',zeros(0,2,'uint32'));
counts = struct('inputs',0,'sinCandidate',0,'cosCandidate',0,'sinRounded',0,'cosRounded',0);
digestSin = java.security.MessageDigest.getInstance('SHA-256');
digestCos = java.security.MessageDigest.getInstance('SHA-256');
for sign = [0 1]
    signBit = uint32(sign) * 0x80000000u32;
    blockFirst = 0x0u32;
    for first = 0x0u32:step:last
        bits = signBit + first + uint32(0:double(min(step - 1, last - first)))';
        x = typecast(bits,'single');
        s = sin(x);
        c = cos(x);
        [cs, cc] = trig_candidate(x);
        digestSin.update(typecast(s,'int8'));
        digestCos.update(typecast(c,'int8'));
        sBits = typecast(s,'uint32');
        cBits = typecast(c,'uint32');
        wrongSin = sBits ~= typecast(cs,'uint32');
        wrongCos = cBits ~= typecast(cc,'uint32');
        exceptions.sin = [exceptions.sin; bits(wrongSin) sBits(wrongSin)];
        exceptions.cos = [exceptions.cos; bits(wrongCos) cBits(wrongCos)];
        counts.inputs = counts.inputs + numel(x);
        counts.sinCandidate = counts.sinCandidate + nnz(wrongSin);
        counts.cosCandidate = counts.cosCandidate + nnz(wrongCos);
        counts.sinRounded = counts.sinRounded + nnz(sBits ~= typecast(single(sin(double(x))),'uint32'));
        counts.cosRounded = counts.cosRounded + nnz(cBits ~= typecast(single(cos(double(x))),'uint32'));
        assert(size(exceptions.sin,1) + size(exceptions.cos,1) <= 4e6, 'The candidate fails on too many inputs to record');
        blockEnd = first + numel(x) - 1;
        if bitand(blockEnd + 1, 0xFFFFFFu32) == 0 || blockEnd == last
            blocks(end+1) = struct('sign',sign,'first',double(blockFirst), ...
                'count',double(blockEnd - blockFirst) + 1, ...
                'sin',hex_digest(digestSin),'cos',hex_digest(digestCos)); %#ok<AGROW>
            blockFirst = blockEnd + 1;
        end
    end
end
rng(736,'twister');
largeBits = uint32(randi([double(last) + 1, double(0x7F7FFFFFu32)], 100000, 1));
largeBits = [largeBits; largeBits + 0x80000000u32; 0x7F800000u32; 0xFF800000u32; 0x7FC00000u32];
large = typecast(largeBits,'single');
item = struct('id','single_trig','kind','single-trig','last',double(last), ...
    'blocks',blocks,'counts',counts, ...
    'sinExceptions',array_file('single_trig_sin_exceptions',exceptions.sin), ...
    'cosExceptions',array_file('single_trig_cos_exceptions',exceptions.cos), ...
    'largeInput',array_file('single_trig_large_input',largeBits), ...
    'largeSin',array_file('single_trig_large_sin',typecast(sin(large),'uint32')), ...
    'largeCos',array_file('single_trig_large_cos',typecast(cos(large),'uint32')));
end

function hex = hex_digest(digest)
bytes = typecast(digest.digest(),'uint8');
hex = lower(reshape(dec2hex(bytes,2)',1,[]));
end

function [s, c] = trig_candidate(x)
% The port's model (precision.rs sin_single and cos_single) in MATLAB's own
% single arithmetic: fdlibm's float sf_sin.c, sf_cos.c, kf_sin.c, kf_cos.c and
% ef_rem_pio2.c, with kf_cos.c's x/4 term keeping 11 fraction bits.
f = @(b) typecast(b,'single');
half = single(0.5);
bits = typecast(x,'uint32');
ix = bitand(bits,0x7FFFFFFFu32);
negative = bitand(bits,0x80000000u32) ~= 0;
small = ix <= 0x3F490FD8u32;
y0 = x;
y1 = zeros(size(x),'single');
n = zeros(size(x),'int32');
sgn = ones(size(x),'single');
sgn(negative) = -1;
near = ~small & ix < 0x4016CBE4u32;
z = x(near) - sgn(near) .* f(0x3FC90F80u32);
third = bitand(ix(near),0xFFFFFFF0u32) == 0x3FC90FD0u32;
sgnNear = sgn(near);
z(third) = z(third) - sgnNear(third) .* f(0x37354400u32);
tail = repmat(f(0x37354443u32),size(z));
tail(third) = f(0x2E85A308u32);
y0(near) = z - sgnNear .* tail;
y1(near) = (z - y0(near)) - sgnNear .* tail;
n(near) = int32(sgnNear);
medium = ~small & ~near;
if any(medium)
    t = abs(x(medium));
    fn = fix(t .* f(0x3F22F984u32) + half);
    r = t - fn .* f(0x3FC90F80u32);
    w = fn .* f(0x37354443u32);
    y = r - w;
    hw = bitand(typecast(single(double(fn) .* (pi / 2)),'uint32'),0xFFFFFF00u32);
    cancels = fn >= 32 | bitand(ix(medium),0xFFFFFF00u32) == hw;
    exponent = int32(bitshift(ix(medium),-23));
    lost = @(v) exponent - int32(bitand(bitshift(typecast(v,'uint32'),-23),0xFFu32));
    second = cancels & lost(y) > 8;
    t2 = r;
    w2 = fn .* f(0x37354400u32);
    r2 = t2 - w2;
    w2 = fn .* f(0x2E85A308u32) - ((t2 - r2) - w2);
    y2 = r2 - w2;
    third = second & lost(y2) > 25;
    w3 = fn .* f(0x2E85A300u32);
    r3 = r2 - w3;
    w3 = fn .* f(0x248D3132u32) - ((r2 - r3) - w3);
    y3 = r3 - w3;
    r(second) = r2(second);
    w(second) = w2(second);
    y(second) = y2(second);
    r(third) = r3(third);
    w(third) = w3(third);
    y(third) = y3(third);
    tailM = (r - y) - w;
    m = sgn(medium);
    y0(medium) = m .* y;
    y1(medium) = m .* tailM;
    n(medium) = int32(m) .* int32(fn);
end
ks = kernel_sin(y0, y1, ~small);
kc = kernel_cos(y0, y1);
quadrant = mod(n,4);
s = ks;
s(quadrant == 1) = kc(quadrant == 1);
s(quadrant == 2) = -ks(quadrant == 2);
s(quadrant == 3) = -kc(quadrant == 3);
c = kc;
c(quadrant == 1) = -ks(quadrant == 1);
c(quadrant == 2) = -kc(quadrant == 2);
c(quadrant == 3) = ks(quadrant == 3);
end

function v = kernel_sin(x, y, tail)
f = @(b) typecast(b,'single');
half = single(0.5);
ix = bitand(typecast(x,'uint32'),0x7FFFFFFFu32);
z = x .* x;
v3 = z .* x;
r = f(0x3C088889u32) + z .* (f(0xB9500D01u32) + z .* (f(0x3638EF1Bu32) + z .* (f(0xB2D72F34u32) + z .* f(0x2F2EC9D3u32))));
v = x + v3 .* (f(0xBE2AAAABu32) + z .* r);
withTail = x - ((z .* (half .* y - v3 .* r) - y) - v3 .* f(0xBE2AAAABu32));
v(tail) = withTail(tail);
tiny = ix < 0x32000000u32;
v(tiny) = x(tiny);
end

function v = kernel_cos(x, y)
f = @(b) typecast(b,'single');
half = single(0.5);
one = single(1);
ix = bitand(typecast(x,'uint32'),0x7FFFFFFFu32);
z = x .* x;
r = z .* (f(0x3D2AAAABu32) + z .* (f(0xBAB60B61u32) + z .* (f(0x37D00D01u32) + z .* (f(0xB493F27Cu32) + z .* (f(0x310F74F6u32) + z .* f(0xAD47D74Eu32))))));
low = one - (half .* z - (z .* r - x .* y));
quarter = typecast(bitand(ix - 0x01000000u32,0xFFFFF000u32),'single');
quarter(ix > 0x3F480000u32) = single(0.28125);
v = (one - quarter) - ((half .* z - quarter) - (z .* r - x .* y));
v(ix < 0x3E99999Au32) = low(ix < 0x3E99999Au32);
v(ix < 0x32000000u32) = one;
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
