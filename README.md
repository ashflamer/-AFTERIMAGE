# Pixel Cipher Lab

[Open the lab on Render](https://pixel-cipher-lab.onrender.com/) · [API health](https://pixel-cipher-lab.onrender.com/api/health)

Encrypt the same image with the same AES-128 key in two modes, then inspect the actual ciphertext bytes as pixels. ECB encrypts identical 16-byte blocks identically. CBC mixes each block with the previous ciphertext block (or the IV for the first block), so repeated input doesn't produce the same visible pattern.

## Reproduce the checkerboard result

1. Open **Pattern press**, select **Checkerboard**, leave **Pitch** at **16 px**, and click **Encrypt pattern**.
2. Check **Block analysis**. Each row consists of 16-pixel runs of dark or light gray. One pixel is one byte, so each run is exactly one AES block. There are only two distinct input blocks in the whole image: ECB produces **4,094 repeats out of 4,096 blocks**. The count excludes the first occurrence of each distinct block.
3. In **Match finder**, read the top and bottom hex strips for each mode. They're two different positions with identical plaintext. Their ECB bytes match exactly; compare the CBC bytes at those same positions. **Next pair** selects another example.
4. Click **New IV** without changing the image or key. The ECB plate stays byte-for-byte identical. Only CBC needs to be encrypted again.

## Working with plates

| To… | Use |
|---|---|
| Try another input | Select **Penguin**, **Text**, or **Gradient**; print rings or a weave in **Pattern press**; or drop a PNG, JPG, or WebP (up to 12 MB). |
| Inspect one position | Point at a plate or move the **Block probe** slider. Its marker tracks the same 16 consecutive pixels in all three images. The slider also accepts arrow keys. |
| Locate repeats | **Show blocks** overlays a grid and highlights repeated ciphertext blocks. The histogram counts individual byte values, not repeated blocks. |
| Present or save a result | **Present** (shortcut: **P**) hides the controls and analytics. **Save plate · PNG** exports the three labeled images at 864 × 390, without the overlays, key, or IV. The PNG includes the plaintext image. |

## Run locally

From the repository root, with **Node.js 22.x**:

```sh
npm start
```

Open <http://localhost:8000>. No dependency install, build step, or database is required. `PORT` overrides the default. The server runs an AES known-answer test before it listens. To run that test without starting the server:

```sh
node -e "require('./lib/engine').selfTest()"
```

For your own hosted instance, [deploy the Render Blueprint](https://render.com/deploy?repo=https://github.com/ashflamer/-AFTERIMAGE). [`render.yaml`](render.yaml) configures a free Node web service from `main` with `/api/health` as its health check. A free instance can take a moment to wake after inactivity.

## What goes to the server

The browser center-crops the image to a square and converts it to 256 × 256 grayscale pixels. It sends those **65,536 bytes**, not the original image file, along with the key and IV. The Node server serves both the interface and the API; encryption happens in [`lib/engine.js`](lib/engine.js).

| Method | Endpoint | Contract |
|---|---|---|
| `GET` | `/api/health` | Returns `ok`, `engine`, and `uptime` in seconds. |
| `POST` | `/api/new-key` or `/api/new-iv` | Returns a random 16-byte value as 32 hex characters, under `key` or `iv`. |
| `GET` | `/api/events?id=<jobId>` | Opens a server-sent event stream. Subscribe before posting the matching job to see its `stage` events in the API event log. |
| `POST` | `/api/encrypt` | Send JSON with `jobId`, `key`, `iv`, `gray` (base64 pixels), and `scope` (`both` or `cbc`). Returns base64 ciphertext for the requested modes, block statistics, byte histograms, and run metadata. |

This is a visual experiment, not a private file-encryption tool. Use sample images and disposable keys on the public instance. Neither mode here authenticates ciphertext; use a vetted authenticated-encryption library for real data.
