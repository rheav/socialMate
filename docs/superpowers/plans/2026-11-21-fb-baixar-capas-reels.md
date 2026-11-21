# Facebook Profile Header Download Buttons (Capas & Reels) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adicionar os botões "Baixar capas" e "Baixar reels" no cabeçalho de perfis do Facebook (logo após `#fbw-hub-btn`), com os mesmos ícones, anel de progresso e máquina de estados do Instagram (`1.44.0`), baixando individualmente as capas nativas (`1080×1920`) e os vídeos MP4 dos reels já carregados na grade.

**Architecture:** Reutilizar e parametrizar os módulos puros compartilhados em `src/lib/shared/` (`igDlButtons.js`, `igHubButton.js`, `fbReelActions.js`, `fbVideoMedia.js`), inlinados em tempo de build via `scripts/gen-inline.mjs` dentro de `src/content/fb/reels-capture.js` (mantendo todos os content scripts 100% livres de `import` ES). Os downloads reutilizam o contrato existente `FBW_DL_MEDIA` + `msg.dir` (`bulkDownloadPath`) no Service Worker sem novas permissões, sem chamadas GraphQL extras e sem tocar em `src/background.js`.

**Tech Stack:** Plain JavaScript (ES2022), Chrome Extension Manifest V3, CRXJS + Vite 8, Vitest 4 + `happy-dom`, `scripts/gen-inline.mjs`.

**Spec:** `docs/superpowers/specs/2026-11-21-fb-baixar-capas-reels-design.md`

## Global Constraints

- Content scripts (`src/content/fb/reels-capture.js`, `src/content/fb/video-capture.js`, `src/content/transcription/inject.js`, `src/content/ig/bridge.js`) **nunca** podem conter `import` ou `export` ES; helpers compartilhados vivem em `src/lib/shared/` e são copiados por `npm run gen:inline`.
- `src/lib/shared/igDlButtons.js` deve permanecer **zero-import** (não importar módulos de Facebook), pois também é inlinado em `src/content/ig/bridge.js`.
- Nenhuma requisição extra ao Facebook: baixar exclusivamente mídias já capturadas passivamente (`script[type="application/json"]`, XHR GraphQL tee em `video-capture.js` e tiles DOM em `reels-capture.js`).
- Coexistência intacta: a barra inferior `#sw-psort` (`Vídeos` / `Miniaturas` em ZIP com `harvest()`) e `FbReelsTool.jsx` não devem ser alterados nem afetados por cancelamentos dos botões de cabeçalho.
- Variante pública limpa: `npm run build:public && npm run verify:public` deve imprimir `verify-public: clean`.
- Código e comentários em inglês; strings de UI/tooltips em pt-BR; zero atribuição de IA em commits, comentários ou docs; bump de versão (`package.json` + `manifest.config.js`) apenas após validação ao vivo no navegador.

## Review Focus

1. **Capa customizada vs `first_frame_thumbnail`:** Um reel com `preferred_thumbnail` customizado e `first_frame_thumbnail` diferentes deve baixar a capa customizada (`preferred_thumbnail`, sem `ctp=`), enquanto `matchFbVideo` continua reconhecendo ambos os caminhos em `rec.thumbs`.
2. **Navegação SPA entre abas do mesmo perfil (`All` ↔ `Reels` ↔ `Photos`) e entre perfis (`profile.php?id=A` → `profile.php?id=B`):** Fora da aba Reels os botões devem exibir `state="empty"` com dica `"Abra a aba Reels do perfil para baixar capas e reels"`; trocar de perfil durante um download `busy` deve encerrar o loop sem vazar downloads para o próximo perfil.
3. **Reel recém-renderizado ainda sem `progressive` MP4 no lote diferido:** Nunca cair para a URL da capa nem lançar exceção não tratada; deve contar em `noLink`, finalizar em `partial` (ponto vermelho) e, no clique seguinte, reexecutar `collect()` e baixar apenas `job.left`.
4. **Reload da extensão (generation takeover):** Uma geração antiga de `reels-capture.js` deve interromper `onFbDlClick` (`disabled === true`) e remover `#fbw-hub-btn`, `#fbw-dl-covers` e `#fbw-dl-posts`, enquanto a nova geração substitui eventuais botões órfãos sem `__fbwDlFire`.
5. **Perfil numérico sem nome hidratado ainda no DOM (`ownerName() === null`):** `profileDir` e o prefixo dos arquivos devem cair de forma determinística para `rec.authorName` ou `parsed.key` (nunca criar pasta vazia ou soltar arquivos na raiz de `Downloads`).

