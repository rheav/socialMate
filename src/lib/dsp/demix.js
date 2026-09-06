import { stft, istft, CHUNK_SIZE, TRIM, DIM_F, DIM_T, SPECTRUM_SIZE } from './stft.js';

export const GEN_SIZE = CHUNK_SIZE - 2 * TRIM;
export const STEP = Math.floor(0.75 * CHUNK_SIZE);

export async function separateVocals(channels, infer, onProgress = () => {}) {
  if (!Array.isArray(channels) || channels.length !== 2 || channels.some(c => !(c instanceof Float32Array)))
    throw new Error('MDX requires stereo Float32Array channels');
  const n = channels[0].length;
  if (channels[1].length !== n) throw new Error('Stereo channels must have equal length');
  if (!n) throw new Error('Audio is empty');
  let peak = 0;
  for (const c of channels) for (const value of c) {
    if (!Number.isFinite(value)) throw new Error('Audio must contain finite samples');
    peak = Math.max(peak, Math.abs(value));
  }
  // Match audio-separator separate(): normalize only above .9 before demix,
  // multiply the primary stem by the original peak, then the writer caps at .9.
  // compensate=1.021 belongs only to the secondary instrumental subtraction.
  const gain = Math.fround(peak > 0.9 ? 0.9 / peak : 1);
  const pad = GEN_SIZE + TRIM - n % GEN_SIZE;
  const length = TRIM + n + pad;
  const result = [new Float32Array(length), new Float32Array(length)];
  const divider = new Float32Array(length);
  const chunks = Math.ceil(length / STEP);
  const chunk = [new Float32Array(CHUNK_SIZE), new Float32Array(CHUNK_SIZE)];
  let done = 0;
  for (let start = 0; start < length; start += STEP) {
    const actual = Math.min(CHUNK_SIZE, length - start);
    for (let c = 0; c < 2; c++) {
      chunk[c].fill(0);
      const first = Math.max(start, TRIM), end = Math.min(start + actual, TRIM + n);
      for (let at = first; at < end; at++) chunk[c][at - start] = channels[c][at - TRIM] * gain;
    }
    const spectrum = stft(chunk);
    for (let c = 0; c < 4; c++) spectrum.fill(0, c * DIM_F * DIM_T, c * DIM_F * DIM_T + 3 * DIM_T);
    const pred = await infer(spectrum);
    if (!(pred instanceof Float32Array) || pred.length !== SPECTRUM_SIZE) throw new Error('Invalid inference output shape');
    const wave = istft(pred);
    for (let i = 0; i < actual; i++) {
      const win = actual === 1 ? 1 : 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (actual - 1));
      divider[start + i] += win;
      for (let c = 0; c < 2; c++) result[c][start + i] += Math.fround(wave[c][i] * win);
    }
    try { onProgress(++done, chunks); } catch { /* advisory */ }
  }
  const out = [new Float32Array(n), new Float32Array(n)];
  let outputPeak = 0;
  for (let i = 0; i < n; i++) {
    const at = i + TRIM;
    for (let c = 0; c < 2; c++) {
      const value = Math.fround(Math.fround(result[c][at] / divider[at]) * peak);
      if (!Number.isFinite(value)) throw new Error('Invalid inference output samples');
      out[c][i] = value;
      outputPeak = Math.max(outputPeak, Math.abs(value));
    }
  }
  if (outputPeak > 0.9) {
    const scale = Math.fround(0.9 / outputPeak);
    for (const c of out) for (let i = 0; i < n; i++) c[i] *= scale;
  }
  return out;
}
