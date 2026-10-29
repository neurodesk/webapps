# Compile ITK's MattesMutualInformationImageToImageMetricv4 with float64 accumulation (#462).
#
# With antsRegistration --float 1 the metric's computation type is float, and so is its
# PDFValueType: the joint histogram adds millions of Parzen-window weights in float, and its sums
# and the metric value are float too. For a transform with global support (the epi2anat affine),
# ComputeResults also adds the derivative's terms over the 48 x 48 bins straight into the float
# derivative. This module writes build-tree copies of ITK's header and its .hxx with
#   - PDFValueType = double: the PDFs, their sums and the metric value accumulate in double;
#   - with HMC_MATTES_DERIVATIVE_DOUBLE ("deriv64"), the global-support derivative also accumulates
#     in double and is rounded to float once. Without it the variant is "pdf64".
# Images, fields and transforms stay float. Each edit fails the build unless its pinned text is
# in the source exactly once.
#
# Include after find_package(ITK) and include(${ITK_USE_FILE}); wasm/ and native/ do. Every
# translation unit must find the copies first, so they are added with include_directories(BEFORE),
# and mattes-pdf-double-check.cxx fails the build if antsRegistration's include chain misses them.
option(HMC_MATTES_DERIVATIVE_DOUBLE "Also accumulate the Mattes global-support derivative in double" OFF)
set(HMC_MATTES_DIR ${CMAKE_CURRENT_BINARY_DIR}/mattes-pdf-double)

function(hmc_mattes_edit text old new out)
  string(FIND "${text}" "${old}" first)
  string(FIND "${text}" "${old}" last REVERSE)
  if(first EQUAL -1 OR NOT first EQUAL last)
    message(FATAL_ERROR "ITK's Mattes metric does not hold this text exactly once:\n${old}")
  endif()
  string(REPLACE "${old}" "${new}" text "${text}")
  set(${out} "${text}" PARENT_SCOPE)
endfunction()

find_file(HMC_MATTES_H itkMattesMutualInformationImageToImageMetricv4.h PATHS ${ITK_INCLUDE_DIRS} NO_DEFAULT_PATH NO_CMAKE_FIND_ROOT_PATH REQUIRED)
file(READ ${HMC_MATTES_H} text)
hmc_mattes_edit("${text}" "  using PDFValueType = TInternalComputationValueType;" "  using PDFValueType = double; // neurodesk/webapps#462" text)
file(WRITE ${HMC_MATTES_DIR}/itkMattesMutualInformationImageToImageMetricv4.h "${text}")

if(HMC_MATTES_DERIVATIVE_DOUBLE)
  find_file(HMC_MATTES_HXX itkMattesMutualInformationImageToImageMetricv4.hxx PATHS ${ITK_INCLUDE_DIRS} NO_DEFAULT_PATH NO_CMAKE_FIND_ROOT_PATH REQUIRED)
  file(READ ${HMC_MATTES_HXX} text)
  hmc_mattes_edit("${text}"
    "  PDFValueType sum = 0.0;\n"
    "  PDFValueType sum = 0.0;\n  // neurodesk/webapps#462: the global-support derivative accumulates in double.\n  std::vector<PDFValueType> globalDerivative;\n  if (this->GetComputeDerivative() && !this->HasLocalSupport())\n  {\n    globalDerivative.assign(this->GetNumberOfLocalParameters(), 0.0);\n  }\n"
    text)
  hmc_mattes_edit("${text}"
    "                (*(this->m_DerivativeResult))[parameter] += (*derivPtr) * pRatio;"
    "                globalDerivative[parameter] += (*derivPtr) * pRatio;"
    text)
  hmc_mattes_edit("${text}"
    "  // Apply the pRatio and sum the per-window derivative\n"
    "  for (SizeValueType parameter = 0; parameter < globalDerivative.size(); ++parameter)\n  {\n    (*(this->m_DerivativeResult))[parameter] += globalDerivative[parameter];\n  }\n\n  // Apply the pRatio and sum the per-window derivative\n"
    text)
  hmc_mattes_edit("${text}"
    "#define itkMattesMutualInformationImageToImageMetricv4_hxx\n"
    "#define itkMattesMutualInformationImageToImageMetricv4_hxx\n#define HMC_MATTES_DERIVATIVE_DOUBLE_APPLIED\n"
    text)
  file(WRITE ${HMC_MATTES_DIR}/itkMattesMutualInformationImageToImageMetricv4.hxx "${text}")
  add_compile_definitions(HMC_MATTES_DERIVATIVE_DOUBLE)
else()
  file(REMOVE ${HMC_MATTES_DIR}/itkMattesMutualInformationImageToImageMetricv4.hxx)
endif()
include_directories(BEFORE ${HMC_MATTES_DIR})
