import os
import sys
import json
import subprocess
import numpy as np
import re
import datetime
from typing import List
import torch
from PIL import Image, ExifTags
from PIL.PngImagePlugin import PngInfo
from pathlib import Path
from string import Template
import itertools
import functools
import gc

import folder_paths
from .logger import logger
from .image_latent_nodes import *
from .load_video_nodes import LoadVideoUpload, LoadVideoPath, LoadVideoFFmpegUpload, LoadVideoFFmpegPath, LoadImagePath
from .load_images_nodes import LoadImagesFromDirectoryUpload, LoadImagesFromDirectoryPath
from .batched_nodes import VAEEncodeBatched, VAEDecodeBatched
from .utils import ffmpeg_path, get_audio, hash_path, validate_path, requeue_workflow, \
        gifski_path, calculate_file_hash, strip_path, try_download_video, is_url, \
        imageOrLatent, BIGMAX, merge_filter_args, ENCODE_ARGS, floatOrInt, cached, \
        ContainsAll
from comfy.utils import ProgressBar
from comfy_api.v0_0_2 import IO

if 'VHS_video_formats' not in folder_paths.folder_names_and_paths:
    folder_paths.folder_names_and_paths["VHS_video_formats"] = ((),{".json"})
if len(folder_paths.folder_names_and_paths['VHS_video_formats'][1]) == 0:
    folder_paths.folder_names_and_paths["VHS_video_formats"][1].add(".json")
audio_extensions = ['mp3', 'mp4', 'wav', 'ogg']

def flatten_list(l):
    ret = []
    for e in l:
        if isinstance(e, list):
            ret.extend(e)
        else:
            ret.append(e)
    return ret

def iterate_format(video_format, for_widgets=True):
    """Provides an iterator over widgets, or arguments"""
    def indirector(cont, index):
        if isinstance(cont[index], list) and (not for_widgets
          or len(cont[index])> 1 and not isinstance(cont[index][1], dict)):
            inp = yield cont[index]
            if inp is not None:
                cont[index] = inp
                yield
    for k in video_format:
        if k == "extra_widgets":
            if for_widgets:
                yield from video_format["extra_widgets"]
        elif k.endswith("_pass"):
            for i in range(len(video_format[k])):
                yield from indirector(video_format[k], i)
            if not for_widgets:
                video_format[k] = flatten_list(video_format[k])
        else:
            yield from indirector(video_format, k)

base_formats_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "video_formats")
@cached(5)
def get_video_formats():
    format_files = {}
    for format_name in folder_paths.get_filename_list("VHS_video_formats"):
        format_files[format_name] = folder_paths.get_full_path("VHS_video_formats", format_name)
    for item in os.scandir(base_formats_dir):
        if not item.is_file() or not item.name.endswith('.json'):
            continue
        format_files[item.name[:-5]] = item.path
    formats = []
    format_widgets = {}
    for format_name, path in format_files.items():
        with open(path, 'r') as stream:
            video_format = json.load(stream)
        if "gifski_pass" in video_format and gifski_path is None:
            #Skip format
            continue
        widgets = list(iterate_format(video_format))
        formats.append("video/" + format_name)
        if (len(widgets) > 0):
            format_widgets["video/"+ format_name] = widgets
    return formats, format_widgets

def apply_format_widgets(format_name, kwargs):
    if os.path.exists(os.path.join(base_formats_dir, format_name + ".json")):
        video_format_path = os.path.join(base_formats_dir, format_name + ".json")
    else:
        video_format_path = folder_paths.get_full_path("VHS_video_formats", format_name)
    with open(video_format_path, 'r') as stream:
        video_format = json.load(stream)
    for w in iterate_format(video_format):
        if w[0] not in kwargs:
            if len(w) > 2 and 'default' in w[2]:
                default = w[2]['default']
            else:
                if type(w[1]) is list:
                    default = w[1][0]
                else:
                    #NOTE: This doesn't respect max/min, but should be good enough as a fallback to a fallback to a fallback
                    default = {"BOOLEAN": False, "INT": 0, "FLOAT": 0, "STRING": ""}[w[1]]
            kwargs[w[0]] = default
            logger.warn(f"Missing input for {w[0]} has been set to {default}")
    wit = iterate_format(video_format, False)
    for w in wit:
        while isinstance(w, list):
            if len(w) == 1:
                #TODO: mapping=kwargs should be safer, but results in key errors, investigate why
                w = [Template(x).substitute(**kwargs) for x in w[0]]
                break
            elif isinstance(w[1], dict):
                w = w[1][str(kwargs[w[0]])]
            elif len(w) > 3:
                w = Template(w[3]).substitute(val=kwargs[w[0]])
            else:
                w = str(kwargs[w[0]])
        wit.send(w)
    return video_format

def tensor_to_int(tensor, bits):
    tensor = tensor.cpu().numpy() * (2**bits-1) + 0.5
    return np.clip(tensor, 0, (2**bits-1))
def tensor_to_shorts(tensor):
    return tensor_to_int(tensor, 16).astype(np.uint16)
def tensor_to_bytes(tensor):
    return tensor_to_int(tensor, 8).astype(np.uint8)

def ffmpeg_process(args, video_format, video_metadata, file_path, env):

    res = None
    frame_data = yield
    total_frames_output = 0
    if video_format.get('save_metadata', 'False') != 'False':
        os.makedirs(folder_paths.get_temp_directory(), exist_ok=True)
        metadata_path = os.path.join(folder_paths.get_temp_directory(), "metadata.txt")
        #metadata from file should  escape = ; # \ and newline
        def escape_ffmpeg_metadata(key, value):
            value = str(value)
            value = value.replace("\\","\\\\")
            value = value.replace(";","\\;")
            value = value.replace("#","\\#")
            value = value.replace("=","\\=")
            value = value.replace("\n","\\\n")
            return f"{key}={value}"

        with open(metadata_path, "w") as f:
            f.write(";FFMETADATA1\n")
            if "prompt" in video_metadata:
                f.write(escape_ffmpeg_metadata("prompt", json.dumps(video_metadata["prompt"])) + "\n")
            if "workflow" in video_metadata:
                f.write(escape_ffmpeg_metadata("workflow", json.dumps(video_metadata["workflow"])) + "\n")
            for k, v in video_metadata.items():
                if k not in ["prompt", "workflow"]:
                    f.write(escape_ffmpeg_metadata(k, json.dumps(v)) + "\n")

        m_args = args[:1] + ["-i", metadata_path] + args[1:] + ["-metadata", "creation_time=now", "-movflags", "use_metadata_tags"]
        with subprocess.Popen(m_args + [file_path], stderr=subprocess.PIPE,
                              stdin=subprocess.PIPE, env=env) as proc:
            try:
                while frame_data is not None:
                    proc.stdin.write(frame_data)
                    #TODO: skip flush for increased speed
                    frame_data = yield
                    total_frames_output+=1
                proc.stdin.flush()
                proc.stdin.close()
                res = proc.stderr.read()
            except BrokenPipeError as e:
                err = proc.stderr.read()
                #Check if output file exists. If it does, the re-execution
                #will also fail. This obscures the cause of the error
                #and seems to never occur concurrent to the metadata issue
                if os.path.exists(file_path):
                    raise Exception("An error occurred in the ffmpeg subprocess:\n" \
                            + err.decode(*ENCODE_ARGS))
                #Res was not set
                print(err.decode(*ENCODE_ARGS), end="", file=sys.stderr)
                logger.warn("An error occurred when saving with metadata")
    if res != b'':
        with subprocess.Popen(args + [file_path], stderr=subprocess.PIPE,
                              stdin=subprocess.PIPE, env=env) as proc:
            try:
                while frame_data is not None:
                    proc.stdin.write(frame_data)
                    frame_data = yield
                    total_frames_output+=1
                proc.stdin.flush()
                proc.stdin.close()
                res = proc.stderr.read()
            except BrokenPipeError as e:
                res = proc.stderr.read()
                raise Exception("An error occurred in the ffmpeg subprocess:\n" \
                        + res.decode(*ENCODE_ARGS))
    yield total_frames_output
    if len(res) > 0:
        print(res.decode(*ENCODE_ARGS), end="", file=sys.stderr)

