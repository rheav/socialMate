# Extrair voz do vídeo — MDX-Net Voc_FT dentro da extensão

Plano de implementação. Escrito para ser executado numa conversa nova, sem
contexto prévio: tudo que está aqui foi medido ou lido no código, não estimado.

---

## 0. A pergunta que originou isso

> "Dá pra bundlar o MDX-Net Voc_FT na extensão, ou precisamos baixar e guardar em cache?"

**Bundla.** A extensão é local, uso pessoal, sem publicação na Chrome Web Store.
O limite de 2 GB do pacote da loja é irrelevante aqui, e não existe limite de
tamanho para uma extensão descompactada carregada via `chrome://extensions`
(Load unpacked). O modelo tem **63,7 MB**.

Isso elimina categorias inteiras de trabalho que seriam obrigatórias num cenário
de publicação:

- sem lógica de download sob demanda
- sem cache em IndexedDB/OPFS, sem invalidação, sem versionamento de modelo
- sem barra de progresso de download, sem retry, sem estado "modelo ausente"
- sem a discussão de política de remote code (peso `.onnx` é dado, não código —
  mas nem precisamos entrar nela)

O modelo entra em `public/models/mdx/` e é lido com `chrome.runtime.getURL()`,
exatamente como o `whisper-base` já é hoje.

Referência de tamanho do que a extensão já carrega, para calibrar: `public/models`
tem 99 MB (Whisper + MiniLM), `public/assets/ort-wasm-simd-threaded.jsep.wasm`
tem 21,6 MB, `public/ffmpeg/ffmpeg-core.wasm` tem 32 MB. Somar 63,7 MB é um
aumento de ~40% no peso do diretório, sem consequência funcional local.

---

## 1. Fatos verificados do modelo

Todos extraídos do arquivo real em `~/.cache/voice-lab-models/UVR-MDX-NET-Voc_FT.onnx`
(baixado pela bancada `voice-lab/`), não de documentação.

### Arquivo

| | |
|---|---|
| Nome | `UVR-MDX-NET-Voc_FT.onnx` |
| Tamanho | 63,7 MB (fp32) |
| Origem | mesmo arquivo que o `audio-separator` baixa; hash MD5 dos últimos 10 MB = `77d07b2667ddf05b9e3175941b4454a0` |

### Tensores

```
INPUT   name="input"   shape=[batch_size, 4, 3072, 256]   float32
OUTPUT  name="output"  shape=[batch_size, 4, 3072, 256]   float32
```

O input **é um espectrograma**, não waveform. Confirma que a STFT/ISTFT roda
fora do grafo e é responsabilidade nossa. Os 4 canais são
`[L.real, L.imag, R.real, R.imag]` — 2 canais de áudio × (real, imaginário).

### Hiperparâmetros (de `mdx_model_data.json`, entrada do hash acima)

```json
{
  "compensate": 1.021,
  "mdx_dim_f_set": 3072,
  "mdx_dim_t_set": 8,
  "mdx_n_fft_scale_set": 7680,
  "primary_stem": "Vocals"
}
```

### Defaults de execução (de `audio_separator/separator/separator.py:139`)

```python
mdx_params = {"hop_length": 1024, "segment_size": 256, "overlap": 0.25,
              "batch_size": 1, "enable_denoise": False}
```

### Constantes derivadas

| símbolo | fórmula | valor |
|---|---|---|
| `n_fft` | — | 7680 |
| `hop_length` | — | 1024 |
| `dim_f` | — | 3072 |
| `dim_t` | `2 ** 8` | 256 |
| `segment_size` | — | 256 |
| `n_bins` | `n_fft // 2 + 1` | 3841 |
| `trim` | `n_fft // 2` | 3840 |
| `chunk_size` | `hop_length * (segment_size - 1)` | 261 120 amostras |
| `gen_size` | `chunk_size - 2 * trim` | 253 440 amostras (≈5,75 s @ 44,1 kHz) |
| `overlap` | — | 0,25 |
| `step` | `int((1 - overlap) * chunk_size)` | 195 840 amostras |

