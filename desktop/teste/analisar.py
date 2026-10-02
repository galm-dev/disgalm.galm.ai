#!/usr/bin/env python3
"""Nível de cada tom de prova numa gravação WAV (Goertzel), só com stdlib.

  python analisar.py teste/saida/exclui/recebida.wav [mais.wav ...]

Imprime o nível em dBFS de 440 Hz (fonte excluída), 1000 Hz (fonte comum) e
uma frequência de controle (700 Hz, nenhuma fonte), o RMS total e o RMS do
resíduo: o que sobra depois de tirar os dois tons. Com o Discord de verdade
(som que não é tom), o resíduo é o que denuncia vazamento.
"""
import math
import struct
import sys

FREQS = {'440 Hz (excluído)': 440, '1000 Hz (comum)': 1000, '700 Hz (controle)': 700}


def ler(caminho):
    """Mono, sem o primeiro 0,5 s (transiente). Aceita PCM 16 e float 32."""
    with open(caminho, 'rb') as f:
        d = f.read()
    pos, fmt, dados = 12, None, None
    while pos + 8 <= len(d):
        nome, tam = d[pos:pos + 4], struct.unpack('<I', d[pos + 4:pos + 8])[0]
        corpo = d[pos + 8:pos + 8 + tam]
        if nome == b'fmt ':
            fmt = struct.unpack('<HHIIHH', corpo[:16])
        elif nome == b'data':
            dados = corpo
        pos += 8 + tam + (tam & 1)
    tag, canais, taxa, _, _, bits = fmt
    if tag == 3:
        amostras = struct.unpack('<%df' % (len(dados) // 4), dados)
    else:
        amostras = [v / 32768 for v in struct.unpack('<%dh' % (len(dados) // 2), dados)]
    mono = [sum(amostras[i:i + canais]) / canais for i in range(0, len(amostras) - canais + 1, canais)]
    return taxa, mono[taxa // 2:]


def db(v):
    return 20 * math.log10(v) if v > 0 else -math.inf


def goertzel(x, taxa, f):
    k = 2 * math.cos(2 * math.pi * f / taxa)
    s1 = s2 = 0.0
    for v in x:
        s1, s2 = v + k * s1 - s2, s1
    potencia = s1 * s1 + s2 * s2 - k * s1 * s2
    return 2 * math.sqrt(max(potencia, 0)) / len(x)


def residuo(x, taxa):
    """RMS depois de subtrair, bloco a bloco (100 ms), a senoide de melhor
    ajuste em 440 e 1000 Hz. Blocos curtos toleram o salto de fase quando o
    tocador reinicia o arquivo do tom."""
    n = taxa // 10
    energia, total = 0.0, 0
    for ini in range(0, len(x) - n + 1, n):
        r = x[ini:ini + n]
        for f in (440, 1000):
            w = 2 * math.pi * f / taxa
            c = 2 * sum(v * math.cos(w * i) for i, v in enumerate(r)) / n
            s = 2 * sum(v * math.sin(w * i) for i, v in enumerate(r)) / n
            r = [v - c * math.cos(w * i) - s * math.sin(w * i) for i, v in enumerate(r)]
        energia += sum(v * v for v in r)
        total += n
    return math.sqrt(energia / total) if total else 0


for caminho in sys.argv[1:]:
    taxa, x = ler(caminho)
    rms = math.sqrt(sum(v * v for v in x) / len(x)) if x else 0
    print(f'{caminho}  ({len(x) / taxa:.1f} s, RMS {db(rms):.1f} dBFS, resíduo sem os tons {db(residuo(x, taxa)):.1f} dBFS)')
    # Bloco de 100 ms (resolução de 10 Hz): o app ajusta o passo de leitura em
    # até ±0,3% (±3 Hz em 1 kHz), o que sai de um bin de 0,1 Hz do sinal inteiro.
    n = taxa // 10
    blocos = [x[i:i + n] for i in range(0, len(x) - n + 1, n)]
    for nome, f in FREQS.items():
        amp = math.sqrt(sum(goertzel(b, taxa, f) ** 2 for b in blocos) / len(blocos)) if blocos else 0
        print(f'  {nome:<20} {db(amp):7.1f} dBFS')
