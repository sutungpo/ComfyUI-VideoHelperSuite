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
    name: "ComfyUI.VHS.LatentConditioningStorage",

    nodeCreated(node) {
        if (node.comfyClass !== "VHS_LatentConditioningStorage" && node.type !== "VHS_LatentConditioningStorage") return;

        // Restore full multi-line hover tooltip (bypasses VHS.core.js single-line truncation)
        node.tooltip = [
            "Save and load Latent and Conditioning tensors.",
            "• Save: Connect latent or conditioning to auto-save to disk.",
            "• Upload: Drag and drop .pt or .zip files directly onto the node.",
            "• Upload: latent file start with 'latent_' & conditioning file with 'cond_'.\n",
            "• Download: Right-click node -> 'Download (Compressed Zip)'."
        ].join("\n");

        // Drag & Drop Support (.pt and .zip)
        node.onDragOver = (e) => !!e?.dataTransfer?.types?.includes?.("Files");

        node.onDragDrop = async function (e) {
            if (!e?.dataTransfer?.types?.includes?.("Files")) return false;
            const files = Array.from(e.dataTransfer.files).filter(f => f.name.endsWith(".pt") || f.name.endsWith(".zip"));
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

        // Right-Click Context Menu (Single Compressed Zip Download)
        const origGetExtraMenuOptions = node.getExtraMenuOptions;
        node.getExtraMenuOptions = function (canvas, options) {
            origGetExtraMenuOptions?.apply(this, arguments);

            const zipFile = node._lastZipFile;
            if (zipFile) {
                options.push({
                    content: "Download (Compressed Zip)",
                    callback: () => {
                        const fileType = node._fileTypes?.[zipFile] || "output";
                        downloadFile(zipFile, fileType);
                    }
                });
            }
        };
    },

    setup() {
        api.addEventListener("executed", ({ detail }) => {
            const node = app.graph.getNodeById(detail?.node);
            if (!node || (node.comfyClass !== "VHS_LatentConditioningStorage" && node.type !== "VHS_LatentConditioningStorage")) return;

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