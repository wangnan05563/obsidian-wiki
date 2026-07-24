"""
Luminous Cognition — Canvas Renderer
=====================================
Render the login background and the abstract cognition icon
according to the Luminous Cognition design philosophy.

Two phases share one geometry; only the light changes:
  - dark  : violet/cyan/magenta on near-black  (creative theme)
  - light : lilac/mint/blush on cream          (macaron theme)

Run:  python render_luminous_cognition.py
Out:  creative-bg.png, macaron-bg.png, cognition-icon.png
"""

from __future__ import annotations

import math
import random
from dataclasses import dataclass
from typing import Iterable

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont


# ---------------------------------------------------------------------------
# Phase palettes — values mirror the project CSS variables exactly.
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class Phase:
    name: str
    bg_void: tuple[int, int, int]      # deepest background
    bg_deep: tuple[int, int, int]      # mid background
    violet: tuple[int, int, int]       # primary node
    cyan: tuple[int, int, int]         # secondary node
    magenta: tuple[int, int, int]      # tertiary node
    pink: tuple[int, int, int]         # accent node
    text: tuple[int, int, int]         # whisper-thin text
    text_dim: tuple[int, int, int]     # tick marks
    grid: tuple[int, int, int]         # grid line color (rgb only)
    grid_alpha: int                    # grid line opacity
    halo_strength: float               # 0..1, controls glow intensity


DARK = Phase(
    name="dark",
    bg_void=(5, 0, 16),
    bg_deep=(10, 1, 24),
    violet=(176, 38, 255),
    cyan=(0, 245, 255),
    magenta=(255, 0, 110),
    pink=(255, 62, 201),
    text=(243, 233, 255),
    text_dim=(107, 90, 143),
    grid=(176, 38, 255),
    grid_alpha=14,
    halo_strength=1.0,
)

LIGHT = Phase(
    name="light",
    bg_void=(255, 249, 245),
    bg_deep=(255, 245, 240),
    violet=(200, 162, 232),
    cyan=(168, 224, 216),
    magenta=(255, 179, 209),
    pink=(255, 196, 214),
    text=(74, 58, 82),
    text_dim=(181, 168, 192),
    grid=(200, 162, 232),
    grid_alpha=18,
    halo_strength=0.55,
)


# A second light phase for the *icon* specifically: deeper, more saturated
# hues so the mark stays visible on a cream background. The background keeps
# the soft macaron palette; the icon needs enough value contrast to read.
LIGHT_ICON = Phase(
    name="light_icon",
    bg_void=(255, 249, 245),
    bg_deep=(255, 245, 240),
    violet=(122, 74, 184),       # deep orchid — reads on cream
    cyan=(45, 157, 141),         # deep mint — visible on white
    magenta=(212, 105, 155),     # deep rose
    pink=(212, 105, 155),
    text=(74, 58, 82),
    text_dim=(181, 168, 192),
    grid=(200, 162, 232),
    grid_alpha=18,
    halo_strength=0.85,          # slightly stronger halo to compensate for lower base glow
)


# ---------------------------------------------------------------------------
# Compositional primitives
# ---------------------------------------------------------------------------

W, H = 1920, 1080            # 16:9 background canvas
ICON_SIZE = 1024             # square icon canvas


def lerp(a: float, b: float, t: float) -> float:
    return a + (b - a) * t


def ease_out_cubic(t: float) -> float:
    return 1 - (1 - t) ** 3


def make_radial_glow(
    size: tuple[int, int],
    center: tuple[float, float],
    radius: float,
    color: tuple[int, int, int],
    intensity: float = 1.0,
    power: float = 2.0,
) -> Image.Image:
    """A radial gradient halo, alpha-only when intensity<1 is achieved by color*intensity."""
    w, h = size
    ys, xs = np.ogrid[:h, :w]
    cx, cy = center
    dist = np.sqrt((xs - cx) ** 2 + (ys - cy) ** 2)
    # avoid divide-by-zero
    r = max(radius, 1.0)
    falloff = np.clip(1.0 - dist / r, 0.0, 1.0) ** power
    alpha = (falloff * 255 * intensity).astype(np.uint8)

    arr = np.zeros((h, w, 4), dtype=np.uint8)
    arr[..., 0] = color[0]
    arr[..., 1] = color[1]
    arr[..., 2] = color[2]
    arr[..., 3] = alpha
    return Image.fromarray(arr, "RGBA")


