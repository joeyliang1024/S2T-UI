#!/usr/bin/env python3
"""Build the local benchmark image without copying credentials or local data."""
import hashlib, os, shutil, subprocess, sys, tempfile
from pathlib import Path

root=Path(__file__).resolve().parents[3]
docker=['docker','--context','colima-s2t-stress']
base='s2t-ui:performance-20261021'
if '--full' in sys.argv:
    subprocess.run(docker+['build','--build-arg','NPM_REGISTRY='+os.environ.get('NPM_REGISTRY','https://registry.npmjs.org'),'-f','Dockerfile.web','-t',base,'.'],cwd=root,check=True)
else:
    # Kubelet can garbage-collect an older incremental base while retaining the
    # currently running image. Reuse it only when its dependency lock matches.
    source=base
    if subprocess.run(docker+['image','inspect',base],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode:
        source='s2t-ui:performance-final-20261021'
    expected=hashlib.sha256((root/'package-lock.json').read_bytes()).hexdigest()
    try:
        actual=subprocess.check_output(docker+['run','--rm','--pull=never','--entrypoint','node',source,'-e',"console.log(require('node:crypto').createHash('sha256').update(require('node:fs').readFileSync('/app/package-lock.json')).digest('hex'))"],text=True).strip()
    except subprocess.CalledProcessError:
        raise SystemExit('No usable local dependency image; rebuild with --full.')
    if actual!=expected:
        raise SystemExit('Dependency lock changed; rebuild with --full before overlaying application code.')
    if source!=base:
        subprocess.run(docker+['tag',source,base],check=True)
subprocess.run(['npm','run','build:web'],cwd=root,check=True)
with tempfile.TemporaryDirectory(prefix='s2t-perf-build-') as directory:
    context=Path(directory)
    for source in ['server','out/web']:
        shutil.copytree(root/source,context/source)
    for source in ['package.json','package-lock.json']:
        shutil.copy2(root/source,context/source)
    (context/'Dockerfile').write_text(f'FROM {base}\nWORKDIR /app\nCOPY server ./server\nCOPY package.json package-lock.json ./\nCOPY out/web ./out/web\n')
    subprocess.run(docker+['build','-t','s2t-ui:performance-final-20261021',str(context)],check=True)
