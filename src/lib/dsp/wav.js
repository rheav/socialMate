// PCM16 RIFF/WAVE. The caller feeds the bytes to the bundled libmp3lame encoder.
export function encodeWav(channels, sampleRate = 44100) {
  if (!Array.isArray(channels) || channels.length < 1 || channels.length > 2)
    throw new Error('WAV requires one or two channels');
  const length = channels[0].length;
  if (channels.some(c => !(c instanceof Float32Array) || c.length !== length))
    throw new Error('WAV channels must be Float32Array with equal length');
  if (!Number.isInteger(sampleRate) || sampleRate <= 0 || sampleRate > 384000) throw new Error('Invalid sample rate');
  const block = channels.length * 2, size = length * block;
  if (size > 0xffffffff - 36) throw new Error('Audio exceeds WAV size limit');
  const bytes = new Uint8Array(44 + size), view = new DataView(bytes.buffer);
  const text = (offset, value) => { for (let i = 0; i < value.length; i++) bytes[offset + i] = value.charCodeAt(i); };
  text(0, 'RIFF'); view.setUint32(4, 36 + size, true); text(8, 'WAVE'); text(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, channels.length, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * block, true);
  view.setUint16(32, block, true); view.setUint16(34, 16, true);
  text(36, 'data'); view.setUint32(40, size, true);
  let offset = 44;
  for (let i = 0; i < length; i++) for (const c of channels) {
    if (!Number.isFinite(c[i])) throw new Error('WAV samples must be finite');
    view.setInt16(offset, Math.max(-1, Math.min(1, c[i])) * 32767, true);
    offset += 2;
  }
  return bytes;
}
