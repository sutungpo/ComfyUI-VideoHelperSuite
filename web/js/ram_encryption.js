import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

let serverPublicKey = null;
let browserKeyPair = null;
let browserPublicKeyPEM = null;

const decryptionCache = new Map();

// =====================================================================
// WebCrypto Handshake Setup
// =====================================================================

function pemToArrayBuffer(pem) {
    const b64 = pem.replace(/-----BEGIN [^-]+-----/, "").replace(/-----END [^-]+-----/, "").replace(/\s+/g, "");
    return Uint8Array.from(atob(b64), c => c.charCodeAt(0)).buffer;
}

function arrayBufferToPem(buffer, header) {
    const b64 = btoa(String.fromCharCode(...new Uint8Array(buffer)));
    return `-----BEGIN ${header}-----\n${b64.match(/.{1,64}/g).join("\n")}\n-----END ${header}-----`;
}

async function registerKey() {
    if (!browserPublicKeyPEM) return;
    try {
        await fetch("/crypto/register_browser_key", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ client_id: api.clientId, pubkey: browserPublicKeyPEM })
        });
    } catch (e) {
        console.error("[RAM Encryption] Key registration failed:", e);
    }
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

        await registerKey();
        console.log("[RAM Encryption] Crypto session ready.");
    } catch (err) {
        console.error("[RAM Encryption] Setup failed:", err);
    }
}

// =====================================================================
// Transparent Interceptor Proxy (Reuses 100% of Comfy & VHS UI Code)
// =====================================================================

async function decryptUrlToBlobUrl(url, mimeType) {
    if (decryptionCache.has(url)) return decryptionCache.get(url);

    const promise = (async () => {
        try {
            const res = await fetch(url);
            const buf = await res.arrayBuffer();

            // Format: [256B wrapped key] + [12B IV] + [Ciphertext + Tag]
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

            return URL.createObjectURL(new Blob([decrypted], { type: mimeType }));
        } catch (err) {
            console.error("[RAM Decryption] Error decrypting media:", url, err);
            return url;
        }
    })();

    decryptionCache.set(url, promise);
    return promise;
}

// Transparent Image Property Interceptor
const originalImageSrc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "src");
Object.defineProperty(HTMLImageElement.prototype, "src", {
    set: function (val) {
        if (typeof val === "string" && val.includes("/view?") && val.includes(".bin")) {
            decryptUrlToBlobUrl(val, "image/png").then(blobUrl => {
                originalImageSrc.set.call(this, blobUrl);
            });
        } else {
            originalImageSrc.set.call(this, val);
        }
    },
    get: function () {
        return originalImageSrc.get.call(this);
    }
});

// Transparent Media (HTML5 Video) Property Interceptor
const originalMediaSrc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "src");
Object.defineProperty(HTMLMediaElement.prototype, "src", {
    set: function (val) {
        if (typeof val === "string" && val.includes("/view?") && val.includes(".bin")) {
            const mime = val.includes("webm") ? "video/webm" : "video/mp4";
            decryptUrlToBlobUrl(val, mime).then(blobUrl => {
                originalMediaSrc.set.call(this, blobUrl);
            });
        } else {
            originalMediaSrc.set.call(this, val);
        }
    },
    get: function () {
        return originalMediaSrc.get.call(this);
    }
});

// =====================================================================
// Extension Registration
// =====================================================================

app.registerExtension({
    name: "ComfyUI.VHS.RAMEncryption",

    async setup() {
        await initCryptoSession();
        api.addEventListener("open", registerKey); // Re-register key on websocket reconnection
    },

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

                        // Local-only preview
                        const img = new Image();
                        img.onload = () => {
                            const minWidth = Math.max(node.size[0] || 0, 240);
                            const aspect = img.naturalWidth / (img.naturalHeight || 1);
                            const imgHeight = minWidth / aspect;
                            const widgetHeight = node.widgets ? node.widgets.length * 32 : 0;
                            node.setSize([minWidth, Math.max(120, widgetHeight + imgHeight + 60)]);
                            node.setDirtyCanvas(true, true);
                        };
                        img.src = URL.createObjectURL(file);
                        node.imgs = [img];

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