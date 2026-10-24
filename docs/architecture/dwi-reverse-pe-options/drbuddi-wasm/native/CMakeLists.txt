# Native x86-64 build of the #596 DR-BUDDI probe (exes/drbuddi-probe at 9d6ca773f).
# It compiles the same TORTOISE sources and the same main.cxx as the WebAssembly
# build, with the same compat/omp.h (one thread), and only drops the Emscripten
# link options.
cmake_minimum_required(VERSION 3.16)
project(DrBuddiNative LANGUAGES C CXX)
set(CMAKE_CXX_STANDARD 17)
find_package(ITK REQUIRED)
include(${ITK_USE_FILE})
file(GLOB_RECURSE source_headers /tortoise/src/*.h)
set(source_dirs /source/compat /boost-headers)
foreach(header ${source_headers})
  get_filename_component(header_dir ${header} DIRECTORY)
  list(APPEND source_dirs ${header_dir})
endforeach()
list(REMOVE_DUPLICATES source_dirs)
add_library(drbuddi-solver STATIC
  /tortoise/src/main/DRBUDDI_Diffeo.cxx
  /tortoise/src/main/run_drbuddi_stage.cxx
  /tortoise/src/main/drbuddi_image_utilities.cxx
  /tortoise/src/tools/DRBUDDI/DRBUDDI_parserBase.cxx
  /tortoise/src/main/antsCommandLineParser.cxx
  /tortoise/src/main/antsCommandLineOption.cxx)
target_include_directories(drbuddi-solver PRIVATE ${source_dirs})
target_compile_definitions(drbuddi-solver PRIVATE DRBUDDIALONE)
target_link_libraries(drbuddi-solver PRIVATE ${ITK_LIBRARIES})
add_executable(drbuddi-probe /source/main.cxx)
target_include_directories(drbuddi-probe PRIVATE ${source_dirs})
target_compile_definitions(drbuddi-probe PRIVATE DRBUDDIALONE)
target_link_libraries(drbuddi-probe PRIVATE drbuddi-solver ${ITK_LIBRARIES})
# readImageD: see missing_readImageD.cxx.
target_sources(drbuddi-probe PRIVATE /native/missing_readImageD.cxx)