def gifski_process(args, dimensions, frame_rate, video_format, file_path, env):
    frame_data = yield
    with subprocess.Popen(args + video_format['main_pass'] + ['-f', 'yuv4mpegpipe', '-'],
                          stderr=subprocess.PIPE, stdin=subprocess.PIPE,
                          stdout=subprocess.PIPE, env=env) as procff:
        with subprocess.Popen([gifski_path] + video_format['gifski_pass']
                              + ['-W', f'{dimensions[0]}', '-H', f'{dimensions[1]}']
                              + ['-r', f'{frame_rate}']
                              + ['-q', '-o', file_path, '-'], stderr=subprocess.PIPE,
                              stdin=procff.stdout, stdout=subprocess.PIPE,
                              env=env) as procgs:
            try:
                while frame_data is not None:
                    procff.stdin.write(frame_data)
                    frame_data = yield
                procff.stdin.flush()
                procff.stdin.close()
                resff = procff.stderr.read()
                resgs = procgs.stderr.read()
                outgs = procgs.stdout.read()
            except BrokenPipeError as e:
                procff.stdin.close()
                resff = procff.stderr.read()
                resgs = procgs.stderr.read()
                raise Exception("An error occurred while creating gifski output\n" \
                        + "Make sure you are using gifski --version >=1.32.0\nffmpeg: " \
                        + resff.decode(*ENCODE_ARGS) + '\ngifski: ' + resgs.decode(*ENCODE_ARGS))
    if len(resff) > 0:
        print(resff.decode(*ENCODE_ARGS), end="", file=sys.stderr)
    if len(resgs) > 0:
        print(resgs.decode(*ENCODE_ARGS), end="", file=sys.stderr)
    #should always be empty as the quiet flag is passed
    if len(outgs) > 0:
        print(outgs.decode(*ENCODE_ARGS))

def to_pingpong(inp):
    if not hasattr(inp, "__getitem__"):
        inp = list(inp)
    yield from inp
    for i in range(len(inp)-2,0,-1):
        yield inp[i]

class LoadAudio:
    @classmethod
    def INPUT_TYPES(s):
        #Hide ffmpeg formats if ffmpeg isn't available
        return {
            "required": {
                "audio_file": ("STRING", {"default": "input/", "vhs_path_extensions": ['wav','mp3','ogg','m4a','flac']}),
                },
            "optional" : {
                "seek_seconds": ("FLOAT", {"default": 0, "min": 0, "widgetType": "VHSTIMESTAMP"}),
                "duration": ("FLOAT" , {"default": 0, "min": 0, "max": 10000000, "step": 0.01, "widgetType": "VHSTIMESTAMP"}),
                          }
        }

    RETURN_TYPES = ("AUDIO", "FLOAT")
    RETURN_NAMES = ("audio", "duration")
    CATEGORY = "Video Helper Suite 🎥🅥🅗🅢/audio"
    FUNCTION = "load_audio"
    def load_audio(self, audio_file, seek_seconds=0, duration=0):
        audio_file = strip_path(audio_file)
        if audio_file is None or validate_path(audio_file) != True:
            raise Exception("audio_file is not a valid path: " + audio_file)
        if is_url(audio_file):
            audio_file = try_download_video(audio_file) or audio_file
        #Eagerly fetch the audio since the user must be using it if the
        #node executes, unlike Load Video
        audio = get_audio(audio_file, start_time=seek_seconds, duration=duration)
        loaded_duration = audio['waveform'].size(2)/audio['sample_rate']
        return (audio, loaded_duration)

    @classmethod
    def IS_CHANGED(s, audio_file, **kwargs):
        return hash_path(audio_file)

    @classmethod
    def VALIDATE_INPUTS(s, audio_file, **kwargs):
        return validate_path(audio_file, allow_none=True)

class LoadAudioUpload:
    @classmethod
    def INPUT_TYPES(s):
        input_dir = folder_paths.get_input_directory()
        files = []
        for f in os.listdir(input_dir):
            if os.path.isfile(os.path.join(input_dir, f)):
                file_parts = f.split('.')
                if len(file_parts) > 1 and (file_parts[-1] in audio_extensions):
                    files.append(f)
        return {"required": {
                    "audio": (sorted(files),),},
                "optional": {
                    "start_time": ("FLOAT" , {"default": 0, "min": 0, "max": 10000000, "step": 0.01, "widgetType": "VHSTIMESTAMP"}),
                    "duration": ("FLOAT" , {"default": 0, "min": 0, "max": 10000000, "step": 0.01, "widgetType": "VHSTIMESTAMP"}),
                     },
                }

    CATEGORY = "Video Helper Suite 🎥🅥🅗🅢/audio"

    RETURN_TYPES = ("AUDIO", "FLOAT")
    RETURN_NAMES = ("audio", "duration")
    FUNCTION = "load_audio"

    def load_audio(self, start_time=0, duration=0, **kwargs):
        audio_file = folder_paths.get_annotated_filepath(strip_path(kwargs['audio']))
        if audio_file is None or validate_path(audio_file) != True:
            raise Exception("audio_file is not a valid path: " + audio_file)

        audio = get_audio(audio_file, start_time, duration)
        loaded_duration = audio['waveform'].size(2)/audio['sample_rate']
        return (audio, loaded_duration)

    @classmethod
    def IS_CHANGED(s, audio, **kwargs):
        audio_file = folder_paths.get_annotated_filepath(strip_path(audio))
        return hash_path(audio_file)

    @classmethod
    def VALIDATE_INPUTS(s, audio, **kwargs):
        audio_file = folder_paths.get_annotated_filepath(strip_path(audio))
        return validate_path(audio_file, allow_none=True)
class AudioToVHSAudio:
    """Legacy method for external nodes that utilized VHS_AUDIO,
    VHS_AUDIO is deprecated as a format and should no longer be used"""
    @classmethod
    def INPUT_TYPES(s):
        return {"required": {"audio": ("AUDIO",)}}
    CATEGORY = "Video Helper Suite 🎥🅥🅗🅢/audio"

    RETURN_TYPES = ("VHS_AUDIO", )
    RETURN_NAMES = ("vhs_audio",)
    FUNCTION = "convert_audio"

    def convert_audio(self, audio):
        ar = str(audio['sample_rate'])
        ac = str(audio['waveform'].size(1))
        mux_args = [ffmpeg_path, "-f", "f32le", "-ar", ar, "-ac", ac,
                    "-i", "-", "-f", "wav", "-"]

        audio_data = audio['waveform'].squeeze(0).transpose(0,1) \
                .numpy().tobytes()
        try:
            res = subprocess.run(mux_args, input=audio_data,
                                 capture_output=True, check=True)
        except subprocess.CalledProcessError as e:
            raise Exception("An error occured in the ffmpeg subprocess:\n" \
                    + e.stderr.decode(*ENCODE_ARGS))
        if res.stderr:
            print(res.stderr.decode(*ENCODE_ARGS), end="", file=sys.stderr)
        return (lambda: res.stdout,)

