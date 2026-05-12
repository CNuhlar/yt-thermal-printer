"""
YouTube Now Playing receipt + local HTTP print server for XP-80.

Two modes:
  python yt_printer.py                 # print a mock receipt (test)
  python yt_printer.py --preview       # save preview_yt.png instead
  python yt_printer.py --serve         # run HTTP server on 127.0.0.1:7878
                                       # POST JSON to /print to trigger a print

JSON payload accepted by /print:
  {
    "title":     "video title",
    "channel":   "channel name",
    "playlist":  "playlist name",          (optional)
    "elapsed":   "0:42",                   (optional, mm:ss)
    "duration":  "3:33",                   (optional, mm:ss)
    "thumbnail": "https://i.ytimg.com/..." (optional URL)
  }

Requires: pip install pywin32 Pillow
"""

import argparse
import io
import json
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer

from PIL import Image, ImageDraw, ImageFont
import win32print

WIDTH = 576  # 80mm @ 8 dots/mm
ESC = b"\x1b"
GS = b"\x1d"
INIT = ESC + b"@"
CUT_FULL = GS + b"V\x00"
TOP_PAD = b"\n" * 2          # paper feed BEFORE raster (top margin)
BOTTOM_PAD = b"\n" * 6       # paper feed AFTER raster (push past cutter)


# ---------- fonts ----------

FONT_REG = ["C:/Windows/Fonts/segoeui.ttf",
            "C:/Windows/Fonts/arial.ttf"]
FONT_BOLD = ["C:/Windows/Fonts/segoeuib.ttf",
             "C:/Windows/Fonts/arialbd.ttf"]


def font(size, bold=False):
    for p in (FONT_BOLD if bold else FONT_REG):
        try:
            return ImageFont.truetype(p, size)
        except OSError:
            continue
    return ImageFont.load_default()


# ---------- icons ----------

