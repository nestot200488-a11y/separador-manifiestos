import os
import io
import re
import uuid
import zipfile
from flask import Flask, request, jsonify, send_file, render_template_string
from pypdf import PdfReader, PdfWriter
import fitz  # PyMuPDF: Renderizado de páginas a imágenes
from PIL import Image
try:
    import pytesseract
except ImportError:
    pytesseract = None

app = Flask(__name__)

# Configuración del puerto dinámico para Render.com y local
PORT = int(os.environ.get("PORT", 3000))

# Almacén en memoria RAM para los archivos ZIP generados
zip_storage = {}

HTML_TEMPLATE = """<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Procesador de Manifiestos</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <style>
    :root {
      --primary: #2563eb;
      --primary-hover: #1d4ed8;
      --primary-light: #eff6ff;
      --success: #16a34a;
      --success-hover: #15803d;
      --border-color: #e2e8f0;
      --text-main: #0f172a;
      --text-muted: #64748b;
      --bg: #f8fafc;
      --card-bg: #ffffff;
      --radius: 14px;
      --shadow: 0 10px 15px -3px rgb(0 0 0 / 0.08), 0 4px 6px -4px rgb(0 0 0 / 0.05);
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Inter', -apple-system, sans-serif;
      background: var(--bg);
      color: var(--text-main);
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 48px 20px;
    }
    .container { width: 100%; max-width: 640px; }
    .header { text-align: center; margin-bottom: 28px; }
    .header h1 { font-size: 1.85rem; font-weight: 800; letter-spacing: -0.025em; margin-bottom: 8px; }
    .header p { color: var(--text-muted); font-size: 0.95rem; }
    .card {
      background: var(--card-bg);
      border-radius: var(--radius);
      box-shadow: var(--shadow);
      border: 1px solid var(--border-color);
      padding: 32px;
      display: flex;
      flex-direction: column;
      gap: 20px;
    }
    .file-dropzone {
      border: 2px dashed #cbd5e1;
      border-radius: var(--radius);
      padding: 40px 24px;
      text-align: center;
      cursor: pointer;
      background: #fafafa;
      position: relative;
      transition: all 0.2s ease;
    }
    .file-dropzone:hover { border-color: var(--primary); background: var(--primary-light); }
    .file-dropzone input[type="file"] {
      position: absolute; top: 0; left: 0; width: 100%; height: 100%; opacity: 0; cursor: pointer;
    }
    .file-icon { width: 52px; height: 52px; margin: 0 auto 12px; color: var(--primary); }
    .file-label { font-weight: 600; font-size: 1.05rem; margin-bottom: 6px; }
    .file-hint { font-size: 0.85rem; color: var(--text-muted); }
    .selected-file-info {
      display: none; align-items: center; justify-content: center; gap: 10px;
      background: #f1f5f9; border-radius: 8px; padding: 12px 16px; font-weight: 600; font-size: 0.92rem;
    }
    .selected-file-info.active { display: flex; }
    .btn-action {
      background: var(--primary); color: #fff; border: none; border-radius: 10px;
      padding: 16px 24px; font-size: 1.05rem; font-weight: 700; cursor: pointer;
      display: flex; align-items: center; justify-content: center; gap: 10px; width: 100%;
    }
    .btn-action:hover:not(:disabled) { background: var(--primary-hover); }
    .btn-action:disabled { background: #94a3b8; cursor: not-allowed; }
    .btn-download-large {
      display: none; background: var(--success); color: #fff; border: none; border-radius: 10px;
      padding: 18px 24px; font-size: 1.15rem; font-weight: 800; cursor: pointer;
      text-decoration: none; text-align: center; align-items: center; justify-content: center;
      gap: 12px; width: 100%; box-shadow: 0 4px 12px rgba(22, 163, 74, 0.25);
    }
    .btn-download-large.active { display: flex; }
    .btn-download-large:hover { background: var(--success-hover); }
    .status-box { display: none; padding: 14px 18px; border-radius: 10px; font-size: 0.92rem; line-height: 1.45; }
    .status-box.active { display: block; }
    .status-box.info { background: #eff6ff; color: #1e40af; border: 1px solid #bfdbfe; }
    .status-box.error { background: #fef2f2; color: #991b1b; border: 1px solid #fecaca; }
    .status-box.success { background: #f0fdf4; color: #166534; border: 1px solid #bbf7d0; }
    .results-container {
      display: none; margin-top: 24px; background: var(--card-bg); border-radius: var(--radius);
      box-shadow: var(--shadow); border: 1px solid var(--border-color); padding: 24px;
    }
    .results-container.active { display: block; }
    .results-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; padding-bottom: 12px; border-bottom: 1px solid var(--border-color); }
    .file-list { list-style: none; display: flex; flex-direction: column; gap: 8px; max-height: 360px; overflow-y: auto; }
    .file-item { display: flex; align-items: center; justify-content: space-between; padding: 10px 14px; background: #f8fafc; border-radius: 8px; border: 1px solid #e2e8f0; font-size: 0.88rem; }
    .badge-ok { background: #dcfce7; color: #15803d; padding: 2px 8px; border-radius: 12px; font-size: 0.75rem; font-weight: 700; }
    .badge-fallback { background: #fef3c7; color: #b45309; padding: 2px 8px; border-radius: 12px; font-size: 0.75rem; font-weight: 700; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Procesamiento de Manifiestos</h1>
      <p>División dinámica por página, OCR y descarga de paquete .ZIP</p>
    </div>
    <div class="card">
      <div class="file-dropzone" id="dropzone">
        <svg class="file-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
        </svg>
        <div class="file-label">Selecciona o arrastra tu archivo PDF</div>
        <div class="file-hint">Formato admitido: exclusivamente archivos con formato .pdf</div>
        <input type="file" id="manifestPdf" accept=".pdf" />
      </div>
      <div class="selected-file-info" id="fileInfo">
        <span id="fileNameDisplay"></span>
      </div>
      <button type="button" class="btn-action" id="btnProcess" disabled>
        <span id="btnText">Procesar Manifiesto</span>
      </button>
      <div class="status-box" id="statusBox"></div>
      <a href="#" class="btn-download-large" id="btnDownloadZip">
        <span>Descargar archivos procesados (.ZIP)</span>
      </a>
    </div>
    <div class="results-container" id="resultsContainer">
      <div class="results-header">
        <h3>Detalle de Páginas Procesadas</h3>
        <span id="badgeTotal" style="font-weight:700; color:#334155;">0 páginas</span>
      </div>
      <ul class="file-list" id="fileList"></ul>
    </div>
  </div>
  <script>
    const fileInput = document.getElementById('manifestPdf');
    const fileInfo = document.getElementById('fileInfo');
    const fileNameDisplay = document.getElementById('fileNameDisplay');
    const btnProcess = document.getElementById('btnProcess');
    const btnText = document.getElementById('btnText');
    const statusBox = document.getElementById('statusBox');
    const btnDownloadZip = document.getElementById('btnDownloadZip');
    const resultsContainer = document.getElementById('resultsContainer');
    const badgeTotal = document.getElementById('badgeTotal');
    const fileList = document.getElementById('fileList');

    let selectedFile = null;

    fileInput.addEventListener('change', (e) => {
      if (e.target.files && e.target.files[0]) {
        const file = e.target.files[0];
        if (!file.name.toLowerCase().endsWith('.pdf')) {
          statusBox.textContent = 'Error: Solo se permiten archivos .pdf';
          statusBox.className = 'status-box active error';
          return;
        }
        selectedFile = file;
        fileNameDisplay.textContent = file.name + ' (' + (file.size / (1024*1024)).toFixed(2) + ' MB)';
        fileInfo.classList.add('active');
        btnProcess.disabled = false;
        btnDownloadZip.classList.remove('active');
        statusBox.className = 'status-box';
        resultsContainer.classList.remove('active');
      }
    });

    btnProcess.addEventListener('click', async () => {
      if (!selectedFile) return;
      btnProcess.disabled = true;
      btnText.textContent = 'Procesando en la nube... Por favor espere';
      statusBox.textContent = 'Contando páginas, ejecutando OCR en memoria y empaquetando el archivo ZIP...';
      statusBox.className = 'status-box active info';
      btnDownloadZip.classList.remove('active');
      resultsContainer.classList.remove('active');

      const formData = new FormData();
      formData.append('manifestPdf', selectedFile);

      try {
        const res = await fetch('/api/process-manifest', { method: 'POST', body: formData });
        const data = await res.json();
        if (!res.ok || data.error) throw new Error(data.error || 'Error en el servidor');

        statusBox.textContent = '¡Procesamiento exitoso! Se procesaron dinámicamente ' + data.totalPages + ' páginas.';
        statusBox.className = 'status-box active success';

        btnDownloadZip.href = '/api/download-zip/' + data.downloadId;
        btnDownloadZip.classList.add('active');

        badgeTotal.textContent = data.totalPages + ' página(s)';
        fileList.innerHTML = '';
        data.files.forEach(f => {
          const li = document.createElement('li');
          li.className = 'file-item';
          const badgeClass = f.status === 'DETECTADA' ? 'badge-ok' : 'badge-fallback';
          li.innerHTML = '<div><strong>' + f.fileName + '</strong></div><span class="' + badgeClass + '">' + f.status + '</span>';
          fileList.appendChild(li);
        });
        resultsContainer.classList.add('active');
      } catch (err) {
        statusBox.textContent = 'Error: ' + err.message;
        statusBox.className = 'status-box active error';
      } finally {
        btnProcess.disabled = false;
        btnText.textContent = 'Procesar Manifiesto';
      }
    });
  </script>
</body>
</html>
"""

