import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

let serverPublicKey = null;
let browserKeyPair = null;
let browserPublicKeyPEM = null;

// =====================================================================
// 1. Core WebCrypto Helpers
// =====================================================================

function pemToArrayBuffer(pem) {
    const b64 = pem.replace(/-----BEGIN [^-]+-----/, "").replace(/-----END [^-]+-----/, "").replace(/\s+/g, "");
    return Uint8Array.from(atob(b64), c => c.charCodeAt(0)).buffer;
}

function arrayBufferToPem(buffer, header) {
    const b64 = btoa(String.fromCharCode(...new Uint8Array(buffer)));
    return `-----BEGIN ${header}-----\n${b64.match(/.{1,64}/g).join("\n")}\n-----END ${header}-----`;
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
// 2. Unified Decryption Helper (Images & Videos)
// =====================================================================

async function resolveEncryptedBlobUrl(item, defaultMime = "image/png") {
    const viewUrl = api.apiURL(
        `/view?filename=${encodeURIComponent(item.filename)}&type=${item.type}&subfolder=${encodeURIComponent(item.subfolder || "")}`
    );
    const binResp = await fetch(viewUrl);
    const buf = await binResp.arrayBuffer();

    // Wire Format: [256B Wrapped Key] + [12B IV] + [Ciphertext + Tag]
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

    return URL.createObjectURL(new Blob([decrypted], { type: item.format || defaultMime }));
}

// =====================================================================
// 3. Register Extension & Unified Execution Listener
// =====================================================================

app.registerExtension({
    name: "ComfyUI.VHS.RAMEncryption",

    async setup() {
        await initCryptoSession();

        // UNIFIED PREVIEW INTERCEPTOR: Listens to all execution results
        api.addEventListener("executed", async ({ detail }) => {
            if (!detail?.output) return;
            const node = app.graph.getNodeById(detail.node);
            if (!node) return;

            // --- A. Handle Images (VHS_ImagePreviewRAM) ---
            if (detail.output.images) {
                const encImages = detail.output.images.filter(img => img.filename.endsWith(".bin"));
                if (encImages.length > 0) {
                    node.imgs = await Promise.all(encImages.map(async item => {
                        const img = new Image();
                        img.src = await resolveEncryptedBlobUrl(item, "image/png");
                        return img;
                    }));
                    node.setSizeForImage?.() || node.setSize(node.computeSize());
                    app.graph.setDirtyCanvas(true);
                }
            }

            // --- B. Handle Videos (VHS_VideoCombine) ---
            if (detail.output.gifs) {
                const encVideos = detail.output.gifs.filter(vid => vid.filename.endsWith(".bin"));
                if (encVideos.length > 0) {
                    const blobUrl = await resolveEncryptedBlobUrl(encVideos[0], "video/mp4");

                    // Hand directly to VHS's native video player widget
                    const vhsWidget = node.widgets?.find(w => w.name === "videopreview" || w.video);
                    if (vhsWidget?.video) {
                        if (vhsWidget.video.src?.startsWith("blob:")) URL.revokeObjectURL(vhsWidget.video.src);
                        vhsWidget.video.src = blobUrl;
                        vhsWidget.video.play().catch(() => {});
                    } else {
                        // Native LiteGraph video element fallback
                        const videoEl = document.createElement("video");
                        videoEl.src = blobUrl;
                        videoEl.autoplay = videoEl.loop = videoEl.controls = true;
                        node.imgs = [videoEl];
                    }
                    app.graph.setDirtyCanvas(true);
                }
            }
        });
    },

    // Retain upload button for VHS_ImageUploadRAM
    beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name === "VHS_ImageUploadRAM") {
            if (!nodeData.input?.optional) nodeData.input = { ...nodeData.input, optional: {} };
            nodeData.input.optional["upload"] = ["BUTTON", {}];
        }
    },

    nodeCreated(node) {
        if (node.comfyClass === "VHS_ImageUploadRAM") {
            if (!node.widgets?.some(w => w.name === "upload")) {
                const uploadBtn = node.addWidget("button", "upload", "Upload & Encrypt (.bin)", () => {
                    const input = document.createElement("input");
                    input.type = "file";
                    input.accept = "image/*";
                    input.onchange = async () => {
                        if (!input.files?.length) return;
                        const file = input.files[0];

                        // Local-only instant preview
                        const img = new Image();
                        img.src = URL.createObjectURL(file);
                        node.imgs = [img];
                        node.setSizeForImage?.() || node.setSize(node.computeSize());

                        uploadBtn.label = "Encrypting...";
                        node.setDirtyCanvas(true);

                        try {
                            // Encrypt with ephemeral AES-GCM and wrap with Server RSA Key
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
                        } finally {
                            uploadBtn.label = "Upload & Encrypt (.bin)";
                            node.setDirtyCanvas(true);
                        }
                    };
                    input.click();
                });
                uploadBtn.serialize = false;
            }
        }
    }
});