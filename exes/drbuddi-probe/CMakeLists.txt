cmake_minimum_required(VERSION 3.16)
project(DrBuddiFeasibility LANGUAGES C CXX)
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
set_target_properties(drbuddi-probe PROPERTIES SUFFIX ".mjs")
target_link_options(drbuddi-probe PRIVATE
  "-sMODULARIZE=1" "-sEXPORT_ES6=1" "-sENVIRONMENT=web,worker,node"
  "-sALLOW_MEMORY_GROWTH=1" "-sMAXIMUM_MEMORY=4294967296"
  "-sEXPORTED_RUNTIME_METHODS=['FS','callMain','stackSave','stackRestore']"
  "-sINVOKE_RUN=0" "-sEXIT_RUNTIME=0" "-sFORCE_FILESYSTEM=1")
