// Fails the build unless antsRegistration's own include chain reaches the build-tree copies of ITK's
// Mattes metric header and, with HMC_MATTES_DERIVATIVE_DOUBLE, its .hxx (cmake/mattes-pdf-double.cmake).
#include <type_traits>
#include "itkantsRegistrationHelper.h"

namespace {
using Image = itk::Image<float, 3>;
using Metric = itk::MattesMutualInformationImageToImageMetricv4<Image, Image, Image, float>;
static_assert(std::is_same_v<Metric::PDFValueType, double>, "Mattes PDFValueType is not double");
}

#if defined(HMC_MATTES_DERIVATIVE_DOUBLE) && !defined(HMC_MATTES_DERIVATIVE_DOUBLE_APPLIED)
#  error "The Mattes global-support derivative is not accumulated in double"
#endif