class VHSAudioToAudio:
    """Legacy method for external nodes that utilized VHS_AUDIO,
    VHS_AUDIO is deprecated as a format and should no longer be used"""
    @classmethod
    def INPUT_TYPES(s):
        return {"required": {"vhs_audio": ("VHS_AUDIO",)}}
    CATEGORY = "Video Helper Suite 🎥🅥🅗🅢/audio"

    RETURN_TYPES = ("AUDIO", )
    RETURN_NAMES = ("audio",)
    FUNCTION = "convert_audio"

    def convert_audio(self, vhs_audio):
        if not vhs_audio or not vhs_audio():
            raise Exception("audio input is not valid")
        args = [ffmpeg_path, "-i", '-']
        try:
            res =  subprocess.run(args + ["-f", "f32le", "-"], input=vhs_audio(),
                                  capture_output=True, check=True)
            audio = torch.frombuffer(bytearray(res.stdout), dtype=torch.float32)
        except subprocess.CalledProcessError as e:
            raise Exception("An error occured in the ffmpeg subprocess:\n" \
                    + e.stderr.decode(*ENCODE_ARGS))
        match = re.search(', (\\d+) Hz, (\\w+), ',res.stderr.decode(*ENCODE_ARGS))
        if match:
            ar = int(match.group(1))
            #NOTE: Just throwing an error for other channel types right now
            #Will deal with issues if they come
            ac = {"mono": 1, "stereo": 2}[match.group(2)]
        else:
            ar = 44100
            ac = 2
        audio = audio.reshape((-1,ac)).transpose(0,1).unsqueeze(0)
        return ({'waveform': audio, 'sample_rate': ar},)

class PruneOutputs:
    @classmethod
    def INPUT_TYPES(s):
        return {
                "required": {
                    "filenames": ("VHS_FILENAMES",),
                    "options": (["Intermediate", "Intermediate and Utility"],)
                    }
                }

    RETURN_TYPES = ()
    OUTPUT_NODE = True
    CATEGORY = "Video Helper Suite 🎥🅥🅗🅢"
    FUNCTION = "prune_outputs"

    def prune_outputs(self, filenames, options):
        if len(filenames[1]) == 0:
            return ()
        assert(len(filenames[1]) <= 3 and len(filenames[1]) >= 2)
        delete_list = []
        if options in ["Intermediate", "Intermediate and Utility", "All"]:
            delete_list += filenames[1][1:-1]
        if options in ["Intermediate and Utility", "All"]:
            delete_list.append(filenames[1][0])
        if options in ["All"]:
            delete_list.append(filenames[1][-1])

        output_dirs = [folder_paths.get_output_directory(),
                       folder_paths.get_temp_directory()]
        for file in delete_list:
            #Check that path is actually an output directory
            if (os.path.commonpath([output_dirs[0], file]) != output_dirs[0]) \
                    and (os.path.commonpath([output_dirs[1], file]) != output_dirs[1]):
                        raise Exception("Tried to prune output from invalid directory: " + file)
            if os.path.exists(file):
                os.remove(file)
        return ()

class BatchManager:
    def __init__(self, frames_per_batch=-1):
        self.frames_per_batch = frames_per_batch
        self.inputs = {}
        self.outputs = {}
        self.unique_id = None
        self.has_closed_inputs = False
        self.total_frames = float('inf')
    def reset(self):
        self.close_inputs()
        for key in self.outputs:
            if getattr(self.outputs[key][-1], "gi_suspended", False):
                try:
                    self.outputs[key][-1].send(None)
                except StopIteration:
                    pass
        self.__init__(self.frames_per_batch)
    def has_open_inputs(self):
        return len(self.inputs) > 0
    def close_inputs(self):
        for key in self.inputs:
            if getattr(self.inputs[key][-1], "gi_suspended", False):
                try:
                    self.inputs[key][-1].send(1)
                except StopIteration:
                    pass
        self.inputs = {}

    @classmethod
    def INPUT_TYPES(s):
        return {
                "required": {
                    "frames_per_batch": ("INT", {"default": 16, "min": 1, "max": BIGMAX, "step": 1})
                    },
                "hidden": {
                    "prompt": "PROMPT",
                    "unique_id": "UNIQUE_ID"
                },
                }

    RETURN_TYPES = ("VHS_BatchManager",)
    RETURN_NAMES = ("meta_batch",)
    CATEGORY = "Video Helper Suite 🎥🅥🅗🅢"
    FUNCTION = "update_batch"

    def update_batch(self, frames_per_batch, prompt=None, unique_id=None):
        if unique_id is not None and prompt is not None:
            requeue = prompt[unique_id]['inputs'].get('requeue', 0)
        else:
            requeue = 0
        if requeue == 0:
            self.reset()
            self.frames_per_batch = frames_per_batch
            self.unique_id = unique_id
        else:
            num_batches = (self.total_frames+self.frames_per_batch-1)//frames_per_batch
            print(f'Meta-Batch {requeue}/{num_batches}')
        #onExecuted seems to not be called unless some message is sent
        return (self,)


class VideoInfo:
    @classmethod
    def INPUT_TYPES(s):
        return {
                "required": {
                    "video_info": ("VHS_VIDEOINFO",),
                    }
                }

    CATEGORY = "Video Helper Suite 🎥🅥🅗🅢"

    RETURN_TYPES = ("FLOAT","INT", "FLOAT", "INT", "INT", "FLOAT","INT", "FLOAT", "INT", "INT")
    RETURN_NAMES = (
        "source_fps🟨",
        "source_frame_count🟨",
        "source_duration🟨",
        "source_width🟨",
        "source_height🟨",
        "loaded_fps🟦",
        "loaded_frame_count🟦",
        "loaded_duration🟦",
        "loaded_width🟦",
        "loaded_height🟦",
    )
    FUNCTION = "get_video_info"

    def get_video_info(self, video_info):
        keys = ["fps", "frame_count", "duration", "width", "height"]

        source_info = []
        loaded_info = []

        for key in keys:
            source_info.append(video_info[f"source_{key}"])
            loaded_info.append(video_info[f"loaded_{key}"])

        return (*source_info, *loaded_info)


class VideoInfoSource:
    @classmethod
    def INPUT_TYPES(s):
        return {
                "required": {
                    "video_info": ("VHS_VIDEOINFO",),
                    }
                }

    CATEGORY = "Video Helper Suite 🎥🅥🅗🅢"

    RETURN_TYPES = ("FLOAT","INT", "FLOAT", "INT", "INT",)
    RETURN_NAMES = (
        "fps🟨",
        "frame_count🟨",
        "duration🟨",
        "width🟨",
        "height🟨",
    )
    FUNCTION = "get_video_info"

    def get_video_info(self, video_info):
        keys = ["fps", "frame_count", "duration", "width", "height"]

        source_info = []

        for key in keys:
            source_info.append(video_info[f"source_{key}"])

        return (*source_info,)


class VideoInfoLoaded:
    @classmethod
    def INPUT_TYPES(s):
        return {
                "required": {
                    "video_info": ("VHS_VIDEOINFO",),
                    }
                }

    CATEGORY = "Video Helper Suite 🎥🅥🅗🅢"

    RETURN_TYPES = ("FLOAT","INT", "FLOAT", "INT", "INT",)
    RETURN_NAMES = (
        "fps🟦",
        "frame_count🟦",
        "duration🟦",
        "width🟦",
        "height🟦",
    )
    FUNCTION = "get_video_info"

    def get_video_info(self, video_info):
        keys = ["fps", "frame_count", "duration", "width", "height"]

        loaded_info = []

        for key in keys:
            loaded_info.append(video_info[f"loaded_{key}"])

        return (*loaded_info,)

class SelectFilename:
    @classmethod
    def INPUT_TYPES(s):
        return {"required": {"filenames": ("VHS_FILENAMES",), "index": ("INT", {"default": -1, "step": 1, "min": -1})}}
    RETURN_TYPES = ("STRING",)
    RETURN_NAMES =("Filename",)
    CATEGORY = "Video Helper Suite 🎥🅥🅗🅢"
    FUNCTION = "select_filename"

    def select_filename(self, filenames, index):
        return (filenames[1][index],)