---

### Task 1: Priorizar capa customizada em `fbVideoMedia.js` e criar `fbDlFilesOf` em `fbReelActions.js`

**Files:**
- Modify: `src/lib/shared/fbVideoMedia.js:43-46`
- Modify: `src/lib/shared/fbReelActions.js:18-35`
- Test: `src/lib/shared/fbVideoMedia.test.js`
- Test: `src/lib/shared/fbReelActions.test.js`

**Interfaces:**
- Consumes: `fbMediaUrl(value)` from `src/lib/shared/fbVideoMedia.js`, `fullResThumb(url)` from `src/lib/shared/fbReelThumb.js`
- Produces:
  - `collectFbVideos(root)` in `src/lib/shared/fbVideoMedia.js` — `rec.thumbs[0]` prioritizes `preferred_thumbnail.image.uri`, `thumbnailImage.uri`, `image.uri` before `first_frame_thumbnail`
  - `fbDlFilesOf(rec, kind, fallbackOwner = null) -> Array<{ url: string | null, kind: "image" | "video", filename: string }>` in `src/lib/shared/fbReelActions.js`

- [ ] **Step 1: Escrever os testes falhando em `src/lib/shared/fbVideoMedia.test.js` e `src/lib/shared/fbReelActions.test.js`**

Adicionar em `src/lib/shared/fbVideoMedia.test.js`:
```js
  it("puts the creator's chosen cover ahead of first_frame_thumbnail while keeping both for matching", () => {
    const [rec] = collectFbVideos(video("1173845761963868", {
      first_frame_thumbnail: cdn("frame0.jpg?stp=dst-jpg"),
      preferred_thumbnail: { image: { uri: cdn("custom-cover.jpg?stp=dst-jpg&ctp=s960x960") } },
      thumbnailImage: { uri: cdn("custom-cover.jpg?stp=dst-jpg&ctp=s960x960") },
    }));
    expect(rec.thumbs[0]).toBe(cdn("custom-cover.jpg?stp=dst-jpg&ctp=s960x960"));
    expect(rec.thumbs).toContain(cdn("frame0.jpg?stp=dst-jpg"));
    expect(matchFbVideo([rec], { thumbs: [cdn("frame0.jpg?other=1")], durationS: 141.867 })?.id).toBe("1173845761963868");
  });
```

Adicionar em `src/lib/shared/fbReelActions.test.js` (importando `fbDlFilesOf`):
```js
it('builds header bulk-download file descriptors for full-res covers and progressive reels', () => {
  const withCrop = {
    ...rec,
    authorName: 'Sandy Spirit Guide',
    thumb: 'https://scontent.fbcdn.net/v/t15.5256-10/cover.jpg?stp=dst-jpg_tt6&cstp=mx1080x1920&ctp=s960x960&oh=abc',
  };
  expect(fbDlFilesOf(withCrop, 'covers')).toEqual([{
    url: 'https://scontent.fbcdn.net/v/t15.5256-10/cover.jpg?stp=dst-jpg_tt6&cstp=mx1080x1920&oh=abc',
    kind: 'image',
    filename: `Sandy Spirit Guide-fb-${rec.id}.jpg`,
  }]);
  expect(fbDlFilesOf(withCrop, 'posts')).toEqual([{
    url: rec.progressive,
    kind: 'video',
    filename: `Sandy Spirit Guide-fb-${rec.id}.mp4`,
  }]);
  expect(fbDlFilesOf({ id: rec.id, authorName: null, thumb: null, progressive: null }, 'posts', '61590925281317')).toEqual([{
    url: null,
    kind: 'video',
    filename: `61590925281317-fb-${rec.id}.mp4`,
  }]);
});
```

- [ ] **Step 2: Rodar os dois arquivos de teste para confirmar a falha**

Run: `npx vitest run src/lib/shared/fbVideoMedia.test.js src/lib/shared/fbReelActions.test.js`
Expected: FAIL (`rec.thumbs[0]` retorna `frame0.jpg` e `fbDlFilesOf` não está exportada)

