import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

function triggerUpload(node, widgetName) {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".pt";
    input.onchange = async () => {
        if (!input.files?.length) return;
        const file = input.files[0];

        const formData = new FormData();
        formData.append("image", file, file.name);
        formData.append("overwrite", "true");

        try {
            const res = await api.fetchApi("/upload/image", { method: "POST", body: formData });
            if (!res.ok) throw new Error(`Upload failed: ${res.statusText}`);
            const data = await res.json();

            const widget = node.widgets?.find(w => w.name === widgetName);
            if (widget) {
                if (widget.options?.values && !widget.options.values.includes(data.name)) {
                    widget.options.values.push(data.name);
                }
                widget.value = data.name;
                node._fileTypes = node._fileTypes || {};
                node._fileTypes[data.name] = "input";
                node.setDirtyCanvas(true, true);
            }
        } catch (err) {
            alert(err.message);
        }
    };
    input.click();
}

function triggerDownload(node, widgetName, label) {
    const widget = node.widgets?.find(w => w.name === widgetName);
    const filename = widget?.value;
    if (!filename) {
        alert(`No ${label} file selected to download.`);
        return;
    }
    const type = node._fileTypes?.[filename] || "output";
    const a = document.createElement("a");
    a.href = api.apiURL(`/view?filename=${encodeURIComponent(filename)}&type=${type}`);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    requestAnimationFrame(() => a.remove());
}

app.registerExtension({
    name: "ComfyUI.VHS.LatentConditioningStorage",

    nodeCreated(node) {
        if (node.comfyClass !== "VHS_LatentConditioningStorage") return;

        // Latent controls: [ ⬆ Latent ] and [ ⬇ Latent ]
        const btnUploadLatent = node.addWidget("button", "upload_latent", "⬆ Upload Latent", () => {
            triggerUpload(node, "latent_file");
        });
        btnUploadLatent.serialize = false;

        const btnDownloadLatent = node.addWidget("button", "download_latent", "⬇ Download Latent", () => {
            triggerDownload(node, "latent_file", "Latent");
        });
        btnDownloadLatent.serialize = false;

        // Conditioning controls: [ ⬆ Cond ] and [ ⬇ Cond ]
        const btnUploadCond = node.addWidget("button", "upload_cond", "⬆ Upload Cond", () => {
            triggerUpload(node, "cond_file");
        });
        btnUploadCond.serialize = false;

        const btnDownloadCond = node.addWidget("button", "download_cond", "⬇ Download Cond", () => {
            triggerDownload(node, "cond_file", "Conditioning");
        });
        btnDownloadCond.serialize = false;
    },

    setup() {
        // Auto-select saved file on execution finish
        api.addEventListener("executed", ({ detail }) => {
            const node = app.graph.getNodeById(detail?.node);
            if (!node || node.comfyClass !== "VHS_LatentConditioningStorage") return;

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
            node.setDirtyCanvas(true, true);
        });
    }
});