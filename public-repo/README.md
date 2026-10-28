# socialRadar

Extensão do Chrome (MV3) com painel lateral para **pesquisar conteúdo** no Facebook,
Instagram, TikTok e Pinterest e **acompanhar contas** ao longo do tempo.

**Tudo roda no seu navegador.** Não há servidor, conta, login nem telemetria. A extensão
só conversa com as próprias redes sociais, usando a sessão que você já tem aberta, e
grava os arquivos na sua pasta de downloads.

## O que ela faz

| Onde | Ferramentas |
| --- | --- |
| Facebook | Filtrar o feed de busca por engajamento · Ordenar Reels de um perfil · Exportar comentários · Baixar fotos de um perfil |
| Instagram | Ordenar posts e reels de um perfil · Stories · Exportar comentários (inclusive de vários posts seguidos) |
| TikTok | Ordenar vídeos · Exportar comentários · Stories · Playlists |
| Pinterest | Baixar uma pasta inteira |
| Em qualquer vídeo | Baixar · Transcrever (Whisper local, em português, inglês, espanhol ou automático) · Salvar no Arquivo |
| Arquivo | Transcrições e vídeos salvos, com exportação |
| Spy | Perfis acompanhados: seguidores, posts por dia, visualizações, top posts e tendências, num painel próprio (botão **Painel** no topo do painel lateral) |

A interface é em português.

## Instalar

### A partir de um release

1. Baixe o `.zip` do release e descompacte.
2. Abra `chrome://extensions`, ligue o **Modo do desenvolvedor**.
3. **Carregar sem compactação** → escolha a pasta descompactada.
4. Clique no ícone da extensão para abrir o painel lateral.

### A partir do código

Precisa de Node 20+.

```bash
npm install
npm run setup   # baixa os modelos e o ffmpeg (~190 MB), conferindo o sha256 de cada arquivo
npm run build   # → dist/
```

Depois carregue a pasta `dist/` como acima.

| Comando | O que faz |
| --- | --- |
| `npm run setup` | Baixa os binários grandes para `public/` (ver `scripts/fetch-assets.mjs`) |
| `npm run build` | Build de produção em `dist/` |
| `npm run dev` | Servidor do Vite com HMR |
| `npm test` | Testes (Vitest) |
| `npm run gen:inline` | Regenera os helpers copiados para os content scripts |

### `npm run gen:inline` — depois de editar `src/lib/shared/`

Um `import` dentro de um content script faz o CRXJS gerar um carregador com
`import()` dinâmico, que a CSP do Facebook e do Instagram pode bloquear — e a captura
para em silêncio. Por isso os content scripts não importam nada: os helpers de
`src/lib/shared/` são copiados para regiões marcadas de cada script. O build e os
testes falham se uma cópia estiver desatualizada. Detalhes em
[`src/lib/shared/README.md`](src/lib/shared/README.md).

## Privacidade e riscos

- Os dados ficam em `chrome.storage` e no IndexedDB da extensão, neste navegador.
  Desinstalar a extensão apaga tudo.
- A área Spy abre perfis numa aba em segundo plano (uma a cada 20–40 s) e respeita um
  limite diário de leituras do Instagram, ajustável em Opções. O Instagram não publica
  um limite oficial: mais leituras aumentam o risco de verificação ou bloqueio
  temporário **da sua conta**. Use com moderação.
- Nada disso é oficial nem afiliado às redes. Elas mudam a página com frequência, e
  uma ferramenta pode parar de funcionar até ser corrigida.

## Licença

GPL-3.0-or-later — ver [`LICENSE`](LICENSE).

Componentes de terceiros baixados pelo `npm run setup` ou instalados pelo npm:

| Componente | Licença |
| --- | --- |
| [ffmpeg.wasm core](https://github.com/ffmpegwasm/ffmpeg.wasm) 0.12.10 | GPL-2.0-or-later |
| [Whisper base](https://huggingface.co/onnx-community/whisper-base) (OpenAI, convertido para ONNX) | MIT |
| [UVR-MDX-NET Voc FT](https://github.com/TRvlvr/model_repo) (separação de voz) | ver o repositório de origem |
| [Transformers.js](https://github.com/huggingface/transformers.js) | Apache-2.0 |
| [ONNX Runtime Web](https://github.com/microsoft/onnxruntime) | MIT |
| [sql.js](https://github.com/sql-js/sql.js) | MIT |