- [ ] **Step 3: Implementar a ordem de `thumbs` em `src/lib/shared/fbVideoMedia.js` e `fbDlFilesOf` em `src/lib/shared/fbReelActions.js`**

Em `src/lib/shared/fbVideoMedia.js:43-45`, reordenar a lista de candidatos para que `o.preferred_thumbnail?.image?.uri`, `o.thumbnailImage?.uri`, `o.image?.uri`, `o.imageLargeAspect?.uri`, `o.imageFlexible?.uri`, `o.imageServerSelected?.uri` venham antes de `o.first_frame_thumbnail`.

Em `src/lib/shared/fbReelActions.js`, exportar `fbDlFilesOf(rec, kind, fallbackOwner = null)`:
- Prefixo base: `${fbAuthorSlug(rec?.authorName || fallbackOwner)}-fb-${rec?.id}`
- Quando `kind === "covers"`: `[{ url: fbMediaUrl(fullResThumb(rec?.thumb)), kind: "image", filename: `${base}.jpg` }]`
- Caso contrário (`"posts"`): `[{ url: fbMediaUrl(rec?.progressive), kind: "video", filename: `${base}.mp4` }]`

- [ ] **Step 4: Sincronizar regiões inline existentes e rodar os testes**

Run: `npm run gen:inline && npx vitest run src/lib/shared/fbVideoMedia.test.js src/lib/shared/fbReelActions.test.js src/lib/shared/fbReelsData.test.js src/lib/inline.test.js`
Expected: PASS em todas as suítes

- [ ] **Step 5: Commit local da Task 1**

```bash
git add src/lib/shared/fbVideoMedia.js src/lib/shared/fbVideoMedia.test.js src/lib/shared/fbReelActions.js src/lib/shared/fbReelActions.test.js src/content/fb/reels-capture.js src/content/fb/video-capture.js src/content/transcription/inject.js
git commit -m "fix(fb-reels): prefer custom reel cover over first frame and add fbDlFilesOf"
```

---

### Task 2: Estender `igHubButton.js` (`afterSync`) e `igDlButtons.js` (tema, stacking e copy do Facebook)

**Files:**
- Modify: `src/lib/shared/igHubButton.js:80-85,197-247`
- Modify: `src/lib/shared/igHubButton.test.js`
- Modify: `src/lib/shared/igDlButtons.js:13-50,80-165`
- Modify: `src/lib/shared/igDlButtons.test.js`

**Interfaces:**
- Consumes: nenhum módulo externo (ambos em `src/lib/shared/` são zero-import)
- Produces:
  - `startHubButton(platform, placeOf, afterSync = null) -> () => void` in `src/lib/shared/igHubButton.js` — chama `afterSync?.(btn, place)` após cada `sync()` (`(null, null)` fora de perfil e no `stop()`; `(null, place)` enquanto `place.anchor` ainda não montou)
  - `FB_DL_FOLDERS = { covers: "capas", posts: "reels" }` in `src/lib/shared/igDlButtons.js`
  - `igDlTip(kind, s, site = "instagram") -> string` in `src/lib/shared/igDlButtons.js`
  - `syncIgDlButtons(doc, { anchor, states, onClick, site = null, ring = null }) -> void` in `src/lib/shared/igDlButtons.js`

- [ ] **Step 1: Escrever os testes falhando em `src/lib/shared/igHubButton.test.js` e `src/lib/shared/igDlButtons.test.js`**

Adicionar em `src/lib/shared/igHubButton.test.js`:
```js
  it("notifies afterSync with the live Hub button on profile ticks and clears it off-profile or on stop", () => {
    vi.useFakeTimers();
    document.body.innerHTML = TT;
    const chrome = chromeStub({ profiles: {} });
    vi.stubGlobal("chrome", chrome);
    const seen = [];
    let current = { key: "61590925281317", anchor: document.querySelector(".circle"), site: "facebook", ring: "var(--surface-background, #fff)" };
    const stop = startHubButton("facebook", () => current, (btn, place) => seen.push([btn?.id || null, place?.key || null]));
    expect(seen.at(-1)).toEqual([HUB_BTN_ID, "61590925281317"]);
    current = { key: "61590925281317", anchor: null, site: "facebook" };
    vi.advanceTimersByTime(1000);
    expect(seen.at(-1)).toEqual([null, "61590925281317"]);
    current = null;
    vi.advanceTimersByTime(1000);
    expect(seen.at(-1)).toEqual([null, null]);
    stop();
    expect(seen.at(-1)).toEqual([null, null]);
  });
```