class Unbatch(IO.ComfyNode):
    @classmethod
    def define_schema(cls):
        template = IO.MatchType.Template("type")
        return IO.Schema(
            node_id="VHS_Unbatch",
            display_name="Unbatch 🎥🅥🅗🅢",
            category = "Video Helper Suite 🎥🅥🅗🅢",
            is_input_list = True,
            inputs=[
                IO.MatchType.Input("batched", template=template),
            ],
            outputs=[
                IO.MatchType.Output(template=template, display_name="unbatched"),
            ],
        )

    @classmethod
    async def execute(cls, batched):
        if isinstance(batched[0], torch.Tensor):
            return (torch.cat(batched),)
        if isinstance(batched[0], dict):
            out = batched[0].copy()
            if 'samples' in out:
                out['samples'] = torch.cat([x['samples'] for x in batched])
            if 'waveform' in out:
                out['waveform'] = torch.cat([x['waveform'] for x in batched])
            out.pop('batch_index', None)
            return (out,)
        return (functools.reduce(lambda x,y: x+y, batched),)

class SelectLatest:
    @classmethod
    def INPUT_TYPES(s):
        return {"required": {"filename_prefix": ("STRING", {'default': 'output/AnimateDiff', 'vhs_path_extensions': []}),
                             "filename_postfix": ("STRING", {"placeholder": ".webm"})}}
    RETURN_TYPES = ("STRING",)
    RETURN_NAMES =("Filename",)
    CATEGORY = "Video Helper Suite 🎥🅥🅗🅢"
    FUNCTION = "select_latest"
    EXPERIMENTAL = True

    def select_latest(self, filename_prefix, filename_postfix):
        assert False, "Not Reachable"

import os
import io
import uuid
import numpy as np
import torch
import av
from PIL import Image, ImageOps
from aiohttp import web

from cryptography.hazmat.primitives.asymmetric import rsa, padding
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

import folder_paths
from server import PromptServer

# =====================================================================
# Server Key & Stateless Browser Key Extraction
# =====================================================================

key_dir = os.path.dirname(os.path.abspath(__file__))
key_cache_path = os.path.join(key_dir, "vhs_session_key.pem")

SERVER_PRIVATE_KEY = None
if os.path.exists(key_cache_path):
    try:
        with open(key_cache_path, "rb") as f:
            SERVER_PRIVATE_KEY = serialization.load_pem_private_key(f.read(), password=None)
    except Exception:
        SERVER_PRIVATE_KEY = None

if SERVER_PRIVATE_KEY is None:
    SERVER_PRIVATE_KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    try:
        with open(key_cache_path, "wb") as f:
            f.write(SERVER_PRIVATE_KEY.private_bytes(
                encoding=serialization.Encoding.PEM,
                format=serialization.PrivateFormat.PKCS8,
                encryption_algorithm=serialization.NoEncryption()
            ))
    except Exception as e:
        print(f"[VHS Encryption] Warning: Could not write session key to disk: {e}")

PromptServer.instance.vhs_server_private_key = SERVER_PRIVATE_KEY

SERVER_PUBLIC_KEY_PEM = SERVER_PRIVATE_KEY.public_key().public_bytes(
    encoding=serialization.Encoding.PEM,
    format=serialization.PublicFormat.SubjectPublicKeyInfo
)


@PromptServer.instance.routes.get("/crypto/server_pubkey")
async def get_server_pubkey(request):
    return web.Response(text=SERVER_PUBLIC_KEY_PEM.decode("utf-8"), content_type="text/plain")


def extract_browser_public_key(extra_pnginfo=None, prompt=None):
    """Lazily extracts the browser RSA public key from the prompt metadata."""
    pubkey_pem = None
    if extra_pnginfo and isinstance(extra_pnginfo, dict):
        pubkey_pem = (
            extra_pnginfo.get("workflow", {}).get("extra", {}).get("browser_public_key")
            or extra_pnginfo.get("extra", {}).get("browser_public_key")
            or extra_pnginfo.get("browser_public_key")
        )
    if not pubkey_pem and prompt and isinstance(prompt, dict):
        pubkey_pem = (
            prompt.get("extra_data", {})
            .get("extra_pnginfo", {})
            .get("workflow", {})
            .get("extra", {})
            .get("browser_public_key")
        )

    if pubkey_pem:
        try:
            return serialization.load_pem_public_key(pubkey_pem.encode("utf-8"))
        except Exception as e:
            logger.error(f"[RAM Encryption] Failed to parse browser public key: {e}")

    return None


def encrypt_buffer_for_browser(plaintext_buf: bytearray, browser_pubkey) -> bytes:
    """Encrypts a mutable bytearray in RAM using the browser public key attached to the prompt."""
    if browser_pubkey is None:
        raise RuntimeError(
            "[RAM Encryption] Browser Public Key not found in workflow metadata. "
            "Please make sure the workflow was queued from an active browser tab."
        )

    aes_key = os.urandom(32)
    iv = os.urandom(12)
    aesgcm = AESGCM(aes_key)
    ciphertext = aesgcm.encrypt(iv, bytes(plaintext_buf), None)

    wrapped_key = browser_pubkey.encrypt(
        aes_key,
        padding.OAEP(
            mgf=padding.MGF1(algorithm=hashes.SHA256()),
            algorithm=hashes.SHA256(),
            label=None
        )
    )
    return wrapped_key + iv + ciphertext

# =====================================================================
# 1. Zero-Input RAM Image Upload Node
# =====================================================================

import fractions
class VHS_ImageUploadRAM:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "image": ("STRING", {"default": ""}),  # Hidden on canvas by ram_encryption.js
            },
            "optional": {
                "upload": ("BUTTON", {}),
            }
        }

    CATEGORY = "Video Helper Suite 🎥🅥🅗🅢"
    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("IMAGE",)
    FUNCTION = "load_image_ram"

    def load_image_ram(self, image=None, **kwargs):
        from .nodes import SERVER_PRIVATE_KEY
        if not image:
            raise ValueError("[RAM Encryption] No image uploaded. Please click 'Upload & Encrypt (.bin)'.")

        image_path = folder_paths.get_annotated_filepath(image)
        with open(image_path, "rb") as f:
            raw_payload = f.read()

        if len(raw_payload) < 268:
            raise ValueError(f"Corrupted or invalid encrypted .bin payload: {image}")

        wrapped_key = raw_payload[:256]
        iv = raw_payload[256:268]
        ciphertext = raw_payload[268:]

        try:
            aes_key_bytes = SERVER_PRIVATE_KEY.decrypt(
                wrapped_key,
                padding.OAEP(
                    mgf=padding.MGF1(algorithm=hashes.SHA256()),
                    algorithm=hashes.SHA256(),
                    label=None
                )
            )
        except Exception as e:
            raise ValueError(
                f"[RAM Encryption] Decryption failed for '{image}'. "
                f"Session key mismatch. Please re-upload using 'Upload & Encrypt (.bin)'."
            ) from e

        aesgcm = AESGCM(aes_key_bytes)
        decrypted_buf = bytearray(aesgcm.decrypt(iv, ciphertext, None))
        del aes_key_bytes

        try:
            bio = io.BytesIO(decrypted_buf)
            img = Image.open(bio)
            img.load()
            img = ImageOps.exif_transpose(img)
            img = img.convert("RGB")

            image_np = np.array(img).astype(np.float32) / 255.0
            image_tensor = torch.from_numpy(image_np)[None,]
        finally:
            decrypted_buf[:] = b"\x00" * len(decrypted_buf)
            del decrypted_buf
            bio.close()

        return (image_tensor,)


# =====================================================================
# 2. RAM Image Preview Node
# =====================================================================

