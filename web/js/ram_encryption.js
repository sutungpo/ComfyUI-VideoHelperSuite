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
// 2. Unified Decryption Helper (Images & Videos)
// =====================================================================

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

// =====================================================================
// 3. Extension Registration & Unified Preview Dispatcher
// =====================================================================

app.registerExtension({
    name: "ComfyUI.VHS.RAMEncryption",

    async setup() {
        await initCryptoSession();

        // Unified Handler for both VHS_ImagePreviewRAM and VHS_VideoCombine
        api.addEventListener("executed", async ({ detail }) => {
            const items = detail?.output?.ram_preview;
            if (!items || !items.length) return;

            const node = app.graph.getNodeById(detail.node);
            if (!node) return;

            try {
                const firstFormat = items[0].format || "";

                // --- A. Image Preview (VHS_ImagePreviewRAM) ---
                if (firstFormat.startsWith("image/")) {
                    const loadedImgs = [];
                    for (const item of items) {
                        const blobUrl = await resolveEncryptedBlobUrl(item);
                        const img = new Image();
                        await new Promise((resolve) => {
                            img.onload = resolve;
                            img.onerror = resolve;
                            img.src = blobUrl;
                        });
                        loadedImgs.push(img);
                    }
                    node.imgs = loadedImgs;
                    if (loadedImgs[0]?.naturalWidth) {
                        resizeNodeForMedia(node, loadedImgs[0].naturalWidth, loadedImgs[0].naturalHeight);
                    }
                }

                app.graph.setDirtyCanvas(true, true);
            } catch (err) {
                console.error("[RAM Encryption] Preview decryption error:", err);
            }
        });
    },

    beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name === "VHS_ImageUploadRAM") {
            if (!nodeData.input) nodeData.input = {};
            if (!nodeData.input.optional) nodeData.input.optional = {};
            nodeData.input.optional["upload"] = ["BUTTON", {}];
        }
    },

    nodeCreated(node) {
        // Upload & Encrypt button for VHS_ImageUploadRAM
        if (node.comfyClass === "VHS_ImageUploadRAM" || node.type === "VHS_ImageUploadRAM") {
            if (!node.widgets?.some(w => w.name === "upload")) {
                const uploadBtn = node.addWidget("button", "upload", "Upload & Encrypt (.bin)", () => {
                    const input = document.createElement("input");
                    input.type = "file";
                    input.accept = "image/*";
                    input.onchange = async () => {
                        if (!input.files?.length) return;
                        const file = input.files[0];

                        // Instant local-only preview
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
    }
});