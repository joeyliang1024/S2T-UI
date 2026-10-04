# Docker web build dependencies

These files are source-controlled inputs for `Dockerfile.web`. They prevent
package install hooks or URL dependencies from bypassing the company's Nexus
registry during an otherwise offline Docker build.

Build with the internal npm group/proxy explicitly supplied. `Dockerfile.web`
requires this value and uses npm's `replace-registry-host=npmjs` option, so
the npmjs URLs retained in the lockfile are rewritten to Nexus instead of
being contacted directly:

```sh
docker build -f Dockerfile.web \
  --build-arg NPM_REGISTRY=https://nexus.example/repository/npm-group/ \
  -t s2t-web:offline .
```

The build host must allow access to this internal Nexus endpoint (and have the
`node:22-bookworm-slim` base image already present or available through the
company Docker registry mirror), while public Internet egress remains blocked.

| File | Purpose | SHA-256 |
| --- | --- | --- |
| `npm/xlsx-0.20.3.tgz` | SheetJS `xlsx` 0.20.3 package; upstream declares a CDN URL | `8dc73fc3b00203e72d176e85b50938627c7b086e607c682e8d3c22c02bb99fe8` |
| `ffmpeg-static/ffmpeg-linux-arm64` | Registry tarball `@ffmpeg-installer/linux-arm64@4.1.4`; extracted binary, no install hooks | `115a825e246078acf820ea2afcaf1b3ff87f1b93f7035ecad38d3223cca55297` |
| `ffmpeg-static/ffmpeg-linux-x64` | `ffmpeg-static` 5.3.0's `b6.1.1` Linux x64 binary | `e7e7fb30477f717e6f55f9180a70386c62677ef8a4d4d1a5d948f4098aa3eb99` |

To update a file, update its version in `package.json`/`package-lock.json`,
replace the matching artifact here, and update this checksum. Docker selects the binary matching Node process.arch (x64 or arm64).
The ARM64 artifact is an older ffmpeg release than the existing x64 artifact;
it is used for this local Docker verification and does not change package-lock.json.
Its npm tarball shasum is `7219f3f901bb67f7926cb060b56b6974a6cad29f`.
Obtain it via the approved registry using npm pack with --ignore-scripts,
then extract package/ffmpeg. Never run package install hooks to fetch binaries.
Nemotron weights and the matching Linux CPU runtime must already exist under
models/nemotron-3-diarization; Docker mounts them read-only and does not fetch them.
