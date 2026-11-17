# libicmm: the C++ simulation core, loaded by the engine through ctypes.
#   cmake -S engine/cpp -B build -DCMAKE_BUILD_TYPE=Release && cmake --build build
#   ctest --test-dir build
# Its one dependency is Eigen, fetched by hash (ADR-0004): no BLAS, LAPACK or
# OpenMP. The golden-cost tests run from pytest against the built library.
cmake_minimum_required(VERSION 3.21)
set(CMAKE_OSX_DEPLOYMENT_TARGET 13.3 CACHE STRING "Minimum macOS version")
project(icmm VERSION 1.0.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)
set(CMAKE_CXX_VISIBILITY_PRESET hidden)
set(CMAKE_VISIBILITY_INLINES_HIDDEN ON)
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")

# Header-only: SOURCE_SUBDIR names a folder without a CMakeLists.txt, so
# Eigen's own build (tests, docs, BLAS) is never configured.
include(FetchContent)
if(POLICY CMP0135)
  cmake_policy(SET CMP0135 NEW)  # extracted files get the extraction time
endif()
FetchContent_Declare(eigen
  URL https://gitlab.com/libeigen/eigen/-/archive/5.0.1/eigen-5.0.1.tar.gz
  URL_HASH SHA256=e9c326dc8c05cd1e044c71f30f1b2e34a6161a3b6ecf445d56b53ff1669e3dec
  SOURCE_SUBDIR headers-only)
FetchContent_MakeAvailable(eigen)
add_library(eigen INTERFACE)
target_include_directories(eigen SYSTEM INTERFACE ${eigen_SOURCE_DIR})
target_compile_definitions(eigen INTERFACE EIGEN_MPL2_ONLY)

find_package(Threads REQUIRED)

add_library(icmm SHARED
  src/expm.cc src/icmm.cc src/inverse.cc src/measure.cc src/model.cc src/score.cc src/session.cc)
include(GenerateExportHeader)
generate_export_header(icmm BASE_NAME ICMM)
target_include_directories(icmm PUBLIC include ${CMAKE_CURRENT_BINARY_DIR})
target_compile_definitions(icmm PRIVATE ICMM_VERSION_STRING="${PROJECT_VERSION}")
target_link_libraries(icmm PRIVATE eigen Threads::Threads)
# Plain IEEE arithmetic on every compiler: no fused multiply-adds the source
# doesn't write, so a sum rounds the same way on arm64 as on x86-64.
if(CMAKE_CXX_COMPILER_ID MATCHES "Clang|GNU")
  target_compile_options(icmm PRIVATE -ffp-contract=off)
endif()

# The test drivers stay in this repo: the public mirror holds tests/ back and
# builds the library alone (release/public-sync.toml).
if(NOT EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/tests")
  return()
endif()

enable_testing()
add_executable(icmm_abi_test tests/abi_test.cc)
target_link_libraries(icmm_abi_test PRIVATE icmm)
target_compile_definitions(icmm_abi_test PRIVATE ICMM_VERSION_STRING="${PROJECT_VERSION}")
add_test(NAME abi COMMAND icmm_abi_test)

# The matrix exponential on matrices from stdin, for tests/test_core_expm.py.
# It isn't exported, so its sources are built in again.
add_executable(icmm_expm_check tests/expm_check.cc src/expm.cc src/inverse.cc src/model.cc)
target_include_directories(icmm_expm_check PRIVATE src include ${CMAKE_CURRENT_BINARY_DIR})
target_link_libraries(icmm_expm_check PRIVATE eigen)
if(CMAKE_CXX_COMPILER_ID MATCHES "Clang|GNU")
  target_compile_options(icmm_expm_check PRIVATE -ffp-contract=off)
endif()
