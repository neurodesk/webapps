function B = imresize(A, scale)
% imresize  Identity stand-in for the Image Processing Toolbox's imresize.
%
% The image package is not installed in the container. samsrf_revcor_prf calls
% imresize(cM, [Model.Rdim Model.Rdim]) on each reverse-correlation map and
% samsrf_fit2dprf calls imresize(ApFrm(:,:,i), [dims dims]) for the profile mask.
% With the X001 apertures (100 x 100) and the default Rdim of 100 both resize to the
% same size, which MATLAB's imresize returns unchanged. Anything else errors here
% instead of silently computing a different interpolation.

if isnumeric(scale) && numel(scale) == 2 && isequal(size(A), scale(:)')
    B = A;
    return;
end
error('imresize shim: only same-size resizes are supported (%s to %s)', mat2str(size(A)), mat2str(scale));
end
