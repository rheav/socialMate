import { MixedRadixFFT } from './fft.js';

export const SAMPLE_RATE = 44100;
export const N_FFT = 7680;
export const HOP_LENGTH = 1024;
export const DIM_F = 3072;
export const DIM_T = 256;
export const TRIM = N_FFT / 2;
export const CHUNK_SIZE = HOP_LENGTH * (DIM_T - 1);
export const SPECTRUM_SIZE = 4 * DIM_F * DIM_T;

// Periodic Hann inside STFT; the outer demix loop uses a symmetric Hann.
const window = Float64Array.from({ length: N_FFT }, (_, k) => 0.5 - 0.5 * Math.cos(2 * Math.PI * k / N_FFT));
const fft = new MixedRadixFFT(N_FFT);
const inputRe = new Float64Array(N_FFT), inputIm = new Float64Array(N_FFT);
const outputRe = new Float64Array(N_FFT), outputIm = new Float64Array(N_FFT);
const envelope = new Float64Array(CHUNK_SIZE + N_FFT);
for (let frame = 0; frame < DIM_T; frame++) {
  const start = frame * HOP_LENGTH;
  for (let k = 0; k < N_FFT; k++) envelope[start + k] += window[k] * window[k];
}
const reflect = (i) => i < 0 ? -i : i >= CHUNK_SIZE ? 2 * CHUNK_SIZE - 2 - i : i;

// Pack L + iR into one complex FFT to transform both real audio channels in
// half the work. Unpack into [L.real,L.imag,R.real,R.imag], frequency-major.
export function stft(channels) {
  if (channels.length !== 2 || channels.some(c => c.length !== CHUNK_SIZE)) throw new Error('STFT requires one stereo MDX chunk');
  const spectrum = new Float32Array(SPECTRUM_SIZE);
  const plane = DIM_F * DIM_T;
  for (let t = 0; t < DIM_T; t++) {
    const start = t * HOP_LENGTH - TRIM;
    for (let k = 0; k < N_FFT; k++) {
      const i = reflect(start + k);
      inputRe[k] = channels[0][i] * window[k];
      inputIm[k] = channels[1][i] * window[k];
    }
    fft.transformInto(inputRe, inputIm, outputRe, outputIm);
    for (let f = 0; f < DIM_F; f++) {
      const mirror = f ? N_FFT - f : 0, idx = f * DIM_T + t;
      spectrum[idx] = (outputRe[f] + outputRe[mirror]) / 2;
      spectrum[plane + idx] = (outputIm[f] - outputIm[mirror]) / 2;
      spectrum[2 * plane + idx] = (outputIm[f] + outputIm[mirror]) / 2;
      spectrum[3 * plane + idx] = (outputRe[mirror] - outputRe[f]) / 2;
    }
  }
  return spectrum;
}

export function istft(spectrum) {
  if (spectrum.length !== SPECTRUM_SIZE) throw new Error('ISTFT spectrum size mismatch');
  const left = new Float64Array(envelope.length), right = new Float64Array(envelope.length);
  const plane = DIM_F * DIM_T;
  for (let t = 0; t < DIM_T; t++) {
    inputRe.fill(0); inputIm.fill(0); // dropped high-frequency bins stay zero
    for (let f = 0; f < DIM_F; f++) {
      const idx = f * DIM_T + t;
      const lr = spectrum[idx], li = f ? spectrum[plane + idx] : 0;
      const rr = spectrum[2 * plane + idx], ri = f ? spectrum[3 * plane + idx] : 0;
      inputRe[f] = lr - ri; inputIm[f] = li + rr;
      if (f) { inputRe[N_FFT - f] = lr + ri; inputIm[N_FFT - f] = -li + rr; }
    }
    fft.transformInto(inputRe, inputIm, outputRe, outputIm, true);
    const start = t * HOP_LENGTH;
    for (let k = 0; k < N_FFT; k++) {
      left[start + k] += outputRe[k] * window[k];
      right[start + k] += outputIm[k] * window[k];
    }
  }
  const out = [new Float32Array(CHUNK_SIZE), new Float32Array(CHUNK_SIZE)];
  for (let i = 0; i < CHUNK_SIZE; i++) {
    const at = i + TRIM; // torch.istft(center=True), inferred original length
    out[0][i] = left[at] / envelope[at];
    out[1][i] = right[at] / envelope[at];
  }
  return out;
}