def add_glow(
    base: Image.Image,
    glow: Image.Image,
    blur_radius: int = 0,
) -> None:
    """Composite a glow layer (RGBA) onto base (RGBA), with optional pre-blur."""
    if blur_radius > 0:
        glow = glow.filter(ImageFilter.GaussianBlur(blur_radius))
    base.alpha_composite(glow)


def draw_grid(
    img: Image.Image,
    phase: Phase,
    spacing: int = 80,
    fade_radius: float = 0.55,
) -> None:
    """Faint grid that fades radially — cyber/specimen feel. Wider spacing reads as map, not as cage."""
    w, h = img.size
    grid = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(grid)
    color = (*phase.grid, phase.grid_alpha)

    for x in range(0, w + 1, spacing):
        d.line([(x, 0), (x, h)], fill=color, width=1)
    for y in range(0, h + 1, spacing):
        d.line([(0, y), (w, y)], fill=color, width=1)

    # radial mask: keep central area, fade to edges
    mask = make_radial_alpha(w, h, center=(w * 0.5, h * 0.5),
                             radius=max(w, h) * fade_radius,
                             power=2.4)
    mask_img = Image.fromarray(mask, "L")
    grid.putalpha(mask_img)
    img.alpha_composite(grid)


def make_radial_alpha(
    w: int, h: int,
    center: tuple[float, float],
    radius: float,
    power: float = 2.0,
) -> np.ndarray:
    ys, xs = np.ogrid[:h, :w]
    cx, cy = center
    dist = np.sqrt((xs - cx) ** 2 + (ys - cy) ** 2)
    r = max(radius, 1.0)
    return (np.clip(1.0 - dist / r, 0.0, 1.0) ** power * 255).astype(np.uint8)


def draw_node(
    img: Image.Image,
    center: tuple[float, float],
    radius: float,
    color: tuple[int, int, int],
    phase: Phase,
    halo_factor: float = 6.0,
    core_intensity: float = 1.0,
) -> None:
    """A luminous node: layered halos with restraint — glass inhaled, not painted."""
    cx, cy = center

    # 1. Outer wide halo (very soft, low intensity — breath, not blast)
    halo_r = radius * halo_factor * 1.6
    halo = make_radial_glow(
        img.size, (cx, cy), halo_r, color,
        intensity=0.11 * phase.halo_strength, power=2.8
    )
    add_glow(img, halo, blur_radius=0)

    # 2. Mid halo (gentler — atmosphere, not spotlight)
    mid_r = radius * halo_factor * 0.9
    mid = make_radial_glow(
        img.size, (cx, cy), mid_r, color,
        intensity=0.28 * phase.halo_strength, power=2.2
    )
    add_glow(img, mid, blur_radius=0)

    # 3. Solid core (slightly feathered edge — organic, not stamped)
    core = Image.new("RGBA", img.size, (0, 0, 0, 0))
    cd = ImageDraw.Draw(core)
    cd.ellipse(
        [cx - radius, cy - radius, cx + radius, cy + radius],
        fill=(*color, int(235 * core_intensity)),
    )
    core = core.filter(ImageFilter.GaussianBlur(radius * 0.35))
    img.alpha_composite(core)

    # 4. White highlight (subtle specular — only on the brighter nodes)
    if core_intensity >= 0.7:
        hl_r = max(radius * 0.32, 1.0)
        hl = make_radial_glow(
            img.size,
            (cx - radius * 0.28, cy - radius * 0.28),
            hl_r * 2.4,
            (255, 255, 255),
            intensity=0.55 * core_intensity,
            power=2.2,
        )
        add_glow(img, hl)


