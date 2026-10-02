# RNNoise (WASM)

`rnnoise.wasm` vem do pacote npm `@jitsi/rnnoise-wasm` 0.2.1, sem alteração
(sha256 `677147b9248aedc0a00de79dc090d1ecead37c08c8bb773a790da16109d2c487`).
É a biblioteca RNNoise da Xiph compilada com Emscripten. A cola JavaScript do
Emscripten não foi copiada: `public/rnnoise-worklet.js` instancia o módulo
direto e fornece as duas importações que ele pede (`a.a` cresce a memória,
`a.b` copia bytes).

Mapa de exportações do binário: `c` memória, `d` construtores, `e`
`rnnoise_init`, `f` `rnnoise_create`, `g` `malloc`, `h` `rnnoise_destroy`, `i`
`free`, `j` `rnnoise_process_frame`. Se trocar o binário, confira esse mapa no
`rnnoise.js` do pacote (`Module["asm"]["…"]`).

Licenças: RNNoise em `COPYING-rnnoise` (BSD-3); empacotamento do Jitsi em
`LICENSE-jitsi-rnnoise-wasm` (Apache-2.0).