Taxa de amostragem fixa: **44 100 Hz, estéreo**. Não é negociável — o modelo foi
treinado nisso e `n_fft`/`hop` estão calibrados para essa taxa.

### O `compensate` NÃO se aplica ao nosso caso

Lendo `mdx_separator.py:192-195`, o `compensate: 1.021` é usado **apenas** ao
derivar o stem secundário (Instrumental) por subtração:

```python
self.secondary_source = (-self.primary_source * self.compensate) + mix.T
```

O stem primário — Vocals, que é o único que queremos — sai do ISTFT **sem**
multiplicação. Ignorar o `compensate` é correto aqui. Confirmar isso na fase 2
comparando bit a bit contra a bancada.

---

## 2. O problema da FFT, e por que ele é menor do que parecia

`n_fft = 7680` não é potência de 2, então `fft.js` e a maioria das libs JS de FFT
(radix-2 puro) não servem. Foi o risco que levantei antes de ter o número.

Com o número em mãos, o risco encolhe:

```
7680 = 2^9 × 3 × 5 = 512 × 15
```

**7680 é 5-smooth** (só tem fatores primos 2, 3 e 5). Isso é exatamente a classe
de tamanhos que FFTs mixed-radix suportam nativamente — não precisa de Bluestein
nem de zero-padding para 16384.

Opções, em ordem de preferência:

1. **`pffft` compilado para WASM** — suporta comprimentos com fatores 2/3/5,
   rápido, testado. É a rota mais segura e mais performática.
2. **FFT mixed-radix radix-2/3/5 em JS puro** — ~200 linhas, sem dependência
   nativa, mais lenta que pffft mas provavelmente não é o gargalo (o gargalo é a
   inferência ONNX, não a FFT).
3. **Bluestein sobre radix-2 de 16384** — fallback se as duas acima derem
   problema. Funciona para qualquer N, custa ~3 FFTs de 16384 por janela.

Otimização que vale desde o começo: o input é **real**, então dá para usar a
técnica de packing (FFT complexa de N/2 para um sinal real de N) e cortar o
trabalho pela metade. E só precisamos dos **primeiros 3072 bins** dos 3841 — o
resto é descartado logo em seguida (`return final_output[..., :self.dim_f, :]`).

Decidir entre 1 e 2 na fase 1, com benchmark. Não escolher antes de medir.

---

## 3. O algoritmo completo, passo a passo

Portado de `audio_separator/separator/architectures/mdx_separator.py` e
`uvr_lib_v5/stft.py`. Esta é a especificação normativa da implementação.

### 3.1 Preparo do sinal

```
entrada: mix = Float32Array[2][n]  (estéreo, 44100 Hz, faixa [-1, 1])

pad      = gen_size + trim - (n % gen_size)
mixture  = concat( zeros(2, trim), mix, zeros(2, pad) )
step     = floor((1 - 0.25) * chunk_size)      // 195840
result   = zeros(2, mixture.length)
divider  = zeros(2, mixture.length)
```

### 3.2 Laço sobre os chunks

Para `i` de `0` até `mixture.length`, passo `step`:

```
start = i
end   = min(i + chunk_size, mixture.length)
chunk_actual = end - start

window = hanning(chunk_actual)            // np.hanning: simétrica, N pontos
mix_part = mixture[:, start:end]
se end != i + chunk_size:
    mix_part = zero-pad à direita até chunk_size

tar = run_model(mix_part)                 // ver 3.3

tar[..., :chunk_actual] *= window
divider[..., start:end]  += window
result[...,  start:end]  += tar[..., :end-start]
```

**Atenção ao `np.hanning`:** é a janela *simétrica* (`periodic=False`),
diferente da janela da STFT. Não confundir as duas — ver 3.3.

### 3.3 `run_model(mix_part)`