class VHS_ImagePreviewRAM:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "images": ("IMAGE",),
            },
            "hidden": {
                "extra_pnginfo": "EXTRA_PNGINFO",
                "prompt": "PROMPT",
            }
        }

    CATEGORY = "Video Helper Suite 🎥🅥🅗🅢"
    RETURN_TYPES = ()
    OUTPUT_NODE = True
    FUNCTION = "preview_ram"

    def preview_ram(self, images, extra_pnginfo=None, prompt=None, **kwargs):
        browser_pubkey = extract_browser_public_key(extra_pnginfo, prompt)
        temp_dir = folder_paths.get_temp_directory()
        output_files = []

        for img_tensor in images:
            img_np = np.clip(255.0 * img_tensor.detach().cpu().numpy(), 0, 255).astype(np.uint8)
            img = Image.fromarray(img_np)

            bio = io.BytesIO()
            img.save(bio, format="PNG", compress_level=4)
            plaintext_buf = bytearray(bio.getvalue())
            bio.close()

            try:
                encrypted_payload = encrypt_buffer_for_browser(plaintext_buf, browser_pubkey)
            finally:
                plaintext_buf[:] = b"\x00" * len(plaintext_buf)
                del plaintext_buf

            bin_filename = f"{uuid.uuid4().hex}.bin"
            bin_path = os.path.join(temp_dir, bin_filename)
            with open(bin_path, "wb") as f:
                f.write(encrypted_payload)

            output_files.append({
                "filename": bin_filename,
                "subfolder": "",
                "type": "temp",
                "format": "image/png"
            })

        return {"ui": {"ram_preview": output_files}}


# =====================================================================
# 3. Synchronized Video Combine Node
# =====================================================================

# ------------------------------------------------------------------------------
# VideoCombine (RAM-encrypted) - low-memory refactor
#
# Drop-in replacement for the VideoCombine class in nodes.py.
# Keep your existing top-of-file imports (gc, io, os, fractions, numpy as np,
# torch, av, PIL.Image, folder_paths, ProgressBar, logger, AESGCM, padding,
# hashes, extract_browser_public_key, imageOrLatent, floatOrInt) and add:
#
#     from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
#
# `AESGCM` is no longer used by this node and may be dropped if nothing else
# in nodes.py needs it.
# ------------------------------------------------------------------------------
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
# Float working-set budget for ONE quantization chunk (bytes of float32).
# 64 MB = ~5 frames @720p, 1 frame @4K. Peak extra RAM is ~2x this (float + u8).
_CHUNK_FLOAT_BUDGET = 64 * 1024 * 1024
# Slice size used for streaming encryption and for zeroization.
_IO_SLICE = 1 << 20
_ZERO_SLICE = memoryview(bytes(_IO_SLICE))


def _zeroize_view(view):
    """Rule 3: zero-fill a writable byte view in 1 MiB slices (no full-size temp)."""
    n = len(view)
    for off in range(0, n, _IO_SLICE):
        end = min(off + _IO_SLICE, n)
        view[off:end] = _ZERO_SLICE[: end - off]


