# Chat photos

Use **Attach photos** (phone library or desktop picker), **Camera** on touch devices, paste screenshots into the composer, or drop files onto the composer. Photos can be sent without text. Remove a thumbnail to detach it. Click an image in history to open the processed image in an authenticated browser tab.

## Limits and conversion

- Up to four images per prompt, 20 MiB per original, 50 megapixels decoded.
- JPEG, PNG, WebP, and HEIC/HEIF. Extensions and client MIME types are not trusted; the server validates and decodes the content.
- HEIC uses bundled libheif WebAssembly via `heic-decode`, including HEVC support, independent of the host's libvips codec build. Only the first image is used; Live Photo video, depth data, and auxiliary frames are not sent.
- Auto-oriented, resized to fit 2048×2048 without enlargement, flattened onto white, and encoded as quality-90 JPEG. EXIF/GPS and other original metadata are stripped. Transparency and original-file fidelity are not preserved.
- One conversion at a time per server process. Upload reading and conversion each have a 30-second deadline. Conversion runs in a disposable Node process with a 256 MiB JS heap limit, pixel limits, disabled sharp cache, and one sharp worker thread. The JS heap limit is not an OS-level memory sandbox for native/WASM allocations; retain deployment container memory limits.
- Models whose RPC catalog does not advertise image input reject photo prompts explicitly. Text-only prompts remain supported.

## Storage and privacy

`STATE_DIR/photos` is a private upload cache with a 256 MiB admission cap. Processed uploads expire after 24 hours; cleanup runs at startup, before uploads, and hourly. Originals exist only as temporary conversion inputs and are removed when processing completes, including failures. After an abrupt process/container death, leftover conversion directories older than a minute are removed on the next cleanup.

Pi receives standard image content blocks and persists processed images in its session JSONL. Sessions are the durable source for sent photos; deleting an upload-cache entry does not delete its session copy. History rebuilds image references from the active branch and serves images for the displayed last 200 messages without embedding base64 in browser snapshots. Existing session backups therefore contain sent photos. No new public file-serving route or third-party image service is used.

Photo upload requires a valid browser session, an allowed Origin, and a valid thread ID in the workspace catalog. Image downloads require a valid browser session. Both use `Cache-Control: no-store`. All signed-in users share this workspace's access, as with chat itself.

Draft photos stay associated with their thread in the current browser page. Upload/send errors retain the draft for review. Drafts are not persisted across page reloads, and uncertain sends are never automatically replayed. Expired uploads must be removed and attached again.

## Validation

Run `npm ci --include=dev`, `npm run check`, and `npm run build`, then `npm test` and `npm run test:browser`. Tests cover actual HEIC decoding, orientation/metadata stripping, authenticated delivery, limits, model rejection, history reconstruction, paste/drop, mobile camera controls, and draft retention on upload failure. The synthetic HEIC fixture is documented under `test/fixtures/photos`.

The normal image build copies the worker and bundled dependencies; no system HEIC packages are required. Build/deploy images via CI or the host, not inside the live pod. Test real iPhone camera/library selection on a device before release; browser emulation cannot exercise the native photo picker.
