# CLIPS

App local para convertir un vídeo, o un enlace de YouTube, Twitch o Kick, en clips verticales listos para TikTok y Reels.

Detecta la cámara, separa juego y streamer, elige los mejores momentos o parte el vídeo, y también puede exportar el vídeo completo. Los subtítulos, la frase de arriba y la descripción salen de lo que se escucha.

Sitio: [dannyelian.github.io/clips-app](https://dannyelian.github.io/clips-app/)

## Qué hace

- Recortes en 9:16, pantalla completa o dos vídeos apilados
- Calidad hasta 4K, sin inventar resolución que el origen no tiene
- Subtítulos con estilo (frase, barra o palabra resaltada), color, tamaño y posición
- Frase y descripción escritas en este equipo con Ollama
- Herramientas por clip: transcribir, traducir, títulos, descripción, silencios, miniatura y chat
- El enlace descargado queda guardado para no bajarlo otra vez

## Requisitos

- Node.js 18+
- ffmpeg y ffprobe
- PostgreSQL (base `clips`)
- Python 3.11, con Pillow, faster-whisper y yt-dlp
- [Ollama](https://ollama.com) con el modelo `llama3.2`, para títulos y descripciones

## Arranque

```bash
cp .env.example .env
npm install
./servidor.sh on
```

Abre http://localhost:8787

`./servidor.sh off` apaga CLIPS y Ollama. `./servidor.sh state` dice si están encendidos.

Las claves de TikTok y la base van solo en `.env`. Ese archivo no se sube.
