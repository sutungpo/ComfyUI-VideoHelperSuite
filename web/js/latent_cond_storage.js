import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

function triggerUpload(node, widget) {
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

            widget.value = data.name;
            node._fileTypes = node._fileTypes || {};
            node._fileTypes[data.name] = "input";
            node.setDirtyCanvas?.(true, true);
            app.graph?.setDirtyCanvas(true, true);
        } catch (err) {
            alert("Upload failed: " + err.message);
        }
    };
    input.click();
}

function triggerDownload(node, widget, label) {
    const filename = widget.value;
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

function createInlineFileWidget(node, name, label) {
    const widget = {
        name: name,
        type: "custom",
        value: "",
        computeSize(width) {
            return [width, 26];
        },
        draw(ctx, node, widget_width, y, H) {
            const margin = 10;
            const x = margin;
            const w = widget_width - margin * 2;

            // 1. Draw Background Box
            ctx.fillStyle = "#1e1e1e";
            ctx.strokeStyle = "#383838";
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.roundRect(x, y, w, H, [4]);
            ctx.fill();
            ctx.stroke();

            // 2. Draw Label & Current File Name
            ctx.font = "11px sans-serif";
            ctx.textAlign = "left";
            ctx.textBaseline = "middle";

            ctx.fillStyle = "#888";
            ctx.fillText(label + ":", x + 8, y + H / 2);

            const labelWidth = ctx.measureText(label + ":").width + 8;
            ctx.fillStyle = this.value ? "#ddd" : "#555";
            const text = this.value || "(empty)";

            // Truncate text if it approaches the buttons on the right
            const maxTextW = w - labelWidth - 52;
            let displayText = text;
            if (ctx.measureText(displayText).width > maxTextW) {
                while (displayText.length > 3 && ctx.measureText(displayText + "...").width > maxTextW) {
                    displayText = displayText.slice(0, -1);
                }
                displayText += "...";
            }
            ctx.fillText(displayText, x + labelWidth + 4, y + H / 2);

            // 3. Draw Inline [ ⬆ ] Button
            const upX = x + w - 44;
            const btnY = y + 3;
            const btnH = H - 6;
            ctx.fillStyle = "#2a2a2a";
            ctx.beginPath();
            ctx.roundRect(upX, btnY, 18, btnH, [3]);
            ctx.fill();
            ctx.fillStyle = "#4af";
            ctx.textAlign = "center";
            ctx.font = "12px sans-serif";
            ctx.fillText("⬆", upX + 9, y + H / 2);

            // 4. Draw Inline [ ⬇ ] Button
            const downX = x + w - 22;
            ctx.fillStyle = "#2a2a2a";
            ctx.beginPath();
            ctx.roundRect(downX, btnY, 18, btnH, [3]);
            ctx.fill();
            ctx.fillStyle = "#4f8";
            ctx.fillText("⬇", downX + 9, y + H / 2);
        },
        mouse(event, [mx, my], node) {
            if (event.type === "pointerdown" || event.type === "mousedown") {
                const margin = 10;
                const x = margin;
                const w = (this.width || node.size[0]) - margin * 2;
                const upX = x + w - 44;
                const downX = x + w - 22;

                if (mx >= upX && mx <= upX + 18) {
                    // Clicked ⬆ Upload
                    triggerUpload(node, this);
                    return true;
                } else if (mx >= downX && mx <= downX + 18) {
                    // Clicked ⬇ Download
                    triggerDownload(node, this, label);
                    return true;
                } else if (mx >= x && mx < upX) {
                    // Clicked the file name text area: quick prompt to edit/view
                    app.canvas.prompt("File name:", this.value, (val) => {
                        this.value = val.trim();
                        node.setDirtyCanvas?.(true, true);
                    });
                    return true;
                }
            }
        }
    };

    node.addCustomWidget(widget);
    return widget;
}

app.registerExtension({
    name: "ComfyUI.VHS.LatentConditioningStorage",

    nodeCreated(node) {
        if (node.comfyClass !== "VHS_LatentConditioningStorage" && node.type !== "VHS_LatentConditioningStorage") return;

        // Clear default widgets if any were auto-generated
        node.widgets = [];

        // Create the two compact rows with inline ⬆ / ⬇
        createInlineFileWidget(node, "latent_file", "Latent");
        createInlineFileWidget(node, "cond_file", "Cond");

        node.setSize(node.computeSize());
        node.setDirtyCanvas?.(true, true);
    },

    setup() {
        // Auto-update file names when workflow execution finishes saving
        api.addEventListener("executed", ({ detail }) => {
            const node = app.graph.getNodeById(detail?.node);
            if (!node || (node.comfyClass !== "VHS_LatentConditioningStorage" && node.type !== "VHS_LatentConditioningStorage")) return;

            const ui = detail.output;
            if (ui?.latent_file?.[0]) {
                const w = node.widgets?.find(w => w.name === "latent_file");
                if (w) w.value = ui.latent_file[0];
            }
            if (ui?.cond_file?.[0]) {
                const w = node.widgets?.find(w => w.name === "cond_file");
                if (w) w.value = ui.cond_file[0];
            }
            node.setDirtyCanvas?.(true, true);
            app.graph?.setDirtyCanvas(true, true);
        });
    }
});