#!/usr/bin/env python3
"""eRIGHT visitor label agent - prints a stick-on label on the Brother QL-700 at the door kiosk when a visitor signs in.

Runs on the door kiosk Pi (systemd unit eright-labels, installed by install-labels.sh). It follows the sign-in server's
live stream (GET /api/stream) and, on every change, reads the public kiosk state (GET /api/state). Any visitor who
signed in within the last LABEL_WINDOW_SECONDS (default 10 min) and has not been printed yet gets one label. The
window means a restart never prints a backlog of people who are long gone. Printed ids are kept in a small state file.

The loaded roll is read from the printer before every label (the QL-700 reports it), so changing the roll needs no
setting: on an endless roll the label is LABEL_LENGTH_MM long (default 90 mm), on a die-cut roll it fills the label.

Commands:
  label_agent.py run              the service loop
  label_agent.py status           what the printer reports (model, roll, errors)
  label_agent.py test             print one sample label now
  label_agent.py render OUT.png [WIDTHxHEIGHT]   draw the sample label to a file (no printer needed)
  label_agent.py reprint BADGE    print again for today's visitor with that badge number
"""
import datetime
import json
import logging
import os
import re
import sys
import threading
import time
import urllib.request

from PIL import Image, ImageDraw, ImageFont

SERVER = os.environ.get('SIGNIN_URL', 'http://192.168.101.102:3000').rstrip('/')
PRINTER = os.environ.get('LABEL_PRINTER', 'file:///dev/usb/lp0')
MODEL = os.environ.get('LABEL_MODEL', 'QL-700')
LENGTH_MM = float(os.environ.get('LABEL_LENGTH_MM', '90'))
WINDOW_S = int(os.environ.get('LABEL_WINDOW_SECONDS', '600'))
STATE_FILE = os.environ.get('LABEL_STATE', '/var/lib/eright-labels/state.json')
SHOW_VEHICLE = os.environ.get('LABEL_SHOW_VEHICLE', '1') != '0'
DPI = 300
MAX_TRIES = 3
RETRY_S = 30

FONT_BOLD = ['/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', 'C:/Windows/Fonts/arialbd.ttf']
FONT_REG = ['/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', 'C:/Windows/Fonts/arial.ttf']

log = logging.getLogger('labels')


# ---- drawing --------------------------------------------------------------------------------------------------------
def _font_path(candidates):
    for p in candidates:
        if os.path.exists(p):
            return p
    raise FileNotFoundError(f'none of these fonts exist: {candidates}')


def clean(text, limit=80):
    """Typed by the public at the kiosk: one line, printable, bounded."""
    return re.sub(r'\s+', ' ', re.sub(r'[\x00-\x1f\x7f]+', ' ', str(text or ''))).strip()[:limit]


def fit(draw, text, bold, max_w, max_h):
    """Largest font (by pixel height) at which `text` fits in max_w x max_h."""
    path = _font_path(FONT_BOLD if bold else FONT_REG)
    size = max(8, int(max_h))
    while size > 8:
        font = ImageFont.truetype(path, size)
        left, top, right, bottom = draw.textbbox((0, 0), text, font=font)
        if right - left <= max_w and bottom - top <= max_h:
            return font
        size -= 2
    return ImageFont.truetype(path, 8)


def local_time(iso):
    t = datetime.datetime.fromisoformat(str(iso).replace('Z', '+00:00'))
    return t.astimezone().strftime('%a %d %b %Y  %H:%M')


