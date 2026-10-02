{
  "targets": [
    {
      "target_name": "loopback",
      "sources": ["loopback.cpp"],
      "include_dirs": ["<!(node -p \"require('node-addon-api').include_dir\")"],
      "defines": ["NAPI_VERSION=8", "NAPI_DISABLE_CPP_EXCEPTIONS", "UNICODE", "_UNICODE"],
      "libraries": ["mmdevapi.lib", "ole32.lib", "avrt.lib"],
      "msvs_settings": {
        "VCCLCompilerTool": { "AdditionalOptions": ["/std:c++17", "/utf-8"] }
      }
    }
  ]
}