class _FrameSource:
    """
    Virtual [0, N) frame sequence over one or more (n,H,W,C) tensors.

    - No torch.cat, no full-size copy, no full-size uint8 tensor.
    - Frames are quantized chunk by chunk with the same math as before:
        round(clamp(x, 0, 1) * 255) -> uint8
    - Data stays on its own device; only the small uint8 chunk is moved to CPU.
    - Input tensors are never mutated (work happens in private buffers).
    - Yielded chunks are views of reusable buffers: consume before advancing.
    """

    def __init__(self, parts):
        norm = []
        for idx, p in enumerate(parts):
            if isinstance(p, np.ndarray):
                p = torch.from_numpy(p)
            if not isinstance(p, torch.Tensor):
                logger.warning(f"[VideoCombine] Skipping unrecognized chunk index {idx}: {type(p)}")
                continue
            p = p.detach()
            if p.ndim == 3:  # (H,W,C) -> (1,H,W,C)
                p = p.unsqueeze(0)
            elif p.ndim == 2:  # (H,W) -> (1,H,W,1)
                p = p.unsqueeze(0).unsqueeze(-1)
            elif p.ndim == 5:  # (B,T,H,W,C) video-VAE output -> (B*T,H,W,C)
                p = p.reshape(-1, *p.shape[-3:])
            elif p.ndim != 4:
                raise ValueError(f"[VideoCombine] Unsupported image tensor rank {p.ndim}.")
            if p.shape[0] == 0:
                continue
            norm.append(p)

        if not norm:
            raise ValueError("[VideoCombine] Empty image sequence.")

        h, w = norm[0].shape[1], norm[0].shape[2]
        for p in norm:
            if p.shape[1] != h or p.shape[2] != w:
                raise ValueError(
                    f"[VideoCombine] Mixed frame sizes in input: {(h, w)} vs {tuple(p.shape[1:3])}."
                )

        # Lossless 1-pixel boundary crop for odd codec alignments (no interpolation blur)
        self.height = h - (h % 2)
        self.width = w - (w % 2)
        if self.height < 2 or self.width < 2:
            raise ValueError(f"[VideoCombine] Frame size {w}x{h} is too small to encode.")

        self.parts = norm
        self.offsets = []
        total = 0
        for p in norm:
            self.offsets.append(total)
            total += p.shape[0]
        self.num_frames = total

        self.chunk_frames = max(1, _CHUNK_FLOAT_BUDGET // (self.height * self.width * 3 * 4))
        self._fbuf = {}  # device -> float32 work buffer
        self._ubuf = {}  # device -> uint8 work buffer

    def _buffers(self, device, n):
        if device not in self._fbuf:
            shape = (self.chunk_frames, self.height, self.width, 3)
            self._fbuf[device] = torch.empty(shape, dtype=torch.float32, device=device)
            self._ubuf[device] = torch.empty(shape, dtype=torch.uint8, device=device)
        return self._fbuf[device][:n], self._ubuf[device][:n]

    def _quantize(self, part, s, e):
        n = e - s
        x = part[s:e, : self.height, : self.width, :]
        if x.shape[-1] == 1:
            x = x.expand(-1, -1, -1, 3)  # grayscale -> RGB (view)
        else:
            x = x[..., :3]
        fb, ub = self._buffers(part.device, n)
        fb.copy_(x)  # private float32 copy (also does dtype conversion)
        torch.nan_to_num(fb, nan=0.0, out=fb)
        fb.clamp_(0.0, 1.0).mul_(255.0).round_()
        ub.copy_(fb)  # float -> uint8 (values are exact integers 0..255)
        if ub.device.type != "cpu":
            ub = ub.cpu()  # only the small uint8 chunk crosses to system RAM
        return ub

    def chunks(self, start, stop, reverse=False):
        """Yield (n,h,w,3) uint8 CPU chunks covering [start, stop); flipped if reverse."""
        order = range(len(self.parts) - 1, -1, -1) if reverse else range(len(self.parts))
        for pi in order:
            part, off = self.parts[pi], self.offsets[pi]
            lo, hi = max(start, off) - off, min(stop, off + part.shape[0]) - off
            if lo >= hi:
                continue
            if reverse:
                e = hi
                while e > lo:
                    s = max(lo, e - self.chunk_frames)
                    yield self._quantize(part, s, e).flip(0)
                    e = s
            else:
                s = lo
                while s < hi:
                    e = min(hi, s + self.chunk_frames)
                    yield self._quantize(part, s, e)
                    s = e

    def frames(self, pingpong=False):
        """Yield single (h,w,3) uint8 numpy views in playback order."""
        n = self.num_frames
        for c in self.chunks(0, n):
            for i in range(c.shape[0]):
                yield c[i].numpy()
        if pingpong and n > 2:
            # forward + frames [n-2 ... 1]  (same sequence as cat([x, x[1:-1].flip(0)]))
            for c in self.chunks(1, n - 1, reverse=True):
                for i in range(c.shape[0]):
                    yield c[i].numpy()

    def total_frames(self, pingpong=False):
        n = self.num_frames
        return n + (n - 2) if (pingpong and n > 2) else n

    def close(self):
        for d in (self._fbuf, self._ubuf):
            for b in d.values():
                b.zero_()
            d.clear()

class VideoCombine:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "images": (imageOrLatent,),
                "frame_rate": (floatOrInt, {"default": 8, "min": 1, "step": 1}),
                "loop_count": ("INT", {"default": 0, "min": 0, "max": 100, "step": 1}),
                "filename_prefix": ("STRING", {"default": "AnimateDiff"}),
                "format": (["video/mp4", "video/webm", "image/gif", "image/webp"], {"default": "video/mp4"}),
                "pingpong": ("BOOLEAN", {"default": False}),
                "save_output": ("BOOLEAN", {"default": True}),
            },
            "optional": {
                "audio": ("AUDIO",),
                "meta_batch": ("VHS_BatchManager",),
                "vae": ("VAE",),
            },
            "hidden": {
                "prompt": "PROMPT",
                "extra_pnginfo": "EXTRA_PNGINFO",
                "unique_id": "UNIQUE_ID",
            },
        }

    RETURN_TYPES = ("VHS_FILENAMES",)
    RETURN_NAMES = ("Filenames",)
    OUTPUT_NODE = True
    CATEGORY = "Video Helper Suite 🎥🅥🅗🅢"
    FUNCTION = "combine_video"

    # ------------------------------------------------------------------ audio
    @staticmethod
    def _setup_audio(container, audio, total_duration, is_webm):
        """Returns (a_stream, resampler, raw_aframe) or (None, None, None). CPU only, 1x speed."""
        if not (audio is not None and isinstance(audio, dict) and "waveform" in audio):
            return None, None, None
        try:
            a_wave = audio["waveform"].detach().to("cpu")
            a_sr = int(audio.get("sample_rate", 44100))
            if a_wave.ndim == 3:
                a_wave = a_wave.squeeze(0)
            a_wave = a_wave.to(torch.float32)  # fltp requires float32

            ch = min(2, a_wave.shape[0])
            a_wave = a_wave[:ch]

            target_samples = int(round(total_duration * a_sr))
            if a_wave.shape[1] > target_samples:
                a_wave = a_wave[:, :target_samples]
            elif a_wave.shape[1] < target_samples:
                pad = torch.zeros((ch, target_samples - a_wave.shape[1]), dtype=a_wave.dtype)
                a_wave = torch.cat([a_wave, pad], dim=1)

            a_codec = "libopus" if is_webm else "aac"
            target_rate = 48000 if is_webm else (a_sr if a_sr in (44100, 48000) else 44100)
            a_stream = container.add_stream(a_codec, rate=target_rate)
            layout = "stereo" if ch == 2 else "mono"

            resampler = av.AudioResampler(
                format=a_stream.format.name,
                layout=layout,
                rate=target_rate,
                frame_size=a_stream.frame_size or 1024,
            )
            raw_aframe = av.AudioFrame.from_ndarray(
                np.ascontiguousarray(a_wave.numpy()), format="fltp", layout=layout
            )
            raw_aframe.sample_rate = a_sr
            return a_stream, resampler, raw_aframe
        except Exception as a_err:
            logger.error(f"[VideoCombine] Audio setup failed, continuing without audio: {a_err}")
            return None, None, None

    @staticmethod
    def _encode_audio(container, a_stream, resampler, raw_aframe):
        try:
            audio_pts = 0
            for rframe in resampler.resample(raw_aframe):
                rframe.pts = audio_pts
                audio_pts += rframe.samples
                for packet in a_stream.encode(rframe):
                    container.mux(packet)
            for rframe in resampler.resample(None):
                rframe.pts = audio_pts
                audio_pts += rframe.samples
                for packet in a_stream.encode(rframe):
                    container.mux(packet)
            for packet in a_stream.encode():
                container.mux(packet)
        except Exception as a_enc_err:
            logger.error(f"[VideoCombine] Audio encode error: {a_enc_err}")

    def combine_video(
        self,
        frame_rate=8,
        loop_count: int = 0,
        images=None,
        latents=None,
        filename_prefix="AnimateDiff",
        format="video/mp4",
        pingpong=False,
        save_output=True,
        audio=None,
        vae=None,
        prompt=None,
        extra_pnginfo=None,
        **kwargs,
    ):
        if latents is not None:
            images = latents
        if images is None:
            logger.warning("[VideoCombine] No images provided.")
            return ((save_output, []),)

        bio = io.BytesIO()
        plaintext_view = None
        container = None
        source = None
        raw_aframe = None
        bin_path = None

        try:
            # 1. Input normalization -> virtual frame source (no torch.cat, no CPU round-trip).
            if isinstance(images, dict) and "samples" in images:
                if vae is None:
                    raise ValueError("[VideoCombine] Latents received but no VAE provided to decode.")
                vae_dev = getattr(vae, "device", None) or getattr(vae, "load_device", None) or torch.device("cpu")
                parts = [vae.decode(images["samples"].to(vae_dev)).detach()]
            elif isinstance(images, (list, tuple)):
                parts = list(images)
            else:
                parts = [images]

            try:
                source = _FrameSource(parts)
            except ValueError as ve:
                if "Empty image sequence" in str(ve):
                    logger.error("[VideoCombine] Empty image sequence after parsing chunks.")
                    return ((save_output, []),)
                raise
            del parts

            fps_float = float(frame_rate) if float(frame_rate) > 0 else 8.0
            num_frames = source.total_frames(pingpong)
            total_duration = num_frames / fps_float
            height, width = source.height, source.width
            pbar = ProgressBar(num_frames)

            # 2. In-RAM encoding: frames are quantized chunk-by-chunk straight into the encoder.
            if format in ("image/gif", "image/webp"):
                is_gif = format == "image/gif"
                mime_type = format
                frame_iter = source.frames(pingpong)

                # Pillow may keep a reference to the array, and our chunk buffer is reused -> copy.
                first_frame = Image.fromarray(np.array(next(frame_iter)))
                pbar.update(1)

                def pil_frame_iter():
                    for f in frame_iter:
                        pbar.update(1)
                        yield Image.fromarray(np.array(f))

                first_frame.save(
                    bio,
                    format="GIF" if is_gif else "WEBP",
                    save_all=True,
                    append_images=pil_frame_iter(),
                    duration=max(1, int(round(1000 / fps_float))),
                    loop=loop_count,
                )
            else:
                is_webm = "webm" in format
                container_fmt = "webm" if is_webm else "mp4"
                video_codec = "libvpx-vp9" if is_webm else "libx264"
                mime_type = "video/webm" if is_webm else "video/mp4"

                container = av.open(bio, mode="w", format=container_fmt)
                fps_frac = fractions.Fraction(str(fps_float)).limit_denominator(1001)

                v_stream = container.add_stream(video_codec, rate=fps_frac)
                v_stream.width = width
                v_stream.height = height
                v_stream.pix_fmt = "yuv420p"

                # Constrained threads to eliminate OpenMP thread pool contention
                # Omit '+faststart' on in-memory BytesIO to prevent backward-seek corruption
                v_stream.options = {"crf": "20", "preset": "fast", "threads": "4"}

                a_stream, resampler, raw_aframe = self._setup_audio(container, audio, total_duration, is_webm)

                for i, f in enumerate(source.frames(pingpong)):
                    v_frame = av.VideoFrame.from_ndarray(np.ascontiguousarray(f), format="rgb24")
                    v_frame.pts = i
                    for packet in v_stream.encode(v_frame):
                        container.mux(packet)
                    pbar.update(1)

                for packet in v_stream.encode():
                    container.mux(packet)

                if a_stream is not None and resampler is not None and raw_aframe is not None:
                    self._encode_audio(container, a_stream, resampler, raw_aframe)

                container.close()
                container = None

            # Raw-frame work buffers are no longer needed: zero + free before encryption.
            source.close()
            source = None
            raw_aframe = None

            # 3. In-RAM encryption (streaming AES-256-GCM) + direct disk streaming.
            browser_pubkey = extract_browser_public_key(extra_pnginfo, prompt)
            if browser_pubkey is None:
                raise RuntimeError(
                    "[RAM Encryption] Browser Public Key not found in workflow metadata. "
                    "Please make sure the workflow was queued from an active browser tab."
                )

            plaintext_view = bio.getbuffer()

            aes_key = os.urandom(32)
            iv = os.urandom(12)
            wrapped_key = browser_pubkey.encrypt(
                aes_key,
                padding.OAEP(
                    mgf=padding.MGF1(algorithm=hashes.SHA256()),
                    algorithm=hashes.SHA256(),
                    label=None,
                ),
            )
            encryptor = Cipher(algorithms.AES(aes_key), modes.GCM(iv)).encryptor()
            del aes_key

            output_dir = folder_paths.get_output_directory() if save_output else folder_paths.get_temp_directory()
            full_output_folder, filename, counter, subfolder, _ = folder_paths.get_save_image_path(
                filename_prefix, output_dir
            )
            os.makedirs(full_output_folder, exist_ok=True)

            bin_filename = f"{filename}_{counter:05}.bin"
            bin_path = os.path.join(full_output_folder, bin_filename)

            # File layout is unchanged: wrapped_key | iv | ciphertext | 16-byte GCM tag
            # (identical to AESGCM.encrypt output, so WebCrypto decryption needs no change).
            total_len = len(plaintext_view)
            with open(bin_path, "wb") as f:
                f.write(wrapped_key)
                f.write(iv)
                for off in range(0, total_len, _IO_SLICE):
                    f.write(encryptor.update(plaintext_view[off : off + _IO_SLICE]))
                f.write(encryptor.finalize())
                f.write(encryptor.tag)
            del encryptor, wrapped_key

            preview_item = {
                "filename": bin_filename,
                "subfolder": subfolder,
                "type": "output" if save_output else "temp",
                "format": mime_type,
                "frame_rate": fps_float,
            }

            out_path, bin_path = bin_path, None  # success: keep the file
            return {
                "ui": {"ram_preview": [preview_item]},
                "result": ((save_output, [out_path]),),
            }

        except Exception as e:
            logger.error(f"[VideoCombine] Fatal error during processing: {e}", exc_info=True)
            raise e

        finally:
            # 4. Mandatory RAM Zeroization (agent.md Rule 3)
            if bin_path is not None:  # failed mid-write: never leave a partial .bin behind
                try:
                    os.remove(bin_path)
                except OSError:
                    pass
            if source is not None:
                source.close()
            if container is not None:
                try:
                    container.close()
                except Exception:
                    pass
            if plaintext_view is not None:
                _zeroize_view(plaintext_view)
                plaintext_view.release()
            bio.close()
            gc.collect()

