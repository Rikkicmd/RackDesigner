#!/usr/bin/env python3
"""Builds the rack designer: dist/system-draw-rack-designer.html

    python -I build.py

One self-contained HTML file that works offline: jsPDF and the IBM Plex fonts are put inside it from
vendor/, and the page's security policy blocks all network access.
"""
import base64, json, os

here = os.path.dirname(os.path.abspath(__file__))
root = here
vendor = os.path.join(here, 'vendor')
out = os.path.join(here, 'dist', 'system-draw-rack-designer.html')


def read(p):
    return open(p, encoding='utf-8').read()


def font(family, file, weight):
    data = base64.b64encode(open(os.path.join(vendor, file), 'rb').read()).decode()
    return f"@font-face{{font-family:{family};font-weight:{weight};font-style:normal;src:url(data:font/woff2;base64,{data}) format('woff2')}}"


fonts = ''.join([
    font('Plex', 'ibm-plex-sans-latin-400-normal.woff2', 400),
    font('Plex', 'ibm-plex-sans-latin-600-normal.woff2', 600),
    font('PlexMono', 'ibm-plex-mono-latin-500-normal.woff2', 500),
])
jspdf = read(os.path.join(vendor, 'jspdf.umd.min.js')).replace('</script', '<\\/script')
page = read(os.path.join(here, 'src', 'index.html'))
for k, v in {'/*@CSS@*/': read(os.path.join(here, 'src', 'app.css')),
             '/*@JSPDF@*/': jspdf,
             '/*@FONTS@*/': json.dumps(fonts),
             '/*@APP@*/': read(os.path.join(here, 'src', 'app.js')).replace('</script', '<\\/script')}.items():
    if page.count(k) != 1:
        raise SystemExit(f'rack designer build: placeholder {k} missing from src/index.html')
    page = page.replace(k, v)
os.makedirs(os.path.dirname(out), exist_ok=True)
open(out, 'w', encoding='utf-8').write(page)
print('built', os.path.relpath(out, root), len(page.encode()), 'bytes')
