import express from 'express';
import multer from 'multer';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { PDFDocument } from 'pdf-lib';

const require = createRequire(import.meta.url);
const archiver = require('archiver');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Configuración de Multer: ALMACENAMIENTO EN DISCO TEMPORAL (Streams)
// Evita cargar archivos grandes (45MB+) en la memoria RAM del servidor
const uploadDir = path.join(os.tmpdir(), 'pdf-manifest-uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + crypto.randomBytes(6).toString('hex');
    cb(null, `manifest-${uniqueSuffix}.pdf`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 250 * 1024 * 1024 }, // Soporta hasta 250MB
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

// Estado en memoria de tareas asíncronas
const jobs = new Map();

// Limpieza periódica de trabajos y archivos temporales antiguos (> 1 hora)
setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs.entries()) {
    if (now - job.createdAt > 60 * 60 * 1000) {
      if (job.tempFilePath && fs.existsSync(job.tempFilePath)) {
        fs.promises.unlink(job.tempFilePath).catch(() => {});
      }
      if (job.zipPath && fs.existsSync(job.zipPath)) {
        fs.promises.unlink(job.zipPath).catch(() => {});
      }
      jobs.delete(id);
    }
  }
}, 10 * 60 * 1000);

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
  // Limpiar espacios dobles o múltiples
  extracted = extracted.replace(/\s{2,}/g, ' ');
  // Eliminar caracteres prohibidos en nombres de archivos
  extracted = extracted.replace(/[\\/:*?"<>|]/g, '');
  extracted = extracted.trim();

  return extracted.length > 0 ? extracted : null;
}

/**
 * Helper para instanciar Archiver de forma compatible
 */
function createArchiveInstance() {
  const options = { zlib: { level: 6 } };
  if (archiver.ZipArchive) {
    return new archiver.ZipArchive(options);
  } else if (typeof archiver === 'function') {
    return archiver('zip', options);
  } else if (archiver.default && typeof archiver.default === 'function') {
    return archiver.default('zip', options);
  }
  throw new Error('No se pudo inicializar la librería de compresión ZIP.');
}

/**
 * 2. PROCESAMIENTO CLOUD OCR CON PDF.CO (Streaming & Batching)
 */
async function processWithPdfCo(job, tempFilePath, originalName, apiKey) {
  const fileStats = await fs.promises.stat(tempFilePath);

  // Paso 1: Obtener URL prefirmada para carga segura vía Stream sin cargar en RAM
  job.status = 'uploading';
  job.progress = 10;
  job.message = 'Transmitiendo archivo a la nube mediante streams seguros...';

  const presignedRes = await fetch(
    `https://api.pdf.co/v1/file/upload/get-presigned-url?name=${encodeURIComponent(originalName)}`,
    { headers: { 'x-api-key': apiKey } }
  );
  const presignedData = await presignedRes.json();
  if (presignedData.error) {
    throw new Error(`PDF.co (Carga): ${presignedData.message}`);
  }

  const { presignedUrl, url: cloudFileUrl } = presignedData;

  // Carga binaria directa por flujo (Stream)
  const fileStream = fs.createReadStream(tempFilePath);
  const uploadRes = await fetch(presignedUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Length': fileStats.size.toString()
    },
    body: fileStream,
    duplex: 'half'
  });

  if (!uploadRes.ok) {
    throw new Error(`Fallo en la carga a la nube (Código HTTP ${uploadRes.status})`);
  }

  // Paso 2: División de páginas en la nube mediante PDF.co (pages: "*")
  job.status = 'splitting';
  job.progress = 25;
  job.message = 'Dividiendo documento en páginas individuales en la nube...';

  const splitRes = await fetch('https://api.pdf.co/v1/pdf/split', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      url: cloudFileUrl,
      pages: '*',
      inline: true,
      async: true
    })
  });
  const splitData = await splitRes.json();
  if (splitData.error) {
    throw new Error(`PDF.co (División): ${splitData.message}`);
  }

  // Esperar a que el trabajo asíncrono de división termine en PDF.co
  const splitJobId = splitData.jobId;
  let splitResult = null;
  while (!splitResult) {
    await new Promise((r) => setTimeout(r, 2000));
    const checkRes = await fetch('https://api.pdf.co/v1/job/check', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ jobId: splitJobId })
    });
    const checkData = await checkRes.json();
    if (checkData.status === 'success') {
      splitResult = checkData;
    } else if (checkData.status === 'failed') {
      throw new Error(`PDF.co (División fallida): ${checkData.message}`);
    }
  }

  const pageUrls = splitResult.urls || [];
  const totalPages = pageUrls.length;
  job.totalPages = totalPages;

  if (totalPages === 0) {
    throw new Error('No se detectaron páginas en el documento.');
  }

  // Paso 3: Preparar archivo ZIP temporal en disco (Stream)
  const zipPath = path.join(uploadDir, `bundle-${job.id}.zip`);
  const zipOutputStream = fs.createWriteStream(zipPath);
  const archive = createArchiveInstance();
  archive.pipe(zipOutputStream);

  // Paso 4: Procesamiento OCR en lotes pequeños (3 páginas a la vez)
  job.status = 'ocr';
  const BATCH_SIZE = 3;
  const generatedFiles = [];

  for (let i = 0; i < totalPages; i += BATCH_SIZE) {
    const batchUrls = pageUrls.slice(i, i + BATCH_SIZE);
    const batchIndices = batchUrls.map((_, idx) => i + idx);

    job.message = `Ejecutando OCR en páginas ${i + 1} a ${Math.min(i + BATCH_SIZE, totalPages)} de ${totalPages}...`;
    job.progress = Math.round(25 + ((i / totalPages) * 65));

    const batchResults = await Promise.all(
      batchUrls.map(async (pageUrl, idx) => {
        const pageIndex = batchIndices[idx];
        const consecutive = pageIndex + 1;
        let ocrText = '';

        try {
          const ocrRes = await fetch('https://api.pdf.co/v1/pdf/convert/to/text', {
            method: 'POST',
            headers: {
              'x-api-key': apiKey,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              url: pageUrl,
              inline: true,
              ocr: true,
              ocrLanguage: 'spa',
              async: false
            })
          });
          const ocrData = await ocrRes.json();
          ocrText = ocrData.body || '';
        } catch (err) {
          console.warn(`[OCR Warning] Página ${consecutive}:`, err.message);
        }

        const razonSocial = extractAndCleanRazonSocial(ocrText);
        const fileName = razonSocial
          ? `${razonSocial}_${consecutive}.pdf`
          : `EMPRESA_NO_DETECTADA_${consecutive}.pdf`;

        // Descarga directa del archivo de página para añadirlo al ZIP
        const pagePdfRes = await fetch(pageUrl);
        const pageBuffer = Buffer.from(await pagePdfRes.arrayBuffer());
        archive.append(pageBuffer, { name: fileName });

        return {
          page: consecutive,
          fileName,
          status: razonSocial ? 'DETECTADA' : 'EMPRESA_NO_DETECTADA',
          sizeBytes: pageBuffer.length
        };
      })
    );

    generatedFiles.push(...batchResults);
    job.processedPages = generatedFiles.length;
  }

  // Paso 5: Finalizar ZIP
  job.status = 'zipping';
  job.progress = 95;
  job.message = 'Consolidando paquete ZIP en disco...';

  await archive.finalize();

  await new Promise((resolve, reject) => {
    zipOutputStream.on('finish', resolve);
    zipOutputStream.on('error', reject);
  });

  job.status = 'completed';
  job.progress = 100;
  job.message = `¡Completado con éxito! Se procesaron ${totalPages} páginas.`;
  job.files = generatedFiles;
  job.zipPath = zipPath;
}

