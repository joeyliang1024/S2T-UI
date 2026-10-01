# Docker web build dependencies

These files are source-controlled inputs for `Dockerfile.web`. They prevent
package install hooks or URL dependencies from bypassing the company's Nexus
registry during an otherwise offline Docker build.

Build with the internal npm group/proxy explicitly supplied. `Dockerfile.web`
requires this value and uses npm's `replace-registry-host=always` option, so
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
| `ffmpeg-static/ffmpeg-linux-x64` | `ffmpeg-static` 5.3.0's `b6.1.1` Linux x64 binary | `e7e7fb30477f717e6f55f9180a70386c62677ef8a4d4d1a5d948f4098aa3eb99` |

To update a file, update its version in `package.json`/`package-lock.json`,
replace the matching artifact here, and update this checksum. The image is
Linux x64; provide another architecture-specific binary before building for a
different target platform.
