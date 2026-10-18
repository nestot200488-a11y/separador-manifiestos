import express from 'express';
import multer from 'multer';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import https from 'https';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { PDFDocument } from 'pdf-lib';
import * as mupdf from 'mupdf';
import { createWorker } from 'tesseract.js';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const archiver = require('archiver');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// 4. PUERTO DE RED DINÁMICO para Render.com y entornos locales
const PORT = process.env.PORT || 3000;

// Directorio para caché de lenguaje OCR
const TESSDATA_DIR = path.join(__dirname, 'tessdata');
const TESSDATA_FILE = path.join(TESSDATA_DIR, 'spa.traineddata.gz');

/**
 * Asegura la existencia del modelo de idioma en memoria/disco local del contenedor
 */
async function ensureTessData() {
  if (fs.existsSync(TESSDATA_FILE)) {
    return true;
  }
  console.log('[OCR] Descargando modelo de lenguaje español para el entorno en la nube...');
  if (!fs.existsSync(TESSDATA_DIR)) {
    fs.mkdirSync(TESSDATA_DIR, { recursive: true });
  }

  return new Promise((resolve) => {
    const fileStream = fs.createWriteStream(TESSDATA_FILE);
    const url = 'https://raw.githubusercontent.com/naptha/tessdata/gh-pages/4.0.0/spa.traineddata.gz';
    
    https.get(url, (res) => {
      res.pipe(fileStream);
      fileStream.on('finish', () => {
        fileStream.close();
        console.log('[OCR] Modelo descargado con éxito.');
        resolve(true);
      });
    }).on('error', (err) => {
      console.warn('[OCR] No se pudo pre-descargar el modelo, se usará la descarga nativa de Tesseract:', err.message);
      if (fs.existsSync(TESSDATA_FILE)) fs.unlinkSync(TESSDATA_FILE);
      resolve(false);
    });
  });
}

// Configuración de Multer: Exclusivamente archivos .pdf almacenados en memoria (Buffer)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }, // Hasta 100MB
  fileFilter: (req, file, cb) => {
    const isPdfExt = path.extname(file.originalname).toLowerCase() === '.pdf';
    const isPdfMime = file.mimetype === 'application/pdf' || file.mimetype === 'application/x-pdf';
    if (isPdfExt || isPdfMime) {
      cb(null, true);
    } else {
      cb(new Error('Solo se permiten archivos con formato .pdf'));
    }
  }
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Almacén en memoria para los paquetes ZIP generados (expiran a los 30 min para proteger la RAM)
const zipStorage = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [id, item] of zipStorage.entries()) {
    if (now - item.timestamp > 30 * 60 * 1000) {
      zipStorage.delete(id);
    }
  }
}, 5 * 60 * 1000);

/**
 * Función de extracción y limpieza de Razón Social
 */
