# Alpuca — Media & Video Tools Reference

> **Machine:** Mac mini M4 ("Alpuca") — replaced the old Almaca
> **OS:** macOS 26 (Tahoe)
> **LAN IP:** 192.168.1.200 | **Tailscale:** 100.74.59.97

---

## Connecting

### Prerequisites
- You must be connected to the **Alpaca Playhouse WiFi/LAN** or **Tailscale**
- SSH key auth is configured; password in Bitwarden if needed

### SSH Connection
```bash
ssh paca@192.168.1.200          # LAN
ssh paca@100.74.59.97           # Tailscale
```

### First-Time Setup (run once after connecting)
The SSH PATH doesn't include Homebrew by default. Run this once:
```bash
echo 'export PATH="/opt/homebrew/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
```

After this, all tools below will be available by name (e.g., `ffmpeg` instead of `/usr/local/bin/ffmpeg`).

### If PATH isn't set yet
Prefix commands with the full path:
```bash
/usr/local/bin/ffmpeg -version
```

---

## Verified Installed Tools

### FFmpeg 8.1
Full-featured video/audio encoder, decoder, transcoder, and stream processor.

```bash
# Check version
ffmpeg -version

# Transcode video to H.264 MP4 (web-friendly)
ffmpeg -i input.mov -c:v libx264 -crf 23 -c:a aac -b:a 128k output.mp4

# Extract audio from video
ffmpeg -i video.mp4 -vn -c:a libmp3lame -q:a 2 audio.mp3

# Create a thumbnail from video
ffmpeg -i video.mp4 -ss 00:00:05 -frames:v 1 thumbnail.jpg

# Trim video (no re-encode, fast)
ffmpeg -i input.mp4 -ss 00:01:00 -to 00:02:30 -c copy trimmed.mp4

# Resize video to 1080p
ffmpeg -i input.mp4 -vf scale=1920:1080 -c:a copy output_1080p.mp4

# Convert image sequence to video
ffmpeg -framerate 30 -i frame_%04d.png -c:v libx264 -pix_fmt yuv420p output.mp4

# Add text overlay / watermark
ffmpeg -i input.mp4 -vf "drawtext=text='Alpaca Playhouse':fontsize=24:fontcolor=white:x=10:y=10" output.mp4

# Concatenate videos (create list.txt with lines like: file 'clip1.mp4')
ffmpeg -f concat -safe 0 -i list.txt -c copy merged.mp4

# Generate waveform image from audio
ffmpeg -i audio.mp3 -filter_complex "showwavespic=s=1920x200:colors=blue" waveform.png

# Extract frames at 1fps (for timelapse / analysis)
ffmpeg -i video.mp4 -vf fps=1 frames/frame_%04d.jpg
```

### FFprobe 8.1 (bundled with FFmpeg)
Inspect media file metadata without processing.

```bash
# Show all metadata as JSON
ffprobe -v quiet -print_format json -show_format -show_streams input.mp4

# Quick summary (duration, size, bitrate)
ffprobe -v error -show_entries format=duration,size,bit_rate -of default=noprint_wrappers=1 input.mp4

# Get video resolution
ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=s=x:p=0 input.mp4
```

### Blender 4.5.7 LTS
3D modeling, rendering, and Video Sequence Editor. Can be used headlessly from CLI.

```bash
# Path (always use full path — not on default PATH)
/usr/local/bin/blender

# Check version
/usr/local/bin/blender --version

# Render a .blend project to PNG frames
/usr/local/bin/blender -b project.blend -o //output/frame_#### -F PNG -a

# Render specific frame range
/usr/local/bin/blender -b project.blend -s 1 -e 250 -a

# Run a Python script in Blender
/usr/local/bin/blender -b --python script.py
```

**Blender add-ons available** (in `~/Downloads/blender-addons/`):
- Bonsai (BlenderBIM) — architectural drafting, IFC export
- BlenderGIS — GIS data import, terrain, satellite imagery
- CAD Sketcher — parametric 2D sketching
- Archipack — parametric walls, fences, roofs

### ImageMagick 7.x
Image processing from the command line. Installed via Homebrew.