```
spek = STFT(mix_part)                 // → [4, 3072, 256]
spek[:, 0:3, :] = 0                   // zera os 3 primeiros bins de frequência
pred = session.run({input: spek[None]})["output"][0]
return ISTFT(pred)                    // → [2, chunk_size]
```

A zeragem dos 3 primeiros bins (`spek[:, :, :3, :] *= 0`) é literal e obrigatória
— está em `mdx_separator.py` logo após a STFT.

### 3.4 STFT (de `uvr_lib_v5/stft.py`)

Equivalente a `torch.stft(n_fft=7680, hop_length=1024, window=hann_periodic,
center=True, return_complex=False)`, seguido de reshape e crop:

```
janela : torch.hann_window(7680, periodic=True)
         → w[k] = 0.5 - 0.5*cos(2*pi*k/7680),  k = 0..7679
center : True  → reflect-pad do sinal em n_fft//2 = 3840 em cada ponta
frames : 256 (por construção de chunk_size)
saída  : para cada canal, (real, imag) → empilha em 4 canais
crop   : mantém apenas os primeiros dim_f = 3072 bins dos 3841
```

Ordem final dos canais: `[L.real, L.imag, R.real, R.imag]`. Isso vem do
`reshape([..., channel_dim, 2, -1, T]).reshape([..., channel_dim*2, -1, T])` —
o eixo real/imag fica **interno** ao canal, então é L.re, L.im, R.re, R.im, e
**não** L.re, R.re, L.im, R.im. Errar isso produz áudio que soa quase certo mas
com os canais cruzados; é a falha mais provável da fase 2.

**Janela periódica aqui**, simétrica no overlap-add da 3.2. São diferentes.

### 3.5 ISTFT

```
1. zero-pad o eixo de frequência de 3072 de volta para n_bins = 3841
2. desempacota [4, 3841, 256] → complexo [2, 3841, 256]
3. torch.istft(n_fft=7680, hop_length=1024, window=hann_periodic, center=True)
   → [2, chunk_size]
```

O `istft` do PyTorch faz overlap-add normalizado pela soma dos quadrados da
janela (NOLA). Reimplementar isso corretamente é a segunda maior fonte de erro
depois da ordem dos canais. Fórmula: acumula `ifft(frame) * w` e divide pelo
acumulado de `w²`, com epsilon para evitar divisão por zero nas bordas.

### 3.6 Finalização

```
tar_waves = result / divider                 // divisão elemento a elemento
tar_waves = tar_waves[:, trim : -trim]       // remove o padding das pontas
vocals    = tar_waves[:, 0:n]                // corta no comprimento original
```

---

## 4. Onde o código entra na extensão

### 4.1 Arquivos novos

```
public/models/mdx/UVR-MDX-NET-Voc_FT.onnx     63,7 MB, commitado
src/offscreen/separate.worker.js               worker de inferência (novo)
src/lib/dsp/fft.js                             FFT mixed-radix 2/3/5
src/lib/dsp/stft.js                            STFT/ISTFT com o contrato da §3.4/3.5
src/lib/dsp/wav.js                             encoder WAV PCM 16-bit (trivial)
src/lib/dsp/*.test.js                          testes unitários (vitest, já configurado)
```

### 4.2 Arquivos alterados

| arquivo | mudança |
|---|---|
| `src/offscreen/offscreen.js` | novo handler `action: "separateVocals"`; decode 44,1 kHz estéreo; encode MP3 via `getFfmpeg()`; blob URL + `liveBlobUrls`; ciclo de vida do worker espelhando `txWorker` |
| `src/background.js` | roteia `FBW_EXTRACT_VOICE` → offscreen; `downloadPath()` para o MP3; timeout próprio (ver §6) |
| `src/content/ig/bridge.js` | ícone `voice` no mapa `ICONS` (~1374) + botão na `buildActs()` (~1839) |
| `package.json` | `onnxruntime-web` como dependência explícita |

Nada em `src/lib/shared/` muda, então `npm run gen:inline` não é necessário
nesta feature — mas o build roda `--check` de qualquer forma.

### 4.3 O worker