def draw_filament(
    img: Image.Image,
    a: tuple[float, float],
    b: tuple[float, float],
    color: tuple[int, int, int],
    phase: Phase,
    width: float = 1.2,
    alpha: int = 110,
) -> None:
    """A glowing hairline connection between two nodes."""
    # outer soft glow
    soft = Image.new("RGBA", img.size, (0, 0, 0, 0))
    sd = ImageDraw.Draw(soft)
    sd.line([a, b], fill=(*color, int(alpha * 0.35)), width=int(width * 4) + 1)
    soft = soft.filter(ImageFilter.GaussianBlur(width * 2.5))
    img.alpha_composite(soft)

    # crisp inner line
    sharp = Image.new("RGBA", img.size, (0, 0, 0, 0))
    sd2 = ImageDraw.Draw(sharp)
    sd2.line([a, b], fill=(*color, alpha), width=max(int(width), 1))
    img.alpha_composite(sharp)


def draw_ticks(
    img: Image.Image,
    phase: Phase,
    margin: int = 56,
    tick_len: int = 12,
    step: int = 80,
) -> None:
    """Clinical tick marks along the top and left margins — observation grammar, whispered."""
    w, h = img.size
    layer = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    color = (*phase.text_dim, 70)

    # top edge ticks
    x = margin
    while x <= w - margin:
        long = (x % (step * 5)) == 0
        L = tick_len + 5 if long else tick_len
        d.line([(x, margin), (x, margin + L)], fill=color, width=1)
        x += step

    # left edge ticks
    y = margin
    while y <= h - margin:
        long = (y % (step * 5)) == 0
        L = tick_len + 5 if long else tick_len
        d.line([(margin, y), (margin + L, y)], fill=color, width=1)
        y += step

    img.alpha_composite(layer)


def draw_corner_brackets(
    img: Image.Image,
    phase: Phase,
    margin: int = 48,
    arm: int = 26,
) -> None:
    """Four thin corner brackets — a frame that respects the canvas, barely there."""
    w, h = img.size
    layer = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    color = (*phase.text_dim, 85)
    t = 1

    # top-left
    d.line([(margin, margin), (margin + arm, margin)], fill=color, width=t)
    d.line([(margin, margin), (margin, margin + arm)], fill=color, width=t)
    # top-right
    d.line([(w - margin, margin), (w - margin - arm, margin)], fill=color, width=t)
    d.line([(w - margin, margin), (w - margin, margin + arm)], fill=color, width=t)
    # bottom-left
    d.line([(margin, h - margin), (margin + arm, h - margin)], fill=color, width=t)
    d.line([(margin, h - margin), (margin, h - margin - arm)], fill=color, width=t)
    # bottom-right
    d.line([(w - margin, h - margin), (w - margin - arm, h - margin)], fill=color, width=t)
    d.line([(w - margin, h - margin), (w - margin, h - margin - arm)], fill=color, width=t)

    img.alpha_composite(layer)


def try_font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont:
    """Locate a thin sans-serif font; fall back to default if none available."""
    candidates = [
        r"C:\Windows\Fonts\Rajdhani-Medium.ttf",
        r"C:\Windows\Fonts\Rajdhani-Light.ttf",
        r"C:\Windows\Fonts\Rajdhani-SemiBold.ttf",
        r"C:\Windows\Fonts\arial.ttf",
        r"C:\Windows\Fonts\segouil.ttf",
        r"C:\Windows\Fonts\segoeuil.ttf",
    ]
    for path in candidates:
        try:
            return ImageFont.truetype(path, size)
        except Exception:
            continue
    return ImageFont.load_default()


def draw_labels(
    img: Image.Image,
    phase: Phase,
) -> None:
    """Three sparse labels — a plumb line, a plate, a coordinate. Nothing more."""
    w, h = img.size
    layer = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)

    font_label = try_font(13, bold=False)
    font_micro = try_font(11, bold=False)
    font_anchor = try_font(22, bold=False)

    text_color = (*phase.text, 115)
    dim_color = (*phase.text_dim, 150)

    # top-left plate identifier — single, restrained
    d.text((72, 70), "PL. 01", font=font_label, fill=text_color)

    # top-right coordinate — clinical, distant
    coord = "λ 410nm · 0x4C2A"
    tw = d.textlength(coord, font=font_micro)
    d.text((w - 72 - tw, 70), coord, font=font_micro, fill=dim_color)

    # bottom-right anchor word — the single plumb line
    word = "cognition"
    tw = d.textlength(word, font=font_anchor)
    d.text((w - 72 - tw, h - 78), word, font=font_anchor, fill=text_color)

    img.alpha_composite(layer)


