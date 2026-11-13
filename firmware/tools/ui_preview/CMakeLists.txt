# Host build of the homework helper's UI (main/hw_ui.c) with the firmware's LVGL,
# fonts and robot art, rendering every screen to an image. See preview.sh.
cmake_minimum_required(VERSION 3.16)
project(hw_ui_preview C)
set(CMAKE_C_STANDARD 11)
set(FW ${CMAKE_CURRENT_LIST_DIR}/../..)
set(LVGL ${FW}/managed_components/lvgl__lvgl)

file(GLOB_RECURSE LVGL_SRC ${LVGL}/src/*.c)
add_library(lvgl STATIC ${LVGL_SRC})
target_include_directories(lvgl PUBLIC ${LVGL} ${LVGL}/src ${CMAKE_CURRENT_BINARY_DIR})
target_compile_definitions(lvgl PUBLIC LV_CONF_KCONFIG_EXTERNAL_INCLUDE="host_sdkconfig.h")
target_compile_options(lvgl PRIVATE -w -O1)

add_executable(hw_ui_preview
    ${CMAKE_CURRENT_LIST_DIR}/preview_main.c
    ${FW}/main/hw_ui.c
    ${FW}/main/hw_model.c
    ${FW}/main/hw_sweep.c
    ${FW}/main/hw_robot_art.c
    ${FW}/assets/fonts/homework/hw_font_18.c
    ${FW}/assets/fonts/homework/hw_font_24.c
    ${FW}/assets/fonts/homework/hw_font_48.c
    ${FW}/components/bsp/src/bsp_display_rounding.c)   # the panel's real corner mask
target_include_directories(hw_ui_preview PRIVATE ${CMAKE_CURRENT_LIST_DIR}/stubs ${FW}/main
                           ${FW}/components/bsp/src)
target_link_libraries(hw_ui_preview lvgl)
