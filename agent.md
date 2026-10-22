"""
================================================================================
PROJECT: ComfyUI RAM Encryption & Video Helper Suite (VHS)
================================================================================
A privacy-focused ComfyUI custom node suite (extending Video Helper Suite) that
enforces client-side encryption on input media and ephemeral in-RAM processing on
the remote server. Unencrypted media files never touch remote cloud storage;
previews are decrypted and rendered exclusively in the local browser via WebCrypto.

TECH STACK & RUN COMMANDS:
- Backend: Python 3.10+, PyTorch, PyAV (av), cryptography (RSA-OAEP, AES-256-GCM),
  ComfyUI V2 API (comfy_api.latest).
- Frontend: Vanilla JavaScript (ES modules), ComfyUI Extension API, LiteGraph.js,
  WebCrypto API (window.crypto.subtle).
- Install: pip install av cryptography torch numpy pillow
- Run:     python main.py --listen 0.0.0.0 --port 8188

KEY ARCHITECTURE & FILE STRUCTURE:
- load_video_nodes.py : LoadVideoUpload (RAM decryption, native VIDEO object generation).
- nodes.py            : VideoCombine, VHS_ImageUploadRAM, VHS_ImagePreviewRAM, server key.
- server.py           : Custom server endpoints (/vhs/viewvideo, /crypto/server_pubkey).
- web/js/
    ram_encryption.js : WebCrypto client encryption, upload logic, local preview render.
    VHS.core.js       : VHS upstream UI controller (widgets, connections, DOM previews).

CORE RULES & CONVENTIONS:
1. Do Not Overcomplicate: Prefer minimal, targeted line diffs over complex wrappers.
2. Zero Cloud Disk Plaintext: Input media must only land as .bin ciphertext.
3. Mandatory RAM Zeroization: Always zero-fill and delete decrypted buffers in a
   finally block:
       finally:
           if decrypted_buf is not None:
               decrypted_buf[:] = b"\x00" * len(decrypted_buf)
               del decrypted_buf
4. Decouple from VHS Server Previews: Never request /vhs/viewvideo on .bin files.
5. Strict API Compliance: Output standard tensors and ComfyUI V2 native objects.

CRITICAL DESIGN DECISIONS (DO NOT ALTER WITHOUT REASON):
- Local-Only Preview for LoadVideoUpload: Renders directly from browser memory
  (URL.createObjectURL(file)) upon upload. Never fetch .bin previews from server.
- Default Empty String ("") for Video Dropdown: files = [""] + sorted(files).
  Prevents new tabs and nodes from auto-selecting existing .bin files on startup.
- Native VIDEO Object via InputImpl.VideoFromComponents: Required by native SaveVideo
  to access .get_dimensions(). Do not use raw Python dicts.
- Dual-Tagged Dynamic Socket ("IMAGE,VIDEO"): Declared in RETURN_TYPES so ComfyUI
  allows connecting to both IMAGE and VIDEO inputs when toggling native_enable.
- Hidden "image" Input for VHS_ImageUploadRAM: Defined in "required" on backend,
  hidden in JS (type="hidden", computeSize=() => [0, -4]) to maintain serialization.
- Audio Speed Invariance: Audio stays at 1x speed regardless of VideoCombine FPS
  changes. Audio duration is defined in absolute sample rate (Hz), not visual FPS.

PAST BUGS PREVENTED (REGRESSION WATCHLIST):
- ValueError (No image uploaded): Caused by placing "image" in INPUT_TYPES["hidden"].
  Backend execution ignores "hidden" inputs; keep in "required", hide visually via JS.
- Missing Upload Button: Caused by checking if (!widgets.some("upload")) when ComfyUI
  auto-created an unlinked widget. Always reuse/attach callback to existing widget.
- Preview Vanished on Upload: Caused by calling targetWidget.callback(data.name).
  This handed control to VHS core, which requested server .bin streams and collapsed.
- Server Crash (Invalid data found): Caused by FFmpeg running on encrypted .bin files.
  Never route .bin files to FFmpeg on the server.
- AttributeError ('dict' has no 'get_dimensions'): Caused by returning raw dict
  instead of InputImpl.VideoFromComponents(Types.VideoComponents(...)).
- SaveVideo Type Mismatch ("expects VIDEO, connected is IMAGE"): Updating output.name
  alone left output.label rendering "IMAGE". Update name, label, and type together.
- TypeError (Cannot read properties of undefined 'refresh_preview'): Adding buttons
  in JS without declaring them in nodeData.input.optional crashed VHS schema loops.
- Old Workflows Rendering Blank: Old workflows saved container state as hidden: true.
  Always explicitly set previewWidget.parentEl.hidden = false in renderDecryptedPreview.
================================================================================
"""