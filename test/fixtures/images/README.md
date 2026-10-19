# Public image fixture

`apollo17-earth.jpg` is Wikimedia Commons' 330-pixel thumbnail of the public-domain
NASA Apollo 17 photograph “The Blue Marble”, downloaded on 2026-10-19.
The downloaded thumbnail bytes are unchanged.

- Source: https://commons.wikimedia.org/wiki/File:The_Earth_seen_from_Apollo_17.jpg
- Download: https://upload.wikimedia.org/wikipedia/commons/thumb/9/97/The_Earth_seen_from_Apollo_17.jpg/330px-The_Earth_seen_from_Apollo_17.jpg
- Credit: NASA / Apollo 17 crew (Harrison Schmitt or Ron Evans)
- License: public domain, US federal government work (NASA)
- Dimensions: 330 × 330
- Size: 38,481 bytes
- SHA-256: `27f1e962b444029c0f0924161c486ccad397f4011dbeedcad3355a0049b121be`

Tests use the checked-in public-image download, not a live network request. This
keeps CI deterministic while exercising publishing, no-upscale previews, and
byte-for-byte download preservation. A separate test generates a compressible
high-resolution image at runtime to verify preview resizing and transparency;
no large binary fixture is needed for that coverage.
