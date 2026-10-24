import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

function uploadFile(node, widgetName) {
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
            if (!res.ok) throw new Error(`Upload failed with status ${res.status}`);
            const data = await res.json();

            const widget = node.widgets?.find(w => w.name === widgetName);
            if (widget) {
                if (widget.options?.values && !widget.options.values.includes(data.name)) {
                    widget.options.values.push(data.name);
                }
                widget.value = data.name;
                node._fileTypes = node._fileTypes || {};
                node._fileTypes[data.name] = "input";
                node.setDirtyCanvas?.(true, true);
                app.graph?.setDirtyCanvas(true, true);
            }
        } catch (err) {
            alert("Upload failed: " + err.message);
        }
    };
    input.click();
}

function downloadFile(node, widgetName, label) {
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

function setupButton(node, name, label, callback) {
    let btn = node.widgets?.find(w => w.name === name);
    if (!btn) {
        btn = node.addWidget("button", name, label, callback);
    } else {
        btn.label = label;
        btn.callback = callback;
    }
    btn.serialize = false;
    return btn;
}

app.registerExtension({
    name: "ComfyUI.VHS.LatentConditioningStorage",

    // Step 1: Declare buttons in nodeData.input.optional to prevent VHS schema pruning
    beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name === "VHS_LatentConditioningStorage") {
            nodeData.input = nodeData.input || {};
            nodeData.input.optional = nodeData.input.optional || {};
            nodeData.input.optional["upload_latent"] = ["BUTTON", {}];
            nodeData.input.optional["download_latent"] = ["BUTTON", {}];
            nodeData.input.optional["upload_cond"] = ["BUTTON", {}];
            nodeData.input.optional["download_cond"] = ["BUTTON", {}];
        }
    },

    // Step 2: Bind handlers and resize node
    nodeCreated(node) {
        if (node.comfyClass !== "VHS_LatentConditioningStorage" && node.type !== "VHS_LatentConditioningStorage") return;

        setupButton(node, "upload_latent", "⬆ Upload Latent", () => {
            uploadFile(node, "latent_file");
        });

        setupButton(node, "download_latent", "⬇ Download Latent", () => {
            downloadFile(node, "latent_file", "Latent");
        });

        setupButton(node, "upload_cond", "⬆ Upload Cond", () => {
            uploadFile(node, "cond_file");
        });

        setupButton(node, "download_cond", "⬇ Download Cond", () => {
            downloadFile(node, "cond_file", "Conditioning");
        });

        // Ensure canvas recalculates size so all 4 buttons and dropdowns are visible
        node.setSize(node.computeSize());
        node.setDirtyCanvas?.(true, true);
        app.graph?.setDirtyCanvas(true, true);
    },

    setup() {
        // Step 3: Listen for execution completion to auto-populate newly saved files
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