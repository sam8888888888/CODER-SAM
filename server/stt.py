#!/usr/bin/env python3
"""STT transkripsi untuk SAMCODER — mendukung 3 provider:
   local (faster-whisper, default, gratis), openai (whisper-1, $0.006/min), groq (whisper-large-v3, gratis).
Usage: stt.py <audio_path> [provider] [language]
Output JSON: {"text": "...", "provider": "...", "error": "..."}
"""
import sys, os, json, time

audio = sys.argv[1] if len(sys.argv) > 1 else ""
provider = sys.argv[2] if len(sys.argv) > 2 else "local"
lang = sys.argv[3] if len(sys.argv) > 3 else "id"

def err(msg):
    print(json.dumps({"text": "", "error": msg}))
    sys.exit(1)

if not audio or not os.path.exists(audio):
    err("File audio tidak ditemukan")

t0 = time.time()

if provider == "openai":
    # OpenAI Whisper API — $0.006/menit, kualitas terbaik
    api_key = os.environ.get("OPENAI_API_KEY", "")
    if not api_key:
        err("OPENAI_API_KEY belum di-set di environment")
    try:
        import httpx
        with open(audio, "rb") as f:
            r = httpx.post(
                "https://api.openai.com/v1/audio/transcriptions",
                headers={"Authorization": "Bearer " + api_key},
                files={"file": (os.path.basename(audio), f, "audio/ogg")},
                data={"model": "whisper-1", "language": lang},
                timeout=120,
            )
        d = r.json()
        if r.status_code != 200:
            err(f"OpenAI {r.status_code}: {d.get('error', {}).get('message', 'gagal')}")
        print(json.dumps({"text": d.get("text", "").strip(), "provider": "openai", "dur_ms": int((time.time()-t0)*1000)}))
    except Exception as e:
        err("OpenAI: " + str(e))

elif provider == "groq":
    # Groq Whisper — GRATIS, model whisper-large-v3 (kualitas setara OpenAI)
    api_key = os.environ.get("GROQ_API_KEY", "")
    if not api_key:
        err("GROQ_API_KEY belum di-set di environment")
    try:
        import httpx
        with open(audio, "rb") as f:
            r = httpx.post(
                "https://api.groq.com/openai/v1/audio/transcriptions",
                headers={"Authorization": "Bearer " + api_key},
                files={"file": (os.path.basename(audio), f, "audio/ogg")},
                data={"model": "whisper-large-v3", "language": lang},
                timeout=120,
            )
        d = r.json()
        if r.status_code != 200:
            err(f"Groq {r.status_code}: {d.get('error', {}).get('message', 'gagal')}")
        print(json.dumps({"text": d.get("text", "").strip(), "provider": "groq", "dur_ms": int((time.time()-t0)*1000)}))
    except Exception as e:
        err("Groq: " + str(e))

else:
    # local faster-whisper — gratis, CPU, model base (default) / small untuk akurasi
    try:
        from faster_whisper import WhisperModel
        model_name = os.environ.get("STT_LOCAL_MODEL", "base")
        model = WhisperModel(model_name, device="cpu", compute_type="int8")
        segments, info = model.transcribe(audio, language=lang, beam_size=5)
        text = " ".join(seg.text.strip() for seg in segments).strip()
        print(json.dumps({"text": text, "provider": "local", "model": model_name, "dur_ms": int((time.time()-t0)*1000)}))
    except Exception as e:
        err("local: " + str(e))
