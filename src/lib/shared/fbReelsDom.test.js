// @vitest-environment happy-dom
import { expect, it } from 'vitest';
import { fbTileCount, fbPlayerMatches } from './fbReelsDom.js';
it('reads native views without injected button/progress/metric text', () => {
  const a=document.createElement('a');
  a.innerHTML='<img><span>4.4K</span><div class="sw-fbr"><button>125</button><span>32</span></div><div class="fbw-acts">Baixar</div>';
  expect(fbTileCount(a)).toBe(4400);
});
it('refuses a previous player while the URL has already advanced', () => {
  expect(fbPlayerMatches({id:'12345678',duration:87},{duration:10},'12345678')).toBe(false);
  expect(fbPlayerMatches({id:'12345678',duration:87},{duration:87},'99999999')).toBe(false);
  expect(fbPlayerMatches({id:'12345678',duration:87},{duration:87},'12345678')).toBe(true);
});