/**
 * PROCESAMIENTO LOCAL POR LOTES (Fallback ligero si no se cuenta con API Key externa)
 */
async function processLocalFallback(job, tempFilePath) {
  job.status = 'splitting';
  job.progress = 20;
  job.message = 'Leyendo estructura del archivo PDF en disco...';

  const fileBytes = await fs.promises.readFile(tempFilePath);
  const mainPdfDoc = await PDFDocument.load(fileBytes);
  const totalPages = mainPdfDoc.getPageCount();
  job.totalPages = totalPages;

  const zipPath = path.join(uploadDir, `bundle-${job.id}.zip`);
  const zipOutputStream = fs.createWriteStream(zipPath);
  const archive = createArchiveInstance();
  archive.pipe(zipOutputStream);

  const BATCH_SIZE = 3;
  const generatedFiles = [];

  for (let i = 0; i < totalPages; i += BATCH_SIZE) {
    const end = Math.min(i + BATCH_SIZE, totalPages);
    job.message = `Dividiendo páginas ${i + 1} a ${end} de ${totalPages}...`;
    job.progress = Math.round(20 + ((i / totalPages) * 70));

    for (let pageIndex = i; pageIndex < end; pageIndex++) {
      const consecutive = pageIndex + 1;
      const singlePageDoc = await PDFDocument.create();
      const [copiedPage] = await singlePageDoc.copyPages(mainPdfDoc, [pageIndex]);
      singlePageDoc.addPage(copiedPage);
      const singleBytes = await singlePageDoc.save();

      // En fallback local sin OCR externo, nombramos con consecutivo
      const fileName = `EMPRESA_NO_DETECTADA_${consecutive}.pdf`;
      archive.append(Buffer.from(singleBytes), { name: fileName });

      generatedFiles.push({
        page: consecutive,
        fileName,
        status: 'EMPRESA_NO_DETECTADA',
        sizeBytes: singleBytes.length
      });
    }

    job.processedPages = generatedFiles.length;
  }

  job.status = 'zipping';
  job.progress = 95;
  await archive.finalize();

  await new Promise((resolve, reject) => {
    zipOutputStream.on('finish', resolve);
    zipOutputStream.on('error', reject);
  });

  job.status = 'completed';
  job.progress = 100;
  job.message = `¡Completado! Se dividieron ${totalPages} páginas.`;
  job.files = generatedFiles;
  job.zipPath = zipPath;
}

