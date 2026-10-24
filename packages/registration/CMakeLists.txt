cmake_minimum_required(VERSION 3.16)
project(NeurodeskRegistration LANGUAGES C CXX)
set(CMAKE_CXX_STANDARD 17)
set(ANTS_SOURCE_DIR "" CACHE PATH "Pinned ANTs source checkout")
if(NOT EXISTS "${ANTS_SOURCE_DIR}/Examples/antsRegistration.cxx")
  message(FATAL_ERROR "Set ANTS_SOURCE_DIR to the pinned ANTs source checkout")
endif()
find_package(ITK REQUIRED)
include(${ITK_USE_FILE})
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
add_executable(syncro-registration src/main.cxx src/apply.cxx src/unsupported.cxx
  ${ANTS_SOURCE_DIR}/Examples/antsRegistration.cxx
  ${ANTS_SOURCE_DIR}/Examples/antsRegistration3DFloat.cxx
  ${ANTS_SOURCE_DIR}/Examples/antsRegistrationTemplateHeader.cxx
  ${ANTS_SOURCE_DIR}/Examples/antsUtilities.cxx
  ${ANTS_SOURCE_DIR}/Examples/ANTsVersion.cxx
  ${ANTS_SOURCE_DIR}/Utilities/ReadWriteData.cxx
  ${ANTS_SOURCE_DIR}/Utilities/antsCommandLineParser.cxx
  ${ANTS_SOURCE_DIR}/Utilities/antsCommandLineOption.cxx)
target_link_libraries(syncro-registration PRIVATE ${ITK_LIBRARIES})
if(EMSCRIPTEN)
  set_target_properties(syncro-registration PROPERTIES SUFFIX ".mjs")
  target_link_options(syncro-registration PRIVATE
    "-sMODULARIZE=1" "-sEXPORT_ES6=1" "-sEXPORT_NAME=createRegistration"
    "-sPTHREAD_POOL_SIZE=0" "-sERROR_ON_UNDEFINED_SYMBOLS=1"
    "-sALLOW_MEMORY_GROWTH=1" "-sMAXIMUM_MEMORY=4294967296" "-sINITIAL_MEMORY=268435456"
    "-sENVIRONMENT=web,worker,node" "-sFORCE_FILESYSTEM=1"
    "-sEXPORTED_RUNTIME_METHODS=['FS','callMain','stackSave','stackRestore']" "-sINVOKE_RUN=0" "-sEXIT_RUNTIME=0")
endif()