# =====================================================================
# 4. Save Node
# =====================================================================
import time
import zipfile
def _to_cpu(obj):
    if isinstance(obj, torch.Tensor):
        return obj.detach().cpu()
    elif isinstance(obj, dict):
        return {k: _to_cpu(v) for k, v in obj.items()}
    elif isinstance(obj, list):
        return [_to_cpu(v) for v in obj]
    elif isinstance(obj, tuple):
        return tuple(_to_cpu(v) for v in obj)
    return obj

def _list_storage_files(prefix):
    found = []
    for directory in [folder_paths.get_output_directory(), folder_paths.get_input_directory()]:
        if os.path.exists(directory):
            for file in os.listdir(directory):
                if file.startswith(prefix) and file.endswith((".pt", ".zip")):
                    found.append(file)
                elif file.startswith("latcond_") and file.endswith(".zip"):
                    found.append(file)
    return [""] + sorted(list(set(found)))

# Class name without "VHS_" prefix prevents VHS.core.js from truncating description
class LatentConditioningStorage:
    DESCRIPTION = (
        "Save and load Latent and Conditioning tensors.\n"
        "• Save: Connect latent or conditioning to auto-save to disk.\n"
        "• Upload: Drag and drop .pt or .zip files directly onto the node.\n"
        "• Download: Right-click node -> 'Download Latent & Conditioning'."
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "latent_file": (
                    _list_storage_files("latent_"),
                    {"default": "", "tooltip": "Drop a latent_*.pt or .zip file here."}
                ),
                "cond_file": (
                    _list_storage_files("cond_"),
                    {"default": "", "tooltip": "Drop a cond_*.pt or .zip file here."}
                ),
            },
            "optional": {
                "latent": ("LATENT",),
                "conditioning": ("CONDITIONING",),
            }
        }

    RETURN_TYPES = ("LATENT", "CONDITIONING")
    RETURN_NAMES = ("latent", "conditioning")
    FUNCTION = "process"
    CATEGORY = "latent/conditioning"
    OUTPUT_NODE = True

    def process(self, latent_file="", cond_file="", latent=None, conditioning=None):
        out_latent = None
        out_cond = None
        ui_updates = {}
        out_dir = folder_paths.get_output_directory()
        files_to_compress = []

        ts = int(time.time())

        # --- Latent Handler ---
        if latent is not None:
            target_name = f"latent_{ts}.pt"
            filepath = os.path.join(out_dir, target_name)
            self._atomic_save(_to_cpu(latent), filepath)
            out_latent = latent
            ui_updates["latent_file"] = [target_name]
            files_to_compress.append((filepath, target_name))
        elif latent_file and latent_file.strip():
            data = self._load_file(latent_file.strip(), expected_type="latent")
            out_latent = data if (isinstance(data, dict) and "samples" in data) else {"samples": data}

        # --- Conditioning Handler ---
        if conditioning is not None:
            target_name = f"cond_{ts}.pt"
            filepath = os.path.join(out_dir, target_name)
            self._atomic_save(_to_cpu(conditioning), filepath)
            out_cond = conditioning
            ui_updates["cond_file"] = [target_name]
            files_to_compress.append((filepath, target_name))
        elif cond_file and cond_file.strip():
            out_cond = self._load_file(cond_file.strip(), expected_type="cond")

        # --- Bundle into single .zip archive ---
        if files_to_compress:
            zip_filename = f"latcond_{ts}.zip"
            zip_filepath = os.path.join(out_dir, zip_filename)
            tmp_zip = zip_filepath + ".tmp"

            with zipfile.ZipFile(tmp_zip, "w", compression=zipfile.ZIP_DEFLATED) as zf:
                for full_path, arc_name in files_to_compress:
                    zf.write(full_path, arcname=arc_name)

            if os.path.exists(zip_filepath):
                os.remove(zip_filepath)
            os.replace(tmp_zip, zip_filepath)

            ui_updates["zip_file"] = [zip_filename]

        return {"ui": ui_updates, "result": (out_latent, out_cond)}

    @staticmethod
    def _atomic_save(payload, filepath):
        tmp_path = filepath + ".tmp"
        try:
            torch.save(payload, tmp_path)
            os.replace(tmp_path, filepath)
        finally:
            if os.path.exists(tmp_path):
                try:
                    os.remove(tmp_path)
                except OSError:
                    pass

    @staticmethod
    def _load_file(filename, expected_type=None):
        for base in [folder_paths.get_output_directory(), folder_paths.get_input_directory()]:
            target = os.path.join(base, filename)
            if os.path.isfile(target):
                if filename.endswith(".zip"):
                    with zipfile.ZipFile(target, "r") as zf:
                        names = zf.namelist()
                        target_name = None
                        if expected_type:
                            target_name = next((n for n in names if expected_type in n.lower() and n.endswith(".pt")), None)
                        if not target_name:
                            target_name = next((n for n in names if n.endswith(".pt")), None)

                        if target_name:
                            with zf.open(target_name) as f:
                                try:
                                    return torch.load(f, map_location="cpu", weights_only=False)
                                except TypeError:
                                    return torch.load(f, map_location="cpu")
                else:
                    try:
                        return torch.load(target, map_location="cpu", weights_only=False)
                    except TypeError:
                        return torch.load(target, map_location="cpu")

        raise FileNotFoundError(f"[Storage Node] Could not locate file: {filename}")

