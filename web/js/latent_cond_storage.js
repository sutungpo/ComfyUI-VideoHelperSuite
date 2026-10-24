import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

function downloadFile(filename, type = "output") {
    if (!filename) return;
    const a = document.createElement("a");
    a.href = api.apiURL(`/view?filename=${encodeURIComponent(filename)}&type=${type}`);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    requestAnimationFrame(() => a.remove());
}

async function uploadAndAssignFile(node, file) {
    const formData = new FormData();
    formData.append("image", file, file.name);
    formData.append("overwrite", "true");

    const res = await api.fetchApi("/upload/image", { method: "POST", body: formData });
    if (!res.ok) throw new Error(`Upload failed for ${file.name}`);
    const data = await res.json();
    const uploadedName = data.name;

    node._fileTypes = node._fileTypes || {};
    node._fileTypes[uploadedName] = "input";

    const lowerName = uploadedName.toLowerCase();
    const latentWidget = node.widgets?.find(w => w.name === "latent_file");
    const condWidget = node.widgets?.find(w => w.name === "cond_file");

    if (lowerName.endsWith(".zip")) {
        [latentWidget, condWidget].forEach(w => {
            if (w) {
                if (w.options?.values && !w.options.values.includes(uploadedName)) {
                    w.options.values.push(uploadedName);
                }
                w.value = uploadedName;
            }
        });
    } else if (lowerName.includes("latent") && latentWidget) {
        if (!latentWidget.options.values.includes(uploadedName)) latentWidget.options.values.push(uploadedName);
        latentWidget.value = uploadedName;
    } else if (lowerName.includes("cond") && condWidget) {
        if (!condWidget.options.values.includes(uploadedName)) condWidget.options.values.push(uploadedName);
        condWidget.value = uploadedName;
    }
}

app.registerExtension({
    name: "ComfyUI.LatentConditioningStorage",

    nodeCreated(node) {
        // Support both naming formats
        const isStorageNode = node.comfyClass === "LatentConditioningStorage" || 
                              node.type === "LatentConditioningStorage" ||
                              node.comfyClass === "VHS_LatentConditioningStorage" || 
                              node.type === "VHS_LatentConditioningStorage";

        if (!isStorageNode) return;

        const fullDescription = [
            "Save and load Latent and Conditioning tensors.",
            "• Save: Connect latent or conditioning to auto-save to disk.",
            "• Upload: Drag and drop .pt or .zip files directly onto the node.",
            "• Download: Right-click node -> 'Download Latent & Conditioning'."
        ].join("\n");

        node.tooltip = fullDescription;
        node.getTooltip = () => fullDescription;

        // 1. VHS Pattern: Explicitly notify ComfyUI's core that this node is targeted
        node.onDragOver = function (e) {
            if (e?.dataTransfer?.types?.includes("Files")) {
                e.preventDefault();
                e.stopPropagation();
                e.dataTransfer.dropEffect = "copy";
                app.dragOverNode = node; // Tells ComfyUI app.ts exactly which node owns this drop
                return true;
            }
            return false;
        };

        // 2. Returns true to fulfill ComfyUI's `if (await n?.onDragDrop?.(event)) return;`
        node.onDragDrop = async function (e) {
            if (!e?.dataTransfer?.types?.includes("Files")) return false;

            e.preventDefault();
            e.stopPropagation();
            if (e.stopImmediatePropagation) e.stopImmediatePropagation();

            const files = Array.from(e.dataTransfer.files).filter(f => f.name.endsWith(".pt") || f.name.endsWith(".zip"));
            if (!files.length) return false;

            try {
                for (const file of files) {
                    await uploadAndAssignFile(node, file);
                }
                node.setDirtyCanvas?.(true, true);
                app.graph?.setDirtyCanvas(true, true);
                return true; // Signals ComfyUI to completely abort workflow loading
            } catch (err) {
                alert(err.message);
                return true; // Still return true so ComfyUI doesn't try loading as workflow on failure
            }
        };

        // 3. Right-Click Context Menu
        const origGetExtraMenuOptions = node.getExtraMenuOptions;
        node.getExtraMenuOptions = function (canvas, options) {
            origGetExtraMenuOptions?.apply(this, arguments);

            const zipFile = node._lastZipFile;
            const latentFile = this.widgets?.find(w => w.name === "latent_file")?.value;
            const condFile = this.widgets?.find(w => w.name === "cond_file")?.value;

            if (zipFile || latentFile || condFile) {
                options.push({
                    content: "Download Latent & Conditioning",
                    callback: () => {
                        if (node._lastZipFile) {
                            const fileType = node._fileTypes?.[node._lastZipFile] || "output";
                            downloadFile(node._lastZipFile, fileType);
                        } else {
                            const toDownload = [];
                            if (latentFile) toDownload.push({ name: latentFile, type: node._fileTypes?.[latentFile] || "output" });
                            if (condFile) toDownload.push({ name: condFile, type: node._fileTypes?.[condFile] || "output" });

                            toDownload.forEach((item, idx) => {
                                setTimeout(() => downloadFile(item.name, item.type), idx * 200);
                            });
                        }
                    }
                });
            }
        };
    },

    setup() {
        api.addEventListener("executed", ({ detail }) => {
            const node = app.graph.getNodeById(detail?.node);
            if (!node) return;

            const isStorageNode = node.comfyClass === "LatentConditioningStorage" || 
                                  node.type === "LatentConditioningStorage" ||
                                  node.comfyClass === "VHS_LatentConditioningStorage" || 
                                  node.type === "VHS_LatentConditioningStorage";

            if (!isStorageNode) return;

            const ui = detail.output;
            if (ui?.zip_file?.[0]) {
                node._lastZipFile = ui.zip_file[0];
            }
            if (ui?.latent_file?.[0]) {
                const w = node.widgets?.find(w => w.name === "latent_file");
                if (w) {
                    const name = ui.latent_file[0];
                    if (!w.options.values.includes(name)) w.options.values.push(name);
                    w.value = name;
                }
            }
            if (ui?.cond_file?.[0]) {
                const w = node.widgets?.find(w => w.name === "cond_file");
                if (w) {
                    const name = ui.cond_file[0];
                    if (!w.options.values.includes(name)) w.options.values.push(name);
                    w.value = name;
                }
            }
            node.setDirtyCanvas?.(true, true);
            app.graph?.setDirtyCanvas(true, true);
        });
    }
});