# ---------------------------------------------------------------------------
# The composition — node network on a background
# ---------------------------------------------------------------------------

@dataclass
class NodeSpec:
    x: float
    y: float
    radius: float
    color: tuple[int, int, int]
    halo_factor: float = 6.0
    core_intensity: float = 1.0


def build_network(phase: Phase, seed: int = 7) -> tuple[list[NodeSpec], list[tuple[int, int, float]]]:
    """Return (nodes, edges) where edges = (i, j, alpha)."""
    rng = random.Random(seed)

    nodes: list[NodeSpec] = []

    # 1. The Nucleus — single dominant focal point (off-center, golden ratio)
    #    halo_factor tuned down so it dominates by composition, not by glare
    nucleus = NodeSpec(
        x=W * 0.382,
        y=H * 0.5,
        radius=20,
        color=phase.violet,
        halo_factor=7.0,
        core_intensity=1.0,
    )
    nodes.append(nucleus)

    # 2. Primary orbital ring (6 satellites, cyan) — slightly varied for breath
    ring_radius = 220
    for i in range(6):
        ang = (i / 6) * 2 * math.pi + math.radians(15)
        jitter = rng.uniform(-10, 10)
        nodes.append(NodeSpec(
            x=nucleus.x + math.cos(ang) * ring_radius + jitter,
            y=nucleus.y + math.sin(ang) * ring_radius + jitter,
            radius=rng.uniform(5.5, 8),
            color=phase.cyan,
            halo_factor=5.0,
            core_intensity=rng.uniform(0.65, 0.88),
        ))

    # 3. Secondary ring (8 smaller nodes, magenta — reduced count for breathing room)
    for i in range(8):
        ang = (i / 8) * 2 * math.pi + math.radians(-8)
        r = rng.uniform(360, 410)
        nodes.append(NodeSpec(
            x=nucleus.x + math.cos(ang) * r,
            y=nucleus.y + math.sin(ang) * r,
            radius=rng.uniform(2.5, 4.5),
            color=phase.magenta,
            halo_factor=4.0,
            core_intensity=rng.uniform(0.45, 0.7),
        ))

    # 4. Far scatter (14 faint sparks — was 24; pruned to honor negative space)
    for _ in range(14):
        ang = rng.uniform(0, 2 * math.pi)
        r = rng.uniform(480, 760)
        nodes.append(NodeSpec(
            x=nucleus.x + math.cos(ang) * r,
            y=nucleus.y + math.sin(ang) * r,
            radius=rng.uniform(1.2, 2.6),
            color=phase.pink if rng.random() < 0.5 else phase.cyan,
            halo_factor=3.6,
            core_intensity=rng.uniform(0.35, 0.6),
        ))

    # 5. Edges: nucleus → primary ring (calibrated tension)
    edges: list[tuple[int, int, float]] = []
    for i in range(1, 7):
        edges.append((0, i, rng.uniform(0.50, 0.68)))

    # primary ring inter-connections (weak, partial — not a full cycle)
    for i in range(1, 7):
        if rng.random() < 0.55:
            j = (i % 6) + 1
            edges.append((i, j, rng.uniform(0.18, 0.32)))

    # primary → secondary (very faint)
    for i in range(1, 7):
        candidates = list(range(7, 15))
        rng.shuffle(candidates)
        for j in candidates[:2]:
            edges.append((i, j, rng.uniform(0.10, 0.22)))

    # secondary → far scatter (rare, almost subliminal)
    for j in range(7, 15):
        if rng.random() < 0.4:
            k = rng.randint(15, len(nodes) - 1)
            edges.append((j, k, rng.uniform(0.06, 0.14)))

    return nodes, edges


