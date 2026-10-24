cmake_minimum_required(VERSION 3.16)
project(NeurodeskDenoise LANGUAGES C CXX)
set(CMAKE_CXX_STANDARD 17)
set(ANTS_SOURCE_DIR "" CACHE PATH "Pinned ANTs source checkout")
set(AD_SOURCE_DIR "" CACHE PATH "Pinned ITKAdaptiveDenoising source checkout")
if(NOT EXISTS "${ANTS_SOURCE_DIR}/Examples/DenoiseImage.cxx")
  message(FATAL_ERROR "Set ANTS_SOURCE_DIR to the pinned ANTs source checkout")
endif()
if(NOT EXISTS "${AD_SOURCE_DIR}/include/itkAdaptiveNonLocalMeansDenoisingImageFilter.h")
  message(FATAL_ERROR "Set AD_SOURCE_DIR to the pinned ITKAdaptiveDenoising source checkout")
endif()
find_package(ITK REQUIRED)
include(${ITK_USE_FILE})
set(ANTS_VERSION_MAJOR 2)
set(ANTS_VERSION_MINOR 6)
set(ANTS_VERSION_PATCH 2)
set(ANTS_VERSION_TWEAK 0)
set(ANTS_VERSION "2.6.2-neurodesk-wasm")
configure_file(${ANTS_SOURCE_DIR}/ANTsVersionConfig.h.in ${CMAKE_CURRENT_BINARY_DIR}/ANTsVersionConfig.h)
# The toolchain's ITK has no AdaptiveDenoising module: compile its one source file here.
# AdaptiveDenoisingExport.h replaces the header ITK's module system would generate.
include_directories(${CMAKE_CURRENT_BINARY_DIR} ${CMAKE_CURRENT_SOURCE_DIR} ${AD_SOURCE_DIR}/include)
include_directories(${ANTS_SOURCE_DIR}/Examples ${ANTS_SOURCE_DIR}/Examples/include
  ${ANTS_SOURCE_DIR}/Utilities ${ANTS_SOURCE_DIR}/ImageRegistration
  ${ANTS_SOURCE_DIR}/Tensor ${ANTS_SOURCE_DIR}/Temporary)
add_executable(ants-denoise main.cxx
  ${AD_SOURCE_DIR}/src/itkNonLocalPatchBasedImageFilterEnums.cxx
  ${ANTS_SOURCE_DIR}/Examples/DenoiseImage.cxx
  ${ANTS_SOURCE_DIR}/Examples/antsUtilities.cxx
  ${ANTS_SOURCE_DIR}/Examples/ANTsVersion.cxx
  ${ANTS_SOURCE_DIR}/Utilities/ReadWriteData.cxx
  ${ANTS_SOURCE_DIR}/Utilities/antsCommandLineParser.cxx
  ${ANTS_SOURCE_DIR}/Utilities/antsCommandLineOption.cxx)
target_link_libraries(ants-denoise PRIVATE ${ITK_LIBRARIES})
if(EMSCRIPTEN)
  set_target_properties(ants-denoise PROPERTIES SUFFIX ".mjs")
  target_link_options(ants-denoise PRIVATE
    "-sMODULARIZE=1" "-sEXPORT_ES6=1" "-sEXPORT_NAME=createDenoise"
    "-sPTHREAD_POOL_SIZE=0" "-sERROR_ON_UNDEFINED_SYMBOLS=1"
    "-sALLOW_MEMORY_GROWTH=1" "-sMAXIMUM_MEMORY=4294967296" "-sINITIAL_MEMORY=268435456"
    "-sENVIRONMENT=web,worker,node" "-sFORCE_FILESYSTEM=1"
    "-sEXPORTED_RUNTIME_METHODS=['FS','callMain','stackSave','stackRestore']" "-sINVOKE_RUN=0" "-sEXIT_RUNTIME=0")
endif()
