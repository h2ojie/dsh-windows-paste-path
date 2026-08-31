# DshClipboardHook — Win32 clipboard listener for the DSH paste-path plugin.
#
# Build with Visual Studio 2022:
#   cmake -S . -B build -G "Visual Studio 17 2022" -A x64
#   cmake --build build --config Release
#
# The executable is standalone: /MT (static runtime) means no VC Redist and no
# administrator rights are required to run it.

cmake_minimum_required(VERSION 3.20)
project(DshClipboardHook LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

add_executable(DshClipboardHook WIN32
  src/main.cpp
  src/clipboard_hook.cpp
  src/state_file.cpp
)

target_include_directories(DshClipboardHook PRIVATE src)
target_compile_definitions(DshClipboardHook PRIVATE
  UNICODE
  _UNICODE
  WIN32_LEAN_AND_MEAN
  NOMINMAX
)

target_link_libraries(DshClipboardHook PRIVATE
  user32
  shell32
  ole32
  advapi32
)

if(MSVC)
  target_compile_options(DshClipboardHook PRIVATE /W4 /utf-8)

  # Static runtime so the exe runs without installing a VC Redist.
  set_property(TARGET DshClipboardHook PROPERTY
    MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
endif()

set_target_properties(DshClipboardHook PROPERTIES
  OUTPUT_NAME "DshClipboardHook"
  RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin"
)