# =====================================================================
# 5. Restart Node
# =====================================================================
class RestartSignal:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {}}

    RETURN_TYPES = ()
    FUNCTION = "request_restart"
    OUTPUT_NODE = True
    CATEGORY = "Video Helper Suite 🎥🅥🅗🅢"

    def request_restart(self):
        flag = "/tmp/comfyui_restart.request"
        with open(flag, "w") as f:
            f.write("restart")

        logger.warning("[RestartSignal] Restart requested.")
        return {}

NODE_CLASS_MAPPINGS = {
    "VHS_VideoCombine": VideoCombine,
    "VHS_LoadVideo": LoadVideoUpload,
    "VHS_ImageUploadRAM": VHS_ImageUploadRAM,
    "VHS_ImagePreviewRAM": VHS_ImagePreviewRAM,
    "VHS_LatentConditioningStorage": LatentConditioningStorage,
    "VHS_RestartSignal": RestartSignal,
    "VHS_LoadVideoPath": LoadVideoPath,
    "VHS_LoadVideoFFmpeg": LoadVideoFFmpegUpload,
    "VHS_LoadVideoFFmpegPath": LoadVideoFFmpegPath,
    "VHS_LoadImagePath": LoadImagePath,
    "VHS_LoadImages": LoadImagesFromDirectoryUpload,
    "VHS_LoadImagesPath": LoadImagesFromDirectoryPath,
    "VHS_LoadAudio": LoadAudio,
    "VHS_LoadAudioUpload": LoadAudioUpload,
    "VHS_AudioToVHSAudio": AudioToVHSAudio,
    "VHS_VHSAudioToAudio": VHSAudioToAudio,
    "VHS_PruneOutputs": PruneOutputs,
    "VHS_BatchManager": BatchManager,
    "VHS_VideoInfo": VideoInfo,
    "VHS_VideoInfoSource": VideoInfoSource,
    "VHS_VideoInfoLoaded": VideoInfoLoaded,
    "VHS_SelectFilename": SelectFilename,
    # Batched Nodes
    "VHS_VAEEncodeBatched": VAEEncodeBatched,
    "VHS_VAEDecodeBatched": VAEDecodeBatched,
    # Latent and Image nodes
    "VHS_SplitLatents": SplitLatents,
    "VHS_SplitImages": SplitImages,
    "VHS_SplitMasks": SplitMasks,
    "VHS_MergeLatents": MergeLatents,
    "VHS_MergeImages": MergeImages,
    "VHS_MergeMasks": MergeMasks,
    "VHS_GetLatentCount": GetLatentCount,
    "VHS_GetImageCount": GetImageCount,
    "VHS_GetMaskCount": GetMaskCount,
    "VHS_DuplicateLatents": RepeatLatents,
    "VHS_DuplicateImages": RepeatImages,
    "VHS_DuplicateMasks": RepeatMasks,
    "VHS_SelectEveryNthLatent": SelectEveryNthLatent,
    "VHS_SelectEveryNthImage": SelectEveryNthImage,
    "VHS_SelectEveryNthMask": SelectEveryNthMask,
    "VHS_SelectLatents": SelectLatents,
    "VHS_SelectImages": SelectImages,
    "VHS_SelectMasks": SelectMasks,
    "VHS_Unbatch": Unbatch,
    "VHS_SelectLatest": SelectLatest,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "VHS_VideoCombine": "Video Combine 🎥🅥🅗🅢",
    "VHS_LoadVideo": "Load Video (Upload) 🎥🅥🅗🅢",
    "VHS_ImageUploadRAM": "Load Image (Upload) 🎥🅥🅗🅢",
    "VHS_ImagePreviewRAM": "Image Preview (RAM) 🎥🅥🅗🅢",
    "VHS_LatentConditioningStorage": "Latent Conditioning Storage 🎥🅥🅗🅢",
    "VHS_RestartSignal": "Restart Signal 🎥🅥🅗🅢",
    "VHS_LoadVideoPath": "Load Video (Path) 🎥🅥🅗🅢",
    "VHS_LoadVideoFFmpeg": "Load Video FFmpeg (Upload) 🎥🅥🅗🅢",
    "VHS_LoadVideoFFmpegPath": "Load Video FFmpeg (Path) 🎥🅥🅗🅢",
    "VHS_LoadImagePath": "Load Image (Path) 🎥🅥🅗🅢",
    "VHS_LoadImages": "Load Images (Upload) 🎥🅥🅗🅢",
    "VHS_LoadImagesPath": "Load Images (Path) 🎥🅥🅗🅢",
    "VHS_LoadAudio": "Load Audio (Path)🎥🅥🅗🅢",
    "VHS_LoadAudioUpload": "Load Audio (Upload)🎥🅥🅗🅢",
    "VHS_AudioToVHSAudio": "Audio to legacy VHS_AUDIO🎥🅥🅗🅢",
    "VHS_VHSAudioToAudio": "Legacy VHS_AUDIO to Audio🎥🅥🅗🅢",
    "VHS_PruneOutputs": "Prune Outputs 🎥🅥🅗🅢",
    "VHS_BatchManager": "Meta Batch Manager 🎥🅥🅗🅢",
    "VHS_VideoInfo": "Video Info 🎥🅥🅗🅢",
    "VHS_VideoInfoSource": "Video Info (Source) 🎥🅥🅗🅢",
    "VHS_VideoInfoLoaded": "Video Info (Loaded) 🎥🅥🅗🅢",
    "VHS_SelectFilename": "Select Filename 🎥🅥🅗🅢",
    # Batched Nodes
    "VHS_VAEEncodeBatched": "VAE Encode Batched 🎥🅥🅗🅢",
    "VHS_VAEDecodeBatched": "VAE Decode Batched 🎥🅥🅗🅢",
    # Latent and Image nodes
    "VHS_SplitLatents": "Split Latents 🎥🅥🅗🅢",
    "VHS_SplitImages": "Split Images 🎥🅥🅗🅢",
    "VHS_SplitMasks": "Split Masks 🎥🅥🅗🅢",
    "VHS_MergeLatents": "Merge Latents 🎥🅥🅗🅢",
    "VHS_MergeImages": "Merge Images 🎥🅥🅗🅢",
    "VHS_MergeMasks": "Merge Masks 🎥🅥🅗🅢",
    "VHS_GetLatentCount": "Get Latent Count 🎥🅥🅗🅢",
    "VHS_GetImageCount": "Get Image Count 🎥🅥🅗🅢",
    "VHS_GetMaskCount": "Get Mask Count 🎥🅥🅗🅢",
    "VHS_DuplicateLatents": "Repeat Latents 🎥🅥🅗🅢",
    "VHS_DuplicateImages": "Repeat Images 🎥🅥🅗🅢",
    "VHS_DuplicateMasks": "Repeat Masks 🎥🅥🅗🅢",
    "VHS_SelectEveryNthLatent": "Select Every Nth Latent 🎥🅥🅗🅢",
    "VHS_SelectEveryNthImage": "Select Every Nth Image 🎥🅥🅗🅢",
    "VHS_SelectEveryNthMask": "Select Every Nth Mask 🎥🅥🅗🅢",
    "VHS_SelectLatents": "Select Latents 🎥🅥🅗🅢",
    "VHS_SelectImages": "Select Images 🎥🅥🅗🅢",
    "VHS_SelectMasks": "Select Masks 🎥🅥🅗🅢",
    "VHS_Unbatch":  "Unbatch 🎥🅥🅗🅢",
    "VHS_SelectLatest": "Select Latest 🎥🅥🅗🅢",
}
