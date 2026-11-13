# 作业助手 (homework helper). The baseline hardware-test pages (demo_*.c, ui_pixel.c)
# stay in the tree for their host tests but are not part of this firmware.
idf_component_register(
    SRCS "main.c"
         "hw_model.c"
         "hw_net.c"
         "hw_provision.c"
         "hw_blufi_security.c"
         "hw_sound.c"
         "hw_ui.c"
         "hw_talk.c"
         "hw_sweep.c"
         "hw_robot_art.c"
    INCLUDE_DIRS "."
    REQUIRES bsp bt esp_event esp_http_client esp_hw_support esp_netif esp_timer esp_wifi
             json mbedtls nvs_flash
    EMBED_FILES "assets/voice/remind2.pcm" "assets/voice/remind1.pcm" "assets/voice/timeup.pcm"
                "assets/voice/start.pcm" "assets/voice/done.pcm" "assets/voice/alldone.pcm"
                "assets/voice/extend.pcm" "assets/voice/newlist.pcm" "assets/voice/hello.pcm"
                "assets/voice/wifi_ok.pcm"
)

target_sources(${COMPONENT_LIB} PRIVATE
    "${CMAKE_CURRENT_LIST_DIR}/../assets/fonts/homework/hw_font_18.c"
    "${CMAKE_CURRENT_LIST_DIR}/../assets/fonts/homework/hw_font_24.c"
    "${CMAKE_CURRENT_LIST_DIR}/../assets/fonts/homework/hw_font_48.c"
)
