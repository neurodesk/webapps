cmake_minimum_required(VERSION 3.16)
project(NeurodeskHmcRegistration LANGUAGES C CXX)
set(CMAKE_CXX_STANDARD 17)
set(ANTS_SOURCE_DIR "" CACHE PATH "Pinned ANTs source checkout")
if(NOT EXISTS "${ANTS_SOURCE_DIR}/Examples/antsRegistration.cxx")
  message(FATAL_ERROR "Set ANTS_SOURCE_DIR to the pinned ANTs source checkout")
endif()
find_package(ITK REQUIRED)
include(${ITK_USE_FILE})
# ITK's Mattes metric accumulates its PDFs, metric value and an affine's derivative in float64 while
# images, fields and transforms stay float (#462, "deriv64"; cmake/mattes-pdf-double.cmake). With
# --float 1 alone the epi2anat affine of SyN-SDC moved the 1.2 mm field 0.538 Hz from native double.
set(HMC_MATTES_DERIVATIVE_DOUBLE ON)
include(${CMAKE_CURRENT_SOURCE_DIR}/cmake/mattes-pdf-double.cmake)
# The same pinned ANTs commit and version label as packages/registration and packages/n4.
set(ANTS_VERSION_MAJOR 2)
set(ANTS_VERSION_MINOR 6)
set(ANTS_VERSION_PATCH 2)
set(ANTS_VERSION_TWEAK 0)
set(ANTS_VERSION "2.6.2-neurodesk-wasm")
configure_file(${ANTS_SOURCE_DIR}/ANTsVersionConfig.h.in ${CMAKE_CURRENT_BINARY_DIR}/ANTsVersionConfig.h)
include_directories(${CMAKE_CURRENT_BINARY_DIR})
include_directories(${ANTS_SOURCE_DIR}/Examples ${ANTS_SOURCE_DIR}/Examples/include
  ${ANTS_SOURCE_DIR}/Utilities ${ANTS_SOURCE_DIR}/ImageRegistration
  ${ANTS_SOURCE_DIR}/Tensor ${ANTS_SOURCE_DIR}/Temporary)
# Only the 3D float implementation of antsRegistration is compiled; src/unsupported.cxx refuses
# every other mode. AverageImages and AverageAffineTransform are ANTs's own sources, unchanged;
# src/apply.cxx keeps the legacy --apply resampler; the full antsApplyTransforms CLI is
# linked unchanged. The small Laplacian entry avoids compiling all of ImageMath.
add_executable(hmc-registration src/main.cxx src/unsupported.cxx src/apply.cxx src/laplacian.cxx
  src/mattes-pdf-double-check.cxx
  ${ANTS_SOURCE_DIR}/Examples/antsApplyTransforms.cxx
  ${ANTS_SOURCE_DIR}/Examples/AverageImages.cxx
  ${ANTS_SOURCE_DIR}/Examples/AverageAffineTransform.cxx
  ${ANTS_SOURCE_DIR}/Examples/antsRegistration.cxx
  ${ANTS_SOURCE_DIR}/Examples/antsRegistration3DFloat.cxx
  ${ANTS_SOURCE_DIR}/Examples/antsRegistrationTemplateHeader.cxx
  ${ANTS_SOURCE_DIR}/Examples/antsUtilities.cxx
  ${ANTS_SOURCE_DIR}/Examples/ANTsVersion.cxx
  ${ANTS_SOURCE_DIR}/Utilities/ReadWriteData.cxx
  ${ANTS_SOURCE_DIR}/Utilities/antsCommandLineParser.cxx
  ${ANTS_SOURCE_DIR}/Utilities/antsCommandLineOption.cxx)
# include(${ITK_USE_FILE}) above puts ITK's directories first in this directory again, so the
# Mattes copies go before them on the target too; src/mattes-pdf-double-check.cxx checks it.
target_include_directories(hmc-registration BEFORE PRIVATE ${HMC_MATTES_DIR})
target_link_libraries(hmc-registration PRIVATE ${ITK_LIBRARIES})
if(EMSCRIPTEN)
  set_target_properties(hmc-registration PROPERTIES SUFFIX ".mjs")
  # The seed always comes from argv (--random-seed), so ENV is not exported: ANTS_RANDOM_SEED is never read.
  # 256 MiB start memory, as packages/registration: four workers need about 1 GiB.
  # callMain puts argv on the 64 KiB stack and never takes it off, so src/index.js restores the
  # stack pointer around each run with stackSave and stackRestore (#537).
  # The toolchain image's LDFLAGS link mimalloc; -sMALLOC=dlmalloc replaces it (#462, see README).
  target_link_options(hmc-registration PRIVATE
    "-sMODULARIZE=1" "-sEXPORT_ES6=1" "-sEXPORT_NAME=createHmcRegistration"
    "-sPTHREAD_POOL_SIZE=0" "-sERROR_ON_UNDEFINED_SYMBOLS=1"
    "-sALLOW_MEMORY_GROWTH=1" "-sMAXIMUM_MEMORY=4294967296" "-sINITIAL_MEMORY=268435456"
    "-sENVIRONMENT=web,worker,node" "-sFORCE_FILESYSTEM=1"
    "-sEXPORTED_RUNTIME_METHODS=['FS','callMain','stackSave','stackRestore']" "-sINVOKE_RUN=0" "-sEXIT_RUNTIME=0"
    "-sMALLOC=dlmalloc")
endif()
