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

// --- Preview & Sizing Helpers ---
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

// --- Unified Decrypt & Render Function ---
async function renderDecryptedPreview(node, item) {
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
        const img = new Image();
        await new Promise(r => { img.onload = r; img.onerror = r; img.src = blobUrl; });
        node.imgs = [img];
        if (img.naturalWidth) {
            resizeNodeForMedia(node, img.naturalWidth, img.naturalHeight);
        }
    }

    node.setDirtyCanvas?.(true, true);
    app.graph?.setDirtyCanvas(true, true);
}

// --- Upload & Local Encrypt Handler ---
function handleFileUpload(node, isImage, uploadBtn) {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = isImage ? "image/*" : "video/*";

    input.onchange = async () => {
        if (!input.files?.length) return;
        const file = input.files[0];

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

            const formData = new FormData();
            formData.append("image", new Blob([payload]), `${file.name.replace(/\.[^/.]+$/, "")}_${Date.now()}.bin`);
            formData.append("overwrite", "true");

            const res = await api.fetchApi("/upload/image", { method: "POST", body: formData });
            if (!res.ok) throw new Error(`Server returned status ${res.status}`);
            const data = await res.json();

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

        // Decrypt and display previews on execution completion
        api.addEventListener("executed", async ({ detail }) => {
            const items = detail?.output?.ram_preview;
            if (!items?.length) return;

            const node = app.graph.getNodeById(detail.node);
            if (!node) return;

            try {
                const item = items[0];
                // Save preview metadata into node state for the refresh button
                node.ramPreviewItem = item;
                node.properties = node.properties || {};
                node.properties["last_ram_preview"] = item;

                await renderDecryptedPreview(node, item);
            } catch (err) {
                console.error("[RAM Encryption] Decryption render error:", err);
            }
        });
    },

    beforeRegisterNodeDef(nodeType, nodeData) {
        // Allow upload button on input nodes
        if (nodeData.name === "VHS_ImageUploadRAM" || nodeData.name === "VHS_LoadVideo") {
            nodeData.input = nodeData.input || {};
            nodeData.input.optional = nodeData.input.optional || {};
            nodeData.input.optional["upload"] = ["BUTTON", {}];
        }

        // Allow refresh_preview button on preview/output nodes so VHS core does not crash
        if (nodeData.name === "VHS_ImagePreviewRAM" || nodeData.name === "VHS_VideoCombine") {
            nodeData.input = nodeData.input || {};
            nodeData.input.optional = nodeData.input.optional || {};
            nodeData.input.optional["refresh_preview"] = ["BUTTON", {}];
        }
    },

    nodeCreated(node) {
        const isImage = (node.comfyClass === "VHS_ImageUploadRAM" || node.type === "VHS_ImageUploadRAM");
        const isLoadVideo = (node.comfyClass === "VHS_LoadVideo" || node.type === "VHS_LoadVideo");
        const isImagePreview = (node.comfyClass === "VHS_ImagePreviewRAM" || node.type === "VHS_ImagePreviewRAM");
        const isVideoCombine = (node.comfyClass === "VHS_VideoCombine" || node.type === "VHS_VideoCombine");

        // Clean up blob URLs when node is removed
        const origOnRemoved = node.onRemoved;
        node.onRemoved = function () {
            origOnRemoved?.apply(this, arguments);
            if (node.decryptedMedia?.blobUrl?.startsWith("blob:")) {
                URL.revokeObjectURL(node.decryptedMedia.blobUrl);
            }
        };

        // Decouple LoadVideo from VHS remote server preview calls
        if (isLoadVideo) {
            if (node.updateParameters) node.updateParameters = function () {};
            const previewWidget = node.widgets?.find(w => w.name === "videopreview");
            if (previewWidget) previewWidget.updateSource = function () {};

            const nativeWidget = node.widgets?.find(w => w.name === "native_enable");
            if (nativeWidget) {
                const syncOutputs = () => {
                    const isVideoMode = Boolean(nativeWidget.value);
                    if (!node.outputs || node.outputs.length === 0) return;

                    if (isVideoMode) {
                        for (let i = node.outputs.length - 1; i >= 1; i--) {
                            node.disconnectOutput(i);
                            node.removeOutput(i);
                        }
                        node.outputs[0].name = "VIDEO";
                        node.outputs[0].label = "VIDEO";
                        node.outputs[0].type = "VIDEO";
                        if (node.outputs[0].localized_name) node.outputs[0].localized_name = "VIDEO";
                    } else {
                        node.outputs[0].name = "IMAGE";
                        node.outputs[0].label = "IMAGE";
                        node.outputs[0].type = "IMAGE";
                        if (node.outputs[0].localized_name) node.outputs[0].localized_name = "IMAGE";

                        const expected = [
                            { name: "frame_count", type: "INT" },
                            { name: "audio", type: "AUDIO" },
                            { name: "video_info", type: "VHS_VIDEOINFO" }
                        ];

                        for (let i = 0; i < expected.length; i++) {
                            const targetIdx = i + 1;
                            if (!node.outputs[targetIdx]) {
                                node.addOutput(expected[i].name, expected[i].type);
                            } else {
                                node.outputs[targetIdx].name = expected[i].name;
                                node.outputs[targetIdx].label = expected[i].name;
                                node.outputs[targetIdx].type = expected[i].type;
                            }
                        }
                    }

                    node.setSize(node.computeSize());
                    node.setDirtyCanvas?.(true, true);
                    app.graph?.setDirtyCanvas(true, true);
                };

                const origCallback = nativeWidget.callback;
                nativeWidget.callback = function () {
                    origCallback?.apply(this, arguments);
                    syncOutputs();
                };

                syncOutputs();
                setTimeout(syncOutputs, 20);
            }
        }

        // --- Uniform Refresh Button for ImagePreview and VideoCombine ---
        if (isImagePreview || isVideoCombine) {
            let refreshBtn = node.widgets?.find(w => w.name === "refresh_preview");
            if (!refreshBtn) {
                refreshBtn = node.addWidget("button", "refresh_preview", "Refresh Preview", () => {});
            }
            refreshBtn.serialize = false;
            refreshBtn.label = "Refresh Preview";
            refreshBtn.callback = async () => {
                const item = node.ramPreviewItem || node.properties?.["last_ram_preview"];
                if (!item) {
                    alert("No generated preview found for this node yet.");
                    return;
                }
                refreshBtn.label = "Decrypting...";
                node.setDirtyCanvas(true);
                try {
                    await renderDecryptedPreview(node, item);
                } catch (err) {
                    alert("Refresh failed: " + err.message);
                } finally {
                    refreshBtn.label = "Refresh Preview";
                    node.setDirtyCanvas(true);
                }
            };
        }

        // Context menu options for saving decrypted media
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

        // Upload button setup for input nodes
        if (isImage || isLoadVideo) {
            if (isImage) {
                let imgWidget = node.widgets?.find(w => w.name === "image");
                if (!imgWidget) {
                    imgWidget = node.addWidget("text", "image", "", () => {}, { serialize: true });
                }
                imgWidget.type = "hidden";
                imgWidget.computeSize = () => [0, -4];
            }

            let uploadBtn = node.widgets?.find(w => w.name === "upload");
            if (!uploadBtn) {
                uploadBtn = node.addWidget("button", "upload", "Upload & Encrypt (.bin)", () => {});
            }
            uploadBtn.serialize = false;
            uploadBtn.label = "Upload & Encrypt (.bin)";
            uploadBtn.callback = () => handleFileUpload(node, isImage, uploadBtn);
        }
    }
});