#!/usr/bin/env python3
"""Generate small, canonical PyTorch fixtures for the MDX DSP port.

Run with ../voice-lab/.venv/bin/python scripts/generate-mdx-fixtures.py.
The large model is deliberately not involved: these fixtures pin the CPU DSP
stages around it, while demix fixtures use an identity inference function.
"""

import json
import math
from pathlib import Path

import numpy as np
import torch


N_FFT = 7680
HOP_LENGTH = 1024
DIM_F = 3072
DIM_T = 256
TRIM = N_FFT // 2
CHUNK_SIZE = HOP_LENGTH * (DIM_T - 1)
GEN_SIZE = CHUNK_SIZE - 2 * TRIM
OVERLAP = 0.25
STEP = int((1 - OVERLAP) * CHUNK_SIZE)

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "src" / "lib" / "dsp" / "fixtures"
WINDOW = torch.hann_window(N_FFT, periodic=True)


def fixture_wave(length: int, peak: float = 0.72) -> np.ndarray:
    i = np.arange(length, dtype=np.float64)
    left = (
        0.48 * np.sin(2 * math.pi * 437.0 * i / 44100)
        + 0.17 * np.cos(2 * math.pi * 7331.0 * i / 44100)
        + 0.07 * np.sin(2 * math.pi * 19000.0 * i / 44100)
    )
    right = (
        0.36 * np.cos(2 * math.pi * 911.0 * i / 44100)
        - 0.21 * np.sin(2 * math.pi * 12003.0 * i / 44100)
        + 0.05 * np.cos(2 * math.pi * 43.0 * i / 44100)
    )
    wave = np.stack((left, right)).astype(np.float32)
    wave *= np.float32(peak / np.max(np.abs(wave)))
    return wave


def mdx_stft(wave: np.ndarray) -> torch.Tensor:
    tensor = torch.from_numpy(wave)
    spec = torch.stft(
        tensor,
        n_fft=N_FFT,
        hop_length=HOP_LENGTH,
        window=WINDOW,
        center=True,
        return_complex=False,
    )
    return spec.permute(0, 3, 1, 2).reshape(4, -1, spec.shape[-2])[:, :DIM_F, :]


def mdx_istft(spec: torch.Tensor) -> torch.Tensor:
    padded = torch.nn.functional.pad(spec, (0, 0, 0, N_FFT // 2 + 1 - DIM_F))
    complex_spec = padded.reshape(2, 2, N_FFT // 2 + 1, DIM_T).permute(0, 2, 3, 1)
    complex_spec = torch.view_as_complex(complex_spec.contiguous())
    return torch.istft(
        complex_spec,
        n_fft=N_FFT,
        hop_length=HOP_LENGTH,
        window=WINDOW,
        center=True,
    )


def identity_demix(wave: np.ndarray) -> np.ndarray:
    length = wave.shape[1]
    peak = np.max(np.abs(wave))
    normalized = wave.copy()
    if peak > 0.9:
        normalized *= np.float32(0.9 / peak)

    pad = GEN_SIZE + TRIM - (length % GEN_SIZE)
    mixture = np.concatenate(
        (np.zeros((2, TRIM), np.float32), normalized, np.zeros((2, pad), np.float32)),
        axis=1,
    )
    result = np.zeros((2, mixture.shape[1]), np.float32)
    divider = np.zeros(mixture.shape[1], np.float32)
    for start in range(0, mixture.shape[1], STEP):
        end = min(start + CHUNK_SIZE, mixture.shape[1])
        actual = end - start
        chunk = np.zeros((2, CHUNK_SIZE), np.float32)
        chunk[:, :actual] = mixture[:, start:end]
        spec = mdx_stft(chunk)
        spec[:, :3, :] = 0
        restored = mdx_istft(spec).numpy()
        window = np.hanning(actual)
        restored[:, :actual] *= window
        result[:, start:end] += restored[:, :actual]
        divider[start:end] += window

    output = result[:, TRIM : -TRIM] / divider[None, TRIM : -TRIM]
    output = output[:, :length] * np.float32(peak)
    output_peak = np.max(np.abs(output))
    if output_peak > 0.9:
        output *= np.float32(0.9 / output_peak)
    return output.astype(np.float32)


def save_f32(name: str, values) -> None:
    np.asarray(values, dtype="<f4").tofile(OUT / name)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)

    i = np.arange(N_FFT, dtype=np.float64)
    fft_input = np.stack(
        (
            0.3 * np.sin(2 * math.pi * 17 * i / N_FFT) + 0.11 * np.cos(2 * math.pi * 103 * i / N_FFT),
            0.07 * np.sin(2 * math.pi * 61 * i / N_FFT),
        ),
        axis=1,
    ).astype(np.float32)
    fft_expected = torch.fft.fft(torch.view_as_complex(torch.from_numpy(fft_input))).numpy()
    save_f32("fft-input.f32", fft_input)
    save_f32("fft-expected.f32", np.stack((fft_expected.real, fft_expected.imag), axis=1))

    chunk = fixture_wave(CHUNK_SIZE)
    spec = mdx_stft(chunk)
    probe_channels = [0, 1, 2, 3]
    probe_bins = [0, 1, 2, 3, 31, 256, 1024, 3071]
    probe_frames = [0, 1, 37, 128, 255]
    probes = [spec[c, f, t] for c in probe_channels for f in probe_bins for t in probe_frames]
    save_f32("stft-probes.f32", torch.stack(probes).numpy())

    restored = mdx_istft(spec)
    save_f32("cropped-istft.f32", restored.numpy())

    short_length = 12000
    multi_length = 300000
    save_f32("demix-short.f32", identity_demix(fixture_wave(short_length, 0.62)))
    save_f32("demix-multichunk.f32", identity_demix(fixture_wave(multi_length, 0.84)))

    metadata = {
        "n_fft": N_FFT,
        "chunk_size": CHUNK_SIZE,
        "short_length": short_length,
        "multi_length": multi_length,
        "probe_channels": probe_channels,
        "probe_bins": probe_bins,
        "probe_frames": probe_frames,
    }
    (OUT / "metadata.json").write_text(json.dumps(metadata, indent=2) + "\n")


if __name__ == "__main__":
    main()
