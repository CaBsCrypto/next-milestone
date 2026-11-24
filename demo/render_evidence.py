"""Render the original Caption Lab classroom excerpt and its Spanish captions."""

import hashlib
import json
import math
import os
from pathlib import Path
import subprocess
import tempfile
import wave

from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "web" / "public" / "evidence"
WIDTH, HEIGHT, FPS = 1280, 720, 24
SCENES = [
    (
        "A wave is a repeating pattern. This blue line moves up and down over time.",
        "Una onda es un patrón que se repite.\nLa línea azul sube y baja con el tiempo.",
        "01", "What is a wave?", "A repeating pattern",
    ),
    (
        "Amplitude is the distance from the middle line to a peak.",
        "La amplitud es la distancia\nentre la línea media y un pico.",
        "02", "Amplitude", "Measure from the center to a peak",
    ),
    (
        "The period is the time between two peaks. Can you spot one full cycle?",
        "El período es el tiempo entre dos picos.\n¿Puedes ubicar un ciclo completo?",
        "03", "Period", "Measure the time between two peaks",
    ),
]


def run(*args):
    subprocess.run([str(arg) for arg in args], check=True)


def speech(text, filename):
    run("ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", f"flite=voice=slt:text={text}", filename)
    with wave.open(str(filename)) as audio:
        return audio.getnframes() / audio.getframerate()


def font(filename, size):
    return ImageFont.truetype(str(Path(os.environ["WINDIR"]) / "Fonts" / filename), size)


def paint(index, filename):
    _, _, number, title, description = SCENES[index]
    image = Image.new("RGB", (WIDTH, HEIGHT), "#101d32")
    draw = ImageDraw.Draw(image)
    draw.text((78, 61), "CAPTION LAB / CLASS EXCERPT", font=font("segoeuib.ttf", 22), fill="#87a8d3")
    draw.text((1202, 65), number + " / 03", font=font("segoeui.ttf", 19), fill="#a9bee1", anchor="ra")
    draw.text((76, 103), title, font=font("segoeuib.ttf", 68), fill="#f5f8ff")
    draw.text((79, 189), description, font=font("segoeui.ttf", 25), fill="#b8cce6")
    draw.rounded_rectangle((76, 257, 1204, 583), radius=24, fill="#172941", outline="#304b69", width=2)
    for y in range(307, 541, 38):
        draw.line((125, y, 1155, y), fill="#263f59", width=1)
    draw.line((124, 421, 1157, 421), fill="#57728e", width=2)

    points = [(x, 421 - 73 * math.sin((x - 154) * math.tau / 420)) for x in range(154, 1133)]
    draw.line(points, fill="#73baf9", width=6)
    if index == 1:
        draw.line((259, 348, 259, 421), fill="#f2d086", width=4)
        for y in (348, 421):
            draw.line((247, y, 271, y), fill="#f2d086", width=4)
    if index == 2:
        draw.line((259, 325, 679, 325), fill="#f2d086", width=4)
        for x in (259, 679):
            draw.line((x, 315, x, 349), fill="#f2d086", width=4)

    draw.text((78, 621), "Short lesson in English", font=font("segoeui.ttf", 19), fill="#a9bee1")
    image.save(filename)


def timestamp(seconds):
    total = round(seconds * 1000)
    hours, remainder = divmod(total, 3_600_000)
    minutes, remainder = divmod(remainder, 60_000)
    seconds, milliseconds = divmod(remainder, 1000)
    return f"{hours:02}:{minutes:02}:{seconds:02}.{milliseconds:03}"


def render():
    OUTPUT.mkdir(parents=True, exist_ok=True)
    cues = ["WEBVTT\n"]
    elapsed = 0.0
    with tempfile.TemporaryDirectory(prefix="milestone-evidence-") as directory:
        working = Path(directory)
        sources = []
        for index, (narration, caption, *_) in enumerate(SCENES):
            audio = working / f"scene-{index}.wav"
            picture = working / f"scene-{index}.png"
            duration = speech(narration, audio)
            scene_duration = math.ceil((duration + 0.18) * FPS) / FPS
            paint(index, picture)
            sources.extend([
                "-loop", "1", "-framerate", str(FPS), "-t", str(scene_duration), "-i", picture, "-i", audio,
            ])
            cues.append(f"{timestamp(elapsed)} --> {timestamp(elapsed + duration)}\n{caption}\n")
            elapsed += scene_duration
            if index == 0:
                paint(index, OUTPUT / "class-subtitles-poster.png")

        graph = "".join(f"[{index * 2}:v][{index * 2 + 1}:a]" for index in range(len(SCENES)))
        graph += f"concat=n={len(SCENES)}:v=1:a=1[picture][audio]"
        run(
            "ffmpeg", "-v", "error", "-y", *sources, "-filter_complex", graph,
            "-map", "[picture]", "-map", "[audio]", "-c:v", "libx264", "-crf", "21",
            "-pix_fmt", "yuv420p", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709",
            "-c:a", "aac", "-ar", "48000", "-movflags", "+faststart", OUTPUT / "class-subtitles.mp4",
        )

    (OUTPUT / "class-subtitles.vtt").write_text("\n".join(cues), encoding="utf-8", newline="\n")
    manifest = OUTPUT / "hito-1.json"
    document = json.loads(manifest.read_text(encoding="utf-8"))
    document["sha256"] = {
        filename: hashlib.sha256((OUTPUT / filename).read_bytes()).hexdigest()
        for filename in document["files"].values()
    }
    manifest.write_text(json.dumps(document, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")


if __name__ == "__main__":
    render()
