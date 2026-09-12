#!/usr/bin/env python3
"""Komposit beberapa gambar (base64) jadi 1 canvas — untuk gabung foto di SAMCODER.
Input: path JSON {images: [b64,...]}. Output: base64 PNG ke stdout (tanpa prefix)."""
import json, sys, base64, io

try:
    from PIL import Image
except ImportError:
    print("", file=sys.stderr); sys.exit(1)

def main():
    inp = json.load(open(sys.argv[1]))
    b64s = inp.get("images", [])
    if not b64s:
        print("", file=sys.stderr); sys.exit(1)
    imgs = []
    for b in b64s:
        raw = base64.b64decode(b)
        im = Image.open(io.BytesIO(raw)).convert("RGB")
        imgs.append(im)
    # susun berdampingan, tinggi disamakan
    target_h = min(im.height for im in imgs)
    resized = []
    for im in imgs:
        ratio = target_h / im.height
        w = max(1, int(im.width * ratio))
        resized.append(im.resize((w, target_h), Image.LANCZOS))
    total_w = sum(im.width for im in resized)
    canvas = Image.new("RGB", (total_w, target_h), (255, 255, 255))
    x = 0
    for im in resized:
        canvas.paste(im, (x, 0))
        x += im.width
    buf = io.BytesIO()
    canvas.save(buf, format="PNG")
    print(base64.b64encode(buf.getvalue()).decode())

if __name__ == "__main__":
    main()
