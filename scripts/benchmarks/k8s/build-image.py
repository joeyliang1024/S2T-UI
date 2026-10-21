#!/usr/bin/env python3
"""Build the local benchmark image without copying credentials or local data."""
import os, shutil, subprocess, sys, tempfile
from pathlib import Path

root=Path(__file__).resolve().parents[3]
docker=['docker','--context','colima-s2t-stress']
base='s2t-ui:performance-20261021'
if '--full' in sys.argv:
    subprocess.run(docker+['build','--build-arg','NPM_REGISTRY='+os.environ.get('NPM_REGISTRY','https://registry.npmjs.org'),'-f','Dockerfile.web','-t',base,'.'],cwd=root,check=True)
else:
    subprocess.run(docker+['image','inspect',base],stdout=subprocess.DEVNULL,check=True)
subprocess.run(['npm','run','build:web'],cwd=root,check=True)
with tempfile.TemporaryDirectory(prefix='s2t-perf-build-') as directory:
    context=Path(directory)
    for source in ['server','out/web']:
        shutil.copytree(root/source,context/source)
    for source in ['package.json','package-lock.json']:
        shutil.copy2(root/source,context/source)
    (context/'Dockerfile').write_text(f'FROM {base}\nWORKDIR /app\nCOPY server ./server\nCOPY package.json package-lock.json ./\nCOPY out/web ./out/web\n')
    subprocess.run(docker+['build','-t','s2t-ui:performance-final-20261021',str(context)],check=True)
