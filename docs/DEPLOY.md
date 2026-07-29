# Deploying to Render

The repo contains a `render.yaml` blueprint, so Render can configure the service itself.

## Blueprint route (recommended)

1. In Render, go to **New → Blueprint**.
2. Connect the `KrisBelau/creativeexpansion` repo.
3. Render reads `render.yaml` and proposes a web service called `creative-expansion`. Apply it.
4. When the build finishes, open **Environment** and copy the generated `ACCESS_PASSWORD`.
5. Visit the service URL. The browser asks for credentials — **any username**, that password.

The blueprint pins the branch to `claude/ad-asset-resizer-spec-3jgp4g`. Change `branch:` in
`render.yaml` once the work is merged.

## Manual route

If you'd rather click through it rather than use the blueprint:

| Setting | Value |
| --- | --- |
| Type | Web Service |
| Runtime | Node |
| Branch | `claude/ad-asset-resizer-spec-3jgp4g` |
| Build command | `npm ci && npm run sample` |
| Start command | `npm start` |
| Health check path | `/healthz` |

Then add the environment variables from the table below.

## Environment variables

| Variable | Default | Why it exists |
| --- | --- | --- |
| `PORT` | set by Render | The server reads it; don't set it yourself. |
| `NODE_VERSION` | `22` | sharp ships prebuilt binaries for current Node on Linux x64. |
| `ACCESS_PASSWORD` | none | HTTP basic auth. **Set this.** Without it the URL is open to anyone. |
| `MAX_UPLOAD_MB` | `24` | Upload ceiling. The local default in the code is the same; a 500 MB upload would OOM a 512 MB instance instantly. |
| `MAX_SOURCES` | `4` | Analysed masters kept in memory before the oldest is evicted. |
| `MAX_BATCHES` | `3` | Rendered batches kept in memory. Each holds every output buffer. |
| `MAX_PLACEMENTS_PER_BATCH` | `60` | Rejected before rendering starts, with a clear error, rather than dying halfway. |

## Instance size

Everything is held in process memory — there is no database and no object storage yet
(SPEC §13). That makes deployment trivial and makes memory the binding constraint.

| Plan | RAM | What to expect |
| --- | --- | --- |
| **Free** | 512 MB | Works for demonstrating the tool. Spins down after ~15 min idle, so the first request after a pause takes ~30 s. Keep batches under ~40 placements. |
| **Starter** | 512 MB | Same memory, no spin-down. |
| **Standard** | 2 GB | What you want for real fan-outs — a full 74-placement run on a large master, comfortably. Raise `MAX_*` to match. |

A 40-placement batch on a 1080×1080 master holds roughly 100–150 MB of pixel buffers at peak.
Doubling the master's dimensions roughly quadruples that.

## Things that will bite you

**Batches vanish on restart.** Sources and rendered outputs live in memory, so a deploy, a
crash, or a free-tier spin-down loses them. Export the ZIP before walking away. Persistence is
specified in SPEC §13 but not built.

**No persistent disk is needed or used.** Don't attach one; nothing writes to disk except the
build-time sample generation.

**The free tier's spin-down looks like a hang.** The first request after idle takes ~30 s while
the container wakes. It is not a bug in the app.

**Rendering is slow on shared CPU.** A 39-placement fan-out takes ~30 s on a dedicated core and
several minutes on a free instance. The render is a background job with a progress bar, so the
page stays responsive and tells you where it is — but if you select the widest presets on the
free tier, expect to wait. Fewer placements per batch, or a Standard instance, is the fix.

**Video is not supported.** Phase 3 needs `ffmpeg`, which Render's Node runtime does not
include. Video placements are filtered out of every preset, so nothing breaks — there is just
nothing to render. Adding it later means either a Docker runtime with ffmpeg installed or
`@ffmpeg-installer/ffmpeg` as a dependency.

## Verifying a deploy

```bash
curl https://<your-service>.onrender.com/healthz
# {"ok":true,"engine":"2026.07.0"}
```

With a password set, everything except `/healthz` returns 401 until you authenticate — that
endpoint is deliberately outside the gate so Render's health check keeps working.
