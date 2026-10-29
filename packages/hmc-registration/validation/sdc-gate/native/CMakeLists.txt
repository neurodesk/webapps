# Native build of the kernel's programs (src/main.cxx) for the #462 precision tests: antsRegistration
# 3D float, optionally 3D double and the Mattes metric variants, and DenoiseImage. Build with
# native/build.sh.
cmake_minimum_required(VERSION 3.16)
project(HmcRegistrationNative LANGUAGES C CXX)
set(CMAKE_CXX_STANDARD 17)
set(ANTS_SOURCE_DIR "" CACHE PATH "Pinned ANTs source checkout")
option(HMC_NATIVE_DOUBLE "Also compile antsRegistration 3D double" OFF)
option(HMC_MATTES_PDF_DOUBLE "Accumulate the Mattes metric in double (../mattes-pdf-double.cmake)" OFF)
set(PKG ${CMAKE_CURRENT_SOURCE_DIR}/../../..)
find_package(ITK REQUIRED)
include(${ITK_USE_FILE})
if(HMC_MATTES_PDF_DOUBLE)
  include(${CMAKE_CURRENT_SOURCE_DIR}/../mattes-pdf-double.cmake)
endif()
set(ANTS_VERSION_MAJOR 2)
set(ANTS_VERSION_MINOR 6)
set(ANTS_VERSION_PATCH 2)
set(ANTS_VERSION_TWEAK 0)
set(ANTS_VERSION "2.6.2-neurodesk-native")
configure_file(${ANTS_SOURCE_DIR}/ANTsVersionConfig.h.in ${CMAKE_CURRENT_BINARY_DIR}/ANTsVersionConfig.h)
include_directories(${CMAKE_CURRENT_BINARY_DIR})
include_directories(${ANTS_SOURCE_DIR}/Examples ${ANTS_SOURCE_DIR}/Examples/include
  ${ANTS_SOURCE_DIR}/Utilities ${ANTS_SOURCE_DIR}/ImageRegistration
  ${ANTS_SOURCE_DIR}/Tensor ${ANTS_SOURCE_DIR}/Temporary)
set(ANTS_COMMON
  ${ANTS_SOURCE_DIR}/Examples/antsUtilities.cxx
  ${ANTS_SOURCE_DIR}/Examples/ANTsVersion.cxx
  ${ANTS_SOURCE_DIR}/Utilities/ReadWriteData.cxx
  ${ANTS_SOURCE_DIR}/Utilities/antsCommandLineParser.cxx
  ${ANTS_SOURCE_DIR}/Utilities/antsCommandLineOption.cxx)
add_executable(hmc-native ${PKG}/src/main.cxx ${CMAKE_CURRENT_SOURCE_DIR}/modes.cxx ${PKG}/src/apply.cxx ${PKG}/src/laplacian.cxx
  ${ANTS_SOURCE_DIR}/Examples/antsApplyTransforms.cxx
  ${ANTS_SOURCE_DIR}/Examples/AverageImages.cxx
  ${ANTS_SOURCE_DIR}/Examples/AverageAffineTransform.cxx
  ${ANTS_SOURCE_DIR}/Examples/antsRegistration.cxx
  ${ANTS_SOURCE_DIR}/Examples/antsRegistration3DFloat.cxx
  ${ANTS_SOURCE_DIR}/Examples/antsRegistrationTemplateHeader.cxx
  ${ANTS_COMMON})
if(HMC_NATIVE_DOUBLE)
  target_sources(hmc-native PRIVATE ${ANTS_SOURCE_DIR}/Examples/antsRegistration3DDouble.cxx)
  target_compile_definitions(hmc-native PRIVATE HMC_NATIVE_DOUBLE)
endif()
if(HMC_MATTES_PDF_DOUBLE)
  target_sources(hmc-native PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/../mattes-pdf-double-check.cxx)
endif()
target_link_libraries(hmc-native PRIVATE ${ITK_LIBRARIES})
add_executable(DenoiseImage ${CMAKE_CURRENT_SOURCE_DIR}/denoise.cxx ${ANTS_SOURCE_DIR}/Examples/DenoiseImage.cxx ${ANTS_COMMON})
target_link_libraries(DenoiseImage PRIVATE ${ITK_LIBRARIES})