def render(visitor, company, size):
    """The label as a landscape image `size` = (long side, short side) in printer dots, black on white."""
    w, h = size
    img = Image.new('1', (w, h), 1)
    d = ImageDraw.Draw(img)
    m = round(h * 0.045)                     # outer margin
    compact = h < 400                        # e.g. a 62x29 die-cut label: fewer, bigger lines
    name = clean(visitor.get('name'), 60) or 'Visitor'
    comp = clean(visitor.get('company'), 60)
    host = clean(visitor.get('hostName'), 60)
    vehicle = clean(visitor.get('vehicle'), 16).upper() if SHOW_VEHICLE else ''
    badge = str(visitor.get('badge') or '').strip()
    when = local_time(visitor['signedInAt']) if visitor.get('signedInAt') else ''

    # black band: VISITOR + company name
    band = round(h * (0.30 if compact else 0.24))
    d.rectangle([0, 0, w, band], fill=0)
    f = fit(d, 'VISITOR', True, w * 0.55, band * 0.70)
    d.text((m, band / 2), 'VISITOR', font=f, fill=1, anchor='lm')
    if company:
        f = fit(d, clean(company, 40), False, w * 0.38, band * 0.36)
        d.text((w - m, band / 2), clean(company, 40), font=f, fill=1, anchor='rm')

    # badge number box, bottom right
    box_w = round(w * (0.24 if compact else 0.22))
    box_h = round((h - band) * (0.62 if compact else 0.46))
    bx0, by0 = w - m - box_w, h - m - box_h
    if badge:
        d.rectangle([bx0, by0, w - m, h - m], outline=0, width=max(3, round(h * 0.008)))
        f = fit(d, 'BADGE', False, box_w * 0.8, box_h * 0.18)
        d.text((bx0 + box_w / 2, by0 + box_h * 0.16), 'BADGE', font=f, fill=0, anchor='mm')
        f = fit(d, badge, True, box_w * 0.85, box_h * 0.62)
        d.text((bx0 + box_w / 2, by0 + box_h * 0.62), badge, font=f, fill=0, anchor='mm')

    # text column: name, company, visiting, time, vehicle
    x = m
    y = band + round(h * 0.035)
    full_w = w - 2 * m
    col_w = (bx0 - m - x) if badge else full_w
    if compact:
        lines = [(name, True, 0.30, full_w), (' · '.join(p for p in [comp, f'visiting {host}' if host else ''] if p), False, 0.17, col_w),
                 (when + (f'   {vehicle}' if vehicle else ''), False, 0.15, col_w)]
    else:
        lines = [(name, True, 0.17, full_w), (comp, False, 0.095, full_w if not badge else full_w),
                 (f'Visiting: {host}' if host else '', False, 0.085, col_w),
                 (f'In: {when}' if when else '', False, 0.07, col_w),
                 (f'Vehicle: {vehicle}' if vehicle else '', False, 0.07, col_w)]
    for text, bold, rel, max_w in lines:
        if not text:
            continue
        lh = round(h * rel)
        # a line that would run into the badge box is held to the column width
        if badge and y + lh > by0 - round(h * 0.01):
            max_w = col_w
        f = fit(d, text, bold, max_w, lh)
        d.text((x, y), text, font=f, fill=0, anchor='lt')
        y += lh + round(h * 0.03)
    return img


# ---- printer --------------------------------------------------------------------------------------------------------
def printer_status():
    from brother_ql.backends.helpers import status
    st, _raw = status(printer_model=MODEL, printer_identifier=PRINTER, backend_identifier='linux_kernel')
    return st


def media_and_canvas():
    """(label identifier, landscape canvas size, rotate) for the roll that is loaded now."""
    st = printer_status()
    if st.get('errors'):
        raise RuntimeError(f"printer reports: {', '.join(st['errors'])}")
    m = st.get('identified_media')
    if m is None:
        raise RuntimeError(f"unknown roll (width {st.get('media_width')} mm, type {st.get('media_type')}, length {st.get('media_length')} mm)")
    across, along = m.dots_printable
    if along == 0:                                   # endless roll: we choose the length
        along = round(LENGTH_MM / 25.4 * DPI)
    if along > across:                               # text runs along the tape: draw landscape, rotate onto the roll
        return m.identifier, (along, across), 90
    return m.identifier, (across, along), 0


def print_image(img, label, rotate):
    from brother_ql.backends.helpers import send
    from brother_ql.conversion import convert
    from brother_ql.raster import BrotherQLRaster
    qlr = BrotherQLRaster(MODEL)
    qlr.exception_on_warning = True
    instructions = convert(qlr=qlr, images=[img], label=label, rotate=str(rotate), threshold=70.0, dither=False,
                           compress=False, red=False, dpi_600=False, hq=True, cut=True)
    result = send(instructions=instructions, printer_identifier=PRINTER, backend_identifier='linux_kernel', blocking=True)
    if result.get('outcome') == 'error':
        errors = (result.get('printer_state') or {}).get('errors')
        raise RuntimeError(f'printer error: {errors}')
    if not result.get('did_print'):
        raise RuntimeError('the printer did not confirm the print')
    return result


def print_visitor(visitor, company):
    label, size, rotate = media_and_canvas()
    print_image(render(visitor, company, size), label, rotate)
    log.info('printed label for %s (badge %s) on %s', clean(visitor.get('name')), visitor.get('badge'), label)


# ---- server ---------------------------------------------------------------------------------------------------------
def fetch_state():
    with urllib.request.urlopen(f'{SERVER}/api/state', timeout=10) as r:
        return json.load(r)


