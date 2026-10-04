# Transcribes audio files with faster-whisper and writes <file>.json next to each one:
# {"file": ..., "text": ..., "words": [[start, end, word], ...]}
# Usage: python asr.py a.wav b.wav ...   (WHISPER_MODEL overrides the model name or path)
import json
import os
import sys

from faster_whisper import WhisperModel

model = WhisperModel(
    os.environ.get("WHISPER_MODEL", "large-v3-turbo"), device="cpu", compute_type="int8", cpu_threads=os.cpu_count() or 4
)
for path in sys.argv[1:]:
    segments, _ = model.transcribe(path, language="en", word_timestamps=True)
    words, text = [], []
    for s in segments:
        text.append(s.text.strip())
        words += [[round(w.start, 3), round(w.end, 3), w.word.strip()] for w in s.words]
    with open(os.path.splitext(path)[0] + ".json", "w", encoding="utf-8") as f:
        json.dump({"file": path, "text": " ".join(text), "words": words}, f)
    print(path, flush=True)