Copiar a estrutura de `src/offscreen/transcribe.worker.js` — ela já resolve as
armadilhas de MV3:

```js
import * as ort from "onnxruntime-web";

// Mesmas restrições do worker de Whisper:
ort.env.wasm.wasmPaths  = paths.assets;   // passado pelo offscreen, chrome.* não existe aqui
ort.env.wasm.numThreads = 1;              // sem pthreads aninhados (CSP do MV3 proíbe blob workers)
ort.env.wasm.proxy      = false;
```

O `onnxruntime-web` **já está em `node_modules`** (versão `1.22.0-dev.20250409`),
puxado transitivamente pelo `@huggingface/transformers`. Importar direto funciona
hoje; declarar como dependência explícita é higiene, não requisito.

O documento offscreen é uma página de extensão, então lê
`chrome.runtime.getURL("models/mdx/UVR-MDX-NET-Voc_FT.onnx")` diretamente —
**não precisa de `web_accessible_resources`** (isso só governa acesso a partir de
páginas web e content scripts).

O CSP já permite tudo que precisamos:
`script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'`.

### 4.4 O botão

Em `src/content/ig/bridge.js`, dentro de `buildActs(rec)` (~linha 1839), ao lado
do botão de transcrever que já existe:

```js
if (rec.video) {
  wrap.appendChild(mk("voice", "Extrair voz (remover música)", (b) =>
    ovlRun(b, () => ovlExtractVoice(rec))));
}
```

`ovlExtractVoice` espelha `ovlTranscribe` (linha 1597): manda
`chrome.runtime.sendMessage({ type: "FBW_EXTRACT_VOICE", ... })` com a URL do MP4.

Precisa de um ícone `"voice"` novo no mapa `ICONS`.

`swallowPointer(b)` é obrigatório — sem ele o Instagram pausa o reel ao toque
(há comentário no código explicando que isso já mordeu save/download/transcribe).

### 4.5 O que o botão entrega — decidido

**Baixa um MP3 com a voz limpa, direto.** Mesma ergonomia do botão de vídeo:
um toque, o arquivo cai na pasta de downloads. Sem Biblioteca, sem Whisper, sem
tela intermediária.

Isso simplifica o escopo: a transcrição não entra nesta feature. O botão é um
irmão do "Baixar mídia", não do "Transcrever".

### 4.6 Encoding e entrega do arquivo

O `ffmpeg-core.wasm` já empacotado **tem encoder MP3**. Verificado nas flags de
build gravadas no próprio binário:

```
--enable-gpl --enable-libx264 ... --enable-libmp3lame --enable-libtheora
--enable-libvorbis --enable-libopus ...
```

(a string `libmp3lame encoder` também está presente). Nenhuma dependência nova —
nem `lamejs`, nem outro core.

O caminho de entrega **já existe e deve ser copiado literalmente**: `muxDownload`
em `src/offscreen/offscreen.js` faz exatamente isso para o MP4. Sequência:

```
1. separação  →  Float32Array[2][n] com a voz, 44,1 kHz
2. WAV PCM 16-bit em memória (src/lib/dsp/wav.js)
3. ffmpeg.wasm:  -i voice.wav -codec:a libmp3lame -q:a 2 out.mp3
4. URL.createObjectURL(new Blob([out], { type: "audio/mpeg" }))
5. registrar em liveBlobUrls  +  setTimeout de revoke (5 min)
6. return { blobUrl, filename: `ig-${id}-voz.mp3` }   ← nome NU, sem pasta
```

Três detalhes do código existente que não podem ser reinventados, todos com
comentário explicando o porquê em `offscreen.js`:

- **Blob URL, não data URL base64** — base64 infla ~33% e constrói uma string
  gigante na memória.
- **`liveBlobUrls` + revoke** — o service worker não consegue criar object URLs,
  então o offscreen cria; sem rastrear, o blob fica vivo 5 minutos fixos. A
  liberação por ociosidade revoga antes.
