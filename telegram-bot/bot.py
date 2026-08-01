#!/usr/bin/env python3
"""AI Studio Telegram Bot — image generation, animation, video & image editing."""

import asyncio
import base64
import io
import logging
import os
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Optional

import httpx
from telegram import BotCommand, InputFile, Update
from telegram.constants import ChatAction, ParseMode
from telegram.ext import (
    Application,
    CommandHandler,
    ContextTypes,
    MessageHandler,
    filters,
)

logging.basicConfig(
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    level=logging.INFO,
)
log = logging.getLogger(__name__)

BOT_TOKEN = os.environ["BOT_TOKEN"]
PORT = int(os.environ.get("PORT", 8080))
REPLICATE_BASE = "https://api.replicate.com/v1"

user_keys: dict[int, str] = {}
pending_photo: dict[int, str] = {}


# ─── Health-check server (keeps Railway happy) ────────────────────────────────

class _HealthHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"OK")

    def log_message(self, *args):
        pass  # silence access logs


def _start_health_server():
    server = HTTPServer(("0.0.0.0", PORT), _HealthHandler)
    log.info("Health server listening on port %d", PORT)
    server.serve_forever()


# ─── Key helpers ───────────────────────────────────────────────────────────────────

def get_key(uid: int) -> Optional[str]:
    return user_keys.get(uid)


def need_key_msg() -> str:
    return (
        "First save your Replicate API key:\n"
        "`/setkey r8\_yourkey`\n"
        "Get one free at replicate\.com/account/api\-tokens"
    )


# ─── Replicate API ────────────────────────────────────────────────────────────

async def replicate_create(model: str, input_data: dict, api_key: str) -> dict:
    versioned = ":" in model
    url = (
        f"{REPLICATE_BASE}/predictions"
        if versioned
        else f"{REPLICATE_BASE}/models/{model}/predictions"
    )
    body = (
        {"version": model.split(":")[1], "input": input_data}
        if versioned
        else {"input": input_data}
    )
    async with httpx.AsyncClient(timeout=60) as client:
        r = await client.post(
            url,
            json=body,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
                "Prefer": "wait=30",
            },
        )
        if not r.is_success:
            try:
                detail = r.json().get("detail", r.text)
            except Exception:
                detail = r.text
            raise RuntimeError(f"Replicate {r.status_code}: {detail}")
        pred = r.json()

    if pred["status"] == "succeeded":
        return pred
    if pred["status"] == "failed":
        raise RuntimeError(pred.get("error") or "Generation failed")
    return await _poll(pred["id"], api_key)


async def _poll(pred_id: str, api_key: str, timeout: int = 360) -> dict:
    deadline = asyncio.get_event_loop().time() + timeout
    async with httpx.AsyncClient(timeout=30) as client:
        while asyncio.get_event_loop().time() < deadline:
            await asyncio.sleep(3)
            r = await client.get(
                f"{REPLICATE_BASE}/predictions/{pred_id}",
                headers={"Authorization": f"Bearer {api_key}"},
            )
            if not r.is_success:
                continue
            pred = r.json()
            if pred["status"] == "succeeded":
                return pred
            if pred["status"] == "failed":
                raise RuntimeError(pred.get("error") or "Generation failed")
    raise TimeoutError("Generation timed out — please try again")


def first_output(pred: dict) -> Optional[str]:
    out = pred.get("output")
    return out[0] if isinstance(out, list) else out


async def fetch_bytes(url: str) -> bytes:
    async with httpx.AsyncClient(timeout=120, follow_redirects=True) as client:
        r = await client.get(url)
        r.raise_for_status()
        return r.content


async def tg_photo_to_b64(file_id: str, bot) -> str:
    f = await bot.get_file(file_id)
    buf = io.BytesIO()
    await f.download_to_memory(buf)
    b64 = base64.b64encode(buf.getvalue()).decode()
    return f"data:image/jpeg;base64,{b64}"


# ─── /start ──────────────────────────────────────────────────────────────────

