import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

let serverPublicKey = null;
let browserKeyPair = null;
let browserPublicKeyPEM = null;

function arrayBufferToPem(buffer, header) {
    const b64 = btoa(String.fromCharCode(...new Uint8Array(buffer)));
    const formatted = b64.match(/.{1,64}/g).join("\n");
    return `-----BEGIN ${header}-----\n${formatted}\n-----END ${header}-----`;
}

function pemToArrayBuffer(pem) {
    const b64 = pem
        .replace(/-----BEGIN [^-]+-----/, "")
        .replace(/-----END [^-]+-----/, "")
        .replace(/\s+/g, "");
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
}

function adjustNodeSizeForMedia(node, mediaWidth, mediaHeight) {
    const minWidth = Math.max(node.size[0] || 0, 320);
    const aspect = mediaWidth / (mediaHeight || 1);
    const calculatedHeight = minWidth / aspect;
    const widgetHeight = node.widgets ? node.widgets.length * 30 : 0;
    const padding = 70;
    node.setSize([minWidth, Math.max(140, widgetHeight + calculatedHeight + padding)]);
    node.setDirtyCanvas(true, true);
}

async function initCryptoSession() {
    try {
        const res = await fetch("/crypto/server_pubkey");
        const serverPem = await res.text();
        const serverSpki = pemToArrayBuffer(serverPem);
        serverPublicKey = await window.crypto.subtle.importKey(
            "spki",
            serverSpki,
            { name: "RSA-OAEP", hash: "SHA-256" },
            false,
            ["wrapKey"]
        );

        browserKeyPair = await window.crypto.subtle.generateKey(
            {
                name: "RSA-OAEP",
                modulusLength: 2048,
                publicExponent: new Uint8Array([1, 0, 1]),
                hash: "SHA-256"
            },
            true,
            ["unwrapKey", "decrypt"]
        );

        const exportedSpki = await window.crypto.subtle.exportKey("spki", browserKeyPair.publicKey);
        browserPublicKeyPEM = arrayBufferToPem(exportedSpki, "PUBLIC KEY");

        await fetch("/crypto/register_browser_key", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                client_id: api.clientId,
                pubkey: browserPublicKeyPEM
            })
        });

        console.log("[Video Helper Suite - RAM] Crypto session ready.");
    } catch (err) {
        console.error("[Video Helper Suite - RAM] Crypto initialization failed:", err);
    }
}

async function encryptFileToBin(file) {
    if (!serverPublicKey) throw new Error("Server Public Key not initialized.");

    const fileBuffer = await file.arrayBuffer();
    const aesKey = await window.crypto.subtle.generateKey(
        { name: "AES-GCM", length: 256 },
        true,
        ["encrypt"]
    );

    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await window.crypto.subtle.encrypt(
        { name: "AES-GCM", iv: iv },
        aesKey,
        fileBuffer
    );

    const wrappedKey = await window.crypto.subtle.wrapKey(
        "raw",
        aesKey,
        serverPublicKey,
        { name: "RSA-OAEP" }
    );

    const combined = new Uint8Array(256 + 12 + ciphertext.byteLength);
    combined.set(new Uint8Array(wrappedKey), 0);
    combined.set(iv, 256);
    combined.set(new Uint8Array(ciphertext), 268);

    return new Blob([combined], { type: "application/octet-stream" });
}

async function decryptBinToBlobUrl(binBuffer, mimeType = "image/png") {
    if (binBuffer.byteLength < 268) throw new Error("Invalid .bin payload.");

    const wrappedKey = binBuffer.slice(0, 256);
    const iv = binBuffer.slice(256, 268);
    const ciphertext = binBuffer.slice(268);

    const aesKey = await window.crypto.subtle.unwrapKey(
        "raw",
        wrappedKey,
        browserKeyPair.privateKey,
        { name: "RSA-OAEP" },
        { name: "AES-GCM", length: 256 },
        false,
        ["decrypt"]
    );

    const decryptedBytes = await window.crypto.subtle.decrypt(
        { name: "AES-GCM", iv: new Uint8Array(iv) },
        aesKey,
        ciphertext
    );

    const blob = new Blob([decryptedBytes], { type: mimeType });
    return URL.createObjectURL(blob);
}

