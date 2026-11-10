function [x, fval, exitflag, output] = fminsearch(funfcn, x0, options, varargin)
% fminsearch  MATLAB's Nelder-Mead simplex search, reimplemented for the Octave reference run.
%
% Octave's own fminsearch takes a different path through the simplex (74 iterations and
% 143 evaluations on the Rosenbrock example where MATLAB documents 85 and 159), so SamSrf's
% fine fits would not match MATLAB. This file follows MATLAB's documented algorithm
% (Lagarias et al. 1998, as in MATLAB's fminsearch.m); the Rust phase-2 port implements
% the same algorithm, so this is the reference for both.
%
%   Initial simplex: x0 and, per coordinate j, x0 with x0(j) * 1.05, or 0.00025 when x0(j) == 0.
%   Coefficients: reflection rho = 1, expansion chi = 2, contraction psi = 0.5, shrink sigma = 0.5.
%   Each iteration: reflect; if better than the best, try to expand and keep the better of the two;
%   else if better than the second worst, keep the reflection; else contract outside (reflection
%   better than the worst, accepted when not worse than the reflection) or inside (accepted when
%   better than the worst); otherwise shrink every vertex towards the best.
%   The simplex is sorted by function value after each iteration with a stable sort.
%   Convergence: max(abs(fv(1) - fv(2:end))) <= TolFun and max(max(abs(v(:,2:end) - v(:,1)))) <= TolX.
%   MATLAB's current source also floors each tolerance at 10 * eps of the best value; that only
%   differs when the best value exceeds about 4.5e11, which no SamSrf error function reaches.
%   Defaults: TolX = TolFun = 1e-4, MaxIter = MaxFunEvals = 200 * numel(x0), Display = 'notify'.
%   OutputFcn(x, optimValues, state) is called with state 'init', 'iter' and 'done'; returning
%   true stops the search with exitflag -1. exitflag is 1 on convergence and 0 at either limit.
%   output has iterations, funcCount, algorithm and message.

if nargin < 3
    options = [];
end
n = numel(x0);
tolx = option(options, 'TolX', 1e-4);
tolf = option(options, 'TolFun', 1e-4);
maxiter = option(options, 'MaxIter', 200 * n);
maxfun = option(options, 'MaxFunEvals', 200 * n);
display = option(options, 'Display', 'notify');
outputfcn = option(options, 'OutputFcn', []);
if ischar(maxiter)
    maxiter = 200 * n;
end
if ischar(maxfun)
    maxfun = 200 * n;
end
if ischar(funfcn)
    funfcn = str2func(funfcn);
end

rho = 1;
chi = 2;
psi = 0.5;
sigma = 0.5;
usual_delta = 0.05;
zero_term_delta = 0.00025;

x = x0;
xin = x0(:);
v = zeros(n, n + 1);
fv = zeros(1, n + 1);
v(:, 1) = xin;
x(:) = xin;
fv(1) = funfcn(x, varargin{:});
func_evals = 1;
itercount = 0;
how = '';
stop = call_output(outputfcn, x, itercount, func_evals, fv(1), how, 'init');
if stop
    [x, fval, exitflag, output] = finish(x, v, fv, -1, itercount, func_evals, display, 'Stopped by OutputFcn.');
    call_output(outputfcn, x, itercount, func_evals, fval, how, 'done');
    return;
end

for j = 1:n
    y = xin;
    if y(j) ~= 0
        y(j) = (1 + usual_delta) * y(j);
    else
        y(j) = zero_term_delta;
    end
    v(:, j + 1) = y;
    x(:) = y;
    fv(j + 1) = funfcn(x, varargin{:});
end
[fv, order] = sort(fv);
v = v(:, order);
how = 'initial simplex';
itercount = itercount + 1;
func_evals = n + 1;
stop = call_output(outputfcn, v(:, 1), itercount, func_evals, fv(1), how, 'iter');
if strcmp(display, 'iter')
    printf(' %5.0f        %5.0f     %12.6g         %s\n', itercount, func_evals, fv(1), how);
end

exitflag = 1;
while func_evals < maxfun && itercount < maxiter && ~stop
    if max(abs(fv(1) - fv(2:n + 1))) <= tolf && max(max(abs(v(:, 2:n + 1) - v(:, ones(1, n))))) <= tolx
        break;
    end
    xbar = sum(v(:, 1:n), 2) / n;
    xr = (1 + rho) * xbar - rho * v(:, end);
    x(:) = xr;
    fxr = funfcn(x, varargin{:});
    func_evals = func_evals + 1;
    if fxr < fv(1)
        xe = (1 + rho * chi) * xbar - rho * chi * v(:, end);
        x(:) = xe;
        fxe = funfcn(x, varargin{:});
        func_evals = func_evals + 1;
        if fxe < fxr
            v(:, end) = xe;
            fv(end) = fxe;
            how = 'expand';
        else
            v(:, end) = xr;
            fv(end) = fxr;
            how = 'reflect';
        end
    else
        if fxr < fv(n)
            v(:, end) = xr;
            fv(end) = fxr;
            how = 'reflect';
        else
            if fxr < fv(end)
                xc = (1 + psi * rho) * xbar - psi * rho * v(:, end);
                x(:) = xc;
                fxc = funfcn(x, varargin{:});
                func_evals = func_evals + 1;
                if fxc <= fxr
                    v(:, end) = xc;
                    fv(end) = fxc;
                    how = 'contract outside';
                else
                    how = 'shrink';
                end
            else
                xcc = (1 - psi) * xbar + psi * v(:, end);
                x(:) = xcc;
                fxcc = funfcn(x, varargin{:});
                func_evals = func_evals + 1;
                if fxcc < fv(end)
                    v(:, end) = xcc;
                    fv(end) = fxcc;
                    how = 'contract inside';
                else
                    how = 'shrink';
                end
            end
            if strcmp(how, 'shrink')
                for j = 2:n + 1
                    v(:, j) = v(:, 1) + sigma * (v(:, j) - v(:, 1));
                    x(:) = v(:, j);
                    fv(j) = funfcn(x, varargin{:});
                end
                func_evals = func_evals + n;
            end
        end
    end
    [fv, order] = sort(fv);
    v = v(:, order);
    itercount = itercount + 1;
    if strcmp(display, 'iter')
        printf(' %5.0f        %5.0f     %12.6g         %s\n', itercount, func_evals, fv(1), how);
    end
    stop = call_output(outputfcn, v(:, 1), itercount, func_evals, fv(1), how, 'iter');
    if stop
        exitflag = -1;
    end
end

if exitflag == -1
    message = 'Stopped by OutputFcn.';
elseif func_evals >= maxfun
    exitflag = 0;
    message = 'Exiting: Maximum number of function evaluations has been exceeded.';
elseif itercount >= maxiter
    exitflag = 0;
    message = 'Exiting: Maximum number of iterations has been exceeded.';
else
    message = 'Optimization terminated: the current x satisfies the termination criteria using OPTIONS.TolX and F(X) satisfies the convergence criteria using OPTIONS.TolFun.';
end
[x, fval, exitflag, output] = finish(x, v, fv, exitflag, itercount, func_evals, display, message);
call_output(outputfcn, x, itercount, func_evals, fval, how, 'done');
end

function [x, fval, exitflag, output] = finish(x, v, fv, exitflag, itercount, func_evals, display, message)
x(:) = v(:, 1);
fval = fv(1);
output.iterations = itercount;
output.funcCount = func_evals;
output.algorithm = 'Nelder-Mead simplex direct search';
output.message = message;
if strcmp(display, 'iter') || strcmp(display, 'final') || (strcmp(display, 'notify') && exitflag == 0)
    disp(message);
end
end

function stop = call_output(outputfcn, x, iteration, funccount, fval, procedure, state)
stop = false;
if isempty(outputfcn)
    return;
end
optimValues.iteration = iteration;
optimValues.funccount = funccount;
optimValues.fval = fval;
optimValues.procedure = procedure;
stop = outputfcn(x, optimValues, state);
end

function value = option(options, name, default)
value = default;
if isstruct(options) && isfield(options, name) && ~isempty(options.(name))
    value = options.(name);
end
end
