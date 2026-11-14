#!/usr/bin/env python3
"""Records the first run's Listen clips with Kokoro (voice Emma, bf_emma, British English), offline.

One clip per first-run step: the step's heading and its one sentence, exactly the strings Listen reads
(public/v2/core/firstrun.js SPOKEN, text from public/v2/strings/en.js, read through node so the words are
the app's own). Writes public/v2/voice/en/<step>.ogg (Opus) and manifest.json with a SHA-256 of each
clip's source text, which test/unit/v2/voice-clips.test.ts checks, so a copy edit cannot ship a stale
clip. No API key and no network service: the model runs on this computer. The model, the voice and the
config are downloaded once from Hugging Face at pinned revisions and checked against SHA-256 hashes.

Modelled on flash-mobile's scripts/voice-audition/generate.py (same model export, revision and hashes).
Setup and run, from the repo root (the venv and the model cache sit in .tmp/, which git ignores):

    uv venv --python 3.11 .tmp/voice/venv
    uv pip install --python .tmp/voice/venv/bin/python -r scripts/record-voice/requirements.lock
    .tmp/voice/venv/bin/python scripts/record-voice/record.py

Kokoro-82M and its voices are Apache-2.0 (public/vendor/licenses/kokoro.txt). Misaki and its
eSpeak fallback only turn the text into phonemes on this computer; they are not shipped.
"""
import argparse
import hashlib
import json
import pathlib
import subprocess
import urllib.request

import numpy as np
import onnxruntime as ort
import soundfile as sf
from misaki import en
from misaki.espeak import EspeakFallback

ROOT = pathlib.Path(__file__).resolve().parents[2]
MODEL_REPO = "onnx-community/Kokoro-82M-v1.0-ONNX"
MODEL_REVISION = "1939ad2a8e416c0acfeecc08a694d14ef25f2231"
MODEL_FILE = ("onnx/model_quantized.onnx", "fbae9257e1e05ffc727e951ef9b9c98418e6d79f1c9b6b13bd59f5c9028a1478")
VOICE = ("bf_emma", "669fe0647f9dd04fcab92f1439a40eeb4c8b4ab1f82e4996fe3d918ce4a63b73")
CONFIG_URL = "https://huggingface.co/hexgrad/Kokoro-82M/resolve/f3ff3571791e39611d31c381e3a41a3af07b4987/config.json"
CONFIG_SHA = "5abb01e2403b072bf03d04fde160443e209d7a0dad49a423be15196b9b43c17f"
RATE = 24000
# A little slower than Kokoro's default, for people who are new to this and may not read well.
SPEED = 0.9

# The first run's spoken strings, read from the app's own modules.
READ_STRINGS = """
const strings = (await import(process.argv[1] + '/public/v2/strings/en.js')).default;
const { SPOKEN, STEPS } = await import(process.argv[1] + '/public/v2/core/firstrun.js');
console.log(JSON.stringify(STEPS.map((step) => ({ step, keys: SPOKEN[step], pieces: SPOKEN[step].map((k) => strings[k]) }))));
"""


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def fetch(cache: pathlib.Path, url: str, name: str, digest: str) -> pathlib.Path:
    target = cache / name
    if not target.exists():
        urllib.request.urlretrieve(url, target)
    if sha(target.read_bytes()) != digest:
        target.unlink()
        raise ValueError(f"hash mismatch for {name}: deleted it, run again to download it afresh")
    return target


def text_hash(pieces: list) -> str:
    """The hash of a clip's source: its strings joined by newlines (the test computes the same)."""
    return sha("\n".join(pieces).encode("utf-8"))


def spoken(pieces: list) -> str:
    """What is said: each piece as a sentence, so the heading is followed by a pause."""
    return " ".join(p if p.rstrip()[-1:] in ".!?" else p.rstrip() + "." for p in pieces)


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--cache", type=pathlib.Path, default=ROOT / ".tmp/voice/assets", help="model download cache (default .tmp/voice/assets)")
    parser.add_argument("--out", type=pathlib.Path, default=ROOT / "public/v2/voice/en", help="where the clips and manifest.json go")
    args = parser.parse_args()
    args.cache.mkdir(parents=True, exist_ok=True)
    args.out.mkdir(parents=True, exist_ok=True)

    base = f"https://huggingface.co/{MODEL_REPO}/resolve/{MODEL_REVISION}/"
    model = fetch(args.cache, base + MODEL_FILE[0], "model_quantized.onnx", MODEL_FILE[1])
    voice_file = fetch(args.cache, base + f"voices/{VOICE[0]}.bin", f"{VOICE[0]}.bin", VOICE[1])
    config = json.loads(fetch(args.cache, CONFIG_URL, "hexgrad_config.json", CONFIG_SHA).read_text())
    vocab = config["vocab"]
    voice = np.fromfile(voice_file, dtype=np.float32).reshape(-1, 1, 256)
    g2p = en.G2P(british=True, fallback=EspeakFallback(british=True))

    options = ort.SessionOptions()
    options.intra_op_num_threads = 2
    options.inter_op_num_threads = 1
    session = ort.InferenceSession(str(model), sess_options=options, providers=["CPUExecutionProvider"])

    steps = json.loads(subprocess.run(["node", "--input-type=module", "-e", READ_STRINGS, str(ROOT)], check=True, capture_output=True, text=True).stdout)
    clips = {}
    for s in steps:
        text = spoken(s["pieces"])
        phonemes, _ = g2p(text)
        unknown = sorted(set(c for c in phonemes if c not in vocab))
        if unknown:
            raise ValueError(f"unknown phonemes in {s['step']}: {unknown}")
        tokens = [vocab[c] for c in phonemes]
        if not 1 <= len(tokens) <= 508:
            raise ValueError(f"{s['step']} is longer than the model takes at once")
        inputs = {"input_ids": np.array([[0, *tokens, 0]], dtype=np.int64), "style": voice[len(tokens)], "speed": np.array([SPEED], dtype=np.float32)}
        audio = session.run(["waveform"], inputs)[0].reshape(-1)
        if not np.isfinite(audio).all() or not 1 <= len(audio) / RATE <= 30:
            raise ValueError(f"bad audio for {s['step']}")
        peak = float(np.max(np.abs(audio)))
        if peak > 1:
            audio = audio / peak * 0.98
        # A short silence first, so a phone's speaker waking up does not swallow the first sound.
        audio = np.concatenate([np.zeros(RATE // 4, dtype=np.float32), audio, np.zeros(RATE // 10, dtype=np.float32)])
        path = args.out / f"{s['step']}.ogg"
        sf.write(str(path), audio, RATE, format="OGG", subtype="OPUS")
        data = path.read_bytes()
        clips[s["step"]] = {
            "file": path.name,
            "keys": s["keys"],
            "text": s["pieces"],
            "text_sha256": text_hash(s["pieces"]),
            "bytes": len(data),
            "sha256": sha(data),
            "seconds": round(len(audio) / RATE, 2),
        }
        print(json.dumps({"step": s["step"], "seconds": clips[s["step"]]["seconds"], "bytes": len(data)}), flush=True)

    manifest = {
        "voice": VOICE[0],
        "model": f"{MODEL_REPO}@{MODEL_REVISION}",
        "speed": SPEED,
        "format": "audio/ogg; codecs=opus",
        "regenerate": ".tmp/voice/venv/bin/python scripts/record-voice/record.py",
        "clips": clips,
    }
    (args.out / "manifest.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n")
    print(json.dumps({"total_bytes": sum(c["bytes"] for c in clips.values())}), flush=True)


if __name__ == "__main__":
    main()