def extract_and_clean_razon_social(text):
    if not text:
        return None
    # Unificar saltos de línea y espacios en blanco
    normalized = " ".join(text.split())
    # Buscar frase exacta: "RAZON SOCIAL DE LA EMPRESA GENERADORA:" hasta "DOMICILIO:"
    match = re.search(r"RAZ[OÓ]N\s+SOCIAL\s+DE\s+LA\s+EMPRESA\s+GENERADORA\s*:\s*(.*?)\s*DOMICILIO\s*:", normalized, re.IGNORECASE)
    if not match or not match.group(1):
        return None
    extracted = match.group(1).strip()
    # Limpiar espacios dobles
    extracted = re.sub(r"\s{2,}", " ", extracted)
    # Eliminar caracteres no permitidos en nombres de archivos (\ / : * ? " < > |)
    extracted = re.sub(r'[\\/:*?"<>|]', "", extracted)
    extracted = extracted.strip()
    return extracted if len(extracted) > 0 else None

@app.route("/")
def index():
    return render_template_string(HTML_TEMPLATE)

@app.route("/api/process-manifest", methods=["POST"])
def process_manifest():
    if "manifestPdf" not in request.files:
        return jsonify({"error": "No se ha subido ningún archivo PDF."}), 400

    uploaded_file = request.files["manifestPdf"]
    if not uploaded_file.filename.lower().endswith(".pdf"):
        return jsonify({"error": "Solo se permiten archivos con formato .pdf."}), 400

    pdf_bytes = uploaded_file.read()
    reader = PdfReader(io.BytesIO(pdf_bytes))
    total_pages = len(reader.pages)

    if total_pages == 0:
        return jsonify({"error": "El archivo PDF no contiene páginas."}), 400

    # Abrir documento con PyMuPDF para renderizado de imagen OCR
    fitz_doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    files_in_memory = []

    # Procesamiento dinámico página por página
    for page_index in range(total_pages):
        consecutive_number = page_index + 1

        # A) División del archivo: 1 archivo PDF independiente por página
        writer = PdfWriter()
        writer.add_page(reader.pages[page_index])
        single_page_buffer = io.BytesIO()
        writer.write(single_page_buffer)
        single_page_bytes = single_page_buffer.getvalue()

        # B) Extracción OCR / Texto
        page = fitz_doc.load_page(page_index)
        page_text = page.get_text()

        # Si el PDF es un escaneo/imagen, aplicar OCR mediante Tesseract si está instalado
        if len(page_text.strip()) < 15 and pytesseract is not None:
            try:
                pix = page.get_pixmap(dpi=150)
                img = Image.open(io.BytesIO(pix.tobytes("png")))
                ocr_text = pytesseract.image_to_string(img, lang="spa")
                if ocr_text.strip():
                    page_text = ocr_text
            except Exception as ocr_err:
                print(f"Advertencia OCR en pág {consecutive_number}: {ocr_err}")

        # C) Extracción específica y limpieza
        razon_social = extract_and_clean_razon_social(page_text)

        # 3. Nomenclatura exacta
        if razon_social:
            filename = f"{razon_social}_{consecutive_number}.pdf"
            status = "DETECTADA"
        else:
            filename = f"EMPRESA_NO_DETECTADA_{consecutive_number}.pdf"
            status = "EMPRESA_NO_DETECTADA"

        files_in_memory.append({
            "page": consecutive_number,
            "filename": filename,
            "bytes": single_page_bytes,
            "status": status
        })

    # Empaquetar todo en un único archivo .ZIP en memoria
    zip_buffer = io.BytesIO()
    with zipfile.ZipFile(zip_buffer, "w", zipfile.ZIP_DEFLATED) as zf:
        for item in files_in_memory:
            zf.writestr(item["filename"], item["bytes"])

    zip_bytes = zip_buffer.getvalue()
    download_id = str(uuid.uuid4())
    zip_storage[download_id] = zip_bytes

    return jsonify({
        "success": True,
        "totalPages": total_pages,
        "downloadId": download_id,
        "files": [{"page": f["page"], "fileName": f["filename"], "status": f["status"]} for f in files_in_memory]
    })

@app.route("/api/download-zip/<download_id>")
def download_zip(download_id):
    zip_bytes = zip_storage.get(download_id)
    if not zip_bytes:
        return "El enlace de descarga ha expirado o no es válido.", 404

    return send_file(
        io.BytesIO(zip_bytes),
        mimetype="application/zip",
        as_attachment=True,
        download_name="manifiestos_procesados.zip"
    )

if __name__ == "__main__":
    print(f"Servidor Python activo en el puerto {PORT}")
    app.run(host="0.0.0.0", port=PORT)
