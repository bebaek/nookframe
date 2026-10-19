---
name: images
description: Publish generated or downloaded images into chat responses, with inline previews and full-resolution downloads. Use when asked to draw, plot, show, or return an image.
---

# Images in responses

Use `imagectl` to publish images. Local filesystem paths and external image URLs
DO NOT render inline in Nookframe. Never invent a browser URL for a local file.
For native checkouts without `imagectl` on PATH, invoke
`node <this-skill-directory>/../../dist/server/image-cli.js` with the same
arguments. Resolve that path from this skill's location, not the current working
directory; Nookframe supplies `NOOKFRAME_IMAGE_STATE_DIR` in either environment.

1. Run `imagectl context`. It returns the current `thread` and a dedicated output
   `directory`. Keep this thread ID for the entire operation.
2. Generate an image there, or download a user-requested public PNG/JPEG/WebP to
   that directory. Quote paths and URLs as literal shell arguments. Do not
   download private resources or include credentials in URLs. Downloads are
   explicit shell operations, not a server-side image proxy. Use bounded requests
   (for example `curl --fail --location --max-time 60 --max-filesize 20971520`).
   The selected URL and redirect destinations must be appropriate public sources.
3. Run `imagectl publish 'THREAD' '/absolute/path/to/image.png' 'Description'`.
   Pass exactly the thread ID from step 1. A changed thread is rejected; do not
   automatically publish an earlier task's image into another thread.
4. Include the returned `markdown` verbatim in your final response. It contains
   an inline preview and a full-resolution download link. Credit public sources
   and respect their licenses. Do not claim success if publishing failed.

Publishing retains an immutable copy associated with the thread, so links survive
browser reloads, thread switching, and restarts. Signed-in browsers can read
published images across threads. They are not public sharing URLs. Previews are
resized to 2048 pixels; downloads preserve the exact original file and metadata.
Do not publish sensitive images or metadata unintentionally. No automatic expiry
or deletion is performed; published images count toward the per-slot quota.

Supported input: static PNG, JPEG, WebP up to 20 MiB and 25 megapixels. SVG, GIF,
animation, symlinks and files outside the dedicated directory are rejected.
Render generated SVG charts to PNG before publishing. Full-resolution downloads
retain the input dimensions; choose a suitable resolution rather than upscaling
an existing small image. If the store is full, report it; do not delete existing
images to make room without explicit approval.