Adicionar em `src/lib/shared/igDlButtons.test.js` (importando `FB_DL_FOLDERS`):
```js
  it("adapts idle and empty tooltips for Facebook reels and off-tab profile views", () => {
    expect(FB_DL_FOLDERS).toEqual({ covers: "capas", posts: "reels" });
    expect(igDlTip("covers", { state: "idle", posts: 10 }, "facebook")).toBe("Baixar 10 capas");
    expect(igDlTip("posts", { state: "idle", posts: 10 }, "facebook")).toBe("Baixar 10 reels");
    expect(igDlTip("posts", { state: "idle", posts: 1 }, "facebook")).toBe("Baixar 1 reel");
    expect(igDlTip("covers", { state: "empty", posts: 0 }, "facebook")).toBe("Role a grade: nenhum reel carregado ainda");
    expect(igDlTip("posts", { state: "empty", posts: 0, offTab: true }, "facebook")).toBe(
      "Abra a aba Reels do perfil para baixar capas e reels",
    );
  });

  it("applies Facebook inline alignment, surface ring variable, and stacking CSS when site='facebook'", () => {
    document.body.innerHTML = HEADER;
    const hub = document.getElementById("fbw-hub-btn");
    syncIgDlButtons(document, {
      anchor: hub,
      site: "facebook",
      ring: "var(--surface-background, #fff)",
      states: { covers: { state: "idle", posts: 10 }, posts: { state: "idle", posts: 10 } },
      onClick() {},
    });
    const postsBtn = document.getElementById(IG_DL_IDS.posts);
    expect(postsBtn.dataset.site).toBe("facebook");
    expect(postsBtn.style.getPropertyValue("--fbw-dl-ring")).toBe("var(--surface-background, #fff)");
    expect(postsBtn.getAttribute("aria-label")).toBe("Baixar 10 reels");
    const css = document.getElementById("fbw-dl-btn-style").textContent;
    expect(css).toContain('.fbw-dl[data-site="facebook"]{vertical-align:middle;margin-left:4px}');
    expect(css).toContain("var(--fbw-dl-ring");
  });
```

- [ ] **Step 2: Rodar os testes para confirmar a falha**

Run: `npx vitest run src/lib/shared/igHubButton.test.js src/lib/shared/igDlButtons.test.js`
Expected: FAIL (`FB_DL_FOLDERS` indefinido, `afterSync` não chamado, atributos `data-site`/`--fbw-dl-ring` ausentes)

- [ ] **Step 3: Implementar `afterSync` em `src/lib/shared/igHubButton.js` e suporte a `site`/`ring`/`offTab` em `src/lib/shared/igDlButtons.js`**

Em `src/lib/shared/igHubButton.js`:
- Em `HUB_BTN_CSS`, adicionar `[role="main"] div:has(#${HUB_BTN_ID}:is(:hover,:focus-visible,.fbw-hub-tip)){z-index:5}` para evitar que linhas irmãs `z-index: 0` cubram o tooltip em perfis de nome curto no Facebook.
- Em `startHubButton(platform, placeOf, afterSync = null)`:
  - Em `sync()`:
    - Se `!place?.key`: `syncHubButton(document, { key: null }); afterSync?.(null, null); return;`
    - Se `!place.anchor`: `afterSync?.(null, place); return;`
    - Caso contrário: `const btn = syncHubButton(document, { key, state, onClick, place }); afterSync?.(btn, place);`
  - No cleanup retornado (`stop()`): chamar `afterSync?.(null, null)` logo após remover `#fbw-hub-btn`.

Em `src/lib/shared/igDlButtons.js`:
- Exportar `export const FB_DL_FOLDERS = { covers: "capas", posts: "reels" };`
- Em `IG_DL_CSS`:
  - Adicionar `.fbw-dl[data-site="facebook"]{vertical-align:middle;margin-left:4px}`
  - Trocar `box-shadow` de `.fbw-dl .fbw-dl-dot` para `0 0 0 2px var(--fbw-dl-ring, rgb(var(--ig-primary-background, 255, 255, 255)))`
  - Adicionar `letter-spacing:normal;text-transform:none;` em `.fbw-dl::after`
  - Adicionar `[role="main"] div:has(.fbw-dl:is(:hover,:focus-visible)){z-index:5}`
