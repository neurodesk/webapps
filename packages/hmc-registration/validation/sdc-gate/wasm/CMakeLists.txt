# The hmc-registration kernel (../../../CMakeLists.txt, unchanged) with float64 accumulation in
# ITK's Mattes metric (../mattes-pdf-double.cmake), for the #462 precision test. build-wasm.sh builds it.
cmake_minimum_required(VERSION 3.16)
project(HmcRegistrationMattesPdfDouble LANGUAGES C CXX)
find_package(ITK REQUIRED)
include(${ITK_USE_FILE})
include(${CMAKE_CURRENT_SOURCE_DIR}/../mattes-pdf-double.cmake)
add_subdirectory(${CMAKE_CURRENT_SOURCE_DIR}/../../.. kernel)
# The kernel's own include(${ITK_USE_FILE}) puts ITK's directories first again in its directory,
# so the copies go before them on the target itself.
target_include_directories(hmc-registration BEFORE PRIVATE ${HMC_MATTES_DIR})
target_sources(hmc-registration PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/../mattes-pdf-double-check.cxx)
