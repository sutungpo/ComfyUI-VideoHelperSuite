import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

// Cryptographic state strictly retained in Browser RAM
let serverPublicKey = null;
let browserKeyPair = null;
let browserPublicKeyPEM = null;

// Convert ArrayBuffer to PEM string
function arrayBufferToPem(buffer, header) {
    const b64 = btoa(String.fromCharCode(...new Uint8Array(buffer)));
    const formatted = b64.match(/.{1,64}/g).join("\n");
    return `-----BEGIN ${header}-----\n${formatted}\n-----END ${header}-----`;
}

// Convert PEM string to ArrayBuffer
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

// Initialize Browser and Server RSA keys
async function initCryptoSession() {
    try {
        // 1. Fetch Server RSA Public Key
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

        // 2. Generate Ephemeral Browser RSA-2048 Keypair in Browser RAM
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

        // 3. Register Browser Public Key with Server
        await fetch("/crypto/register_browser_key", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                client_id: api.clientId,
                pubkey: browserPublicKeyPEM
            })
        });

        console.log("[RAM Encryption] Session initialized and public keys exchanged.");
    } catch (err) {
        console.error("[RAM Encryption] Initialization error:", err);
    }
}

// Client-side Encrypt File -> .bin Blob
async function encryptFileToBin(file) {
    if (!serverPublicKey) {
        throw new Error("Server Public Key not loaded yet.");
    }

    const fileBuffer = await file.arrayBuffer();

    // 1. Generate Ephemeral AES-256-GCM Key
    const aesKey = await window.crypto.subtle.generateKey(
        { name: "AES-GCM", length: 256 },
        true,
        ["encrypt"]
    );

    // 2. Encrypt File Content
    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await window.crypto.subtle.encrypt(
        { name: "AES-GCM", iv: iv },
        aesKey,
        fileBuffer
    );

    // 3. Wrap Ephemeral AES Key with Server RSA Public Key (RSA-OAEP)
    const wrappedKey = await window.crypto.subtle.wrapKey(
        "raw",
        aesKey,
        serverPublicKey,
        { name: "RSA-OAEP" }
    );

    // 4. Concatenate: [Wrapped Key (256B)] + [IV (12B)] + [Ciphertext + Tag]
    const combined = new Uint8Array(256 + 12 + ciphertext.byteLength);
    combined.set(new Uint8Array(wrappedKey), 0);
    combined.set(iv, 256);
    combined.set(new Uint8Array(ciphertext), 268);

    return new Blob([combined], { type: "application/octet-stream" });
}

// Client-side Decrypt .bin ArrayBuffer -> Plaintext Image ObjectURL
async function decryptBinToBlobUrl(binBuffer) {
    if (binBuffer.byteLength < 268) {
        throw new Error("Invalid .bin payload received.");
    }

    const wrappedKey = binBuffer.slice(0, 256);
    const iv = binBuffer.slice(256, 268);
    const ciphertext = binBuffer.slice(268);

    // 1. Unwrap AES Key with Browser RSA Private Key
    const aesKey = await window.crypto.subtle.unwrapKey(
        "raw",
        wrappedKey,
        browserKeyPair.privateKey,
        { name: "RSA-OAEP" },
        { name: "AES-GCM", length: 256 },
        false,
        ["decrypt"]
    );

    // 2. Decrypt Content
    const decryptedBytes = await window.crypto.subtle.decrypt(
        { name: "AES-GCM", iv: new Uint8Array(iv) },
        aesKey,
        ciphertext
    );

    const blob = new Blob([decryptedBytes], { type: "image/png" });
    return URL.createObjectURL(blob);
}

// Register ComfyUI Extension
app.registerExtension({
    name: "ComfyUI.RAMEncryption",

    async setup() {
        await initCryptoSession();
    },

    nodeCreated(node) {
        // =============================================================
        // Hook: ImageUploadRAM Node UI
        // =============================================================
        if (node.comfyClass === "ImageUploadRAM") {
            const uploadBtn = node.addWidget("button", "Upload & Encrypt (.bin)", "upload", () => {
                const input = document.createElement("input");
                input.type = "file";
                input.accept = "image/*";
                input.style.display = "none";

                input.onchange = async () => {
                    if (!input.files || input.files.length === 0) return;
                    const file = input.files[0];
                    uploadBtn.name = "Encrypting...";
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
                        uploadBtn.name = "Upload & Encrypt (.bin)";
                        node.setDirtyCanvas(true);
                    }
                };

                document.body.appendChild(input);
                input.click();
                document.body.removeChild(input);
            });
        }

        // =============================================================
        // Hook: ImagePreviewRAM Node UI
        // =============================================================
        if (node.comfyClass === "ImagePreviewRAM") {
            // Automatically supply Browser Public Key widget value if present
            const pubWidget = node.widgets?.find(w => w.name === "browser_pubkey");
            if (pubWidget) {
                pubWidget.type = "hidden"; // Hide raw PEM text from workspace
            }

            // Override onExecuted to fetch and decrypt ciphertext .bin files
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

                        const blobUrl = await decryptBinToBlobUrl(binArray);
                        const img = new Image();
                        img.src = blobUrl;
                        imgElements.push(img);
                    }

                    node.imgs = imgElements;
                    app.graph.setDirtyCanvas(true);
                }
            };
        }
    },

    // Inject Browser Public Key into prompt submission
    async beforeQueuedPrompt(prompt) {
        if (!browserPublicKeyPEM) return;
        for (const nodeId in prompt.output) {
            const nodeData = prompt.output[nodeId];
            if (nodeData.class_type === "ImagePreviewRAM" && nodeData.inputs) {
                nodeData.inputs["browser_pubkey"] = browserPublicKeyPEM;
            }
        }
    }
});