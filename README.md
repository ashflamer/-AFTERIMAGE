# PIXEL CIPHER LAB

Upload a picture. Watch one mode fail to hide it.

PIXEL CIPHER LAB is a small visual lab for AES-128. You upload an image, the server encrypts it in ECB and CBC mode, and the browser shows the plaintext next to both ciphertexts. ECB leaks the structure of the image because identical plaintext blocks produce identical ciphertext blocks. CBC chains each block to the previous one, so the leak disappears.

Run it:

    node server.js

Then open http://localhost:8000

On startup the server runs a NIST known-answer check and prints `engine ok: 69c4e0d86a7b0430d8cdb78070b4c55a` if the AES engine is correct.

## API

| Method | Path | What it does |
|---|---|---|
| GET | /api/health | Reports engine status and uptime |
| GET | /api/events?id=... | Server-sent events for one encrypt job |
| POST | /api/new-key | Returns a fresh random 128-bit key as hex |
| POST | /api/new-iv | Returns a fresh random IV as hex |
| POST | /api/encrypt | Encrypts 65536 grayscale bytes in ECB, CBC, or both |

## ECB vs CBC

ECB encrypts every 16-byte block on its own, so the same plaintext block always gives the same ciphertext block. Flat areas of an image become flat areas of repeated ciphertext, and the picture shows through. CBC XORs each plaintext block with the previous ciphertext block before encrypting, so identical blocks encrypt differently and the structure is hidden. Neither mode provides integrity — a tampered ciphertext still decrypts. Use AES-GCM in production.
