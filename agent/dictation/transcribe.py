#!/usr/bin/env python3
"""Transcribe a WAV file with local faster-whisper. Prints transcript to stdout.

Language handling:
- DICTATION_LANG=nl|en|... -> force that language
- DICTATION_LANG=auto (default) -> run nl and en, keep result with higher
  language probability (good for mixed NL/EN speech)
"""
import os
import sys

from faster_whisper import WhisperModel

wav_path = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser("~/.pi/agent/dictation/recording.wav")
model_name = os.environ.get("DICTATION_MODEL", "medium")
lang_setting = (os.environ.get("DICTATION_LANG", "auto") or "auto").lower()

device = "cuda"
compute_type = "float16"
try:
    import ctranslate2
    if ctranslate2.get_cuda_device_count() < 1:
        raise RuntimeError("no cuda")
except Exception:
    device = "cpu"
    compute_type = "int8"

model = WhisperModel(model_name, device=device, compute_type=compute_type)

def run(language):
    segments, info = model.transcribe(
        wav_path,
        language=language,
        vad_filter=True,
        beam_size=5,
    )
    segs = [seg for seg in segments if seg.text.strip()]
    text = " ".join(seg.text.strip() for seg in segs).strip()
    score = sum(seg.avg_logprob for seg in segs) / max(len(segs), 1) if segs else -10.0
    return score, text

if lang_setting in ("auto", "both"):
    nl_score, nl_text = run("nl")
    en_score, en_text = run("en")
    text = nl_text if nl_score >= en_score else en_text
else:
    _, text = run(lang_setting)

print(text)