- **Nome de arquivo NU** — este documento gera bytes, não decide onde downloads
  moram. `background.js` arquiva sob `social-mate/` via `downloadPath()`. Um
  segundo dono de caminho quebra a convenção.

Reusar `getFfmpeg()` (lazy, já implementado) e `baseNameFor(rec, ext)` do
`src/lib/shared/filenames.js`, que é o que o botão de download usa hoje para
nomear.

### 4.7 O ícone

Os ícones são glifos lucide 24×24 traçados, no mapa `ICONS` de
`src/content/ig/bridge.js:1374`, renderizados por `overlayIcon(name, 15)`.

Já existe um `audio:` (nota musical, linha 1398) — **mas ele significa outra
coisa**: "o som que o reel usa", nas estatísticas. Reusá-lo para o botão de voz
seria ambíguo. Precisa de uma entrada nova.

Duas opções, ambas lucide:

```js
// A — audio-lines (barras de forma de onda)   ← recomendado
voice: '<path d="M2 10v3"/><path d="M6 6v11"/><path d="M10 3v18"/><path d="M14 8v7"/><path d="M18 5v13"/><path d="M22 10v3"/>',

// B — speech (cabeça falando + ondas), o "boneco falando"
voice: '<path d="M8.8 20v-4.1l1.9.2a2.3 2.3 0 0 0 2.164-2.1V8.3A5.37 5.37 0 0 0 2 8.25c0 2.8.656 3.054 1 4.55a5.77 5.77 0 0 1 .029 2.758L2 20"/><path d="M19.8 17.8a7.5 7.5 0 0 0 .003-10.603"/><path d="M17 15a3.5 3.5 0 0 0-.025-4.975"/>',
```

Recomendo **A**. A rail renderiza a 15 px, e nesse tamanho a cabeça do "boneco
falando" vira uma mancha — os arcos de som colam no crânio. As barras da forma de
onda continuam legíveis a 15 px e leem como "voz/áudio" na hora. Se quiser o
boneco mesmo assim, vale testar a 15 px antes de fechar.

---

## 5. Realidade de performance — leia antes de implementar

Medição real da bancada `voice-lab/`, no mesmo Mac, no mesmo modelo:

| | |
|---|---|
| Áudio | 59,4 s (reel do Instagram) |
| Separação MDX Voc_FT | **43,4 s** |
| Ambiente | Python + ONNX Runtime com **CoreMLExecutionProvider** ativo |

Isso é ~0,73× tempo real **com aceleração de hardware**. Dentro da extensão o
cenário é pior em dois eixos:

1. **WASM em vez de CoreML.** Sem EP nativo.
2. **`numThreads = 1`.** O worker de Whisper é single-thread por causa do CSP do
   MV3, e o de separação herda a restrição.

Extrapolação honesta: **algo entre 3× e 10× mais lento**, ou seja, 2 a 7 minutos
para um reel de 60 s. Isso não é aceitável como UX sem mitigação.

### As alavancas, em ordem de retorno

1. **WebGPU EP.** O `ort-wasm-simd-threaded.jsep.wasm` que já está em
   `public/assets/` é justamente o build com jsep — o backend que serve WebGPU.
   Tentar `executionProviders: ["webgpu", "wasm"]`. Se funcionar num documento
   offscreen, muda a ordem de grandeza. **Isto é a primeira coisa a testar na
   fase 1** — o resto do plano depende do resultado.
2. **Processar só um trecho.** Para avaliar qualidade não é preciso separar 60 s;
   um recorte de 15 s já responde.
3. **Aumentar `batch_size`.** O laço roda chunk a chunk com batch 1. Agrupar 2-4
   chunks por chamada amortiza overhead — custa RAM.
4. **Reduzir `overlap` de 0,25 para 0.** Corta o número de chunks em ~25%, ao
   custo de possíveis artefatos nas junções. Medir antes de aceitar.

### O que NÃO se aplica aqui

