import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

async function uploadAndAssignFile(node, file) {
    const formData = new FormData();
    formData.append("image", file, file.name);
    formData.append("overwrite", "true");

    const res = await api.fetchApi("/upload/image", { method: "POST", body: formData });
    if (!res.ok) throw new Error(`Upload failed for ${file.name}`);
    const data = await res.json();
    const uploadedName = data.name;

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
        const isStorageNode = node.comfyClass === "LatentConditioningStorage" || 
                              node.type === "LatentConditioningStorage" ||
                              node.comfyClass === "VHS_LatentConditioningStorage" || 
                              node.type === "VHS_LatentConditioningStorage";

        if (!isStorageNode) return;

        const fullDescription = [
            "Save and load Latent and Conditioning tensors.",
            "• Save: Connect latent or conditioning to auto-save to disk.",
            "• Upload: Drag and drop .pt or .zip files directly onto the node.",
            "• Download: Right-click node -> 'Download (Compressed Zip)'."
        ].join("\n");

        node.tooltip = fullDescription;
        node.getTooltip = () => fullDescription;

        // 1. Drag & Drop Support
        node.onDragOver = function (e) {
            if (e?.dataTransfer?.types?.includes("Files")) {
                e.preventDefault();
                e.stopPropagation();
                e.dataTransfer.dropEffect = "copy";
                app.dragOverNode = node;
                return true;
            }
            return false;
        };

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
                return true;
            } catch (err) {
                alert(err.message);
                return true;
            }
        };

        // 2. Right-Click Context Menu: ALWAYS downloads a single compressed .zip
        const origGetExtraMenuOptions = node.getExtraMenuOptions;
        node.getExtraMenuOptions = function (canvas, options) {
            origGetExtraMenuOptions?.apply(this, arguments);

            const latentFile = this.widgets?.find(w => w.name === "latent_file")?.value || "";
            const condFile = this.widgets?.find(w => w.name === "cond_file")?.value || "";

            if (latentFile || condFile) {
                options.push({
                    content: "Download (Compressed Zip)",
                    callback: () => {
                        // Requests single zip archive from backend - NO multi-file loop
                        const url = api.apiURL(
                            `/latcond/download?latent_file=${encodeURIComponent(latentFile)}&cond_file=${encodeURIComponent(condFile)}`
                        );
                        const a = document.createElement("a");
                        a.href = url;
                        document.body.appendChild(a);
                        a.click();
                        requestAnimationFrame(() => a.remove());
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