- Em `igDlTip(kind, s, site = "instagram")`:
  - Se `s.state === "empty"`: retornar `"Abra a aba Reels do perfil para baixar capas e reels"` quando `s.offTab`, ou `"Role a grade: nenhum reel carregado ainda"` quando `site === "facebook"`, mantendo `"Role a grade: nenhum post carregado ainda"` no padrão.
  - No retorno final (`idle`) quando `!covers` e `site === "facebook"`: retornar `Baixar ${plural(s.posts, "reel", "reels")}`.
- Em `syncIgDlButtons(doc, { anchor, states, onClick, site = null, ring = null })`:
  - Sincronizar `btn.dataset.site` quando `site` for passado, sincronizar `--fbw-dl-ring` quando `ring` for passado, e passar `site || "instagram"` para `igDlTip(kind, s, site || "instagram")`.

- [ ] **Step 4: Regenerar regiões inline e rodar os testes**

Run: `npm run gen:inline && npx vitest run src/lib/shared/igHubButton.test.js src/lib/shared/igDlButtons.test.js src/lib/inline.test.js`
Expected: PASS em todas as suítes

- [ ] **Step 5: Commit local da Task 2**

```bash
git add src/lib/shared/igHubButton.js src/lib/shared/igHubButton.test.js src/lib/shared/igDlButtons.js src/lib/shared/igDlButtons.test.js src/content/ig/bridge.js src/content/fb/reels-capture.js src/content/tt/tt-relay.js
git commit -m "feat(shared): support Facebook header layout and tooltips in igDlButtons and startHubButton"
```

---

### Task 3: Integrar os botões de download no cabeçalho de `src/content/fb/reels-capture.js`

**Files:**
- Modify: `scripts/gen-inline.mjs:56-60`
- Modify: `src/content/fb/reels-capture.js:2868-2892`
- Test: `src/content/fb/reels-capture.test.js`

**Interfaces:**
- Consumes:
  - `IG_DL_KINDS`, `FB_DL_FOLDERS`, `syncIgDlButtons`, `removeIgDlButtons` (inlinados de `src/lib/shared/igDlButtons.js`)
  - `fbDlFilesOf`, `fbAuthorSlug` (inlinados de `src/lib/shared/fbReelActions.js`)
  - `startHubButton` (inlinado de `src/lib/shared/igHubButton.js`)
  - `FBW_DL_MEDIA` message contract `{ type: "FBW_DL_MEDIA", platform: "facebook", kind: "image" | "video", url, filename, dir: [profileFolder, subfolder] }`
- Produces:
  - `#fbw-dl-covers` e `#fbw-dl-posts` montados logo após `#fbw-hub-btn` em perfis do Facebook, sincronizados em `startHubButton`, em `tick()` e a cada arquivo baixado.

- [ ] **Step 1: Adicionar `"src/lib/shared/igDlButtons.js"` em `scripts/gen-inline.mjs` e o marcador vazio em `src/content/fb/reels-capture.js`, depois escrever os testes falhando em `src/content/fb/reels-capture.test.js`**

Em `scripts/gen-inline.mjs`, no array `TARGETS["src/content/fb/reels-capture.js"]`, adicionar `"src/lib/shared/igDlButtons.js"` logo após `"src/lib/shared/igHubButton.js"`. Em `src/content/fb/reels-capture.js`, adicionar o bloco marcador `// <<< inline:src/lib/shared/igDlButtons.js` + `// >>> inline:end` logo após o fim de `igHubButton.js` e rodar `npm run gen:inline`.

