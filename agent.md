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
- nodes.py            : VideoCombine (+ _FrameSource, _zeroize_view helpers),
                        VHS_ImageUploadRAM, VHS_ImagePreviewRAM, server key.
- server.py           : Custom server endpoints (/vhs/viewvideo, /crypto/server_pubkey).
- web/js/
    ram_encryption.js : WebCrypto client encryption, upload logic, local preview render,
                        keypair export/import session management.
    VHS.core.js       : VHS upstream UI controller (widgets, connections, DOM previews).

CORE RULES & CONVENTIONS:
1. Do Not Overcomplicate: Prefer minimal, targeted line diffs over complex wrappers.
2. Zero Cloud Disk Plaintext: Input media must only land as .bin ciphertext.
3. Mandatory RAM Zeroization: Always zero-fill and delete decrypted/plaintext buffers in
   a finally block. Zero-fill in 1 MiB slices from a preallocated zero block, never
   with a full-size temporary (b"\x00" * len(buf) allocates a second copy):
       finally:
           if source is not None:
               source.close()                  # zero-fills the reusable chunk buffers
           if plaintext_view is not None:
               _zeroize_view(plaintext_view)   # chunked zero-fill of the encoded buffer
               plaintext_view.release()
           bio.close()
4. Decouple from VHS Server Previews: Never request /vhs/viewvideo on .bin files.
5. Strict API Compliance: Output standard tensors and ComfyUI V2 native objects.

