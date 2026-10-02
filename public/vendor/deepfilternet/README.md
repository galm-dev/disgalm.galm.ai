# DeepFilterNet3 (WASM)

`df_bg.wasm.gz` é o `dist/df_bg.wasm` do pacote npm `@lofcz/deepfilternet-web`
0.1.0 (fork comunitário `lofcz/DeepFilterNet`, commit
`773cf0ca65da1f82bc63ee5d8fd15d9314190231`), compactado com gzip nível 9. O
modelo DeepFilterNet3 padrão vem embutido no binário, e não há outro download.

- WASM: sha256 `596034b83a03b546f33daa14b791bcdb59655cb3a07053ac39ddb0ba42c52fa4`, 34.135.648 bytes
- gzip: sha256 `292ad8877cae1017a9bed2d0351c420142c5439ad131ad9c9dbb395dede8af2c`, 12.640.501 bytes

O gzip existe por causa do limite de 25 MiB por asset do Cloudflare Workers.
`public/ruido.js` descompacta o arquivo com `DecompressionStream` na thread
principal e compila o módulo. O asset não pode ser servido com
`Content-Encoding: gzip`, porque o navegador já o descompactaria. O loader
aceita os dois casos olhando os primeiros bytes.

A cola JavaScript do wasm-bindgen não foi copiada. Ela cria um `TextDecoder`,
que não existe no AudioWorkletGlobalScope. `public/deepfilter-worklet.js`
fornece as quatro importações que o binário pede, com os nomes que incluem o
hash deste build. Se trocar o binário, confira esses nomes com
`WebAssembly.Module.imports`.

Licenças: código MIT ou Apache-2.0 (`LICENSE-MIT`, `LICENSE-APACHE`). Os pesos
são os oficiais do DeepFilterNet3. O autor declara que foram publicados sob
licença aberta, mas não há uma declaração específica para os arquivos do
modelo.
