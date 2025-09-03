# 🎵 Hookshot

**Automatically find and extract the catchiest part of any song for social media**

Hookshot uses advanced audio analysis to identify the "hook" in your tracks and creates perfectly-timed vertical videos for TikTok, Instagram Reels, and YouTube Shorts. No more guessing where the best part starts – let the algorithm find it for you.

![Demo](https://img.shields.io/badge/demo-video-blue) ![License](https://img.shields.io/badge/license-Apache--2.0-green)
 ![Node](https://img.shields.io/badge/node-%3E%3D14-brightgreen)

## ✨ Features

- **Intelligent Hook Detection**: Multi-feature audio analysis combining energy, spectral centroid, zero-crossing rate, and novelty detection  
- **Genre-Optimized**: Pre-tuned settings for pop, hip-hop, electronic, rock, and acoustic music  
- **Fast Processing**: Unified feature extraction processes a 3-minute track in under 200ms  
- **Visual Feedback**: See what the algorithm detects with Unicode sparkline visualizations  
- **Flexible Output**: Customizable duration, titles, QR codes, and backgrounds  

## 🚀 Quick Start

```powershell
# Run directly with Node.js
node src/index.js --in song.mp3 --out output.mp4 --title "My Track" --subtitle "@artist"

# Use genre-specific detection
node src/index.js --in track.mp3 --genre electronic --duration 15
```

## 📦 Installation

### Prerequisites
- Node.js 14+  
- FFmpeg (automatically installed via `@ffmpeg-installer/ffmpeg`)  

### From Source
```powershell
git clone https://github.com/yourusername/hookshot.git
cd hookshot
npm install
```

*(You can also use `npm link` if you want the global `hookshot` command, but it’s optional.)*

## 🎯 Usage

### Basic Usage
```powershell
node src/index.js --in input.mp3

# Choose detection method
node src/index.js --in song.mp3 --method energy    # energy/novelty
node src/index.js --in song.mp3 --method chorus    # repetition/chorus
node src/index.js --in song.mp3 --method auto      # default: compares and picks

```

### Advanced Options
```powershell
node src/index.js `
  --in song.mp3 `
  --out tiktok.mp4 `
  --duration 15 `
  --genre hiphop `
  --title "New Heat 🔥" `
  --subtitle "@producer · Out Now" `
  --bg background.jpg `
  --qr https://link.to/song
```

### Command Line Options

| Option | Alias | Default | Description |
|--------|-------|---------|-------------|
| `--in` | `-i` | *required* | Input audio file (mp3/wav) |
| `--out` | `-o` | `hookshot.mp4` | Output video path |
| `--duration` | `-d` | `17` | Clip duration in seconds |
| `--genre` | | `hiphop` | Detection preset: `pop`, `hiphop`, `electronic`, `rock`, `acoustic` |
| `--title` | | | Main title text |
| `--subtitle` | | | Subtitle text (artist info, etc) |
| `--bg` | | | Background image path |
| `--qr` | | | URL to encode as QR code |
| `--font` | | Inter Bold | Path to TTF font file |
| `--method` | | `auto` | energy, chorus, or auto (compare normalized scores) |

### Method
- `energy`: weighted mix of energy, spectral centroid, ZCR, and novelty.
- `chorus`: chroma self-similarity to detect repeated sections (chorus).
- `auto` (default): runs both, min-max normalizes each method’s window scores, then picks the higher normalized score (slight bias toward `chorus` for repeated hooks).

## 🧠 How It Works

Hookshot uses a sophisticated multi-feature analysis to identify hooks:

1. **Unified Feature Extraction**  
   - **RMS Energy**: Overall loudness and intensity  
   - **Spectral Centroid**: "Brightness" of the sound  
   - **Zero-Crossing Rate**: Detects percussive/rhythmic content  
   - **Spectral Flux**: Identifies sudden changes and onsets  
   - **Novelty Score**: Measures dramatic entrances  

2. **Intelligent Scoring**  
   Each feature is normalized and weighted based on genre:  

   ```javascript
   hiphop: { energy: 0.4, centroid: 0.2, zcr: 0.25, novelty: 0.15 }
   electronic: { energy: 0.25, centroid: 0.25, zcr: 0.2, novelty: 0.3 }
   ```

3. **Hook Selection**  
   The algorithm slides a window across the track, scoring each position, with an “entrance bonus” for dramatic changes.

## 📊 Performance

Testing on a Modern Laptop with a 3-minute MP3:

| Operation | Time | Memory |
|-----------|------|--------|
| WAV Conversion | ~450ms | 12MB |
| Feature Extraction (old) | ~800ms | 48MB |
| **Feature Extraction (unified)** | **~200ms** | **32MB** |
| Video Rendering | ~3–5s | 95MB |

The unified extraction provides a 75% speedup by computing all features in a single pass through the audio data.

