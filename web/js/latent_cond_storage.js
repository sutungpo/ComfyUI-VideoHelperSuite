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

    // Track that this file is located in the 'input' folder
    node._fileTypes = node._fileTypes || {};
    node._fileTypes[uploadedName] = "input";

    const lowerName = uploadedName.toLowerCase();
    let targetWidget = null;

    // Prefix recognition: route to latent or cond widget
    if (lowerName.includes("latent")) {
        targetWidget = node.widgets?.find(w => w.name === "latent_file");
    } else if (lowerName.includes("cond")) {
        targetWidget = node.widgets?.find(w => w.name === "cond_file");
    }

    if (targetWidget) {
        if (targetWidget.options?.values && !targetWidget.options.values.includes(uploadedName)) {
            targetWidget.options.values.push(uploadedName);
        }
        targetWidget.value = uploadedName;
    }
}

app.registerExtension({
    name: "ComfyUI.VHS.LatentConditioningStorage",

    nodeCreated(node) {
        if (node.comfyClass !== "VHS_LatentConditioningStorage" && node.type !== "VHS_LatentConditioningStorage") return;

        // 1. Drag & Drop Support
        node.onDragOver = (e) => !!e?.dataTransfer?.types?.includes?.("Files");

        node.onDragDrop = async function (e) {
            if (!e?.dataTransfer?.types?.includes?.("Files")) return false;
            const files = Array.from(e.dataTransfer.files).filter(f => f.name.endsWith(".pt"));
            if (!files.length) return false;

            try {
                for (const file of files) {
                    await uploadAndAssignFile(node, file);
                }
                node.setDirtyCanvas?.(true, true);
                app.graph?.setDirtyCanvas(true, true);
                return true;
            } catch (err) {
                alert(err.message);
                return false;
            }
        };

        // 2. Right-Click Context Menu to Download Both
        const origGetExtraMenuOptions = node.getExtraMenuOptions;
        node.getExtraMenuOptions = function (canvas, options) {
            origGetExtraMenuOptions?.apply(this, arguments);

            const latentFile = this.widgets?.find(w => w.name === "latent_file")?.value;
            const condFile = this.widgets?.find(w => w.name === "cond_file")?.value;

            if (latentFile || condFile) {
                options.push({
                    content: "Download Latent & Conditioning",
                    callback: () => {
                        const downloads = [];
                        if (latentFile) downloads.push({ name: latentFile, type: node._fileTypes?.[latentFile] || "output" });
                        if (condFile) downloads.push({ name: condFile, type: node._fileTypes?.[condFile] || "output" });

                        // Stagger downloads by 200ms so browsers do not drop concurrent files
                        downloads.forEach((item, index) => {
                            setTimeout(() => {
                                downloadFile(item.name, item.type);
                            }, index * 200);
                        });
                    }
                });
            }
        };
    },

    setup() {
        // Auto-update dropdowns when remote execution finishes saving
        api.addEventListener("executed", ({ detail }) => {
            const node = app.graph.getNodeById(detail?.node);
            if (!node || (node.comfyClass !== "VHS_LatentConditioningStorage" && node.type !== "VHS_LatentConditioningStorage")) return;

            const ui = detail.output;
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