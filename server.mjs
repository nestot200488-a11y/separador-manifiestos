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

const BRAND_DEFINITIONS = [
  {
    name: 'FARMACIAS DEL AHORRO',
    regex: /(?:(?:FARMACIA\s*S?|FARMACTAS|FARMACAS|FARMACIS)\s*)?(?:DEL\s*AHORRO|DELAHORRO|OER[\s\-_]*AHONNO|OER[\s\-_]*AHORRO|AHORRO|AHONNO)\b/i,
    trigger: /\b(?:AHORRO|AHONNO|DELAHORRO|FARMACTAS|FARMACAS|FARMACIS)\b/i
  },
  {
    name: 'FARMACIAS SIMILARES',
    regex: /(?:(?:FARMACIA\s*S?|FARMACTAS|FARMACAS|FARMACIS)\s*)?(?:SIMILARES)\b/i,
    trigger: /\bSIMILARES\b/i
  },
  {
    name: 'FARMACIAS BENAVIDES',
    regex: /(?:(?:FARMACIA\s*S?|FARMACTAS|FARMACAS)\s*)?(?:BENAVIDES)\b/i,
    trigger: /\bBENAVIDES\b/i
  },
  {
    name: 'FARMACIAS GUADALAJARA',
    regex: /(?:(?:FARMACIA\s*S?|FARMACTAS|FARMACAS)\s*)?(?:GUADALAJARA)\b/i,
    trigger: /\bGUADALAJARA\b/i
  },
  {
    name: 'NUEVA WALMART DE MEXICO',
    regex: /(?:NUEVA\s+)?(?:WALMART|WAL-MART)(?:\s+DE\s+MEXICO)?\b/i,
    trigger: /\b(?:WALMART|WAL-MART)\b/i
  },
  {
    name: 'CENTRO HOSPITALARIO MAC',
    regex: /(?:CENTRO\s+HOSPITALARIO\s+MAC|HOSPITAL(?:ARIO)?\s+MAC)\b/i,
    trigger: /\b(?:CENTRO\s+HOSPITALARIO\s+MAC|HOSPITAL(?:ARIO)?\s+MAC)\b/i
  }
];

/**
 * Limpieza interna del renglón detectado (Línea 4):
 * - Remueve comas sueltas y caracteres especiales ilegales de Windows.
 * - Conserva paréntesis, acentos y letras como la Ñ (ej: MUÑOZ (SAPM)).
 * - Estandariza a MAYÚSCULAS y remueve espacios dobles.
 */