/**
 * Ejecutor en segundo plano (Asíncrono)
 */
async function runJobInBackground(jobId, tempFilePath, originalName, apiKey) {
  const job = jobs.get(jobId);
  try {
    const key = apiKey || process.env.PDFCO_API_KEY;
    if (key && key.trim() !== '') {
      await processWithPdfCo(job, tempFilePath, originalName, key.trim());
    } else {
      console.log(`[Job ${jobId}] Sin clave PDF.co. Ejecutando división local en lotes...`);
      await processLocalFallback(job, tempFilePath);
    }
  } catch (error) {
    console.error(`[Job ${jobId}] Error en proceso:`, error);
    job.status = 'error';
    job.error = error.message;
    job.message = `Error durante el procesamiento: ${error.message}`;
  } finally {
    // Eliminar archivo PDF temporal de entrada
    fs.promises.unlink(tempFilePath).catch(() => {});
  }
}

/**
 * 3. ENTREGA ASÍNCRONA:
 * Libera la conexión inmediatamente en menos de 1 segundo para evitar timeouts en Render
 */
app.post('/api/process-manifest', upload.single('manifestPdf'), (req, res) => {
  try {
    if (!req.file || !req.file.path) {
      return res.status(400).json({ error: 'No se ha cargado ningún archivo PDF válido.' });
    }

    const jobId = crypto.randomUUID();
    const apiKey = (req.body && req.body.apiKey) ? req.body.apiKey.trim() : '';

    const newJob = {
      id: jobId,
      status: 'queued',
      progress: 5,
      message: 'Documento recibido en el servidor. Iniciando procesamiento en segundo plano...',
      totalPages: 0,
      processedPages: 0,
      files: [],
      zipPath: null,
      tempFilePath: req.file.path,
      error: null,
      createdAt: Date.now()
    };

    jobs.set(jobId, newJob);

    // Lanzar procesamiento en segundo plano SIN bloquear la respuesta HTTP
    runJobInBackground(jobId, req.file.path, req.file.originalname, apiKey);

    // Respuesta inmediata al navegador (< 500 ms)
    return res.json({
      success: true,
      jobId,
      message: 'Procesamiento iniciado en segundo plano.'
    });
  } catch (error) {
    console.error('Error al recibir archivo:', error);
    return res.status(500).json({ error: error.message });
  }
});

/**
 * Consulta de progreso en tiempo real
 */
app.get('/api/job-status/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: 'Trabajo no encontrado o expirado.' });
  }

  res.json({
    id: job.id,
    status: job.status,
    progress: job.progress,
    message: job.message,
    totalPages: job.totalPages,
    processedPages: job.processedPages,
    files: job.files || [],
    error: job.error
  });
});

/**
 * Descarga por Streaming del archivo .ZIP resultante
 */
app.get('/api/download-zip/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job || job.status !== 'completed' || !job.zipPath || !fs.existsSync(job.zipPath)) {
    return res.status(404).send('El archivo ZIP no está disponible o ha expirado.');
  }

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename="manifiestos_procesados.zip"');

  const fileStream = fs.createReadStream(job.zipPath);
  fileStream.pipe(res);
});

/**
 * Información de configuración
 */
app.get('/api/config', (req, res) => {
  res.json({
    hasServerApiKey: Boolean(process.env.PDFCO_API_KEY && process.env.PDFCO_API_KEY.trim() !== '')
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`=======================================================`);
  console.log(`Servidor de Manifiestos PDF activo en el puerto ${PORT}`);
  console.log(`Modo: Streams en Disco + Cloud OCR + Procesamiento Asíncrono`);
  console.log(`Límite de subida: 250 MB | Render Timeout Safe`);
  console.log(`=======================================================`);
});
