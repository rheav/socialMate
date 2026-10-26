// Puts the large binaries the extension ships into public/: the Whisper model, the
// voice-separation model, the ffmpeg core and the ONNX Runtime wasm. They are not in
// git (≈190 MB); every file is pinned to an upstream address and a sha256, and a file
// already present with the right hash is left alone.
//
//   npm run setup
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const ROOT = new URL("../", import.meta.url).pathname;
// onnx-community/whisper-base at the commit these files were taken from.
const WHISPER = "https://huggingface.co/onnx-community/whisper-base/resolve/1846881b6b3a3024392c1eea3ad983695bc23925";
const FFMPEG = "https://unpkg.com/@ffmpeg/core@0.12.10/dist/esm";
const UVR = "https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models";

const ASSETS = [
  ["models/Xenova/whisper-base/config.json", `${WHISPER}/config.json`, "f4d0608f7d918166da7edb3e188de5ef1bfe70d9802e785d271fd88111e9cf4b"],
  ["models/Xenova/whisper-base/generation_config.json", `${WHISPER}/generation_config.json`, "61070cf8de25b1e9256e8e102ded49d8d24a8369ed36ef84fdf21549e68125a0"],
  ["models/Xenova/whisper-base/preprocessor_config.json", `${WHISPER}/preprocessor_config.json`, "a6a76d28c93edb273669eb9e0b0636a2bddbb1272c3261e47b7ca6dfdbac1b8d"],
  ["models/Xenova/whisper-base/tokenizer.json", `${WHISPER}/tokenizer.json`, "27fc476bfe7f17299480be2273fc0608e4d5a99aba2ab5dec5374b4482d1a566"],
  ["models/Xenova/whisper-base/tokenizer_config.json", `${WHISPER}/tokenizer_config.json`, "2e036e4dbacfdeb7242c7d4ec4149f4a16e86026048f94d1637e3a8ee9c6a573"],
  ["models/Xenova/whisper-base/onnx/decoder_model_merged_quantized.onnx", `${WHISPER}/onnx/decoder_model_merged_quantized.onnx`, "fa3ef9902734ce5ae6f9ef2bdb2ba9a6c4b5785b09f4f420ce036573dc9d090b"],
  ["models/Xenova/whisper-base/onnx/encoder_model_quantized.onnx", `${WHISPER}/onnx/encoder_model_quantized.onnx`, "5862993336bf33acd23736071aae2b32261d3b1b2f37780194460d4ef974dd46"],
  ["models/mdx/UVR-MDX-NET-Voc_FT.onnx", `${UVR}/UVR-MDX-NET-Voc_FT.onnx`, "534b2070fcc7df514b13ef660dc8cbb328679c2374d04354a5c42bb14ecce111"],
  ["ffmpeg/ffmpeg-core.js", `${FFMPEG}/ffmpeg-core.js`, "67a48f11645f85439f3fde4f2119042c16b374b910206b7a7a24f342e28dcae3"],
  ["ffmpeg/ffmpeg-core.wasm", `${FFMPEG}/ffmpeg-core.wasm`, "9f57947a5bd530d8f00c5b3f2cb2a3492faa7e5d823315342d6a8656d0a6b7b7"],
];
// Same build as the onnxruntime-web the transformers package resolves; copied, not downloaded.
const ORT = ["ort-wasm-simd-threaded.jsep.wasm", "ort-wasm-simd-threaded.jsep.mjs"];

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

let fetched = 0;
for (const [rel, url, hash] of ASSETS) {
  const out = join(ROOT, "public", rel);
  if (existsSync(out) && sha256(readFileSync(out)) === hash) continue;
  process.stdout.write(`${rel} … `);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const got = sha256(buf);
  if (got !== hash) throw new Error(`${rel}: sha256 ${got}, expected ${hash}`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, buf);
  fetched++;
  console.log(`${(buf.length / 1024 ** 2).toFixed(1)} MB`);
}
mkdirSync(join(ROOT, "public/assets"), { recursive: true });
for (const f of ORT) copyFileSync(join(ROOT, "node_modules/onnxruntime-web/dist", f), join(ROOT, "public/assets", f));
console.log(fetched ? `setup: ${fetched} file(s) fetched` : "setup: all assets present");