def load_printed():
    try:
        with open(STATE_FILE, encoding='utf-8') as f:
            return json.load(f).get('printed', {})
    except (OSError, ValueError):
        return {}


def save_printed(printed):
    cutoff = time.time() - 2 * 86400
    keep = {k: v for k, v in printed.items() if v.get('t', 0) >= cutoff}
    os.makedirs(os.path.dirname(STATE_FILE), exist_ok=True)
    tmp = STATE_FILE + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump({'printed': keep}, f)
    os.replace(tmp, STATE_FILE)


def due(visitors, printed, now):
    """Visitors to print now: signed in within the window, not printed, not out of tries, retry spacing respected."""
    out = []
    for v in visitors:
        try:
            t = datetime.datetime.fromisoformat(str(v['signedInAt']).replace('Z', '+00:00')).timestamp()
        except (KeyError, ValueError):
            continue
        if now - t > WINDOW_S or v.get('signedOutAt'):
            continue
        p = printed.get(v['id'])
        if p and (p.get('ok') or p.get('tries', 0) >= MAX_TRIES or now - p.get('last', 0) < RETRY_S):
            continue
        out.append(v)
    return out


def stream_watcher(wake):
    """Sets `wake` on every message from the server's live stream; reconnects for ever."""
    while True:
        try:
            req = urllib.request.Request(f'{SERVER}/api/stream', headers={'Accept': 'text/event-stream'})
            with urllib.request.urlopen(req, timeout=90) as r:
                for line in r:
                    if line.startswith((b'event:', b'data:')):
                        wake.set()
        except Exception as e:  # noqa: BLE001 - any failure: wait and reconnect
            log.debug('stream: %s', e)
        time.sleep(5)


def run():
    wake = threading.Event()
    threading.Thread(target=stream_watcher, args=(wake,), daemon=True).start()
    printed = load_printed()
    log.info('label agent: server %s, printer %s (%s), window %ss', SERVER, PRINTER, MODEL, WINDOW_S)
    last_err = None
    while True:
        wake.wait(20)          # the stream wakes us at once; the 20 s poll covers a lost stream
        wake.clear()
        try:
            state = fetch_state()
        except Exception as e:  # noqa: BLE001
            if str(e) != last_err:
                log.warning('server not reachable: %s', e)
                last_err = str(e)
            continue
        last_err = None
        for v in due(state.get('visitors', []), printed, time.time()):
            p = printed.setdefault(v['id'], {'tries': 0})
            p.update(t=time.time(), last=time.time(), tries=p.get('tries', 0) + 1)
            try:
                print_visitor(v, state.get('companyName') or '')
                p['ok'] = True
            except Exception as e:  # noqa: BLE001
                log.error('label for %s (badge %s) not printed, try %s of %s: %s', clean(v.get('name')), v.get('badge'), p['tries'], MAX_TRIES, e)
            save_printed(printed)


SAMPLE = {'name': 'Jane Example', 'company': 'Example Supplies Ltd', 'hostName': 'Alan Meade', 'vehicle': 'AB12 CDE',
          'badge': 7, 'signedInAt': datetime.datetime.now(datetime.timezone.utc).isoformat()}


def main(argv):
    logging.basicConfig(level=logging.INFO, format='%(levelname)s %(message)s', stream=sys.stdout)
    cmd = argv[1] if len(argv) > 1 else 'run'
    if cmd == 'run':
        run()
    elif cmd == 'status':
        st = printer_status()
        print(f"model {st.get('model_name')}, roll: {getattr(st.get('identified_media'), 'name', None) or 'not identified'}, errors: {st.get('errors') or 'none'}")
    elif cmd == 'render':
        size = tuple(int(x) for x in argv[3].lower().split('x')) if len(argv) > 3 else (round(LENGTH_MM / 25.4 * DPI), 696)
        render(SAMPLE, 'eRIGHT Ltd', size).save(argv[2])
        print(f'wrote {argv[2]} {size[0]}x{size[1]}')
    elif cmd == 'test':
        print_visitor(SAMPLE, 'eRIGHT Ltd')
    elif cmd == 'reprint':
        state = fetch_state()
        v = next((x for x in state.get('visitors', []) if str(x.get('badge')) == argv[2]), None)
        if not v:
            sys.exit(f'no visitor on site with badge {argv[2]}')
        print_visitor(v, state.get('companyName') or '')
    else:
        sys.exit(__doc__)


if __name__ == '__main__':
    main(sys.argv)