def render_background(phase: Phase, seed: int = 7) -> Image.Image:
    """Render the full 1920×1080 background for a given phase."""
    # base
    img = Image.new("RGBA", (W, H), (*phase.bg_void, 255))

    # 1. Atmospheric radial gradients — three large soft halos (calibrated down for restraint)
    for center, color, r, intensity in [
        ((W * 0.30, H * 0.45), phase.violet, 900, 0.14),
        ((W * 0.70, H * 0.55), phase.cyan, 800, 0.10),
        ((W * 0.50, H * 0.92), phase.magenta, 700, 0.08),
    ]:
        halo = make_radial_glow(
            (W, H), center, r, color,
            intensity=intensity * phase.halo_strength, power=2.6
        )
        add_glow(img, halo, blur_radius=0)

    # 2. Subtle vertical gradient (deep at top/bottom, slightly lifted in middle)
    grad = np.zeros((H, W, 4), dtype=np.uint8)
    for y in range(H):
        t = abs(y - H * 0.5) / (H * 0.5)
        t = ease_out_cubic(t)
        r = int(lerp(phase.bg_deep[0], phase.bg_void[0], t))
        g = int(lerp(phase.bg_deep[1], phase.bg_void[1], t))
        b = int(lerp(phase.bg_deep[2], phase.bg_void[2], t))
        grad[y, :, :] = (r, g, b, 70)
    img.alpha_composite(Image.fromarray(grad, "RGBA"))

    # 3. Grid (radial fade, wider spacing — map, not cage)
    draw_grid(img, phase, spacing=80, fade_radius=0.62)

    # 4. Network
    nodes, edges = build_network(phase, seed=seed)

    # 4a. Filaments first (under nodes) — alpha dampened for whisper quality
    for i, j, alpha in edges:
        a = (nodes[i].x, nodes[i].y)
        b = (nodes[j].x, nodes[j].y)
        color = nodes[i].color if nodes[i].core_intensity >= nodes[j].core_intensity else nodes[j].color
        draw_filament(img, a, b, color, phase, width=1.0, alpha=int(220 * alpha))

    # 4b. Nodes (sorted by radius, smaller first so big ones sit on top)
    for n in sorted(nodes, key=lambda s: s.radius):
        draw_node(img, (n.x, n.y), n.radius, n.color, phase,
                  halo_factor=n.halo_factor, core_intensity=n.core_intensity)

    # 5. Vignette — center the eye on the nucleus; edges recede
    draw_vignette(img, phase)

    # 6. Clinical frame: ticks + brackets + labels (whisper-thin)
    draw_corner_brackets(img, phase)
    draw_ticks(img, phase)
    draw_labels(img, phase)

    # 7. Very fine noise (analog tactility) — light phase uses less
    if phase.name == "dark":
        add_noise(img, amount=3)
    else:
        add_noise(img, amount=2)

    return img


def draw_vignette(img: Image.Image, phase: Phase) -> None:
    """A radial darkening at the edges — the eye is drawn inward, not pushed outward."""
    w, h = img.size
    # vignette strength: dark phase needs more, light phase needs very gentle
    max_alpha = 95 if phase.name == "dark" else 35
    vignette_color = phase.bg_void

    ys, xs = np.ogrid[:h, :w]
    cx, cy = w * 0.42, h * 0.5      # offset toward the nucleus for asymmetric pull
    dist = np.sqrt((xs - cx) ** 2 + (ys - cy) ** 2)
    # normalize to max corner distance, then sharpen the falloff
    max_dist = math.sqrt((w - cx) ** 2 + max(cy, h - cy) ** 2)
    norm = np.clip(dist / max_dist, 0.0, 1.0)
    # only darken the outer ~45%; center stays untouched
    falloff = np.clip((norm - 0.55) / 0.45, 0.0, 1.0) ** 2.2
    alpha = (falloff * max_alpha).astype(np.uint8)

    arr = np.zeros((h, w, 4), dtype=np.uint8)
    arr[..., 0] = vignette_color[0]
    arr[..., 1] = vignette_color[1]
    arr[..., 2] = vignette_color[2]
    arr[..., 3] = alpha
    img.alpha_composite(Image.fromarray(arr, "RGBA"))


