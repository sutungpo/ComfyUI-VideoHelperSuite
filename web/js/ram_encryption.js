import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

// --- Session WebCrypto State ---
let browserKeyPair = null;
let browserPublicKeyPEM = null;

function pemToArrayBuffer(pem) {
    const b64 = pem.replace(/-----BEGIN [^-]+-----/, "").replace(/-----END [^-]+-----/, "").replace(/\s+/g, "");
    return Uint8Array.from(atob(b64), c => c.charCodeAt(0)).buffer;
}

function arrayBufferToPem(buffer, header) {
    const b64 = btoa(String.fromCharCode(...new Uint8Array(buffer)));
    return `-----BEGIN ${header}-----\n${b64.match(/.{1,64}/g).join("\n")}\n-----END ${header}-----`;
}

async function ensureBrowserKeys() {
    if (!browserKeyPair) {
        browserKeyPair = await window.crypto.subtle.generateKey(
            { name: "RSA-OAEP", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
            true,
            ["unwrapKey", "decrypt"]
        );
        const spki = await window.crypto.subtle.exportKey("spki", browserKeyPair.publicKey);
        browserPublicKeyPEM = arrayBufferToPem(spki, "PUBLIC KEY");
    }
    return browserPublicKeyPEM;
}

// --- Preview & Node Sizing Helpers ---
function resizeNodeForMedia(node, width, height) {
    if (!width || !height) return;
    const minWidth = Math.max(node.size[0] || 0, 260);
    const aspect = width / height;
    const mediaHeight = (minWidth - 20) / aspect;
    const widgetHeight = node.widgets ? node.widgets.length * 28 : 0;
    node.setSize([minWidth, Math.max(140, widgetHeight + mediaHeight + 50)]);
    node.setDirtyCanvas?.(true, true);
    app.graph?.setDirtyCanvas(true, true);
}

function setDecryptedMedia(node, blobUrl, filename, format) {
    if (node.decryptedMedia?.blobUrl?.startsWith("blob:")) {
        URL.revokeObjectURL(node.decryptedMedia.blobUrl);
    }
    node.decryptedMedia = { blobUrl, filename, format };
}

async function resolveEncryptedBlobUrl(item) {
    const viewUrl = api.apiURL(
        `/view?filename=${encodeURIComponent(item.filename)}&type=${encodeURIComponent(item.type || "temp")}&subfolder=${encodeURIComponent(item.subfolder || "")}`
    );
    const resp = await fetch(viewUrl);
    if (!resp.ok) throw new Error(`Failed to fetch preview: ${resp.statusText}`);
    const buf = await resp.arrayBuffer();

    if (buf.byteLength < 268) throw new Error("Invalid encrypted payload size.");

    const aesKey = await window.crypto.subtle.unwrapKey(
        "raw",
        buf.slice(0, 256),
        browserKeyPair.privateKey,
        { name: "RSA-OAEP" },
        { name: "AES-GCM", length: 256 },
        false,
        ["decrypt"]
    );

    const decrypted = await window.crypto.subtle.decrypt(
        { name: "AES-GCM", iv: new Uint8Array(buf.slice(256, 268)) },
        aesKey,
        buf.slice(268)
    );

    return URL.createObjectURL(new Blob([decrypted], { type: item.format || "application/octet-stream" }));
}

// --- Upload & Local Encrypt Handler ---
function handleFileUpload(node, isImage, uploadBtn) {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = isImage ? "image/*" : "video/*";

    input.onchange = async () => {
        if (!input.files?.length) return;
        const file = input.files[0];

        // 1. Instant local preview
        if (isImage) {
            const img = new Image();
            img.onload = () => {
                node.imgs = [img];
                resizeNodeForMedia(node, img.naturalWidth, img.naturalHeight);
            };
            const blobUrl = URL.createObjectURL(file);
            img.src = blobUrl;
            setDecryptedMedia(node, blobUrl, file.name, file.type);
        } else {
            const previewWidget = node.widgets?.find(w => w.name === "videopreview");
            if (previewWidget?.videoEl) {
                const blobUrl = URL.createObjectURL(file);
                previewWidget.videoEl.src = blobUrl;
                previewWidget.videoEl.hidden = false;
                if (previewWidget.parentEl) previewWidget.parentEl.hidden = false;
                if (previewWidget.imgEl) previewWidget.imgEl.hidden = true;
                previewWidget.value = previewWidget.value || {};
                previewWidget.value.hidden = false;
                previewWidget.videoEl.loop = true;
                previewWidget.videoEl.muted = true;
                previewWidget.videoEl.autoplay = true;
                previewWidget.videoEl.play().catch(() => {});
                previewWidget.videoEl.onloadedmetadata = () => {
                    previewWidget.aspectRatio = previewWidget.videoEl.videoWidth / previewWidget.videoEl.videoHeight;
                    resizeNodeForMedia(node, previewWidget.videoEl.videoWidth, previewWidget.videoEl.videoHeight);
                };
                setDecryptedMedia(node, blobUrl, file.name, file.type);
            }
        }

        uploadBtn.label = "Encrypting...";
        node.setDirtyCanvas(true);

        try {
            // 2. Encrypt locally in browser RAM
            const keyRes = await fetch("/crypto/server_pubkey");
            if (!keyRes.ok) throw new Error("Could not fetch server public key");
            const serverKey = await window.crypto.subtle.importKey(
                "spki",
                pemToArrayBuffer(await keyRes.text()),
                { name: "RSA-OAEP", hash: "SHA-256" },
                false,
                ["wrapKey"]
            );

            const fileBuf = await file.arrayBuffer();
            const aesKey = await window.crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt"]);
            const iv = window.crypto.getRandomValues(new Uint8Array(12));
            const ciphertext = await window.crypto.subtle.encrypt({ name: "AES-GCM", iv }, aesKey, fileBuf);
            const wrappedKey = await window.crypto.subtle.wrapKey("raw", aesKey, serverKey, { name: "RSA-OAEP" });

            const payload = new Uint8Array(256 + 12 + ciphertext.byteLength);
            payload.set(new Uint8Array(wrappedKey), 0);
            payload.set(iv, 256);
            payload.set(new Uint8Array(ciphertext), 268);

            // 3. Upload only encrypted .bin payload
            const formData = new FormData();
            formData.append("image", new Blob([payload]), `${file.name.replace(/\.[^/.]+$/, "")}_${Date.now()}.bin`);
            formData.append("overwrite", "true");

            const res = await api.fetchApi("/upload/image", { method: "POST", body: formData });
            if (!res.ok) throw new Error(`Server returned status ${res.status}`);
            const data = await res.json();

            // 4. Update widget value so ComfyUI passes filename to Python
            // DO NOT call targetWidget.callback() here — that invites VHS to overwrite local preview
            const targetWidgetName = isImage ? "image" : "video";
            const targetWidget = node.widgets?.find(w => w.name === targetWidgetName);
            if (targetWidget) {
                if (targetWidget.options?.values && !targetWidget.options.values.includes(data.name)) {
                    targetWidget.options.values.push(data.name);
                }
                targetWidget.value = data.name;
            }

            app.graph?.setDirtyCanvas(true, true);
        } catch (err) {
            alert("Upload failed: " + err.message);
        } finally {
            uploadBtn.label = "Upload & Encrypt (.bin)";
            node.setDirtyCanvas(true);
        }
    };

    input.click();
}

// --- Extension Registration ---
app.registerExtension({
    name: "ComfyUI.VHS.RAMEncryption",

    async setup() {
        await ensureBrowserKeys();

        // Inject browser public key into prompt workflow metadata
        const origGraphToPrompt = app.graphToPrompt;
        app.graphToPrompt = async function () {
            const res = await origGraphToPrompt.apply(this, arguments);
            await ensureBrowserKeys();
            if (res?.workflow && browserPublicKeyPEM) {
                res.workflow.extra = res.workflow.extra || {};
                res.workflow.extra["browser_public_key"] = browserPublicKeyPEM;
            }
            return res;
        };

        // Decrypt and display output previews locally on execution
        api.addEventListener("executed", async ({ detail }) => {
            const items = detail?.output?.ram_preview;
            if (!items?.length) return;

            const node = app.graph.getNodeById(detail.node);
            if (!node) return;

            try {
                const item = items[0];
                const blobUrl = await resolveEncryptedBlobUrl(item);
                const isVideo = item.format?.startsWith("video/") || item.format === "image/gif";
                const previewWidget = node.widgets?.find(w => w.name === "videopreview");

                setDecryptedMedia(node, blobUrl, item.filename, item.format);

                if (isVideo && previewWidget?.videoEl) {
                    previewWidget.videoEl.src = blobUrl;
                    previewWidget.videoEl.hidden = false;
                    if (previewWidget.imgEl) previewWidget.imgEl.hidden = true;
                    if (previewWidget.parentEl) previewWidget.parentEl.hidden = false;

                    previewWidget.value = previewWidget.value || {};
                    previewWidget.value.hidden = false;
                    previewWidget.videoEl.loop = true;
                    previewWidget.videoEl.muted = previewWidget.value.muted ?? true;
                    previewWidget.videoEl.autoplay = true;

                    previewWidget.videoEl.onloadedmetadata = () => {
                        previewWidget.aspectRatio = previewWidget.videoEl.videoWidth / previewWidget.videoEl.videoHeight;
                        resizeNodeForMedia(node, previewWidget.videoEl.videoWidth, previewWidget.videoEl.videoHeight);
                    };

                    await previewWidget.videoEl.play().catch(() => {});
                } else if (item.format === "image/webp" && previewWidget?.imgEl) {
                    previewWidget.imgEl.src = blobUrl;
                    previewWidget.imgEl.hidden = false;
                    if (previewWidget.videoEl) previewWidget.videoEl.hidden = true;
                    if (previewWidget.parentEl) previewWidget.parentEl.hidden = false;

                    previewWidget.imgEl.onload = () => {
                        previewWidget.aspectRatio = previewWidget.imgEl.naturalWidth / previewWidget.imgEl.naturalHeight;
                        resizeNodeForMedia(node, previewWidget.imgEl.naturalWidth, previewWidget.imgEl.naturalHeight);
                    };
                } else {
                    const loadedImgs = [];
                    for (const it of items) {
                        const bUrl = (it === item) ? blobUrl : await resolveEncryptedBlobUrl(it);
                        const img = new Image();
                        await new Promise(r => { img.onload = r; img.onerror = r; img.src = bUrl; });
                        loadedImgs.push(img);
                    }
                    node.imgs = loadedImgs;
                    if (loadedImgs[0]?.naturalWidth) {
                        resizeNodeForMedia(node, loadedImgs[0].naturalWidth, loadedImgs[0].naturalHeight);
                    }
                }

                node.setDirtyCanvas?.(true, true);
                app.graph.setDirtyCanvas(true, true);
            } catch (err) {
                console.error("[RAM Encryption] Decryption render error:", err);
            }
        });
    },

    beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name === "VHS_ImageUploadRAM" || nodeData.name === "VHS_LoadVideo") {
            nodeData.input = nodeData.input || {};
            nodeData.input.optional = nodeData.input.optional || {};
            nodeData.input.optional["upload"] = ["BUTTON", {}];
        }
    },

    nodeCreated(node) {
        const isImage = (node.comfyClass === "VHS_ImageUploadRAM" || node.type === "VHS_ImageUploadRAM");
        const isLoadVideo = (node.comfyClass === "VHS_LoadVideo" || node.type === "VHS_LoadVideo");
        const isVideoCombine = (node.comfyClass === "VHS_VideoCombine" || node.type === "VHS_VideoCombine");

        // Clean up blob URLs when node is removed
        const origOnRemoved = node.onRemoved;
        node.onRemoved = function () {
            origOnRemoved?.apply(this, arguments);
            if (node.decryptedMedia?.blobUrl?.startsWith("blob:")) {
                URL.revokeObjectURL(node.decryptedMedia.blobUrl);
            }
        };

        // 1. Guard against VHS requesting raw ciphertext via updateParameters
        if ((isLoadVideo || isVideoCombine) && node.updateParameters) {
            const origUpdate = node.updateParameters;
            node.updateParameters = function (params) {
                if (params?.filename?.endsWith(".bin")) return;
                return origUpdate.apply(this, arguments);
            };
        }

        // 2. Guard against VHS replacing working preview with remote .bin via updateSource
        if (isLoadVideo || isVideoCombine) {
            const previewWidget = node.widgets?.find(w => w.name === "videopreview");
            if (previewWidget && previewWidget.updateSource) {
                const origUpdateSource = previewWidget.updateSource;
                previewWidget.updateSource = function () {
                    const currentFile = node.widgets?.find(w => w.name === "video")?.value;
                    if (currentFile?.endsWith(".bin")) return;
                    return origUpdateSource.apply(this, arguments);
                };
            }
        }

        // 3. Extra context menu options for saving decrypted media
        const origGetExtraMenuOptions = node.getExtraMenuOptions;
        node.getExtraMenuOptions = function (canvas, options) {
            origGetExtraMenuOptions?.apply(this, arguments);
            if (this.decryptedMedia?.blobUrl) {
                const { blobUrl, filename, format } = this.decryptedMedia;
                if (!options.some(opt => opt?.content === "Save preview")) {
                    options.unshift(
                        {
                            content: "Save preview",
                            callback: () => {
                                const a = document.createElement("a");
                                a.href = blobUrl;
                                const ext = format?.startsWith("video/") ? ".mp4" : ".png";
                                a.download = (filename || "preview").replace(/\.bin$/, ext);
                                document.body.appendChild(a);
                                a.click();
                                requestAnimationFrame(() => a.remove());
                            }
                        },
                        {
                            content: "Open preview",
                            callback: () => { window.open(blobUrl, "_blank"); }
                        }
                    );
                }
            }
        };

        // 4. Upload button setup for input nodes
        if (isImage || isLoadVideo) {
            // For ImageUploadRAM: Hide the "image" input widget completely from the canvas
            if (isImage) {
                let imgWidget = node.widgets?.find(w => w.name === "image");
                if (!imgWidget) {
                    imgWidget = node.addWidget("text", "image", "", () => {}, { serialize: true });
                }
                imgWidget.type = "hidden";
                imgWidget.computeSize = () => [0, -4];
            }

            // Always guarantee the upload button exists with the proper handler attached
            let uploadBtn = node.widgets?.find(w => w.name === "upload");
            if (!uploadBtn) {
                uploadBtn = node.addWidget("button", "upload", "Upload & Encrypt (.bin)", () => {});
            }
            uploadBtn.serialize = false;
            uploadBtn.label = "Upload & Encrypt (.bin)";
            uploadBtn.callback = () => handleFileUpload(node, isImage, uploadBtn);
        }

        // Dynamic output slot switcher for LoadVideoUpload
        if (isLoadVideo) {
            const enableWidget = node.widgets?.find(w => w.name === "enable");
            if (enableWidget) {
                const updateOutputs = (val) => {
                    const isVideoOnly = (val === "enable");

                    // Disconnect invalid links when mode changes
                    if (node.outputs) {
                        for (let i = 0; i < node.outputs.length; i++) {
                            node.disconnectOutput(i);
                        }
                    }

                    if (isVideoOnly) {
                        node.outputs = [
                            { name: "video", type: "VIDEO", links: null }
                        ];
                    } else {
                        node.outputs = [
                            { name: "IMAGE", type: "IMAGE", links: null },
                            { name: "frame_count", type: "INT", links: null },
                            { name: "audio", type: "AUDIO", links: null },
                            { name: "video_info", type: "VHS_VIDEOINFO", links: null }
                        ];
                    }
                    node.setSize(node.computeSize());
                    app.graph?.setDirtyCanvas(true, true);
                };

                // Hook callback and run on initialization
                const origCallback = enableWidget.callback;
                enableWidget.callback = function (val) {
                    origCallback?.apply(this, arguments);
                    updateOutputs(val);
                };

                // Apply initial state based on current widget value (default: disable)
                setTimeout(() => updateOutputs(enableWidget.value || "disable"), 20);
            }
        }
    }
});