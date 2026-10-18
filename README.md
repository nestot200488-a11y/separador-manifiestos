# Procesador y Separador de Manifiestos PDF

Aplicación web para la división dinámica de páginas de manifiestos PDF, reconocimiento óptico de caracteres (OCR) y descarga empaquetada en formato `.ZIP`.

Diseñada para despliegue en la nube en **Render.com** o ejecución local.

## Características
- **División Dinámica**: Procesa cualquier cantidad de páginas de forma automática (1 página = 1 archivo PDF independiente).
- **Motor OCR**: Reconocimiento de texto en imágenes y escaneos mediante Tesseract OCR con modelo en español (`spa`).
- **Extracción de Razón Social**: Búsqueda exacta de la frase `RAZON SOCIAL DE LA EMPRESA GENERADORA:` hasta antes de `DOMICILIO:`.
- **Nomenclatura Estricta**: `[Razón_Social]_[Consecutivo].pdf` o `EMPRESA_NO_DETECTADA_[Consecutivo].pdf`.
- **Almacenamiento en Memoria / Nube**: No guarda archivos en disco; procesa todo en memoria (Buffers) y genera un único paquete `.ZIP` listo para descargar con un solo clic.

## Despliegue en Render.com
1. Crea un nuevo **Web Service** en Render conectado a este repositorio.
2. Configuración:
   - **Environment**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Environment Variables**: `NODE_VERSION` = `20`
