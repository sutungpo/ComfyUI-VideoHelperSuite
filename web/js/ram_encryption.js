import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

let serverPublicKey = null;
let browserKeyPair = null;
let browserPublicKeyPEM = null;

// =====================================================================
// 1. Core WebCrypto & Sizing Helpers
// =====================================================================

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

async function initCryptoSession() {
    try {
        const res = await fetch("/crypto/server_pubkey");
        serverPublicKey = await window.crypto.subtle.importKey(
            "spki",
            pemToArrayBuffer(await res.text()),
            { name: "RSA-OAEP", hash: "SHA-256" },
            false,
            ["wrapKey"]
        );

        browserKeyPair = await window.crypto.subtle.generateKey(
            { name: "RSA-OAEP", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
            true,
            ["unwrapKey", "decrypt"]
        );

        const exportedSpki = await window.crypto.subtle.exportKey("spki", browserKeyPair.publicKey);
        browserPublicKeyPEM = arrayBufferToPem(exportedSpki, "PUBLIC KEY");

        await fetch("/crypto/register_browser_key", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ client_id: api.clientId, pubkey: browserPublicKeyPEM })
        });

        console.log("[RAM Encryption] Session ready.");
    } catch (err) {
        console.error("[RAM Encryption] Setup failed:", err);
    }
}

// =====================================================================
// 2. Local Video Encrypted Upload Handler
// =====================================================================

function executeEncryptedVideoUpload(node) {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "video/*";

    input.onchange = async () => {
        if (!input.files?.length) return;
        const file = input.files[0];

        // 1. Instant local video preview (matching VHS_ImageUploadRAM)
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

        const uploadBtn = node.widgets?.find(w => w.name === "upload" || w.name === "choose video to upload");
        if (uploadBtn) {
            uploadBtn.label = "Encrypting...";
            node.setDirtyCanvas(true);
        }

        try {
            const fileBuf = await file.arrayBuffer();
            const aesKey = await window.crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt"]);
            const iv = window.crypto.getRandomValues(new Uint8Array(12));
            const ciphertext = await window.crypto.subtle.encrypt({ name: "AES-GCM", iv }, aesKey, fileBuf);
            const wrappedKey = await window.crypto.subtle.wrapKey("raw", aesKey, serverPublicKey, { name: "RSA-OAEP" });

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
                const widget = node.widgets?.find(w => w.name === "video");
                if (widget) {
                    if (!widget.options.values.includes(data.name)) widget.options.values.push(data.name);
                    widget.value = data.name;
                }
            }
        } catch (err) {
            alert("Video encryption upload failed: " + err.message);
        } finally {
            if (uploadBtn) {
                uploadBtn.label = "Upload & Encrypt (.bin)";
                node.setDirtyCanvas(true);
            }
        }
    };
    input.click();
}

function configureLoadVideoNode(node) {
    if (!node) return;

    // Guard against VHS attempting to fetch encrypted .bin from backend
    if (node.updateParameters && !node._vhs_encrypted_guarded) {
        node._vhs_encrypted_guarded = true;
        const origUpdate = node.updateParameters;
        node.updateParameters = function (params, force_update) {
            if (params?.filename?.endsWith(".bin")) {
                return;
            }
            return origUpdate.apply(this, arguments);
        };
    }

    // Hijack button to make sure only ONE "Upload & Encrypt (.bin)" exists
    const btn = node.widgets?.find(w => w.name === "choose video to upload" || w.name === "upload" || w.label?.includes("upload"));
    if (btn) {
        btn.name = "upload";
        btn.label = "Upload & Encrypt (.bin)";
        btn.callback = () => executeEncryptedVideoUpload(node);
    }
}

// =====================================================================
// 3. Extension Registration
// =====================================================================

app.registerExtension({
    name: "ComfyUI.VHS.RAMEncryption",

    async setup() {
        await initCryptoSession();
    },

    beforeRegisterNodeDef(nodeType, nodeData) {
        // VHS_ImageUploadRAM registration
        if (nodeData.name === "VHS_ImageUploadRAM") {
            if (!nodeData.input) nodeData.input = {};
            if (!nodeData.input.optional) nodeData.input.optional = {};
            nodeData.input.optional["upload"] = ["BUTTON", {}];
        }

        // Intercept VHS_LoadVideo creation directly in prototype
        if (nodeData.name === "VHS_LoadVideo") {
            const origOnNodeCreated = nodeType.prototype.onNodeCreated;
            nodeType.prototype.onNodeCreated = function () {
                const r = origOnNodeCreated ? origOnNodeCreated.apply(this, arguments) : undefined;
                configureLoadVideoNode(this);
                return r;
            };
        }
    },

    loadedGraphNode(node) {
        if (node.type === "VHS_LoadVideo" || node.comfyClass === "VHS_LoadVideo") {
            configureLoadVideoNode(node);
        }
    },

    nodeCreated(node) {
        // VHS_ImageUploadRAM button (untouched original behavior)
        if (node.comfyClass === "VHS_ImageUploadRAM" || node.type === "VHS_ImageUploadRAM") {
            if (!node.widgets?.some(w => w.name === "upload")) {
                const uploadBtn = node.addWidget("button", "upload", "Upload & Encrypt (.bin)", () => {
                    const input = document.createElement("input");
                    input.type = "file";
                    input.accept = "image/*";
                    input.onchange = async () => {
                        if (!input.files?.length) return;
                        const file = input.files[0];

                        const img = new Image();
                        img.onload = () => {
                            node.imgs = [img];
                            resizeNodeForMedia(node, img.naturalWidth, img.naturalHeight);
                        };
                        img.src = URL.createObjectURL(file);

                        uploadBtn.label = "Encrypting...";
                        node.setDirtyCanvas(true);

                        try {
                            const fileBuf = await file.arrayBuffer();
                            const aesKey = await window.crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt"]);
                            const iv = window.crypto.getRandomValues(new Uint8Array(12));
                            const ciphertext = await window.crypto.subtle.encrypt({ name: "AES-GCM", iv }, aesKey, fileBuf);
                            const wrappedKey = await window.crypto.subtle.wrapKey("raw", aesKey, serverPublicKey, { name: "RSA-OAEP" });

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
                                const widget = node.widgets.find(w => w.name === "image");
                                if (widget) {
                                    if (!widget.options.values.includes(data.name)) widget.options.values.push(data.name);
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
                });
                uploadBtn.serialize = false;
                uploadBtn.label = "Upload & Encrypt (.bin)";
            }
        }

        if (node.comfyClass === "VHS_LoadVideo" || node.type === "VHS_LoadVideo") {
            configureLoadVideoNode(node);
        }
    }
});