from .videohelpersuite.nodes import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS
import folder_paths
from .videohelpersuite.server import server
from .videohelpersuite import documentation
from .videohelpersuite import latent_preview

from .videohelpersuite.nodes import VHS_ImageUploadRAM, VHS_ImagePreviewRAM

NODE_CLASS_MAPPINGS["VHS_ImageUploadRAM"] = VHS_ImageUploadRAM
NODE_CLASS_MAPPINGS["VHS_ImagePreviewRAM"] = VHS_ImagePreviewRAM

NODE_DISPLAY_NAME_MAPPINGS["VHS_ImageUploadRAM"] = "Image Upload RAM"
NODE_DISPLAY_NAME_MAPPINGS["VHS_ImagePreviewRAM"] = "Image Preview RAM"

WEB_DIRECTORY = "./web/js"
__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
documentation.format_descriptions(NODE_CLASS_MAPPINGS)