> **Note:** After install, `magick` may need `brew link imagemagick` to appear on PATH. If `magick` isn't found, use the full Cellar path: `$(brew --prefix imagemagick)/bin/magick`

```bash
# Resize image
magick input.jpg -resize 1920x1080 output.jpg

# Convert format
magick input.png output.jpg

# Create contact sheet / montage
magick montage *.jpg -geometry 200x200+5+5 -tile 4x contact_sheet.jpg

# Add text to image
magick input.jpg -pointsize 36 -fill white -annotate +10+40 "Alpaca Playhouse" output.jpg

# Batch resize
for f in *.jpg; do magick "$f" -resize 50% "resized_$f"; done
```

### yt-dlp
Download video/audio from YouTube and 1000+ sites. Installed as standalone binary.

```bash
# Download best quality video+audio
yt-dlp "https://youtube.com/watch?v=VIDEO_ID"

# Download audio only (MP3)
yt-dlp -x --audio-format mp3 "https://youtube.com/watch?v=VIDEO_ID"

# List available formats
yt-dlp -F "URL"

# Download specific format codes
yt-dlp -f 137+140 "URL"

# Download with subtitles
yt-dlp --write-subs --sub-lang en "URL"

# Download playlist
yt-dlp -o "%(playlist_index)s-%(title)s.%(ext)s" "PLAYLIST_URL"
```

---

## Also Installed (CAD/GIS)

These are primarily for property/construction work but may be useful:

| Tool | Version | Purpose |
|------|---------|---------|
| QGIS | 4.0.0 | GIS mapping, parcel data, print layouts |
| LibreCAD | 2.x | 2D CAD drafting (DXF format) |
| GDAL/OGR | 3.12.0 | Geospatial format conversion (bundled with QGIS) |

---

## Common Workflows

### Property Walkthrough Video
```bash
# 1. Transfer video from phone/camera to Mac (AirDrop or USB)
# 2. Trim to relevant section
ffmpeg -i raw_walkthrough.mov -ss 00:00:10 -to 00:05:00 -c copy trimmed.mp4
# 3. Add property watermark
ffmpeg -i trimmed.mp4 -vf "drawtext=text='160 Still Forest Dr':fontsize=20:fontcolor=white:x=w-tw-10:y=h-th-10" final.mp4
# 4. Generate thumbnail
ffmpeg -i final.mp4 -ss 00:00:03 -frames:v 1 thumbnail.jpg
```

### Timelapse from Photos
```bash
ffmpeg -framerate 24 -i IMG_%04d.jpg -c:v libx264 -pix_fmt yuv420p timelapse.mp4
```

### Audio Extraction for Transcription
```bash
ffmpeg -i meeting.mp4 -vn -ar 16000 -ac 1 -c:a pcm_s16le meeting.wav
```

### Download and Process YouTube Video
```bash
# Download
yt-dlp -o "%(title)s.%(ext)s" "URL"
# Convert to MP4 if needed
ffmpeg -i "downloaded.webm" -c:v libx264 -c:a aac output.mp4
```

---

## File Locations

| Purpose | Path |
|---------|------|
| Working directory | `~/Desktop` or `~/Movies` |
| Blender projects | `~/Documents/blender/` |
| Downloads | `~/Downloads/` |
| Blender add-ons | `~/Downloads/blender-addons/` |

## Troubleshooting

| Problem | Solution |
|---------|----------|
| `ffmpeg: command not found` | Run `export PATH="/usr/local/bin:$PATH"` or use full path `/usr/local/bin/ffmpeg` |
| `magick: command not found` | Run `brew link imagemagick` or use `$(brew --prefix imagemagick)/bin/magick` |
| `yt-dlp: command not found` | Use full path `/usr/local/bin/yt-dlp` |
| Can't connect via SSH | Verify you're on Alpaca Playhouse WiFi/LAN or Tailscale. Alpuca is at 192.168.1.200 (LAN) or 100.74.59.97 (Tailscale) |
| Need to update tools | Run `brew upgrade ffmpeg imagemagick` (yt-dlp: `yt-dlp -U`) |
| Need GUI access (Blender UI) | Use Chrome Remote Desktop — PIN is in the password vault |