def yt_logo(img, x, y, scale=1.0):
    """Rounded black rectangle + white play triangle."""
    d = ImageDraw.Draw(img)
    rw = int(110 * scale)
    rh = int(78 * scale)
    radius = int(20 * scale)
    d.rounded_rectangle((x, y, x + rw, y + rh), radius=radius, fill=0)
    tw = int(rw * 0.36)
    th = int(rh * 0.56)
    tx = x + (rw - tw) // 2 + 4
    ty = y + (rh - th) // 2
    d.polygon([(tx, ty), (tx + tw, ty + th // 2), (tx, ty + th)], fill=255)
    return rw, rh


def draw_thumbs_up(d, x, y, s, fill=0):
    fist_h = int(s * 0.55)
    fist_y = y + s - fist_h
    d.rounded_rectangle((x + s*0.10, fist_y, x + s*0.95, y + s),
                        radius=int(s*0.10), fill=fill)
    thumb_w = int(s * 0.34)
    thumb_h = int(s * 0.68)
    d.rounded_rectangle((x, y, x + thumb_w, y + thumb_h),
                        radius=int(s*0.14), fill=fill)
    # knuckle lines
    for i in range(3):
        ky = fist_y + int(s * 0.13 * (i + 1))
        d.line((x + s*0.28, ky, x + s*0.90, ky), fill=255, width=2)


def draw_prev(d, x, y, s, fill=0):
    d.rectangle((x, y, x + s*0.18, y + s), fill=fill)
    d.polygon([(x + s, y), (x + s*0.22, y + s/2), (x + s, y + s)], fill=fill)


def draw_play(d, x, y, s, fill=0):
    d.polygon([(x, y), (x + s, y + s/2), (x, y + s)], fill=fill)


def draw_next(d, x, y, s, fill=0):
    d.polygon([(x, y), (x + s*0.78, y + s/2), (x, y + s)], fill=fill)
    d.rectangle((x + s*0.82, y, x + s, y + s), fill=fill)


# ---------- layout helpers ----------

def wrap_center(d, text, fnt, y, max_w=WIDTH - 40, line_gap=4):
    lines, cur = [], ""
    for w in text.split():
        trial = (cur + " " + w).strip()
        if d.textlength(trial, font=fnt) <= max_w:
            cur = trial
        else:
            if cur:
                lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    for line in lines:
        tw = d.textlength(line, font=fnt)
        d.text(((WIDTH - tw) / 2, y), line, font=fnt, fill=0)
        bb = fnt.getbbox(line)
        y += (bb[3] - bb[1]) + line_gap
    return y


def parse_mmss(s):
    try:
        m, sec = s.split(":")
        return int(m) * 60 + int(sec)
    except Exception:
        return 0


# ---------- image ----------

def make_image(title, channel, playlist="", elapsed="0:00",
               duration="0:00", thumb=None):
    img = Image.new("1", (WIDTH, 1800), color=1)
    d = ImageDraw.Draw(img)

    y = 50  # top margin inside image

    # Header — logo + wordmark, centered as a group
    logo_scale = 1.2
    rw, rh = int(110 * logo_scale), int(78 * logo_scale)
    brand_fnt = font(72, bold=True)
    bw = d.textlength("YouTube", font=brand_fnt)
    group_w = rw + 22 + bw
    gx = (WIDTH - group_w) // 2
    yt_logo(img, gx, y, scale=logo_scale)
    d.text((gx + rw + 22, y - 6), "YouTube", font=brand_fnt, fill=0)
    y += rh + 28

    # "NOW WATCHING"
    lf = font(24)
    label = "N O W   W A T C H I N G"
    tw = d.textlength(label, font=lf)
    d.text(((WIDTH - tw) / 2, y), label, font=lf, fill=0)
    y += 40

    # Double divider
    d.line((20, y, WIDTH - 20, y), fill=0, width=3)
    y += 6
    d.line((20, y, WIDTH - 20, y), fill=0, width=1)
    y += 24

    # Thumbnail (if provided), dithered to 1-bit
    if thumb is not None:
        target_w = 480
        ratio = target_w / thumb.width
        target_h = int(thumb.height * ratio)
        t = thumb.resize((target_w, target_h)).convert(
            "1", dither=Image.FLOYDSTEINBERG)
        img.paste(t, ((WIDTH - target_w) // 2, y))
        # frame
        d.rectangle((((WIDTH - target_w) // 2) - 3, y - 3,
                     ((WIDTH + target_w) // 2) + 3, y + target_h + 3),
                    outline=0, width=2)
        y += target_h + 30

    # Title (large, bold, wrapped)
    y = wrap_center(d, title, font(44, bold=True), y, line_gap=8)
    y += 14

    # Channel
    y = wrap_center(d, channel, font(30), y, line_gap=4)
    y += 8

    # Playlist
    if playlist:
        y = wrap_center(d, "from playlist “" + playlist + "”",
                        font(22), y, line_gap=4)
    y += 30

    # Progress bar
    bx1, bx2 = 30, WIDTH - 30
    bar_h = 10
    d.rectangle((bx1, y, bx2, y + bar_h), outline=0, width=2)
    pct = parse_mmss(elapsed) / max(1, parse_mmss(duration))
    pct = max(0.0, min(1.0, pct))
    fill_x = bx1 + int((bx2 - bx1) * pct)
    d.rectangle((bx1, y, fill_x, y + bar_h), fill=0)
    d.ellipse((fill_x - 8, y - 4, fill_x + 8, y + bar_h + 4), fill=0)
    y += bar_h + 14

    # Time labels
    tf = font(22)
    d.text((bx1, y), elapsed, font=tf, fill=0)
    dw = d.textlength(duration, font=tf)
    d.text((bx2 - dw, y), duration, font=tf, fill=0)
    y += 44

    # Controls: like / prev / play / next
    isz = 54
    gap = 44
    total = isz * 4 + gap * 3
    cx = (WIDTH - total) // 2
    draw_thumbs_up(d, cx, y, isz)
    draw_prev(d, cx + (isz + gap), y, isz)
    pcx = cx + (isz + gap) * 2 + isz // 2
    pcy = y + isz // 2
    pr = isz // 2 + 6
    d.ellipse((pcx - pr, pcy - pr, pcx + pr, pcy + pr),
              outline=0, width=3)
    draw_play(d, cx + (isz + gap) * 2 + 6, y + 4, isz - 8)
    draw_next(d, cx + (isz + gap) * 3, y, isz)
    y += isz + 32

    # Footer divider
    d.line((20, y, WIDTH - 20, y), fill=0, width=1)
    y += 6
    d.line((20, y, WIDTH - 20, y), fill=0, width=3)
    y += 22

    # Footer
    ff = font(20)
    foot = "printed by xp-80  *  yt tracker"
    fw = d.textlength(foot, font=ff)
    d.text(((WIDTH - fw) / 2, y), foot, font=ff, fill=0)
    y += 50  # bottom margin

    return img.crop((0, 0, WIDTH, y))


# ---------- ESC/POS raster ----------

def image_to_raster(img):
    if img.mode != "1":
        img = img.convert("1")
    w, h = img.size
    bw = (w + 7) // 8
    hdr = bytes([0x1D, 0x76, 0x30, 0x00,
                 bw & 0xFF, (bw >> 8) & 0xFF,
                 h & 0xFF, (h >> 8) & 0xFF])
    px = img.load()
    out = bytearray()
    for yy in range(h):
        for bx in range(bw):
            byte = 0
            for bit in range(8):
                xx = bx * 8 + bit
                if xx < w and px[xx, yy] == 0:
                    byte |= 1 << (7 - bit)
            out.append(byte)
    return hdr + bytes(out)


def send_raw(printer, data, job="yt-now-playing"):
    h = win32print.OpenPrinter(printer)
    try:
        win32print.StartDocPrinter(h, 1, (job, None, "RAW"))
        try:
            win32print.StartPagePrinter(h)
            win32print.WritePrinter(h, data)
            win32print.EndPagePrinter(h)
        finally:
            win32print.EndDocPrinter(h)
    finally:
        win32print.ClosePrinter(h)


def fetch_thumb(url):
    if not url:
        return None
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "yt-printer/1.0"})
        with urllib.request.urlopen(req, timeout=6) as r:
            return Image.open(io.BytesIO(r.read())).convert("RGB")
    except Exception as e:
        print(f"thumb fetch failed: {e}")
        return None


def print_now(printer, info):
    """info is a dict with keys: title, channel, playlist, elapsed, duration, thumbnail"""
    thumb = fetch_thumb(info.get("thumbnail"))
    img = make_image(
        info.get("title", "Unknown video"),
        info.get("channel", "Unknown channel"),
        info.get("playlist", ""),
        info.get("elapsed", "0:00"),
        info.get("duration", "0:00"),
        thumb,
    )
    payload = INIT + TOP_PAD + image_to_raster(img) + BOTTOM_PAD + CUT_FULL
    send_raw(printer, payload)
    return len(payload)


# ---------- HTTP server ----------

class PrintHandler(BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        # Health check
        if self.path in ("/", "/health"):
            self.send_response(200)
            self._cors()
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"ok":true,"service":"yt-printer"}')
            return
        self.send_response(404)
        self._cors()
        self.end_headers()

    def do_POST(self):
        if self.path != "/print":
            self.send_response(404)
            self._cors()
            self.end_headers()
            return
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length)
        try:
            info = json.loads(body)
        except json.JSONDecodeError:
            self.send_response(400)
            self._cors()
            self.end_headers()
            self.wfile.write(b'{"error":"bad json"}')
            return
        try:
            n = print_now(self.server.printer, info)
            print(f"[print] {info.get('title','?')} — {info.get('channel','?')}  ({n} bytes)")
            self.send_response(200)
            self._cors()
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"ok": True, "bytes": n}).encode())
        except Exception as e:
            print(f"[error] {e}")
            self.send_response(500)
            self._cors()
            self.end_headers()
            self.wfile.write(json.dumps({"error": str(e)}).encode())

    def log_message(self, format, *args):
        return  # quiet default access log


def serve(host, port, printer):
    srv = HTTPServer((host, port), PrintHandler)
    srv.printer = printer
    print(f"yt-printer listening on http://{host}:{port}/print -> {printer}")
    print("ctrl+c to stop")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped.")


# ---------- CLI ----------

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--serve", action="store_true")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=7878)
    ap.add_argument("--printer", default="XP80")

    ap.add_argument("--title", default="Never Gonna Give You Up (Official Music Video)")
    ap.add_argument("--channel", default="Rick Astley")
    ap.add_argument("--playlist", default="80s Classics")
    ap.add_argument("--elapsed", default="0:42")
    ap.add_argument("--duration", default="3:33")
    ap.add_argument("--thumb",
                    default="https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg")

    ap.add_argument("--preview", action="store_true")
    args = ap.parse_args()

    if args.serve:
        serve(args.host, args.port, args.printer)
        return

    thumb = fetch_thumb(args.thumb)
    img = make_image(args.title, args.channel, args.playlist,
                     args.elapsed, args.duration, thumb)

    if args.preview:
        img.save("preview_yt.png")
        print(f"saved preview_yt.png ({img.size[0]}x{img.size[1]})")
        return

    payload = INIT + TOP_PAD + image_to_raster(img) + BOTTOM_PAD + CUT_FULL
    send_raw(args.printer, payload)
    print(f"sent {len(payload)} bytes to {args.printer}.")


if __name__ == "__main__":
    main()
