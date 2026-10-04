import hashlib
import json
import pathlib
import sys
import zipfile

app = pathlib.Path(__file__).resolve().parents[1]
manifest = json.loads((app / 'browser-runtime.json').read_text())
with zipfile.ZipFile(sys.argv[1], 'w', zipfile.ZIP_DEFLATED) as archive:
    for entry in manifest['sourceFiles']:
        contents = (app / 'vendor/sct' / entry['file']).read_bytes()
        if hashlib.sha256(contents).hexdigest() != entry['sha256']:
            raise RuntimeError('Pinned SCT source changed: ' + entry['file'])
        info = zipfile.ZipInfo(entry['file'], (2000, 1, 1, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        archive.writestr(info, contents)