function extractAndCleanRazonSocial(rawText) {
  if (!rawText) return null;

  const text = rawText.replace(/\r?\n+/g, ' ');
  const regex = /RAZ[OÓ]N\s+SOCIAL\s+DE\s+LA\s+EMPRESA\s+GENERADORA\s*:\s*(.*?)\s*DOMICILIO\s*:/i;
  const match = text.match(regex);

  if (!match || !match[1]) {
    return null;
  }

  let extracted = match[1].trim();
  // Limpiar espacios dobles
  extracted = extracted.replace(/\s{2,}/g, ' ');
  // Eliminar caracteres prohibidos en nombres de archivos
  extracted = extracted.replace(/[\\/:*?"<>|]/g, '');
  extracted = extracted.trim();

  return extracted.length > 0 ? extracted : null;
}

/**
 * Empaqueta un array de archivos en memoria (Buffer) dentro de un único archivo ZIP en memoria
 */
function createZipInMemory(files) {
  return new Promise((resolve, reject) => {
    let archive;
    const options = { zlib: { level: 9 } };

    if (archiver.ZipArchive) {
      archive = new archiver.ZipArchive(options);
    } else if (typeof archiver === 'function') {
      archive = archiver('zip', options);
    } else if (archiver.default && typeof archiver.default === 'function') {
      archive = archiver.default('zip', options);
    } else {
      return reject(new Error('No se pudo inicializar la librería de compresión ZIP.'));
    }

    const chunks = [];

    archive.on('data', (chunk) => chunks.push(chunk));
    archive.on('end', () => resolve(Buffer.concat(chunks)));
    archive.on('error', (err) => reject(err));

    for (const file of files) {
      archive.append(file.buffer, { name: file.fileName });
    }

    archive.finalize();
  });
}

/**
 * Endpoint principal de procesamiento
 */
app.post('/api/process-manifest', upload.single('manifestPdf'), async (req, res) => {
  try {
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ error: 'No se ha cargado ningún archivo PDF válido.' });
    }

    const pdfBuffer = req.file.buffer;

    // 1. PROCESAMIENTO DINÁMICO: Contar activamente las páginas del PDF cargado
    const mainPdfDoc = await PDFDocument.load(pdfBuffer);
    const totalPages = mainPdfDoc.getPageCount();

    if (totalPages === 0) {
      return res.status(400).json({ error: 'El archivo PDF no contiene páginas detectables.' });
    }

    console.log(`[Procesamiento] Iniciando procesamiento dinámico de ${totalPages} páginas en memoria...`);

    // Inicializar MuPDF para renderizado de páginas
    const muDoc = mupdf.Document.openDocument(pdfBuffer, 'application/pdf');

    // Inicializar Tesseract con configuración de modelo
    const hasLocalModel = fs.existsSync(TESSDATA_FILE);
    const workerOptions = hasLocalModel
      ? { langPath: TESSDATA_DIR, cacheMethod: 'none', gzip: true }
      : {};

    const worker = await createWorker('spa', 1, workerOptions);

    // 2. ENTREGA DE ARCHIVOS EN LA NUBE: Guardar temporalmente en memoria interna (Buffer)
    const filesInMemory = [];

    for (let pageIndex = 0; pageIndex < totalPages; pageIndex++) {
      const consecutiveNumber = pageIndex + 1; // 1, 2, 3... hasta totalPages

      // Dividir el PDF: 1 página independiente por archivo
      const singlePagePdf = await PDFDocument.create();
      const [copiedPage] = await singlePagePdf.copyPages(mainPdfDoc, [pageIndex]);
      singlePagePdf.addPage(copiedPage);
      const singlePageBytes = await singlePagePdf.save();

      // Renderizado a imagen y OCR
      const muPage = muDoc.loadPage(pageIndex);
      const pixmap = muPage.toPixmap(mupdf.Matrix.scale(2, 2), mupdf.ColorSpace.DeviceRGB, false);
      const pngBuffer = Buffer.from(pixmap.asPNG());

      const ocrResult = await worker.recognize(pngBuffer);
      const ocrText = ocrResult?.data?.text || '';

      // Extracción específica y nombrado
      const razonSocial = extractAndCleanRazonSocial(ocrText);
      const fileName = razonSocial
        ? `${razonSocial}_${consecutiveNumber}.pdf`
        : `EMPRESA_NO_DETECTADA_${consecutiveNumber}.pdf`;

      // Almacenamiento en memoria interna
      filesInMemory.push({
        page: consecutiveNumber,
        fileName,
        buffer: Buffer.from(singlePageBytes),
        status: razonSocial ? 'DETECTADA' : 'EMPRESA_NO_DETECTADA'
      });
    }

    await worker.terminate();

    // Empaquetar todos los archivos generados dentro de un único archivo comprimido .ZIP en memoria
    console.log(`[ZIP] Generando archivo comprimido con ${filesInMemory.length} páginas...`);
    const zipBuffer = await createZipInMemory(filesInMemory);

    const downloadId = crypto.randomUUID();
    zipStorage.set(downloadId, {
      zipBuffer,
      totalFiles: filesInMemory.length,
      timestamp: Date.now()
    });

    console.log(`[Listo] Proceso completado. ID de descarga: ${downloadId} (${(zipBuffer.length / 1024).toFixed(1)} KB)`);

    return res.json({
      success: true,
      totalPages,
      downloadId,
      files: filesInMemory.map((f) => ({
        page: f.page,
        fileName: f.fileName,
        status: f.status,
        sizeBytes: f.buffer.length
      }))
    });
  } catch (error) {
    console.error('Error al procesar el manifiesto:', error);
    return res.status(500).json({
      error: 'Error durante el procesamiento del archivo: ' + error.message
    });
  }
});

/**
 * 3. Endpoint de Descarga directa del archivo comprimido (.ZIP)
 */
app.get('/api/download-zip/:id', (req, res) => {
  const downloadItem = zipStorage.get(req.params.id);

  if (!downloadItem || !downloadItem.zipBuffer) {
    return res.status(404).send('El enlace de descarga ha expirado o no es válido.');
  }

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename="manifiestos_procesados.zip"');
  res.setHeader('Content-Length', downloadItem.zipBuffer.length);
  return res.end(downloadItem.zipBuffer);
});

// Inicialización del servidor
ensureTessData().then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`=======================================================`);
    console.log(`Servidor activo y escuchando en el puerto ${PORT}`);
    console.log(`Modo: Render Cloud Ready (Almacenamiento en Memoria / Buffer)`);
    console.log(`=======================================================`);
  });
});