async def cmd_start(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    await update.message.reply_text(
        "*AI Studio Bot*\n\n"
        "Generate images, animations, and videos with AI.\n\n"
        "*Quick start:*\n"
        "1. Get a free API key at replicate.com\n"
        "2. /setkey r8\_yourkey\n"
        "3. /imagine a glowing cyberpunk city at night\n\n"
        "Type /help to see all commands.",
        parse_mode=ParseMode.MARKDOWN,
    )


# ─── /help ──────────────────────────────────────────────────────────────────

async def cmd_help(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    await update.message.reply_text(
        "*AI Studio Commands*\n\n"
        "*Setup*\n"
        "/setkey r8\_xxx - save your Replicate key\n\n"
        "*Generate from text*\n"
        "/imagine <prompt> - square image\n"
        "/imagine16 <prompt> - 16:9 landscape\n"
        "/imagine9 <prompt> - 9:16 portrait\n"
        "/video <prompt> - video clip\n\n"
        "*Edit a photo* (send a photo first, then the command)\n"
        "/animate - animate it\n"
        "/upscale - upscale 4x\n"
        "/removebg - remove background\n"
        "/restore - restore & enhance faces\n"
        "/repaint <instruction> - repaint with AI",
        parse_mode=ParseMode.MARKDOWN,
    )


# ─── /setkey ────────────────────────────────────────────────────────────────

async def cmd_setkey(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    uid = update.effective_user.id
    if not ctx.args:
        await update.message.reply_text(
            "Usage: `/setkey r8_yourreplicatekey`",
            parse_mode=ParseMode.MARKDOWN,
        )
        return
    key = ctx.args[0].strip()
    if not key.startswith("r8_"):
        await update.message.reply_text(
            "That doesn't look like a Replicate key - it should start with `r8_`.",
            parse_mode=ParseMode.MARKDOWN,
        )
        return
    user_keys[uid] = key
    await update.message.reply_text(
        "Key saved! Try `/imagine a sunrise over the mountains`.",
        parse_mode=ParseMode.MARKDOWN,
    )


# ─── /imagine ────────────────────────────────────────────────────────────────

async def cmd_imagine(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    uid = update.effective_user.id
    key = get_key(uid)
    if not key:
        await update.message.reply_text(need_key_msg(), parse_mode=ParseMode.MARKDOWN)
        return
    prompt = " ".join(ctx.args).strip()
    if not prompt:
        await update.message.reply_text(
            "Usage: `/imagine a hyper-realistic warrior portrait`",
            parse_mode=ParseMode.MARKDOWN,
        )
        return
    cmd_name = update.message.text.split()[0].lstrip("/").lower()
    aspect = "16:9" if "16" in cmd_name else ("9:16" if "9" in cmd_name else "1:1")

    msg = await update.message.reply_text(f"Generating {aspect} image...")
    await update.effective_chat.send_action(ChatAction.UPLOAD_PHOTO)
    try:
        pred = await replicate_create(
            "black-forest-labs/flux-schnell",
            {
                "prompt": prompt,
                "aspect_ratio": aspect,
                "num_inference_steps": 4,
                "output_format": "webp",
                "output_quality": 90,
            },
            key,
        )
        url = first_output(pred)
        if not url:
            raise ValueError("No output URL returned")
        data = await fetch_bytes(url)
        await msg.delete()
        await update.message.reply_photo(
            photo=InputFile(io.BytesIO(data), filename="image.webp"),
            caption=prompt[:900],
        )
    except Exception as e:
        log.exception("imagine failed")
        await msg.edit_text(f"Error: {e}")


# ─── Photo handler ────────────────────────────────────────────────────────────

async def handle_photo(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    uid = update.effective_user.id
    pending_photo[uid] = update.message.photo[-1].file_id
    await update.message.reply_text(
        "Photo received! Now use:\n"
        "/animate - bring it to life\n"
        "/upscale - sharpen & enlarge 4x\n"
        "/removebg - remove background\n"
        "/restore - restore & enhance faces\n"
        "/repaint <instruction> - repaint with AI"
    )


# ─── /animate ────────────────────────────────────────────────────────────────

async def cmd_animate(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    uid = update.effective_user.id
    key = get_key(uid)
    if not key:
        await update.message.reply_text(need_key_msg(), parse_mode=ParseMode.MARKDOWN)
        return
    file_id = pending_photo.get(uid)
    if not file_id:
        await update.message.reply_text("Send a photo first, then use /animate.")
        return
    msg = await update.message.reply_text("Animating... this takes 1-3 minutes")
    await update.effective_chat.send_action(ChatAction.UPLOAD_VIDEO)
    try:
        img = await tg_photo_to_b64(file_id, ctx.bot)
        pred = await replicate_create(
            "stability-ai/stable-video-diffusion",
            {
                "input_image": img,
                "motion_bucket_id": 127,
                "fps_id": 12,
                "num_frames": 25,
                "decoding_t": 7,
                "output_format": "mp4",
            },
            key,
        )
        url = first_output(pred)
        if not url:
            raise ValueError("No output returned")
        data = await fetch_bytes(url)
        await msg.delete()
        await update.message.reply_video(
            video=InputFile(io.BytesIO(data), filename="animation.mp4"),
            caption="Animation complete!",
        )
    except Exception as e:
        log.exception("animate failed")
        await msg.edit_text(f"Error: {e}")


# ─── /video ──────────────────────────────────────────────────────────────────

async def cmd_video(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    uid = update.effective_user.id
    key = get_key(uid)
    if not key:
        await update.message.reply_text(need_key_msg(), parse_mode=ParseMode.MARKDOWN)
        return
    prompt = " ".join(ctx.args).strip()
    if not prompt:
        await update.message.reply_text("Usage: /video an eagle soaring over mountains")
        return
    msg = await update.message.reply_text("Generating video... this takes 2-5 minutes")
    await update.effective_chat.send_action(ChatAction.UPLOAD_VIDEO)
    try:
        pred = await replicate_create(
            "minimax/video-01",
            {"prompt": prompt, "prompt_optimizer": True},
            key,
        )
        url = first_output(pred)
        if not url:
            raise ValueError("No output URL returned")
        data = await fetch_bytes(url)
        await msg.delete()
        await update.message.reply_video(
            video=InputFile(io.BytesIO(data), filename="video.mp4"),
            caption=prompt[:900],
        )
    except Exception as e:
        log.exception("video failed")
        await msg.edit_text(f"Error: {e}")


# ─── /upscale ────────────────────────────────────────────────────────────────

async def cmd_upscale(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    uid = update.effective_user.id
    key = get_key(uid)
    if not key:
        await update.message.reply_text(need_key_msg(), parse_mode=ParseMode.MARKDOWN)
        return
    file_id = pending_photo.get(uid)
    if not file_id:
        await update.message.reply_text("Send a photo first, then use /upscale.")
        return
    msg = await update.message.reply_text("Upscaling 4x...")
    await update.effective_chat.send_action(ChatAction.UPLOAD_PHOTO)
    try:
        img = await tg_photo_to_b64(file_id, ctx.bot)
        pred = await replicate_create(
            "nightmareai/real-esrgan:f121d640bd286e1fdc67f9799164c1d5be36ff74576ee11c803ae5b665dd46aa",
            {"image": img, "scale": 4, "face_enhance": False},
            key,
        )
        url = first_output(pred)
        if not url:
            raise ValueError("No output returned")
        data = await fetch_bytes(url)
        await msg.delete()
        await update.message.reply_photo(
            photo=InputFile(io.BytesIO(data), filename="upscaled.png"),
            caption="Upscaled 4x",
        )
    except Exception as e:
        log.exception("upscale failed")
        await msg.edit_text(f"Error: {e}")


# ─── /removebg ───────────────────────────────────────────────────────────────

async def cmd_removebg(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    uid = update.effective_user.id
    key = get_key(uid)
    if not key:
        await update.message.reply_text(need_key_msg(), parse_mode=ParseMode.MARKDOWN)
        return
    file_id = pending_photo.get(uid)
    if not file_id:
        await update.message.reply_text("Send a photo first, then use /removebg.")
        return
    msg = await update.message.reply_text("Removing background...")
    await update.effective_chat.send_action(ChatAction.UPLOAD_DOCUMENT)
    try:
        img = await tg_photo_to_b64(file_id, ctx.bot)
        pred = await replicate_create(
            "cjwbw/rembg:fb8af171cfa1616ddcf1242c093f9c46bcada5ad4cf6f2fbe8b81b330ec5c003",
            {"image": img},
            key,
        )
        url = first_output(pred)
        if not url:
            raise ValueError("No output returned")
        data = await fetch_bytes(url)
        await msg.delete()
        await update.message.reply_document(
            document=InputFile(io.BytesIO(data), filename="no-background.png"),
            caption="Background removed - PNG with transparency",
        )
    except Exception as e:
        log.exception("removebg failed")
        await msg.edit_text(f"Error: {e}")


# ─── /restore ────────────────────────────────────────────────────────────────

async def cmd_restore(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    uid = update.effective_user.id
    key = get_key(uid)
    if not key:
        await update.message.reply_text(need_key_msg(), parse_mode=ParseMode.MARKDOWN)
        return
    file_id = pending_photo.get(uid)
    if not file_id:
        await update.message.reply_text("Send a photo first, then use /restore.")
        return
    msg = await update.message.reply_text("Restoring & enhancing...")
    await update.effective_chat.send_action(ChatAction.UPLOAD_PHOTO)
    try:
        img = await tg_photo_to_b64(file_id, ctx.bot)
        pred = await replicate_create(
            "tencentarc/gfpgan:0fbacf7afc6998f1c4b3d2b771e69eb58c1741c0fd3c4db4bdb58090be8c7516",
            {"img": img, "version": "v1.4", "scale": 2},
            key,
        )
        url = first_output(pred)
        if not url:
            raise ValueError("No output returned")
        data = await fetch_bytes(url)
        await msg.delete()
        await update.message.reply_photo(
            photo=InputFile(io.BytesIO(data), filename="restored.png"),
            caption="Restored & enhanced",
        )
    except Exception as e:
        log.exception("restore failed")
        await msg.edit_text(f"Error: {e}")


# ─── /repaint ────────────────────────────────────────────────────────────────

async def cmd_repaint(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    uid = update.effective_user.id
    key = get_key(uid)
    if not key:
        await update.message.reply_text(need_key_msg(), parse_mode=ParseMode.MARKDOWN)
        return
    instruction = " ".join(ctx.args).strip()
    if not instruction:
        await update.message.reply_text(
            "Usage: /repaint replace the background with a sunny beach"
        )
        return
    file_id = pending_photo.get(uid)
    if not file_id:
        await update.message.reply_text("Send a photo first, then use /repaint <instruction>.")
        return
    msg = await update.message.reply_text("Repainting...")
    await update.effective_chat.send_action(ChatAction.UPLOAD_PHOTO)
    try:
        img = await tg_photo_to_b64(file_id, ctx.bot)
        pred = await replicate_create(
            "stability-ai/stable-diffusion-inpainting:95b7223104132402a9ae91cc677285bc5eb997834bd2349fa486f53910fd68b3",
            {
                "image": img,
                "prompt": instruction,
                "num_inference_steps": 25,
                "guidance_scale": 7.5,
            },
            key,
        )
        url = first_output(pred)
        if not url:
            raise ValueError("No output returned")
        data = await fetch_bytes(url)
        await msg.delete()
        await update.message.reply_photo(
            photo=InputFile(io.BytesIO(data), filename="repainted.png"),
            caption=instruction[:900],
        )
    except Exception as e:
        log.exception("repaint failed")
        await msg.edit_text(f"Error: {e}")


# ─── Bot setup ────────────────────────────────────────────────────────────────

async def post_init(app: Application) -> None:
    await app.bot.set_my_commands([
        BotCommand("start",     "Welcome & quick start"),
        BotCommand("help",      "All commands"),
        BotCommand("setkey",    "Save your Replicate API key"),
        BotCommand("imagine",   "Text to image (square)"),
        BotCommand("imagine16", "Text to image (16:9)"),
        BotCommand("imagine9",  "Text to image (9:16)"),
        BotCommand("video",     "Text to video clip"),
        BotCommand("animate",   "Photo to animation"),
        BotCommand("upscale",   "Photo upscaled 4x"),
        BotCommand("removebg",  "Photo with background removed"),
        BotCommand("restore",   "Photo with face restoration"),
        BotCommand("repaint",   "Photo repainted with AI"),
    ])


def main() -> None:
    # Railway (and similar platforms) require something bound to $PORT.
    # We run a tiny health-check server in a background thread so the
    # platform is happy, while the bot itself uses long-polling.
    threading.Thread(target=_start_health_server, daemon=True).start()

    app = (
        Application.builder()
        .token(BOT_TOKEN)
        .post_init(post_init)
        .build()
    )

    app.add_handler(CommandHandler("start",                        cmd_start))
    app.add_handler(CommandHandler("help",                         cmd_help))
    app.add_handler(CommandHandler("setkey",                       cmd_setkey))
    app.add_handler(CommandHandler(["imagine", "imagine16",
                                    "imagine9"],                    cmd_imagine))
    app.add_handler(CommandHandler("video",                        cmd_video))
    app.add_handler(CommandHandler("animate",                      cmd_animate))
    app.add_handler(CommandHandler("upscale",                      cmd_upscale))
    app.add_handler(CommandHandler("removebg",                     cmd_removebg))
    app.add_handler(CommandHandler("restore",                      cmd_restore))
    app.add_handler(CommandHandler("repaint",                      cmd_repaint))
    app.add_handler(MessageHandler(filters.PHOTO,                  handle_photo))

    log.info("Bot polling...")
    app.run_polling(allowed_updates=["message"])


if __name__ == "__main__":
    main()