Adicionar em `src/content/fb/reels-capture.test.js` testes cobrindo:
1. **Montagem no cabeçalho + download de capas e reels carregados:**
   - DOM com `<div role="main"><span dir="auto" style="font-size:32px"><div role="button">Sandy Spirit Guide</div></span></div>` e 2 tiles `<a href="/reel/11111111"><img src="https://scontent.fbcdn.net/c1.jpg?stp=dst-jpg&ctp=s960x960"><span>666</span></a>` e `<a href="/reel/22222222"><img src="https://scontent.fbcdn.net/c2.jpg?stp=dst-jpg&ctp=s960x960"><span>380</span></a>`.
   - Publicar `__fbwReelRecords` com `progressive` MP4 para `11111111` e `progressive: null` para `22222222`.
   - Verificar que `#fbw-dl-covers` e `#fbw-dl-posts` aparecem exatamente após `#fbw-hub-btn` com `aria-label` `"Baixar 2 capas"` e `"Baixar 2 reels"`.
   - Clicar em `#fbw-dl-covers` → verificar 2 chamadas `FBW_DL_MEDIA` com `dir: ["Sandy Spirit Guide", "capas"]`, `kind: "image"`, URLs sem `ctp=`, e estado final `data-state="done"`.
   - Clicar em `#fbw-dl-posts` → verificar 1 chamada `FBW_DL_MEDIA` para `11111111` (`dir: ["Sandy Spirit Guide", "reels"]`, `kind: "video"`) e estado final `data-state="partial"` com `aria-label` contendo `"1 de 2 baixados"` e `"1 vídeo ainda sem link: espere uns segundos."`.
   - Publicar `__fbwReelRecords` entregando `progressive` de `22222222` e clicar novamente em `#fbw-dl-posts` → verificar que **apenas** `22222222` é baixado na retentativa e o botão passa para `data-state="done"`.
2. **Aba fora de Reels (`All` / `Photos`):**
   - Em `https://www.facebook.com/profile.php?id=61590925281317` (sem `sk=reels_tab`), verificar `data-state="empty"`, `aria-disabled="true"` e `aria-label="Abra a aba Reels do perfil para baixar capas e reels"`.
3. **Cancelamento no clique em `busy` e limpeza em `__fbwReelsTakeover`:**
   - Durante download em andamento (`busy`), um segundo clique marca `stopped` (`Parado: 1 de 2 baixados. Falta 1: clique para continuar`).
   - Ao receber `window.postMessage({ __fbwReelsTakeover: "new-gen" })`, `#fbw-hub-btn`, `#fbw-dl-covers` e `#fbw-dl-posts` são removidos do DOM.

- [ ] **Step 2: Rodar `src/content/fb/reels-capture.test.js` para confirmar a falha**

Run: `npx vitest run src/content/fb/reels-capture.test.js`
Expected: FAIL (`#fbw-dl-covers` e `#fbw-dl-posts` ainda não são criados por `reels-capture.js`)

- [ ] **Step 3: Implementar `fbDlStates`, `syncFbDl` e `onFbDlClick` em `src/content/fb/reels-capture.js`**

Em `src/content/fb/reels-capture.js` (logo após `fbNameAnchor()`):
```js
  const dlJobs = { covers: null, posts: null };
  let lastHubBtn = null;
  let lastHubPlace = null;

  async function dlMedia(msg) {
    const res = await chrome.runtime.sendMessage(msg);
    if (!res || res.ok === false) throw new Error(res?.error || "download falhou");
  }

  function fbDlStates() {
    const surf = currentSurface();
    if (!surf?.startsWith("profile:")) {
      const emptyOff = { state: "empty", posts: 0, offTab: true };
      return { covers: emptyOff, posts: emptyOff };
    }
    const posts = collect().length;
    const states = {};
    for (const kind of IG_DL_KINDS) {
      const job = dlJobs[kind];
      states[kind] = job && job.surface === surf ? { ...job, posts } : { state: posts ? "idle" : "empty", posts };
    }
    return states;
  }

  function syncFbDl() {
    if (disabled || !lastHubBtn?.isConnected) {
      removeIgDlButtons(document);
      return;
    }
    syncIgDlButtons(document, {
      anchor: lastHubBtn,
      site: "facebook",
      ring: lastHubPlace?.ring || "var(--surface-background, #fff)",
      states: fbDlStates(),
      onClick: (kind) => void onFbDlClick(kind),
    });
  }

  async function onFbDlClick(kind) {
    const surf = currentSurface();
    const key = lastHubPlace?.key;
    if (!surf?.startsWith("profile:") || !key) return;
    const job = dlJobs[kind]?.surface === surf ? dlJobs[kind] : null;
    if (job?.state === "busy") { job.stop = true; return; }
    const records = collect();
    const owner = ownerName() || records.find((r) => r.authorName)?.authorName || key;
    const all = records.flatMap((r) => fbDlFilesOf(r, kind, owner));
    const files = job?.state === "partial" ? all.filter((f) => job.left.has(f.filename)) : all;
    if (!files.length) return;
    const dir = [fbAuthorSlug(owner), FB_DL_FOLDERS[kind]];
    const run = { surface: surf, state: "busy", total: files.length, done: 0, noLink: 0, stop: false, stopped: false, left: new Set() };
    dlJobs[kind] = run;
    syncFbDl();
    for (const f of files) {
      if (run.stop || disabled || currentSurface() !== surf) { run.left.add(f.filename); continue; }
      if (!f.url) { run.noLink += 1; run.left.add(f.filename); continue; }
      try {
        await dlMedia({ type: "FBW_DL_MEDIA", platform: "facebook", kind: f.kind, url: f.url, filename: f.filename, dir });
        run.done += 1;
      } catch {
        run.left.add(f.filename);
      }
      syncFbDl();
    }
    run.state = run.left.size ? "partial" : "done";
    run.stopped = run.stop && run.left.size > 0;
    syncFbDl();
  }
```
- Passar `(btn, place) => { lastHubBtn = btn; lastHubPlace = place; syncFbDl(); }` como 3º argumento (`afterSync`) de `startHubButton("facebook", ..., afterSync)`.
- Chamar `if (lastHubBtn?.isConnected) syncFbDl();` também ao final de `tick()` para refletir imediatamente novos reels carregados durante a rolagem sem esperar o ciclo de 1 s.