def add_noise(img: Image.Image, amount: int = 4) -> None:
    """Add a whisper of grain — analog tactility."""
    arr = np.array(img, dtype=np.int16)
    noise = np.random.randint(-amount, amount + 1, arr.shape[:2], dtype=np.int16)
    # apply only to RGB channels, leave alpha alone
    for c in range(3):
        arr[..., c] = np.clip(arr[..., c] + noise, 0, 255)
    out = arr.astype(np.uint8)
    img.paste(Image.fromarray(out, "RGBA"), (0, 0))


# ---------------------------------------------------------------------------
# The cognition icon — replaces the legacy robot avatar
# ---------------------------------------------------------------------------

def render_icon(phase: Phase = DARK) -> Image.Image:
    """A square icon: luminous nucleus orbited by 6 cyan satellites on void.
    Refined to museum-grade restraint — every radius calibrated, every halo tempered."""
    S = ICON_SIZE
    img = Image.new("RGBA", (S, S), (*phase.bg_void, 0))  # transparent bg

    # subtle central halo (atmosphere, not backdrop)
    halo = make_radial_glow(
        (S, S), (S * 0.5, S * 0.5), S * 0.52, phase.violet,
        intensity=0.18 * phase.halo_strength, power=2.4
    )
    add_glow(img, halo, blur_radius=0)

    cx, cy = S * 0.5, S * 0.5
    nucleus_r = S * 0.068

    # 6 satellites — slightly wider orbit for breathing room
    ring_r = S * 0.32
    satellites = []
    for i in range(6):
        ang = (i / 6) * 2 * math.pi + math.radians(15)
        sx = cx + math.cos(ang) * ring_r
        sy = cy + math.sin(ang) * ring_r
        satellites.append((sx, sy, ang))

    # filaments — thinner and gentler; whisper, not wire
    for sx, sy, _ in satellites:
        draw_filament(img, (cx, cy), (sx, sy), phase.cyan, phase,
                      width=1.6, alpha=140)

    # nucleus (halo tempered for restraint)
    draw_node(img, (cx, cy), nucleus_r, phase.violet, phase,
              halo_factor=6.5, core_intensity=1.0)

    # satellites (slightly smaller, harmonized)
    for sx, sy, _ in satellites:
        draw_node(img, (sx, sy), S * 0.024, phase.cyan, phase,
                  halo_factor=5.5, core_intensity=0.92)

    # very fine noise for tactility
    add_noise(img, amount=2)

    return img


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    out_dir = r"d:\code\otherProjects\19_Karpathy-AI+Obsidian知识库\karpathy-wiki\docs\design\login-canvas"

    print("→ rendering dark phase (creative)…")
    dark = render_background(DARK, seed=7)
    dark_path = f"{out_dir}\\creative-bg.png"
    dark.convert("RGB").save(dark_path, "PNG", optimize=True)
    print(f"  saved: {dark_path}")

    print("→ rendering light phase (macaron)…")
    light = render_background(LIGHT, seed=7)
    light_path = f"{out_dir}\\macaron-bg.png"
    light.convert("RGB").save(light_path, "PNG", optimize=True)
    print(f"  saved: {light_path}")

    print("→ rendering cognition icon (dark)…")
    icon_dark = render_icon(DARK)
    icon_dark_path = f"{out_dir}\\cognition-icon.png"
    icon_dark.save(icon_dark_path, "PNG", optimize=True)
    print(f"  saved: {icon_dark_path}")

    print("→ rendering cognition icon (light)…")
    icon_light = render_icon(LIGHT_ICON)
    icon_light_path = f"{out_dir}\\cognition-icon-light.png"
    icon_light.save(icon_light_path, "PNG", optimize=True)
    print(f"  saved: {icon_light_path}")

    print("\n✓ done.")


if __name__ == "__main__":
    main()
