// Empacotamento e feeds de atualização (electron-builder + electron-updater),
// no modelo do t3code (desktop/docs/estudo-t3code-distribuicao.md). O CI
// (.github/workflows/desktop-release.yml) roda `npm run dist` em cada SO e
// publica a release; o builder não publica nada sozinho (--publish never).
//
// Canais: DISGALM_CANAL=nightly gera nightly*.yml (release prerelease, versão
// 0.5.0-nightly.20261002.42); sem ele, stable, com latest*.yml. O canal também
// vai no app-update.yml embutido: é o padrão do app instalado.
const nightly = process.env.DISGALM_CANAL === 'nightly'

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: 'ai.galm.disgalm',
  productName: 'Disgalm',
  artifactName: 'Disgalm-${version}-${os}-${arch}.${ext}',
  // build/icon.png (npm run icone) vira o .icns, o .ico e o ícone do AppImage.
  directories: { output: 'dist', buildResources: 'build' },
  // Só o app. A UI vem de https://disgalm.galm.ai (main.js): não vai public/.
  files: [
    'main.js', 'preload.js', 'captura.js', 'alvo.js', 'login.js', 'pipewire.js', 'bandeja.js',
    'atualizacao.js', 'saude.js', 'reamostrar.js', 'marca.js', 'renderer/**', 'package.json', 'build/icon.png',
    { from: 'native/build/Release', to: 'native/build/Release', filter: ['loopback.node'] },
  ],
  // O .node não carrega de dentro do asar.
  asarUnpack: ['native/**/*.node'],
  // O módulo N-API é compilado antes (npm run build:native, no Windows e no Mac).
  npmRebuild: false,
  publish: [{
    provider: 'github', owner: 'galm-dev', repo: 'disgalm.galm.ai',
    channel: nightly ? 'nightly' : 'latest',
    releaseType: nightly ? 'prerelease' : 'release',
  }],

  mac: {
    // Só Apple Silicon: ninguém do grupo usa Mac Intel, e cada arquitetura a
    // mais custa uns 2 min de CI.
    target: [{ target: 'dmg', arch: ['arm64'] }, { target: 'zip', arch: ['arm64'] }],
    category: 'public.app-category.social-networking',
    // Assinatura com identidade estável (CSC_LINK): a permissão de Gravação de
    // Tela e o Squirrel.Mac dependem do mesmo requisito designado entre versões.
    // CSC_NAME escolhe a identidade (no CI, "Disgalm Release (GALM)").
    identity: process.env.CSC_NAME || undefined,
    hardenedRuntime: true,
    entitlements: 'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.plist',
    notarize: false,
    extendInfo: {
      NSMicrophoneUsageDescription: 'O Disgalm usa o microfone na chamada.',
      NSCameraUsageDescription: 'O Disgalm usa a câmera quando você liga o vídeo.',
      // Tap do Core Audio (native/loopback_mac.mm): áudio da tela sem o Discord.
      NSAudioCaptureUsageDescription: 'O Disgalm envia o áudio do sistema junto com a tela, sem o Discord.',
    },
  },
  dmg: { artifactName: 'Disgalm-${version}-mac-${arch}.${ext}' },

  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
  },
  nsis: {
    oneClick: true,
    perMachine: false,
    artifactName: 'Disgalm-${version}-windows-${arch}-setup.${ext}',
  },

  linux: {
    target: [{ target: 'AppImage', arch: ['x64'] }],
    category: 'Network',
    synopsis: 'Compartilhamento de tela com áudio do sistema sem o Discord',
  },
}