A bancada mediu que, para **transcrição**, a separação compra quase nada: no
mesmo reel, o baseline e o MDX Voc_FT produziram as mesmas 195 palavras, com
0,02 de diferença no logprob do decoder.

Isso era o argumento contra a feature — e **não vale para este botão**. O
objetivo aqui é obter o arquivo de áudio com a voz limpa. Para isso a separação
não tem substituto: nenhum ajuste de Whisper produz um MP3.

O único portão real, portanto, é o **tempo de processamento** (§6, fase 1). Se
um reel de 60 s levar 2-7 minutos, a pergunta passa a ser se isso é tolerável
para um download sob demanda — e provavelmente é, desde que haja progresso
visível e a possibilidade de cancelar. Um download que demora e avisa é aceitável;
um botão que trava sem dizer nada, não.

---

## 6. Fases

### Fase 1 — Viabilidade (spike, descartável)

Antes de escrever qualquer código de produção, responder duas perguntas numa
página de teste isolada:

1. WebGPU funciona para este modelo no ORT-web, num documento offscreen?
2. Quanto tempo leva um chunk de 261 120 amostras, em WASM e em WebGPU?

Entregável: dois números e uma decisão de seguir ou parar. Sem tocar em
`src/`.

**Portão:** se WASM ficar acima de ~5× tempo real e WebGPU não funcionar,
parar e reavaliar (processar só um recorte, ou abandonar).

### Fase 2 — DSP com paridade comprovada

`fft.js`, `stft.js` e o laço de demix, com testes contra saídas de referência.

Método de verificação — este é o ponto crítico do plano:

```bash
# gerar vetores de referência a partir da bancada, que usa a implementação canônica
cd voice-lab
.venv/bin/python  # dump de: spek pós-STFT, saída do modelo, waveform pós-ISTFT
```

Salvar os tensores como JSON/binário em `src/lib/dsp/__fixtures__/` e afirmar no
vitest que a implementação JS bate com tolerância `1e-4`.

Verificar nesta ordem, porque cada etapa depende da anterior:

1. FFT de 7680 pontos contra a de referência
2. STFT completa → shape `[4, 3072, 256]` **e a ordem dos canais** (§3.4)
3. ISTFT (round-trip STFT→ISTFT deve reconstruir o sinal)
4. Laço de demix com overlap-add

**Portão:** áudio separado no JS indistinguível do da bancada.

### Fase 3 — Integração na extensão

Worker, handler no offscreen, roteamento no background, botão na rail, encoder
WAV, download.

Ciclo de vida a espelhar de `transcribe.worker.js` / `offscreen.js`:

- worker preguiçoso, criado na primeira chamada
- liberação por ociosidade (o offscreen já tem `scheduleIdleRelease`)
- **`abortSeparation`** análogo ao `abortTranscription` — terminar o worker é a
  única forma de parar a inferência no meio. Sem isso um job travado segura um
  core e bloqueia a liberação por ociosidade
- não mexer em `inFlight` no abort; deixar o `finally` do `job()` decrementar
  (há comentário no código explicando que zerar leva o contador a negativo e
  trava a liberação para sempre)
- timeout no background maior que o da transcrição (3 min hoje) — separação é
  mais lenta

**Portão:** botão no reel → MP3 só com a voz na pasta de downloads, e o áudio
bate com o `vocals.wav` que a bancada produz para o mesmo vídeo.

### Fase 4 — Progresso e cancelamento (não é polimento)

Com a separação levando minutos, isto é requisito, não enfeite: um botão que
fica mudo por 4 minutos é indistinguível de um botão quebrado. Foi exatamente o
bug que a bancada teve — jobs pareciam travados enquanto só baixavam.

- **Progresso por chunk.** O laço da §3.2 dá isso de graça:
  `chunk_atual / total_chunks`. Reusar `src/lib/transcriptionProgress.js` como
  modelo do canal de eventos.
- **Estado no botão.** `flashOverlayBtn` já existe para ok/erro; falta o estado
  "em andamento" com percentual.
