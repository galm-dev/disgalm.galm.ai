# Cenário de prova: dois tons tocando ao mesmo tempo, em processos diferentes.
#   440 Hz  — tocado por um FILHO de um "Discord.exe" substituto (cópia do
#             powershell.exe com esse nome), para provar que a exclusão pega a
#             árvore e não só o processo achado pelo nome.
#   1000 Hz — tocado por um powershell.exe comum.
# Depois abre o app em modo de teste, que grava a track antes e depois do
# WebRTC em teste\saida\<Nome>. Rode na sessão de desktop (precisa de áudio).
#
#   .\teste\cenario.ps1 -Nome exclui          # exclui o Discord.exe substituto
#   .\teste\cenario.ps1 -Nome controle -Excluir nada.exe   # não exclui nada
#   .\teste\cenario.ps1 -Nome depois -Depois       # substituto abre com o app já capturando
#   .\teste\cenario.ps1 -Nome real -SemSubstituto  # Discord de verdade aberto
param(
  [string]$Nome = 'exclui',
  [string]$Excluir = 'Discord.exe',
  [int]$Segundos = 10,
  [switch]$SemSubstituto,
  [switch]$Depois
)
$ErrorActionPreference = 'Stop'
$desktop = Split-Path $PSScriptRoot
$tmp = Join-Path $env:TEMP 'disgalm-teste'
New-Item -ItemType Directory -Force $tmp | Out-Null

function Tom([double]$hz, [string]$arquivo) {
  $taxa = 48000; $n = $taxa * 5
  $fs = [IO.File]::Create($arquivo); $w = New-Object IO.BinaryWriter $fs
  $w.Write([Text.Encoding]::ASCII.GetBytes('RIFF')); $w.Write([int](36 + $n * 2))
  $w.Write([Text.Encoding]::ASCII.GetBytes('WAVEfmt ')); $w.Write([int]16); $w.Write([int16]1); $w.Write([int16]1)
  $w.Write([int]$taxa); $w.Write([int]($taxa * 2)); $w.Write([int16]2); $w.Write([int16]16)
  $w.Write([Text.Encoding]::ASCII.GetBytes('data')); $w.Write([int]($n * 2))
  for ($i = 0; $i -lt $n; $i++) { $w.Write([int16](8000 * [Math]::Sin(2 * [Math]::PI * $hz * $i / $taxa))) }
  $w.Close()
}
$t440 = Join-Path $tmp 'tom440.wav'; $t1000 = Join-Path $tmp 'tom1000.wav'
if (-not (Test-Path $t440)) { Tom 440 $t440 }
if (-not (Test-Path $t1000)) { Tom 1000 $t1000 }

$ps = (Get-Command powershell.exe).Source
$tocar = { param($f) "(New-Object Media.SoundPlayer '$f').PlayLooping(); Start-Sleep 600" }
$procs = @()
function Substituto {
  $falso = Join-Path $tmp 'Discord.exe'
  Copy-Item $ps $falso -Force
  # O substituto não toca nada; quem toca é o filho dele.
  $filho = "& '$ps' -NoProfile -Command `"$(& $tocar $t440)`""
  Start-Process $falso -ArgumentList '-NoProfile', '-Command', $filho -WindowStyle Hidden -PassThru
}
if (-not $SemSubstituto -and -not $Depois) { $procs += Substituto }
$procs += Start-Process $ps -ArgumentList '-NoProfile', '-Command', (& $tocar $t1000) -WindowStyle Hidden -PassThru
Start-Sleep 2

try {
  $saida = Join-Path $desktop "teste\saida\$Nome"
  Remove-Item -Recurse -Force $saida -ErrorAction SilentlyContinue
  $env:DISGALM_EXCLUIR = $Excluir
  $electron = Join-Path $desktop 'node_modules\electron\dist\electron.exe'
  # Com -Depois a captura começa sem o substituto (exclui o próprio app) e
  # tem de trocar de alvo sozinha; o aquecimento cobre a troca (até 2 s depois).
  if ($Depois) { $env:DISGALM_TESTE_QUERY = 'aquecer=12' }
  $app = Start-Process $electron -ArgumentList "`"$desktop`"", "--teste=`"$saida`"" -PassThru
  if ($Depois) { Start-Sleep 8; $procs += Substituto }
  if (-not $app.WaitForExit(($Segundos + 60) * 1000)) { $app.Kill(); throw 'app não terminou' }
  "app saiu com $($app.ExitCode); saída em $saida"
} finally {
  # Mata as árvores dos tocadores (o filho do substituto inclusive).
  foreach ($p in $procs) { & taskkill /T /F /PID $p.Id 2>&1 | Out-Null }
}
