"""Make the installer's background picture show up on macOS 26 (Tahoe).

    python scripts/dmg-fix-background.py /Volumes/SetEngine           # patch
    python scripts/dmg-fix-background.py --check /Volumes/SetEngine   # verify

Run by scripts/make-dmg.mjs, with the virtualenv's Python, on the mounted image:
writable for the patch, the finished read-only one for the check.

Finder finds the background through a bookmark (`pBBk`) stored in the volume's
.DS_Store. dmgbuild builds that bookmark by hand, and on macOS 26 the system
refuses to resolve it ("The file doesn't exist") — so the window opened with
the icons in place and no picture behind them. A bookmark made by macOS itself
resolves, so this asks the system for one and swaps it in. dmgbuild's other
reference to the picture, the classic alias inside `icvp`, is left alone for
the older systems that read it.

Measured on macOS 26.5 with URL(resolvingBookmarkData:): dmgbuild's bookmark
fails, Finder's own and the one written here both resolve.
"""

import base64
import os
import subprocess
import sys

from ds_store import DSStore

BACKGROUND = '.background.tiff'

# NSURL.bookmarkData, through osascript's Objective-C bridge: nothing to compile
# and no Automation permission involved (it never talks to Finder). The options
# are the ones Finder itself uses for this record — a minimal bookmark with no
# implicit security scope.
MAKE_BOOKMARK = r'''
ObjC.import('Foundation');
function run(argv) {
  var url = $.NSURL.fileURLWithPath(argv[0]);
  var err = Ref();
  var data = url.bookmarkDataWithOptionsIncludingResourceValuesForKeysRelativeToURLError(
    0x20000200, $(), $(), err);
  if (!data || data.isNil()) throw new Error('could not create a bookmark for ' + argv[0]);
  return data.base64EncodedStringWithOptions(0).js;
}
'''

# withoutUI | withoutMounting: resolve only if the file is really there.
RESOLVE_BOOKMARK = r'''
ObjC.import('Foundation');
function run(argv) {
  var data = $.NSData.alloc.initWithBase64EncodedStringOptions(argv[0], 0);
  var err = Ref();
  var url = $.NSURL.URLByResolvingBookmarkDataOptionsRelativeToURLBookmarkDataIsStaleError(
    data, 0x300, $(), null, err);
  if (!url || url.isNil()) return '';
  return url.path.js;
}
'''


def jxa(script, arg):
    out = subprocess.run(
        ['/usr/bin/osascript', '-l', 'JavaScript', '-e', script, arg],
        check=True, capture_output=True, text=True,
    )
    return out.stdout.strip()


class RawBookmark:
    """Lets ds_store write bookmark bytes it did not build itself."""

    def __init__(self, data):
        self._data = data

    def to_bytes(self):
        return self._data


def stored_bookmark(volume):
    with DSStore.open(os.path.join(volume, '.DS_Store'), 'r') as store:
        for entry in store:
            if entry.filename == '.' and entry.code == b'pBBk':
                return entry.value.to_bytes()
    return None


def check(volume):
    data = stored_bookmark(volume)
    if data is None:
        sys.exit('The image has no background bookmark.')
    resolved = jxa(RESOLVE_BOOKMARK, base64.b64encode(data).decode())
    expected = os.path.realpath(os.path.join(volume, BACKGROUND))
    if not resolved or os.path.realpath(resolved) != expected:
        sys.exit(f'The background bookmark does not resolve (got "{resolved}", expected "{expected}").')


def patch(volume):
    picture = os.path.join(volume, BACKGROUND)
    if not os.path.exists(picture):
        sys.exit(f'{picture} is missing — dmgbuild did not copy the background.')
    data = base64.b64decode(jxa(MAKE_BOOKMARK, picture))
    with DSStore.open(os.path.join(volume, '.DS_Store'), 'r+') as store:
        store['.']['pBBk'] = RawBookmark(data)
    check(volume)


if __name__ == '__main__':
    args = sys.argv[1:]
    if args[:1] == ['--check']:
        check(args[1])
    else:
        patch(args[0])
