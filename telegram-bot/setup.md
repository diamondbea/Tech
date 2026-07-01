# AI Studio — Telegram Bot Setup

## 1. Create your bot

1. Open Telegram and message [@BotFather](https://t.me/BotFather)
2. Send `/newbot` and follow the prompts
3. Copy the bot token you receive

## 2. Install dependencies

```bash
cd telegram-bot
python -m venv venv
source venv/bin/activate   # Windows: venv\Scripts\activate
pip install -r requirements.txt
```

## 3. Configure

```bash
cp .env.example .env
# Edit .env and paste your BOT_TOKEN
```

## 4. Run

```bash
export $(cat .env | xargs)
python bot.py
```

The bot is now live. Message it on Telegram.

---

## Using the bot

1. Send `/setkey r8_yourreplicatekey` — get a free key at [replicate.com](https://replicate.com/account/api-tokens)
2. Generate images: `/imagine a glowing cyberpunk city at night`
3. Send any photo, then use `/animate`, `/upscale`, `/removebg`, `/restore`, or `/repaint <instruction>`
4. Generate video: `/video an eagle soaring over mountains at golden hour`

## Commands reference

| Command | What it does | Model used |
|---|---|---|
| `/imagine <prompt>` | Text → square image | FLUX Schnell |
| `/imagine16 <prompt>` | Text → 16:9 landscape | FLUX Schnell |
| `/imagine9 <prompt>` | Text → 9:16 portrait | FLUX Schnell |
| `/video <prompt>` | Text → video clip | MiniMax Video-01 |
| `/animate` | Photo → animation | Stable Video Diffusion |
| `/upscale` | Photo → 4× upscale | Real-ESRGAN |
| `/removebg` | Photo → transparent BG | rembg |
| `/restore` | Photo → face restoration | GFPGAN |
| `/repaint <text>` | Photo → AI repaint | SD Inpainting |

## Deploy to a server (optional)

To keep the bot running 24/7, run it on any VPS with `screen`, `tmux`, or `systemd`:

```bash
# systemd example
sudo nano /etc/systemd/system/aistudio-bot.service
```

```ini
[Unit]
Description=AI Studio Telegram Bot
After=network.target

[Service]
WorkingDirectory=/path/to/telegram-bot
EnvironmentFile=/path/to/telegram-bot/.env
ExecStart=/path/to/venv/bin/python bot.py
Restart=always

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now aistudio-bot
```
