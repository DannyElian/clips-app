<p align="center">
  <img src="docs/app-icon.png" width="88" alt="Icono de CLIPS" />
</p>

<h1 align="center">CLIPS</h1>

<p align="center">
  De un vídeo largo a piezas verticales para TikTok y Reels.<br />
  El archivo no sale del equipo: el recorte, los subtítulos y el texto se hacen en local.
</p>

<p align="center">
  <a href="https://dannyelian.github.io/clips-app/">Sitio</a>
  &nbsp;·&nbsp;
  <a href="https://github.com/DannyElian/clips-app/releases/tag/v1.0.0">Código en zip</a>
</p>

---

CLIPS abre un archivo o un enlace de YouTube, Twitch o Kick, encuentra los tramos que merecen un clip y los exporta en 9:16. También puede devolver el vídeo completo, con la misma cámara, la misma calidad y los mismos subtítulos.

La frase de arriba y la descripción salen de lo que se oye. No hay un texto genérico reutilizado en todos los clips.

## Para qué sirve

| | |
| --- | --- |
| Origen | Un archivo, o un enlace. Se puede apilar un segundo vídeo. |
| Encuadre | Cámara arriba y juego abajo, pantalla completa, o dos vídeos. La cara se detecta sola. |
| Corte | Mejores momentos, partes iguales, o el vídeo entero en un solo archivo. |
| Imagen | 360p a 4K. Si el origen no da esa resolución, no se inventan píxeles. |
| Subtítulos | Frase con contorno, barra de color o palabra resaltada. Color, tamaño y posición. |
| Texto | Frase, título y descripción a partir del audio, con un modelo local. |
| Después | Transcribir, traducir, títulos, silencios, miniatura y chat sobre el clip ya exportado. |
| Publicar | El clip se puede mandar a TikTok desde la app, con la cuenta del usuario. |

Un enlace que ya se descargó queda guardado. La siguiente vez, los clips salen de esa copia y de la transcripción que ya existe.

## Cómo está hecho

El servidor es Node.js y Express. ffmpeg recorta y compone; el texto se dibuja con Python y Pillow porque este ffmpeg no trae filtro de texto. La transcripción es faster-whisper. PostgreSQL guarda transcripciones, títulos y el índice de enlaces. Ollama, en esta máquina, escribe la frase, los títulos y la descripción.

Nada de esto se ejecuta en el sitio público. [dannyelian.github.io/clips-app](https://dannyelian.github.io/clips-app/) es la ficha del producto. La app corre en `localhost`.

## Arranque

Hace falta Node.js 18 o superior, ffmpeg, ffprobe, PostgreSQL, Python 3.11 y [Ollama](https://ollama.com) con el modelo `llama3.2`.

En Python: Pillow, faster-whisper y yt-dlp.

```bash
cp .env.example .env
npm install
./servidor.sh on
```

Abre [http://localhost:8787](http://localhost:8787).

| Comando | Qué hace |
| --- | --- |
| `./servidor.sh on` | Postgres, Ollama y CLIPS. Siguen encendidos al cerrar la terminal. |
| `./servidor.sh off` | Apaga CLIPS y Ollama. Postgres se queda, es la base del Mac. |
| `./servidor.sh state` | Dice cuál de los tres está caído. |

La base, el modelo y las claves de TikTok van en `.env`. Ese archivo no está en el repositorio. La plantilla es `.env.example`.

## Qué hay en el repo

```
public/     interfaz
src/        servidor, colas, descarga y herramientas
scripts/    transcripción, subtítulos y miniaturas
docs/       sitio público
servidor.sh encendido y apagado
```

Los vídeos, las exportaciones y la base quedan en `data/`, fuera de git.