CRITICAL DESIGN DECISIONS (DO NOT ALTER WITHOUT REASON):
- Chunked Streaming Pipeline for VideoCombine (replaces the old "Pure System RAM /
  normalize everything to CPU" rule): the full image batch is never copied, concatenated
  or converted as one tensor. Input (tensor, list/tuple of chunks, or VAE-decoded latents)
  becomes a virtual [0, N) frame sequence (_FrameSource). Frames are quantized in chunks
  of at most ~64 MB float (_CHUNK_FLOAT_BUDGET) on the tensor's own device, and ONLY the
  small uint8 chunk is moved to System RAM, then streamed straight into the encoder.
  Encoding, audio, encryption and zeroization all run in System RAM (CPU).
  Peak extra RAM is ~300 MB for 720p regardless of clip length (measured: old code needed
  ~2x the input tensor; new code 286 MB at 60 frames, 314 MB at 120 frames).
- Lossless Precision Conversion: same math, exact half-up rounding:
  clamp(0,1) -> *255 -> round -> uint8 (bit-identical to
  `torch.round(images.clamp(0.0, 1.0) * 255.0).to(torch.uint8)` for float32 input).
  Never truncate floats. NEVER mutate upstream input tensors: in-place ops (clamp_, mul_,
  round_) are allowed ONLY on the private float32 work buffer (fb.copy_(x) first).
  NaN is mapped to 0 (nan_to_num) before the cast. Non-float32 inputs are converted to
  float32 first (more accurate than the old half-precision clamp/multiply).
- On-The-Fly Frame Slicing (O(1) Video RAM): Never build a full uint8 tensor, never run
  `np.ascontiguousarray` on a whole batch, never torch.cat the input list. Crop to even
  size and [:3] channels per chunk (1-channel input is expanded to RGB), then slice
  single frames from the chunk inside the encoding loop.
- Pingpong by Index, Not by Copy: same rule as before (only when N > 2, sequence is
  [0..N-1] + [N-2..1], total N + (N-2)), but implemented as a forward pass plus a reversed
  chunk pass over [1, N-1). total_duration/audio length use this virtual frame count.
- Strict C-Contiguity for PyAV: Enforce `np.ascontiguousarray` on each individual frame
  before `av.VideoFrame.from_ndarray` to ensure valid line pitch.
- GIF/WebP via Pillow: chunk buffers are reused, so every frame handed to Pillow MUST be
  copied (`Image.fromarray(np.array(f))`). Known limit: Pillow's WebP writer collects all
  frames into a list internally, so long WebP is not O(1) memory (GIF streams lazily).
- Zero-Copy Buffer & Streaming Encryption: Access the encoded container via
  `bio.getbuffer()` (memoryview) and encrypt it with a streaming
  `Cipher(algorithms.AES(key), modes.GCM(iv)).encryptor()` over 1 MiB slices, writing each
  slice straight to the .bin file. Do NOT use one-shot `AESGCM.encrypt` (holds ciphertext
  copy in RAM, fails above ~2 GB). On-disk layout is unchanged and byte-compatible with
  AESGCM.encrypt and WebCrypto, so ram_encryption.js needs no change:
      wrapped_key (RSA-OAEP, 256 B for 2048-bit) | iv (12 B) | ciphertext | GCM tag (16 B)
  If writing fails, the partial .bin is removed in finally.
- Audio is processed on CPU and cast to float32 before `AudioFrame.from_ndarray(fltp)`.
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
- Browser Key Export/Import (Option 2): Provide JWK `.json` keypair export and import
  in the node's right-click context menu. Strip `key_ops` upon import to ensure
  WebCrypto compatibility across different browsers and sessions.
- Encoder Output Unchanged: libx264/libvpx-vp9, crf 20, preset fast, yuv420p, same fps
  fraction and pts. BT.709 tagging, audio interleaving and fragmented MP4 were
  deliberately left OFF (output identical to the old node).

PAST BUGS PREVENTED (REGRESSION WATCHLIST):
- Multi-GPU Silent Crash (CUDA c10 Access Violation / SIGSEGV): Caused by cross-device
  `torch.cat` on CUDA tensors or DMA transfer races without synchronization. The streaming
  design never concatenates across devices and only moves small uint8 chunks with a
  blocking `.cpu()` copy; the explicit `torch.cuda.synchronize()` was dropped by decision.
  NOTE: GPU/multi-GPU input has not been tested on real hardware. If this crash returns,
  re-add `torch.cuda.synchronize()` at node entry and after each chunk quantize.
- FFmpeg libswscale Segfault (0xc0000005 / SIGSEGV): Caused by passing non-contiguous
  NumPy views (from odd dimension crops or channel slices) to `av.VideoFrame.from_ndarray`.
  Always wrap individual frame slices in `np.ascontiguousarray(f)`.
- In-Memory PyAV Crash on Close: Caused by setting `movflags: +faststart` on an in-memory
  `io.BytesIO` container. Never use `+faststart` on in-memory buffers; WebCrypto decrypts
  the entire payload client-side anyway.
- OpenMP / libx264 Thread Contention Crash: Caused by unconstrained encoder threads
  colliding with PyTorch OpenMP on high-core/multi-socket machines. Always cap
  `v_stream.options = {"crf": "20", "preset": "fast", "threads": "4"}`.
- WebCrypto DataError on Key Import: Caused by JWK `key_ops` member inconsistency when
  public keys are generated with empty usages. Always declare full usages
  `["unwrapKey", "decrypt", "wrapKey", "encrypt"]` in `generateKey()` and delete
  `key_ops` from parsed JWK objects prior to `importKey()`.
- System RAM Explosion / OOM at `torch.round(images.clamp(...)*255)` in VideoCombine:
  Caused by full-batch float32 temporaries (clamp result, product, rounded result alive
  together), `torch.cat` of list inputs, a second full copy for pingpong, and a full
  float32 GPU->CPU copy. Fixed by chunked quantization into reusable buffers, a virtual
  frame source, index-based pingpong, and quantizing on the source device so only uint8
  chunks reach host RAM. Never reintroduce a full-batch float or uint8 tensor.
- UnboundLocalError (raw_aframe) on GIF/WebP: `del raw_aframe` ran after all branches but
  it was only assigned in the mp4/webm branch, so GIF/WebP always failed. Initialize
  `raw_aframe = None` before the branches.
- AES-GCM One-Shot Limit: `AESGCM.encrypt` fails above ~2 GB and duplicates the payload.
  Use the streaming Cipher/GCM encryptor.
- Silent Audio Loss: float64/float16 waveforms failed `from_ndarray(fltp)` inside the
  except and the video was written without audio. Cast waveform to float32.
- 5D Latent Output: video VAEs can return (B,T,H,W,C); flatten to (-1,H,W,C).
- Pillow Buffer Reuse: Pillow can keep a reference to the array passed to
  Image.fromarray; with reused chunk buffers frames would be corrupted. Always copy.
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