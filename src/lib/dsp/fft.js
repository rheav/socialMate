// Cooley–Tukey with radix 2/3/5. MDX's 7680-point transform cannot use a
// radix-2-only library. Twiddles and butterfly scratch are reused across frames.
export class MixedRadixFFT {
  constructor(size) {
    if (!Number.isInteger(size) || size < 1) throw new Error('Invalid FFT size');
    let rest = size;
    for (const factor of [2, 3, 5]) while (rest > 1 && rest % factor === 0) rest /= factor;
    if (rest !== 1) throw new Error('FFT size must have only factors 2, 3, 5');
    this.size = size;
    this.cos = Float64Array.from({ length: size }, (_, k) => Math.cos(2 * Math.PI * k / size));
    this.sin = Float64Array.from({ length: size }, (_, k) => Math.sin(2 * Math.PI * k / size));
    this.scratchRe = new Float64Array(5);
    this.scratchIm = new Float64Array(5);
  }

  transformInto(real, imag, outRe, outIm, inverse = false) {
    const size = this.size;
    if ([real, imag, outRe, outIm].some(x => x.length !== size)) throw new Error('FFT input size mismatch');
    if (real === outRe || real === outIm || imag === outRe || imag === outIm)
      throw new Error('FFT input and output must be separate buffers');
    const sign = inverse ? 1 : -1;
    const cos = this.cos, sin = this.sin, scratchRe = this.scratchRe, scratchIm = this.scratchIm;
    function work(n, offset, stride, dest) {
      if (n === 1) { outRe[dest] = real[offset]; outIm[dest] = imag[offset]; return; }
      const radix = n % 2 === 0 ? 2 : n % 3 === 0 ? 3 : 5;
      const m = n / radix, twiddleStep = size / n;
      for (let j = 0; j < radix; j++) work(m, offset + j * stride, stride * radix, dest + j * m);
      for (let k = 0; k < m; k++) {
        if (radix === 2) {
          const a = dest + k, b = a + m, tw = k * twiddleStep;
          const c = cos[tw], s = sign * sin[tw];
          const br = outRe[b] * c - outIm[b] * s;
          const bi = outRe[b] * s + outIm[b] * c;
          outRe[b] = outRe[a] - br; outIm[b] = outIm[a] - bi;
          outRe[a] += br; outIm[a] += bi;
        } else {
          for (let j = 0; j < radix; j++) { scratchRe[j] = outRe[dest + j * m + k]; scratchIm[j] = outIm[dest + j * m + k]; }
          for (let r = 0; r < radix; r++) {
            let re = scratchRe[0], im = scratchIm[0];
            for (let j = 1; j < radix; j++) {
              const tw = (j * (k + r * m) * twiddleStep) % size;
              const c = cos[tw], s = sign * sin[tw];
              re += scratchRe[j] * c - scratchIm[j] * s;
              im += scratchRe[j] * s + scratchIm[j] * c;
            }
            outRe[dest + r * m + k] = re; outIm[dest + r * m + k] = im;
          }
        }
      }
    }
    work(size, 0, 1, 0);
    if (inverse) for (let i = 0; i < size; i++) { outRe[i] /= size; outIm[i] /= size; }
    return [outRe, outIm];
  }

  forward(real, imag = new Float64Array(this.size)) {
    return this.transformInto(real, imag, new Float64Array(this.size), new Float64Array(this.size));
  }
  inverse(real, imag) {
    return this.transformInto(real, imag, new Float64Array(this.size), new Float64Array(this.size), true);
  }
}