app.registerExtension({
    name: "ComfyUI.VHS.RAMEncryption",

    async setup() {
        await initCryptoSession();
    },

    beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name === "VHS_ImageUploadRAM") {
            if (!nodeData.input) nodeData.input = {};
            if (!nodeData.input.optional) nodeData.input.optional = {};
            nodeData.input.optional["upload"] = ["BUTTON", {}];
        }
    },

    nodeCreated(node) {
        // =============================================================
        // 1. VHS_ImageUploadRAM: Local Preview & Encrypted Upload
        // =============================================================
        if (node.comfyClass === "VHS_ImageUploadRAM") {
            if (!node.widgets?.some(w => w.name === "upload")) {
                const uploadBtn = node.addWidget("button", "upload", "Upload & Encrypt (.bin)", () => {
                    const input = document.createElement("input");
                    input.type = "file";
                    input.accept = "image/*";
                    input.style.display = "none";

                    input.onchange = async () => {
                        if (!input.files || input.files.length === 0) return;
                        const file = input.files[0];

                        // RENDER LOCALLY: Instant in-memory preview without cloud interaction
                        const localUrl = URL.createObjectURL(file);
                        const localImg = new Image();
                        localImg.onload = () => {
                            node.imgs = [localImg];
                            adjustNodeSizeForMedia(node, localImg.naturalWidth, localImg.naturalHeight);
                        };
                        localImg.src = localUrl;

                        uploadBtn.label = "Encrypting...";
                        node.setDirtyCanvas(true);

                        try {
                            const encryptedBlob = await encryptFileToBin(file);
                            const safeName = `${file.name.replace(/\.[^/.]+$/, "")}_${Date.now()}.bin`;

                            const formData = new FormData();
                            formData.append("image", encryptedBlob, safeName);
                            formData.append("overwrite", "true");

                            const resp = await api.fetchApi("/upload/image", {
                                method: "POST",
                                body: formData
                            });

                            if (resp.status === 200) {
                                const result = await resp.json();
                                const imageWidget = node.widgets.find(w => w.name === "image");
                                if (imageWidget) {
                                    if (!imageWidget.options.values.includes(result.name)) {
                                        imageWidget.options.values.push(result.name);
                                    }
                                    imageWidget.value = result.name;
                                }
                            }
                        } catch (err) {
                            alert("Encryption upload failed: " + err.message);
                        } finally {
                            uploadBtn.label = "Upload & Encrypt (.bin)";
                            node.setDirtyCanvas(true);
                        }
                    };

                    document.body.appendChild(input);
                    input.click();
                    document.body.removeChild(input);
                });

                uploadBtn.serialize = false;
                uploadBtn.label = "Upload & Encrypt (.bin)";
            }
        }

        // =============================================================
        // 2. VHS_ImagePreviewRAM: In-Memory Decrypt & Proportional Render
        // =============================================================
        if (node.comfyClass === "VHS_ImagePreviewRAM") {
            const originalOnExecuted = node.onExecuted;
            node.onExecuted = async function (message) {
                if (originalOnExecuted) {
                    originalOnExecuted.apply(this, arguments);
                }

                if (message?.bin_images && message.bin_images.length > 0) {
                    const imgElements = [];
                    for (const item of message.bin_images) {
                        const viewUrl = api.apiURL(
                            `/view?filename=${encodeURIComponent(item.filename)}&type=${item.type}&subfolder=${encodeURIComponent(item.subfolder || "")}`
                        );
                        const binResp = await fetch(viewUrl);
                        const binArray = await binResp.arrayBuffer();

                        const blobUrl = await decryptBinToBlobUrl(binArray, "image/png");
                        const img = new Image();
                        img.onload = () => {
                            adjustNodeSizeForMedia(node, img.naturalWidth, img.naturalHeight);
                        };
                        img.src = blobUrl;
                        imgElements.push(img);
                    }

                    node.imgs = imgElements;
                    app.graph.setDirtyCanvas(true);
                }
            };
        }

        // VHS_VideoCombine: Client-Side Web Assembly & Hardware Encoding
        // =============================================================
        if (node.comfyClass === "VideoCombine") {
            const originalOnExecuted = node.onExecuted;
            node.onExecuted = async function (message) {
                if (originalOnExecuted) {
                    originalOnExecuted.apply(this, arguments);
                }

                if (message?.client_video_frames && message.client_video_frames.length > 0) {
                    for (const item of message.client_video_frames) {
                        // 1. Fetch Ciphertext .bin
                        const viewUrl = api.apiURL(
                            `/view?filename=${encodeURIComponent(item.filename)}&type=${item.type}&subfolder=${encodeURIComponent(item.subfolder || "")}`
                        );
                        const binResp = await fetch(viewUrl);
                        const binArray = await binResp.arrayBuffer();

                        // 2. Decrypt in WebCrypto RAM
                        const wrappedKey = binArray.slice(0, 256);
                        const iv = binArray.slice(256, 268);
                        const ciphertext = binArray.slice(268);

                        const aesKey = await window.crypto.subtle.unwrapKey(
                            "raw",
                            wrappedKey,
                            browserKeyPair.privateKey,
                            { name: "RSA-OAEP" },
                            { name: "AES-GCM", length: 256 },
                            false,
                            ["decrypt"]
                        );

                        const decryptedBytes = await window.crypto.subtle.decrypt(
                            { name: "AES-GCM", iv: new Uint8Array(iv) },
                            aesKey,
                            ciphertext
                        );

                        // 3. Unpack Frames from Decrypted RAM Buffer
                        const view = new DataView(decryptedBytes);
                        const numFrames = view.getUint32(0, true);
                        const width = view.getUint32(4, true);
                        const height = view.getUint32(8, true);

                        let offset = 12;
                        const bitmaps = [];
                        for (let i = 0; i < numFrames; i++) {
                            const frameLen = view.getUint32(offset, true);
                            offset += 4;
                            const frameBlob = new Blob([decryptedBytes.slice(offset, offset + frameLen)], { type: "image/webp" });
                            offset += frameLen;
                            const bmp = await createImageBitmap(frameBlob);
                            bitmaps.push(bmp);
                        }

                        // 4. Assemble Video Container Locally via Canvas + Native Hardware Encoder
                        const canvas = document.createElement("canvas");
                        canvas.width = width;
                        canvas.height = height;
                        const ctx = canvas.getContext("2d");

                        const stream = canvas.captureStream(0);
                        const track = stream.getVideoTracks()[0];

                        // Target MP4 if supported locally, otherwise fallback to WebM
                        const mimeType = (item.format === "video/mp4" && MediaRecorder.isTypeSupported("video/mp4;codecs=avc1"))
                            ? "video/mp4;codecs=avc1"
                            : (MediaRecorder.isTypeSupported("video/webm;codecs=vp9") ? "video/webm;codecs=vp9" : "video/webm");

                        const recorder = new MediaRecorder(stream, { mimeType });
                        const chunks = [];
                        recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };

                        const encodingPromise = new Promise((resolve) => {
                            recorder.onstop = () => {
                                const videoBlob = new Blob(chunks, { type: mimeType });
                                resolve(URL.createObjectURL(videoBlob));
                            };
                        });

                        recorder.start();

                        // Render frame-by-frame into encoder
                        const frameDelay = 1000 / item.fps;
                        for (const bmp of bitmaps) {
                            ctx.drawImage(bmp, 0, 0);
                            if (track.requestFrame) track.requestFrame();
                            await new Promise((r) => setTimeout(r, frameDelay));
                            bmp.close(); // Immediate GPU memory cleanup
                        }

                        recorder.stop();
                        const localVideoUrl = await encodingPromise;

                        // 5. Mount into interactive local <video> player widget
                        let videoWidget = node.widgets?.find(w => w.name === "ram_video_player");
                        if (!videoWidget) {
                            const videoEl = document.createElement("video");
                            videoEl.controls = true;
                            videoEl.autoplay = true;
                            videoEl.loop = true;
                            videoEl.muted = true;
                            videoEl.style.width = "100%";
                            videoEl.style.borderRadius = "4px";

                            videoEl.onloadedmetadata = () => {
                                adjustNodeSizeForMedia(node, videoEl.videoWidth || 320, videoEl.videoHeight || 240);
                            };

                            videoWidget = node.addDOMWidget("ram_video_player", "video", videoEl, {
                                getValue: () => videoEl.src,
                                setValue: (v) => { videoEl.src = v; }
                            });
                            videoWidget.serialize = false;
                        }

                        const videoEl = videoWidget.element;
                        if (videoEl) {
                            if (videoEl.src && videoEl.src.startsWith("blob:")) {
                                URL.revokeObjectURL(videoEl.src);
                            }
                            videoEl.src = localVideoUrl;
                            videoEl.play().catch(() => {});
                        }
                    }
                    app.graph.setDirtyCanvas(true);
                }
            };
        }
    }
});