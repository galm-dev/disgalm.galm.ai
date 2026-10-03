{
  "targets": [
    {
      "target_name": "loopback",
      "include_dirs": ["<!(node -p \"require('node-addon-api').include_dir\")"],
      "defines": ["NAPI_VERSION=8", "NAPI_DISABLE_CPP_EXCEPTIONS"],
      "conditions": [
        ["OS=='win'", {
          "sources": ["loopback.cpp"],
          "defines": ["UNICODE", "_UNICODE"],
          "libraries": ["mmdevapi.lib", "ole32.lib", "avrt.lib"],
          "msvs_settings": {
            "VCCLCompilerTool": { "AdditionalOptions": ["/std:c++17", "/utf-8"] }
          }
        }],
        ["OS=='mac'", {
          "sources": ["loopback_mac.mm"],
          "xcode_settings": {
            "CLANG_ENABLE_OBJC_ARC": "YES",
            "CLANG_CXX_LANGUAGE_STANDARD": "c++17",
            "MACOSX_DEPLOYMENT_TARGET": "13.0",
            "OTHER_LDFLAGS": ["-framework CoreAudio", "-framework Foundation"]
          }
        }]
      ]
    }
  ]
}