- [ ] **Step 4: Rodar os testes e checar regiões inline**

Run: `npm run gen:inline && npx vitest run src/content/fb/reels-capture.test.js src/lib/inline.test.js`
Expected: PASS

- [ ] **Step 5: Commit local da Task 3**

```bash
git add scripts/gen-inline.mjs src/content/fb/reels-capture.js src/content/fb/reels-capture.test.js
git commit -m "feat(fb-reels): add Baixar capas and Baixar reels buttons to Facebook profile header"
```

---

### Task 4: Verificação Completa (Suíte, Build Privado, Build Público e Validação ao Vivo no Chrome)

**Files:**
- Modify (apenas após validação ao vivo com sucesso): `package.json`, `manifest.config.js`, `CHANGELOG.md`

**Interfaces:**
- Consumes: todas as tarefas anteriores
- Produces: build `dist/` e `dist-public/` validados + release local tagueada conforme regras do projeto

- [ ] **Step 1: Rodar toda a suíte de testes e ambos os builds (privado + público)**

Run: `npm test && npm run build && npm run build:public && npm run verify:public`
Expected: Todas as suítes verdes, `dist/` e `dist-public/` gerados sem warnings de região stale, e `verify-public: clean`.

- [ ] **Step 2: Validar ao vivo no Chrome compartilhado sobre o perfil de referência**

Seguindo as regras globais de automação de browser:
1. Iniciar `~/.local/bin/open-agent-chrome`
2. Abrir aba nova: `AGENT_BROWSER_AUTO_CONNECT=1 agent-browser tab new "https://www.facebook.com/profile.php?id=61590925281317&sk=reels_tab"`
3. Verificar visualmente (com screenshot) os botões `#fbw-dl-covers` e `#fbw-dl-posts` alinhados ao lado de `#fbw-hub-btn`, os tooltips em hover (`Baixar 10 capas` / `Baixar 10 reels`), a aba `All` (`Abra a aba Reels do perfil para baixar capas e reels`), e testar um clique real em Capas e Reels verificando os arquivos em `~/Downloads` (`1080×1920` JPEG da capa customizada e MP4 reproduzível).
4. Fechar a aba criada (`agent-browser tab close`) e encerrar o Chrome compartilhado (`python3 ~/.claude/hooks/close-shared-chrome.py </dev/null`).

- [ ] **Step 3: Atualizar `CHANGELOG.md`, bumpar versão em `package.json` e `manifest.config.js` (`1.45.0`), validar build e criar commit + tag anotada local**

Run: `npm test && npm run build`
Expected: PASS, seguido de:
```bash
git add CHANGELOG.md package.json manifest.config.js
git commit -m "release: 1.45.0 — Baixar capas and Baixar reels in a Facebook profile's header"
git tag -a v1.45.0 -m "1.45.0 — Baixar capas and Baixar reels in a Facebook profile's header"
```
*(Não fazer `git push` até solicitação explícita.)*