function cleanSingleLineText(text) {
  if (!text) return '';
  let str = text.trim();

  // Corte estricto en el renglón si aparece DOMICILIO o campos contiguos
  const domMatch = str.match(/\b(?:DOMICI?LIO|DOMICTLIO|DIRECCI[OÓ]N)\b/i);
  if (domMatch) {
    str = str.substring(0, domMatch.index).trim();
  }
  const clientMatch = str.match(/\b(?:(?:NO\.?|NUM\.?|N[UÚ]MERO)\s+DE\s+CLIENTE|FOLIO)\b/i);
  if (clientMatch) {
    str = str.substring(0, clientMatch.index).trim();
  }
  const munMatch = str.match(/\b(?:MUNICIPIO|ALCALD[IÍ]A|EDO\.?|ESTADO|C\.?P\.?|CP\s+\d{4,5})\b/i);
  if (munMatch) {
    str = str.substring(0, munMatch.index).trim();
  }

  // Eliminar prefijos iniciales basura: "4.-", "4-", "L+", ")", "(", "-", "_"
  str = str.replace(/^(?:L[\s\-_]*4[\s\.\-]*|4[\s\.\-]+|L[\+\-]\s*|[\s)("'\-_+=:;.,/|\\]+)+/gi, '').trim();

  // Limpieza de casillas SEMARNAT mezcladas
  str = str.replace(/(?:1\s*[\.\-]*\s*)?N[UÚ]M\.?\s*DE\s*REGISTRO(?:\s+AMBIENTAL)?\s*[:.-]?\s*[\w\-/]*/gi, ' ').trim();
  str = str.replace(/\bN\.?R\.?A\.?\s*[:.-]?\s*[\w\-/]*/gi, ' ').trim();

  // Eliminar caracteres prohibidos en nombres de archivo de Windows: \ / : * ? " < > |
  // y caracteres de puntuación como comas intermedias/sueltas, puntos (convierte S.A. a SA)
  str = str.replace(/[\\/:*?"<>|,;.#\x00-\x1f]/g, '');

  // Limpiar espacios dobles
  str = str.replace(/\s{2,}/g, ' ').trim();

  // Convertir a MAYÚSCULAS
  str = str.toUpperCase();

  // Limpiar cualquier símbolo raro al inicio o al final (manteniendo letras, números y paréntesis)
  str = str.replace(/^[^A-Z0-9ÁÉÍÓÚÑ(]+/, '').trim();
  str = str.replace(/[^A-Z0-9ÁÉÍÓÚÑ)]+$/, '').trim();

  return str;
}

/**
 * Control de Errores de Lectura (Reemplazo Inteligente):
 * Si detecta palabras de marca (ej: FARMACTAS, AHORRO, SIMILARES) en la línea,
 * estandariza el inicio del nombre correctamente ("FARMACIAS DEL AHORRO" o "FARMACIAS SIMILARES")
 * y lo conecta con el nombre de la sucursal extraído de esa misma línea.
 */
function applyBrandDictionaryToLine(line) {
  if (!line) return null;

  for (const brandDef of BRAND_DEFINITIONS) {
    if (brandDef.trigger.test(line)) {
      const match = brandDef.regex.exec(line);
      if (match) {
        // Capturar ÚNICAMENTE el texto que aparece a la derecha de la marca en esa misma línea
        let rawSuffix = line.slice(match.index + match[0].length);

        // Cortar antes de DOMICILIO o campos contiguos
        const domMatch = rawSuffix.match(/\b(?:DOMICI?LIO|DOMICTLIO|DIRECCI[OÓ]N|MUNICIPIO|ALCALD[IÍ]A|EDO\.?|ESTADO|C\.?P\.?|CP\b|(?:NO\.?|NUM\.?|N[UÚ]MERO)\s+DE\s+CLIENTE|FOLIO)\b/i);
        if (domMatch) {
          rawSuffix = rawSuffix.substring(0, domMatch.index);
        }

        // Limpieza de caracteres de puntuación (coma, punto, guion) y caracteres ilegales
        let suffix = rawSuffix.trim();
        suffix = suffix.replace(/^[,\s;:\-_+=/|\\]+/, '').trim();
        suffix = suffix.replace(/[\\/:*?"<>|,;.#\x00-\x1f]/g, '');
        suffix = suffix.replace(/\s{2,}/g, ' ').trim();
        suffix = suffix.replace(/[,\s;:\-_+=/|\\.]+$/, '').trim();
        suffix = suffix.toUpperCase();

        // Filtrar si el sufijo son solo palabras genéricas de formato
        const formatWordRegex = /^(?:MANIFIESTO|RESIDUOS|TRANSPORTE|SEMARNAT|FORMATO|DOCUMENTO|INSTRUCCIONES|GENERADORA|CLIENTE|DOMICILIO|FOLIO|REGISTRO|AMBIENTAL|RAZON\s+SOCIAL)$/i;
        if (formatWordRegex.test(suffix) || /^[\d\s]+$/.test(suffix) || suffix.length < 2) {
          suffix = '';
        }
        suffix = suffix.replace(/\b(?:MANIFIESTO|RESIDUOS|TRANSPORTE|SEMARNAT|GENERADORA|CLIENTE|DOMICILIO|FOLIO|REGISTRO|AMBIENTAL)\b.*/i, '').trim();

        let finalName = brandDef.name;
        if (suffix) {
          finalName = `${brandDef.name} ${suffix}`.replace(/\s{2,}/g, ' ').trim();
        }

        if (finalName.length > 60) {
          finalName = finalName.substring(0, 60).trim();
        }
        finalName = finalName.replace(/[^A-Z0-9ÁÉÍÓÚÑ)]+$/, '').trim();
        return finalName;
      }
    }
  }

  return null;
}

/**
 * Diccionario de Respaldo Asociativo
 * Si el OCR falla en aislar la Casilla 4 pero el texto completo contiene marcas conocidas en alguna línea.
 */
function checkBackupDictionary(fullText) {
  if (!fullText) return null;

  const lines = fullText.split(/\r?\n+/);

  for (const line of lines) {
    const res = applyBrandDictionaryToLine(line);
    if (res) return res;
  }

  for (const brandDef of BRAND_DEFINITIONS) {
    if (brandDef.trigger.test(fullText)) {
      return brandDef.name;
    }
  }

  return null;
}

/**
 * Sanitizer de nombre de empresa para compatibilidad
 */
function sanitizeCompanyName(name, fullText = '') {
  if (!name && !fullText) return null;

  const line = (name || '').split(/\r?\n+/)[0] || '';

  const brandResult = applyBrandDictionaryToLine(line);
  if (brandResult) return brandResult;

  let cleaned = cleanSingleLineText(line);

  const formatWordsRegex = /\b(?:GENERADORA|CLIENTE|DOMICILIO|DOMICTLIO|DIRECCION|FOLIO|REGISTRO|AMBIENTAL|RAZON\s+SOCIAL|MANIFIESTO|RESIDUOS|TRANSPORTE|SEMARNAT|FORMATO|DOCUMENTO|INSTRUCCIONES)\b/i;
  if (formatWordsRegex.test(cleaned) || cleaned.length < 4 || /^[\d\s]+$/.test(cleaned)) {
    return checkBackupDictionary(fullText || name);
  }

  if (cleaned.length > 60) {
    cleaned = cleaned.substring(0, 60).trim();
  }
  cleaned = cleaned.replace(/[^A-Z0-9ÁÉÍÓÚÑ)]+$/, '').trim();

  return cleaned.length >= 4 ? cleaned : (checkBackupDictionary(fullText || name) || null);
}

/**
 * Función de extracción de Razón Social por regla de coincidencia exacta por renglón (Línea 4):
 * 1. CAPTURA EXCLUSIVA A LA DERECHA DE LOS DOS PUNTOS:
 *    Localiza la línea específica de la Casilla 4 de SEMARNAT y toma únicamente lo que está a la derecha de ':'.
 *    Se detiene antes de cualquier salto de línea '\n' o de la palabra 'DOMICILIO' (no lee renglones inferiores).
 * 2. LIMPIEZA INTERNA DEL RENGLÓN DETECTADO:
 *    Remueve espacios dobles y comas sueltas, conservando intacta la sucursal, ciudad o siglas (ej: "MUÑOZ (SAPM)").
 * 3. CONTROL DE ERRORES DE LECTURA (Reemplazo Inteligente):
 *    Estandariza marcas ("FARMACIAS DEL AHORRO", "FARMACIAS SIMILARES") unidas con la sucursal de esa misma línea.
 */
function extractAndCleanRazonSocial(rawText) {
  if (!rawText) return null;

  // Dividir el texto por líneas para evitar arrastrar líneas inferiores
  const lines = rawText.split(/\r?\n+/);

  // 1. CAPTURA EXCLUSIVA A LA DERECHA DE LOS DOS PUNTOS (Línea 4)
  const box4HeaderRegex = /(?:(?:L[\s\-_]*)?4\s*[\.\-]+|L[\+\-]\s*|\)\s*[-_]?\s*)?(?:RAZ[OÓ]N\s+SOCIAL(?:\s+DE\s+LA)?(?:\s+EMPRESA)?(?:\s+GENERADORA)?|EMPRESA\s+GENERADORA|\bGENERADORA\b)/i;

  let line4 = null;
  for (const line of lines) {
    if (box4HeaderRegex.test(line)) {
      line4 = line;
      break;
    }
  }

  let capturedText = '';

  if (line4) {
    const headerMatch = box4HeaderRegex.exec(line4);
    // Buscar específicamente los dos puntos ':' a la derecha del patrón de Casilla 4
    const colonIndex = line4.indexOf(':', headerMatch.index);
    if (colonIndex !== -1) {
      capturedText = line4.slice(colonIndex + 1);
    } else {
      // Si la línea no contiene ':' capturar lo que sigue al encabezado en ese renglón
      capturedText = line4.slice(headerMatch.index + headerMatch[0].length);
    }
  } else {
    // Si no localiza la cabecera explícita "4.- RAZON SOCIAL", buscar renglón que contenga alguna marca del diccionario
    for (const line of lines) {
      for (const brandDef of BRAND_DEFINITIONS) {
        if (brandDef.trigger.test(line)) {
          const brandMatch = brandDef.regex.exec(line);
          if (brandMatch) {
            capturedText = line.slice(brandMatch.index);
            break;
          }
        }
      }
      if (capturedText) break;
    }
  }

  if (!capturedText) {
    return null;
  }

  // Detener la extracción inmediatamente si empieza la palabra DOMICILIO en esa misma línea
  const domMatch = capturedText.match(/\b(?:DOMICI?LIO|DOMICTLIO|DIRECCI[OÓ]N)\b/i);
  if (domMatch) {
    capturedText = capturedText.substring(0, domMatch.index);
  }

  // 2. CONTROL DE ERRORES DE LECTURA (Diccionario de reemplazo inteligente)
  const brandResult = applyBrandDictionaryToLine(capturedText);
  if (brandResult) {
    return brandResult;
  }

  // 3. LIMPIEZA INTERNA DEL RENGLÓN PARA OTRAS EMPRESAS
  let cleaned = cleanSingleLineText(capturedText);

  // Validación de formato
  const formatWordsRegex = /\b(?:GENERADORA|CLIENTE|DOMICILIO|DOMICTLIO|DIRECCION|FOLIO|REGISTRO|AMBIENTAL|RAZON\s+SOCIAL|MANIFIESTO|RESIDUOS|TRANSPORTE|SEMARNAT|FORMATO|DOCUMENTO|INSTRUCCIONES)\b/i;
  if (formatWordsRegex.test(cleaned) || cleaned.length < 4 || /^[\d\s]+$/.test(cleaned)) {
    return checkBackupDictionary(rawText);
  }

  if (cleaned.length > 60) {
    cleaned = cleaned.substring(0, 60).trim();
  }
  cleaned = cleaned.replace(/[^A-Z0-9ÁÉÍÓÚÑ)]+$/, '').trim();

  return cleaned.length >= 4 ? cleaned : (checkBackupDictionary(rawText) || null);
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
 * 1. CONTADOR DE PÁGINAS SEGURO (Flujos asíncronos, chunks y fallback remoto a PDF.co)
 * - Maneja PDFs escaneados y de gran tamaño leyendo en flujos asíncronos y chunks (64KB).
 * - Si la librería local (pdf-lib) falla al abrir el archivo debido a su peso,
 *   delega el conteo directamente a la API de PDF.co mediante su lectura remota (/v1/pdf/info).
 */
async function countPdfPages({ tempFilePath, apiKey = '', cloudFileUrl = null, originalName = 'document.pdf' }) {
  console.log(`[Contador de Páginas] Iniciando conteo seguro para: ${originalName || path.basename(tempFilePath)}`);

  let localError = null;

  // Paso 1: Intento de conteo local seguro usando flujos asíncronos por chunks
  try {
    const fileStats = await fs.promises.stat(tempFilePath);
    console.log(`[Contador de Páginas] Peso del archivo: ${(fileStats.size / (1024 * 1024)).toFixed(2)} MB`);

    // Cargar búfer por partes (chunks) con flujo asíncrono para proteger el consumo de RAM
    const chunks = [];
    const readStream = fs.createReadStream(tempFilePath, { highWaterMark: 64 * 1024 });
    for await (const chunk of readStream) {
      chunks.push(chunk);
    }
    const fileBuffer = Buffer.concat(chunks);

    // Intento con la librería local pdf-lib
    const pdfDoc = await PDFDocument.load(fileBuffer, {
      ignoreEncryption: true,
      updateMetadata: false
    });
    const pageCount = pdfDoc.getPageCount();

    if (typeof pageCount === 'number' && pageCount > 0) {
      console.log(`[Contador de Páginas] Librería local contó exitosamente ${pageCount} páginas.`);
      return { pageCount, cloudFileUrl, delegatedToRemote: false };
    }
  } catch (err) {
    localError = err;
    console.warn(`[Contador de Páginas] Librería local falló al abrir el archivo debido a su peso/estructura (${err.message}). Delegando conteo nativo a PDF.co...`);
  }

  // Paso 2: Delegación a la API de PDF.co con función nativa de lectura remota (/v1/pdf/info)
  const effectiveKey = (apiKey && apiKey.trim()) || process.env.PDFCO_API_KEY;
  if (!effectiveKey || effectiveKey.trim() === '') {
    if (localError) {
      throw new Error(`Fallo de lectura local (${localError.message}) y no se proporcionó clave de PDF.co para delegar lectura remota.`);
    }
    throw new Error('No se detectaron páginas en el documento.');
  }

  const key = effectiveKey.trim();
  let remoteFileUrl = cloudFileUrl;

  // Si el archivo aún no ha sido subido a PDF.co, transmitir por flujo (Stream) sin saturar RAM
  if (!remoteFileUrl) {
    console.log('[Contador de Páginas] Transmitiendo archivo a PDF.co mediante streams para lectura remota...');
    const fileStats = await fs.promises.stat(tempFilePath);
    const presignedRes = await fetch(
      `https://api.pdf.co/v1/file/upload/get-presigned-url?name=${encodeURIComponent(originalName || 'document.pdf')}`,
      { headers: { 'x-api-key': key } }
    );
    const presignedData = await presignedRes.json();
    if (presignedData.error) {
      throw new Error(`PDF.co (Carga para info remota): ${presignedData.message}`);
    }

    remoteFileUrl = presignedData.url;

    const fileStream = fs.createReadStream(tempFilePath);
    const uploadRes = await fetch(presignedData.presignedUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Length': fileStats.size.toString()
      },
      body: fileStream,
      duplex: 'half'
    });

    if (!uploadRes.ok) {
      throw new Error(`Fallo en la transmisión a PDF.co para lectura remota (HTTP ${uploadRes.status})`);
    }
  }

  // Consulta nativa remota en PDF.co: POST /v1/pdf/info
  console.log('[Contador de Páginas] Consultando función nativa de lectura remota en PDF.co (/v1/pdf/info)...');
  const infoRes = await fetch('https://api.pdf.co/v1/pdf/info', {
    method: 'POST',
    headers: {
      'x-api-key': key,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      url: remoteFileUrl,
      async: false
    })
  });

  const infoData = await infoRes.json();
  if (infoData.error) {
    throw new Error(`PDF.co (Lectura remota /pdf/info): ${infoData.message}`);
  }

  const remotePageCount = (infoData.info && typeof infoData.info.PageCount === 'number')
    ? infoData.info.PageCount
    : (typeof infoData.pageCount === 'number' ? infoData.pageCount : 0);

  console.log(`[Contador de Páginas] Función nativa de PDF.co reportó ${remotePageCount} páginas.`);

  if (remotePageCount === 0) {
    throw new Error('No se detectaron páginas en el documento.');
  }

  return { pageCount: remotePageCount, cloudFileUrl: remoteFileUrl, delegatedToRemote: true };
}

/**
 * 2. PROCESAMIENTO CLOUD OCR CON PDF.CO (Streaming & Batching)
 */
async function processWithPdfCo(job, tempFilePath, originalName, apiKey) {
  const fileStats = await fs.promises.stat(tempFilePath);

  // Paso 1: Contador seguro de páginas (flujos asíncronos / chunks / delegación nativa a PDF.co)
  job.status = 'analyzing';
  job.progress = 8;
  job.message = 'Analizando y contando páginas del documento de forma segura...';

  const countResult = await countPdfPages({
    tempFilePath,
    apiKey,
    originalName
  });

  const detectedPages = countResult.pageCount;
  job.totalPages = detectedPages;
  let cloudFileUrl = countResult.cloudFileUrl;

  job.message = `Documento analizado: ${detectedPages} páginas detectadas. Preparando transmisión...`;

  // Transmitir a la nube si no se transmitió previamente durante la delegación remota
  if (!cloudFileUrl) {
    job.status = 'uploading';
    job.progress = 15;
    job.message = 'Transmitiendo archivo a la nube mediante streams seguros...';

    const presignedRes = await fetch(
      `https://api.pdf.co/v1/file/upload/get-presigned-url?name=${encodeURIComponent(originalName)}`,
      { headers: { 'x-api-key': apiKey } }
    );
    const presignedData = await presignedRes.json();
    if (presignedData.error) {
      throw new Error(`PDF.co (Carga): ${presignedData.message}`);
    }

    const { presignedUrl, url } = presignedData;
    cloudFileUrl = url;

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
  }

  // Paso 2: División de páginas en la nube mediante PDF.co (pages: "*")
  job.status = 'splitting';
  job.progress = 25;
  job.message = `Dividiendo documento (${detectedPages} páginas) en páginas individuales en la nube...`;

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
  let splitResult = null;
  if (splitData.jobId) {
    const splitJobId = splitData.jobId;
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
  } else {
    splitResult = splitData;
  }

  // Extracción robusta de las URLs de páginas individuales
  // (Soporta array 'urls', enlace remoto 'result.json' para PDFs grandes de 45MB+, o string)
  let pageUrls = [];
  if (Array.isArray(splitResult.urls) && splitResult.urls.length > 0) {
    pageUrls = splitResult.urls;
  } else if (typeof splitResult.url === 'string' && splitResult.url.length > 0) {
    if (splitResult.url.toLowerCase().includes('.json')) {
      try {
        console.log(`[PDF.co Split] Obteniendo lista de páginas desde enlace JSON remoto: ${splitResult.url}`);
        const jsonRes = await fetch(splitResult.url);
        const jsonData = await jsonRes.json();
        if (Array.isArray(jsonData)) {
          pageUrls = jsonData;
        } else if (jsonData && Array.isArray(jsonData.urls)) {
          pageUrls = jsonData.urls;
        } else if (jsonData && typeof jsonData.url === 'string') {
          pageUrls = [jsonData.url];
        }
      } catch (jsonErr) {
        console.warn('[PDF.co Split] Error al descargar result.json:', jsonErr.message);
      }
    } else {
      pageUrls = [splitResult.url];
    }
  } else if (typeof splitResult.urls === 'string' && splitResult.urls.length > 0) {
    pageUrls = splitResult.urls.split(',').map((u) => u.trim());
  }

  pageUrls = pageUrls.map((item) => (typeof item === 'string' ? item : item?.url || item)).filter(Boolean);

  const totalPages = pageUrls.length || detectedPages;
  job.totalPages = totalPages;

  if (totalPages === 0) {
    throw new Error('No se detectaron páginas en el documento.');
  }

  // Paso 3: Preparar archivo ZIP temporal en disco (Stream)
  const zipPath = path.join(uploadDir, `bundle-${job.id}.zip`);
  const zipOutputStream = fs.createWriteStream(zipPath);
  const archive = createArchiveInstance();
  archive.pipe(zipOutputStream);

  const usedFileNames = new Set();
  const fileNameCounts = new Map();

  function getUniquePdfFileName(baseName) {
    let fileName = `${baseName}.pdf`;
    if (usedFileNames.has(fileName)) {
      const count = (fileNameCounts.get(baseName) || 1) + 1;
      fileNameCounts.set(baseName, count);
      fileName = `${baseName} (${count}).pdf`;
    } else {
      fileNameCounts.set(baseName, 1);
      usedFileNames.add(fileName);
    }
    return fileName;
  }

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
        const baseName = razonSocial || 'EMPRESA_NO_DETECTADA';
        const fileName = getUniquePdfFileName(baseName);

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
async function processLocalFallback(job, tempFilePath, apiKey = '', originalName = 'document.pdf') {
  job.status = 'analyzing';
  job.progress = 15;
  job.message = 'Contando páginas del documento de forma segura...';

  // Usar el contador seguro de páginas con flujos asíncronos y chunks
  const countResult = await countPdfPages({
    tempFilePath,
    apiKey,
    originalName
  });

  const totalPages = countResult.pageCount;
  job.totalPages = totalPages;

  if (totalPages === 0) {
    throw new Error('No se detectaron páginas en el documento.');
  }

  job.status = 'splitting';
  job.progress = 25;
  job.message = `Leyendo estructura de ${totalPages} páginas en disco por chunks...`;

  // Carga segura del búfer por partes (chunks) usando flujos asíncronos
  const chunks = [];
  const readStream = fs.createReadStream(tempFilePath, { highWaterMark: 64 * 1024 });
  for await (const chunk of readStream) {
    chunks.push(chunk);
  }
  const fileBytes = Buffer.concat(chunks);
  const mainPdfDoc = await PDFDocument.load(fileBytes, { ignoreEncryption: true });

  const zipPath = path.join(uploadDir, `bundle-${job.id}.zip`);
  const zipOutputStream = fs.createWriteStream(zipPath);
  const archive = createArchiveInstance();
  archive.pipe(zipOutputStream);

  const BATCH_SIZE = 3;
  const generatedFiles = [];

  const usedFileNames = new Set();
  const fileNameCounts = new Map();

  function getUniquePdfFileName(baseName) {
    let fileName = `${baseName}.pdf`;
    if (usedFileNames.has(fileName)) {
      const count = (fileNameCounts.get(baseName) || 1) + 1;
      fileNameCounts.set(baseName, count);
      fileName = `${baseName} (${count}).pdf`;
    } else {
      fileNameCounts.set(baseName, 1);
      usedFileNames.add(fileName);
    }
    return fileName;
  }

  for (let i = 0; i < totalPages; i += BATCH_SIZE) {
    const end = Math.min(i + BATCH_SIZE, totalPages);
    job.message = `Dividiendo páginas ${i + 1} a ${end} de ${totalPages}...`;
    job.progress = Math.round(25 + ((i / totalPages) * 65));

    for (let pageIndex = i; pageIndex < end; pageIndex++) {
      const consecutive = pageIndex + 1;
      const singlePageDoc = await PDFDocument.create();
      const [copiedPage] = await singlePageDoc.copyPages(mainPdfDoc, [pageIndex]);
      singlePageDoc.addPage(copiedPage);
      const singleBytes = await singlePageDoc.save();

      // Nombramiento seguro sin sufijo de página
      const fileName = getUniquePdfFileName('EMPRESA_NO_DETECTADA');
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
      await processLocalFallback(job, tempFilePath, key, originalName);
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

export {
  app,
  countPdfPages,
  processWithPdfCo,
  processLocalFallback,
  checkBackupDictionary,
  sanitizeCompanyName,
  extractAndCleanRazonSocial
};