- **Cancelar.** O `abortSeparation` da fase 3 precisa estar acessível pela UI —
  terminar o worker é a única forma de parar a inferência no meio.

**Portão:** dá para acompanhar e abortar um job de 60 s sem abrir o devtools.

---

## 7. Riscos, do mais provável ao menos

| risco | probabilidade | mitigação |
|---|---|---|
| Ordem dos canais da STFT trocada (L.re,L.im,R.re,R.im) | **alta** | fixture da fase 2 pega na hora |
| Lento demais em WASM para ser usável | **alta** | fase 1 mede antes de investir |
| ISTFT com normalização NOLA errada → cliques nas junções | média | teste de round-trip |
| WebGPU indisponível em documento offscreen | média | fallback WASM + recorte curto |
| Confundir janela periódica (STFT) com simétrica (overlap-add) | média | duas funções com nomes distintos, testadas |
| Espera longa sem progresso lida como travamento | **alta** | barra de progresso por chunk + cancelar (fase 4, não opcional) |
| RAM: chunk de 261k amostras × 4 × 3072 × 256 float32 ≈ 12 MB por tensor | baixa | batch 1; liberar tensores entre chunks |

---

## 8. Material de referência

Implementação canônica, já instalada localmente pela bancada:

```
voice-lab/.venv/lib/python3.12/site-packages/audio_separator/separator/
    architectures/mdx_separator.py     laço de demix, run_model, chunking
    uvr_lib_v5/stft.py                 STFT/ISTFT — o contrato a replicar
```

Bancada para gerar fixtures e comparar resultados:

```
voice-lab/          README.md explica; ./run.sh sobe em :8765
```

Modelo e metadados já baixados:

```
~/.cache/voice-lab-models/UVR-MDX-NET-Voc_FT.onnx    63,7 MB
~/.cache/voice-lab-models/mdx_model_data.json        hiperparâmetros por hash
```

Pontos de ancoragem no código da extensão:

```
src/offscreen/transcribe.worker.js       padrão de worker ONNX em MV3
src/offscreen/offscreen.js:147-161       decode de áudio (hoje 16k mono)
src/offscreen/offscreen.js:472-520       dispatch de mensagens do offscreen
src/content/ig/bridge.js:1597            ovlTranscribe — espelhar para voz
src/content/ig/bridge.js:1839            buildActs — onde o botão entra
src/lib/shared/README.md                 ler antes de mexer em helper compartilhado
```

**Se alterar qualquer coisa em `src/lib/shared/`, rodar `npm run gen:inline`.**
O build falha sem isso (`gen-inline.mjs --check` roda antes do vite).

---

## Implementação — 2026-09-05

Implementado no código e empacotado em `dist/`:

- Botão de ondas na rail do Instagram para extrair voz e baixar `*-voz.mp3`.
- MDX Voc_FT incluído em `public/models/mdx/`, worker próprio com WebGPU e fallback WASM.
- FFT mixed-radix 2/3/5 com packing estéreo; STFT/ISTFT e overlap-add.
- Progresso por chunk no botão do vídeo, com cancelamento ao tocar novamente; sem toast.
- Cancelamento interrompe worker/fetch/encoding, ignora resultados atrasados e permite tentar novamente.
- FFmpeg compartilhado com acesso serializado; blobs rastreados até o download.
- Timeout de 15 minutos e liberação dos runtimes por ociosidade.

Validação: `npm test` — 651 testes passando em 52 arquivos; `npm run build` concluído.
As referências de DSP são reproduzíveis com
`../voice-lab/.venv/bin/python scripts/generate-mdx-fixtures.py`.
A comparação da ISTFT usa o resultado canônico com bins cortados, pois não há
reconstrução exata de frequências descartadas. A normalização antes/depois da
separação acompanha a bancada instalada.

Por instrução do usuário, a medição prévia da fase 1 foi dispensada para implementar
diretamente. Velocidade, qualidade perceptiva e o fluxo real no Instagram ficam
para o teste manual do usuário; não há números medidos de WebGPU/WASM neste build.
