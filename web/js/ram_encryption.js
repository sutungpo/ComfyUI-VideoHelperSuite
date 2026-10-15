import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

let serverPublicKey = null;
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

function resizeNodeForMedia(node, mediaWidth, mediaHeight) {
    const minWidth = Math.max(node.size[0] || 0, 260);
    const aspect = (mediaWidth || 1) / (mediaHeight || 1);
    const mediaDisplayHeight = minWidth / aspect;
    const widgetHeight = node.widgets ? node.widgets.length * 28 : 0;
    node.setSize([minWidth, Math.max(140, widgetHeight + mediaDisplayHeight + 60)]);
    app.graph.setDirtyCanvas(true, true);
}

function getDownloadFilename(item) {
    const extMap = {
        "video/mp4": ".mp4",
        "video/webm": ".webm",
        "image/gif": ".gif",
        "image/webp": ".webp",
    };
    const ext = extMap[item.format] || (item.format?.startsWith("video/") ? ".mp4" : ".png");
    return (item.filename || "preview").replace(/\.bin$/, ext);
}

async function ensureBrowserKeys() {
    if (!browserKeyPair) {
        browserKeyPair = await window.crypto.subtle.generateKey(
            { name: "RSA-OAEP", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
            true,
            ["unwrapKey", "decrypt"]
        );
        const exportedSpki = await window.crypto.subtle.exportKey("spki", browserKeyPair.publicKey);
        browserPublicKeyPEM = arrayBufferToPem(exportedSpki, "PUBLIC KEY");
    }
    return browserPublicKeyPEM;
}

async function resolveEncryptedBlobUrl(item) {
    const viewUrl = api.apiURL(
        `/view?filename=${encodeURIComponent(item.filename)}&type=${item.type}&subfolder=${encodeURIComponent(item.subfolder || "")}`
    );
    const binResp = await fetch(viewUrl);
    const buf = await binResp.arrayBuffer();

    if (buf.byteLength < 268) {
        throw new Error("Invalid encrypted .bin payload size.");
    }

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

app.registerExtension({
    name: "ComfyUI.VHS.RAMEncryption",

    async setup() {
        await ensureBrowserKeys();

        // Attach browser public key to workflow metadata
        const origGraphToPrompt = app.graphToPrompt;
        app.graphToPrompt = async function () {
            const res = await origGraphToPrompt.apply(this, arguments);
            await ensureBrowserKeys();
            if (res && res.workflow && browserPublicKeyPEM) {
                res.workflow.extra = res.workflow.extra || {};
                res.workflow.extra["browser_public_key"] = browserPublicKeyPEM;
            }
            return res;
        };

        // Decrypt and render previews on execution
        api.addEventListener("executed", async ({ detail }) => {
            const items = detail?.output?.ram_preview;
            if (!items || !items.length) return;

            const node = app.graph.getNodeById(detail.node);
            if (!node) return;

            try {
                const item = items[0];
                const blobUrl = await resolveEncryptedBlobUrl(item);
                const downloadFilename = getDownloadFilename(item);
                const isVideo = item.format?.startsWith("video/") || item.format === "image/gif";
                const previewWidget = node.widgets?.find(w => w.name === "videopreview");

                node.decryptedMedia = {
                    blobUrl,
                    filename: downloadFilename,
                    format: item.format,
                };

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
                        const w = node.size[0];
                        const h = (w - 20) / previewWidget.aspectRatio + 60;
                        node.setSize([w, Math.max(140, h)]);
                        node.setDirtyCanvas?.(true, true);
                        app.graph.setDirtyCanvas(true, true);
                    };

                    await previewWidget.videoEl.play().catch(() => {});
                } else if (item.format === "image/webp" && previewWidget?.imgEl) {
                    previewWidget.imgEl.src = blobUrl;
                    previewWidget.imgEl.hidden = false;
                    if (previewWidget.videoEl) previewWidget.videoEl.hidden = true;
                    if (previewWidget.parentEl) previewWidget.parentEl.hidden = false;

                    previewWidget.imgEl.onload = () => {
                        previewWidget.aspectRatio = previewWidget.imgEl.naturalWidth / previewWidget.imgEl.naturalHeight;
                        node.setDirtyCanvas?.(true, true);
                        app.graph.setDirtyCanvas(true, true);
                    };
                } else {
                    const loadedImgs = [];
                    for (const it of items) {
                        const bUrl = (it === item) ? blobUrl : await resolveEncryptedBlobUrl(it);
                        const img = new Image();
                        await new Promise((resolve) => {
                            img.onload = resolve;
                            img.onerror = resolve;
                            img.src = bUrl;
                        });
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
                console.error("[RAM Encryption] Preview decryption error:", err);
            }
        });
    },

    nodeCreated(node) {
        const isImage = (node.comfyClass === "VHS_ImageUploadRAM" || node.type === "VHS_ImageUploadRAM");
        const isLoadVideo = (node.comfyClass === "VHS_LoadVideo" || node.type === "VHS_LoadVideo");
        const isVideoCombine = (node.comfyClass === "VHS_VideoCombine" || node.type === "VHS_VideoCombine");

        // Guard against VHS requesting raw ciphertext
        if ((isLoadVideo || isVideoCombine) && node.updateParameters) {
            const origUpdate = node.updateParameters;
            node.updateParameters = function (params, force_update) {
                if (params?.filename?.endsWith(".bin")) return;
                return origUpdate.apply(this, arguments);
            };
        }

        // Attach "Save preview" and "Open preview" to context menu
        const origGetExtraMenuOptions = node.getExtraMenuOptions;
        node.getExtraMenuOptions = function (canvas, options) {
            if (origGetExtraMenuOptions) {
                origGetExtraMenuOptions.apply(this, arguments);
            }
            if (this.decryptedMedia?.blobUrl) {
                const { blobUrl, filename } = this.decryptedMedia;
                if (!options.some(opt => opt?.content === "Save preview")) {
                    options.unshift(
                        {
                            content: "Save preview",
                            callback: () => {
                                const a = document.createElement("a");
                                a.href = blobUrl;
                                a.download = filename;
                                document.body.appendChild(a);
                                a.click();
                                requestAnimationFrame(() => a.remove());
                            }
                        },
                        {
                            content: "Open preview",
                            callback: () => {
                                window.open(blobUrl, "_blank");
                            }
                        }
                    );
                }
            }
        };

        // Client-side encryption & upload handler
        if (isImage || isLoadVideo) {
            const widgetKey = isImage ? "image" : "video";
            const acceptType = isImage ? "image/*" : "video/*";

            // If ImageUploadRAM, hide the "image" text widget so NO input dropdown shows on canvas
            if (isImage) {
                const imgWidget = node.widgets?.find(w => w.name === "image");
                if (imgWidget) {
                    imgWidget.type = "hidden";
                    imgWidget.computeSize = () => [0, -4];
                }
            }

            // Reuse existing "upload" widget from ComfyUI or create it
            let uploadBtn = node.widgets?.find(w => w.name === "upload");
            if (!uploadBtn) {
                uploadBtn = node.addWidget("button", "upload", "Upload & Encrypt (.bin)", () => {});
            }
            uploadBtn.serialize = false;
            uploadBtn.label = "Upload & Encrypt (.bin)";

            uploadBtn.callback = () => {
                const input = document.createElement("input");
                input.type = "file";
                input.accept = acceptType;
                input.onchange = async () => {
                    if (!input.files?.length) return;
                    const file = input.files[0];

                    if (isImage) {
                        const img = new Image();
                        img.onload = () => {
                            node.imgs = [img];
                            resizeNodeForMedia(node, img.naturalWidth, img.naturalHeight);
                        };
                        img.src = URL.createObjectURL(file);
                    } else {
                        const previewWidget = node.widgets?.find(w => w.name === "videopreview");
                        if (previewWidget?.videoEl) {
                            previewWidget.videoEl.src = URL.createObjectURL(file);
                            previewWidget.videoEl.hidden = false;
                            if (previewWidget.parentEl) previewWidget.parentEl.hidden = false;
                            if (previewWidget.imgEl) previewWidget.imgEl.hidden = true;
                            previewWidget.videoEl.loop = true;
                            previewWidget.videoEl.muted = true;
                            previewWidget.videoEl.autoplay = true;
                            previewWidget.videoEl.play().catch(() => {});
                            previewWidget.videoEl.onloadedmetadata = () => {
                                previewWidget.aspectRatio = previewWidget.videoEl.videoWidth / previewWidget.videoEl.videoHeight;
                                resizeNodeForMedia(node, previewWidget.videoEl.videoWidth, previewWidget.videoEl.videoHeight);
                            };
                        }
                    }

                    uploadBtn.label = "Encrypting...";
                    node.setDirtyCanvas(true);

                    try {
                        const keyRes = await fetch("/crypto/server_pubkey");
                        const activeServerKey = await window.crypto.subtle.importKey(
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
                        const wrappedKey = await window.crypto.subtle.wrapKey("raw", aesKey, activeServerKey, { name: "RSA-OAEP" });

                        const combined = new Uint8Array(256 + 12 + ciphertext.byteLength);
                        combined.set(new Uint8Array(wrappedKey), 0);
                        combined.set(iv, 256);
                        combined.set(new Uint8Array(ciphertext), 268);

                        const formData = new FormData();
                        formData.append("image", new Blob([combined]), `${file.name.replace(/\.[^/.]+$/, "")}_${Date.now()}.bin`);
                        formData.append("overwrite", "true");

                        const res = await api.fetchApi("/upload/image", { method: "POST", body: formData });
                        if (res.status === 200) {
                            const data = await res.json();
                            const widget = node.widgets?.find(w => w.name === widgetKey);
                            if (widget) {
                                if (widget.options?.values && !widget.options.values.includes(data.name)) {
                                    widget.options.values.push(data.name);
                                }
                                widget.value = data.name;
                            }
                        }
                    } catch (err) {
                        alert("Encryption upload failed: " + err.message);
                    } finally {
                        uploadBtn.label = "Upload & Encrypt (.bin)";
                        node.setDirtyCanvas(true);
                    }
                };
                input.click();
            };
        }
    }
});