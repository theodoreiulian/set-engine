# dmgbuild settings for the SetEngine installer image. Run by scripts/make-dmg.mjs:
#
#   dmgbuild -s scripts/dmg-settings.py -D app=… -D background=… -D layout=… SetEngine out.dmg
#
# dmgbuild writes the Finder window layout (.DS_Store) itself, so this needs
# neither Finder scripting nor a logged-in desktop, and builds the same way on a
# CI runner. The geometry lives in assets/dmg/layout.json, shared with the
# script that draws the background around it.
import json

with open(defines['layout']) as fh:  # noqa: F821 — `defines` is injected by dmgbuild
    layout = json.load(fh)

app = defines['app']  # noqa: F821

files = [app]
symlinks = {'Applications': '/Applications'}

# HFS+ so every macOS the app supports can mount it, and because it is the
# filesystem Finder's window backgrounds were designed around.
filesystem = 'HFS+'
# Built writable first: make-dmg.mjs patches the background reference on the
# mounted image (see dmg-fix-background.py) and compresses it afterwards.
format = 'UDRW'

background = defines['background']  # noqa: F821

# The window is deliberately a little shorter than the picture. Finder's window
# size includes the title bar, and what is left for the picture varies: the bar
# is 28 pt on older systems and 32 pt on macOS 26 (measured from a screenshot),
# and a user who keeps Finder's path bar on loses another ~28 pt at the bottom.
# A window taller than the picture shows a blank band — white, in light mode —
# so the picture is given spare height at the bottom instead, holding only the
# decorative waveform, and whatever the system takes is cropped from that.
window_rect = ((200, 140), (layout['window']['width'], layout['contentHeight'] + layout['titleBar']))
default_view = 'icon-view'
show_status_bar = False
show_tab_view = False
show_toolbar = False
show_pathbar = False
show_sidebar = False

arrange_by = None
label_pos = 'bottom'
icon_size = layout['iconSize']
text_size = layout['textSize']
icon_locations = {
    'SetEngine.app': (layout['app']['x'], layout['app']['y']),
    'Applications': (layout['applications']['x'], layout['applications']['y']),
}
