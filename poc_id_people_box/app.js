// Person Tracker - 100% Browser-based with ONNX Runtime Web
// OPTIMIZED VERSION
// ============================================================

const CONFIG = {
    MODEL_PATH: 'yolov8n.onnx',
    INPUT_SIZE: 640,  // Debe coincidir con el tamaño del modelo exportado
    CONFIDENCE: 0.3,
    IOU_THRESHOLD: 0.45,
    MAX_TRACK_LEN: 20,  // Reducido para menos memoria
    BOX_ALPHA: 0.6,
    BACKGROUND_DIM: 0.08,
    PROCESS_EVERY_N_FRAMES: 4,  // Procesar cada 4 frames para compensar el tamaño mayor
    MAX_DETECTIONS: 50  // Límite de detecciones para procesar
};

const PALETTE = [
    [255, 200, 0], [100, 255, 0], [50, 50, 255], [255, 0, 200],
    [255, 255, 0], [0, 200, 255], [255, 100, 100], [180, 180, 0]
];

let session = null;
let webcamStream = null;
let animationId = null;
let trajectories = new Map();
let stats = { fps: 0, processTime: 0, personCount: 0 };
let lastFrameTime = Date.now();
let frameCounter = 0;
let lastDetections = [];
let lastTracked = [];
let trackIdCounter = 0;

// Buffers reutilizables para evitar allocaciones
let preprocessBuffer = null;
let offscreenCanvas = null;
let offscreenCtx = null;

const elements = {
    webcam: document.getElementById('webcam'),
    output: document.getElementById('output'),
    loading: document.getElementById('loading'),
    app: document.getElementById('app'),
    status: document.getElementById('status'),
    startBtn: document.getElementById('startBtn'),
    stopBtn: document.getElementById('stopBtn'),
    clearBtn: document.getElementById('clearBtn'),
    bgMode: document.getElementById('bgMode'),
    showTrajectories: document.getElementById('showTrajectories'),
    mirrorMode: document.getElementById('mirrorMode'),
    personCount: document.getElementById('personCount'),
    fps: document.getElementById('fps'),
    processTime: document.getElementById('processTime')
};

function getColor(trackId) {
    return PALETTE[trackId % PALETTE.length];
}

function updateStatus(message, type = 'info') {
    elements.status.textContent = message;
    elements.status.className = 'status';
    if (type === 'error') elements.status.classList.add('error');
    if (type === 'success') elements.status.classList.add('success');
}

function updateStats() {
    elements.personCount.textContent = stats.personCount;
    elements.fps.textContent = stats.fps;
    elements.processTime.textContent = stats.processTime;
}

async function loadModel() {
    try {
        updateStatus('⏳ Cargando modelo YOLO...');
        
        // FORZAR WASM - No usar WebGL que tiene problemas con resize
        console.log('FORZANDO uso de WASM (no WebGL)');
        
        session = await ort.InferenceSession.create(CONFIG.MODEL_PATH, {
            executionProviders: ['wasm'],
            graphOptimizationLevel: 'all',
            enableCpuMemArena: true,
            enableMemPattern: true
        });
        
        // Pre-alocar buffer de preprocesamiento
        const bufferSize = 3 * CONFIG.INPUT_SIZE * CONFIG.INPUT_SIZE;
        preprocessBuffer = new Float32Array(bufferSize);
        
        // Crear OffscreenCanvas para preprocesamiento más rápido
        offscreenCanvas = new OffscreenCanvas(CONFIG.INPUT_SIZE, CONFIG.INPUT_SIZE);
        offscreenCtx = offscreenCanvas.getContext('2d', { 
            willReadFrequently: true,
            alpha: false 
        });
        
        const provider = session.executionProviders && session.executionProviders.length > 0 
            ? session.executionProviders[0] 
            : 'unknown';
        console.log('Modelo cargado con provider:', provider);
        updateStatus(`✅ Modelo cargado (${provider}). Haz clic en Iniciar cámara`, 'success');
        elements.loading.classList.add('hidden');
        elements.app.classList.remove('hidden');
    } catch (error) {
        console.error('Error:', error);
        updateStatus('❌ Error: Asegúrate de tener yolov8n.onnx en esta carpeta', 'error');
    }
}

async function startWebcam() {
    try {
        updateStatus('⏳ Solicitando acceso a la cámara...');
        
        webcamStream = await navigator.mediaDevices.getUserMedia({
            video: { 
                width: { ideal: 640 },
                height: { ideal: 480 },
                facingMode: 'user',
                frameRate: { ideal: 30, max: 30 }
            },
            audio: false
        });
        
        elements.webcam.srcObject = webcamStream;
        
        await new Promise((resolve) => {
            elements.webcam.onloadedmetadata = () => {
                elements.webcam.play();
                resolve();
            };
        });
        
        elements.startBtn.disabled = true;
        elements.stopBtn.disabled = false;
        updateStatus('📹 Cámara activa - Procesando...', 'success');
        
        processFrame();
    } catch (error) {
        console.error('Error accediendo a la cámara:', error);
        let errorMsg = '❌ Error: ';
        
        if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError') {
            errorMsg += 'Permiso denegado. Debes permitir el acceso a la cámara.';
        } else if (error.name === 'NotFoundError' || error.name === 'DevicesNotFoundError') {
            errorMsg += 'No se encontró ninguna cámara.';
        } else if (error.name === 'NotReadableError' || error.name === 'TrackStartError') {
            errorMsg += 'La cámara está siendo usada por otra aplicación.';
        } else if (error.name === 'NotSupportedError') {
            errorMsg += 'Navegador no compatible. Usa Chrome o Edge.';
        } else if (error.name === 'TypeError') {
            errorMsg += 'Debes usar HTTPS o localhost. No funciona con file://';
        } else {
            errorMsg += error.message || 'Error desconocido. Verifica la consola (F12).';
        }
        
        updateStatus(errorMsg, 'error');
    }
}

function stopWebcam() {
    if (webcamStream) {
        webcamStream.getTracks().forEach(track => track.stop());
        webcamStream = null;
    }
    if (animationId) {
        cancelAnimationFrame(animationId);
        animationId = null;
    }
    elements.startBtn.disabled = false;
    elements.stopBtn.disabled = true;
    updateStatus('⏸️ Detenido');
}

// Optimización: Función de dibujo más eficiente con batching
function drawAll(ctx, tracked, canvas, bgMode) {
    const boxAlpha = bgMode === 'opaque' ? 1.0 : CONFIG.BOX_ALPHA;
    const showTraj = elements.showTrajectories.checked;
    
    // Batch de operaciones de dibujo
    ctx.save();
    
    tracked.forEach(person => {
        const { x1, y1, x2, y2, trackId } = person;
        const color = getColor(trackId);
        const colorStr = `rgb(${color[0]}, ${color[1]}, ${color[2]})`;
        
        // Actualizar trayectoria
        const cx = (x1 + x2) / 2;
        const cy = (y1 + y2) / 2;
        
        if (!trajectories.has(trackId)) {
            trajectories.set(trackId, []);
        }
        const traj = trajectories.get(trackId);
        traj.push({ x: cx, y: cy });
        if (traj.length > CONFIG.MAX_TRACK_LEN) {
            traj.shift();
        }
        
        // Dibujar trayectoria
        if (showTraj && traj.length >= 2) {
            ctx.strokeStyle = colorStr;
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(traj[0].x, traj[0].y);
            for (let i = 1; i < traj.length; i++) {
                const alpha = i / traj.length;
                ctx.globalAlpha = alpha * 0.8;
                ctx.lineTo(traj[i].x, traj[i].y);
            }
            ctx.stroke();
            
            // Punto final
            ctx.globalAlpha = 1.0;
            ctx.fillStyle = colorStr;
            ctx.beginPath();
            ctx.arc(cx, cy, 4, 0, Math.PI * 2);
            ctx.fill();
        }
        
        // Dibujar caja
        ctx.globalAlpha = boxAlpha;
        ctx.fillStyle = colorStr;
        ctx.fillRect(x1, y1, x2 - x1, y2 - y1);
        ctx.globalAlpha = 1.0;
        ctx.strokeStyle = colorStr;
        ctx.lineWidth = 2;
        ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
        
        // Etiqueta
        const side = (x1 < canvas.width / 2) ? 'IZQ' : 'DER';
        const text = `#${trackId} ${side}`;
        ctx.font = '14px Arial';
        const metrics = ctx.measureText(text);
        
        ctx.fillStyle = colorStr;
        ctx.fillRect(x1, y1 - 20, metrics.width + 8, 20);
        ctx.fillStyle = '#000';
        ctx.fillText(text, x1 + 4, y1 - 5);
    });
    
    ctx.restore();
}

async function processFrame() {
    if (!session || !webcamStream) return;
    
    const canvas = elements.output;
    const ctx = canvas.getContext('2d', { alpha: false });
    
    canvas.width = elements.webcam.videoWidth || 640;
    canvas.height = elements.webcam.videoHeight || 480;
    
    const startTime = performance.now();
    
    // Dibujar video base
    if (elements.mirrorMode.checked) {
        ctx.save();
        ctx.scale(-1, 1);
        ctx.drawImage(elements.webcam, -canvas.width, 0, canvas.width, canvas.height);
        ctx.restore();
    } else {
        ctx.drawImage(elements.webcam, 0, 0, canvas.width, canvas.height);
    }
    
    // Procesar solo cada N frames
    frameCounter++;
    let detections = [];
    
    if (frameCounter % CONFIG.PROCESS_EVERY_N_FRAMES === 0) {
        try {
            detections = await detectPersons(canvas);
        } catch (error) {
            console.error('Error en detección:', error);
            detections = lastDetections;
        }
    } else {
        // Reutilizar detecciones anteriores
        detections = lastDetections;
    }
    
    // Aplicar fondo oscuro si es necesario
    const bgMode = elements.bgMode.value;
    if (bgMode === 'dark' && detections.length > 0) {
        ctx.fillStyle = `rgba(0, 0, 0, ${1 - CONFIG.BACKGROUND_DIM})`;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    
    // Tracking
    const tracked = frameCounter % CONFIG.PROCESS_EVERY_N_FRAMES === 0 
        ? simpleTracking(detections) 
        : lastTracked;
    
    // Dibujar todo (optimizado)
    drawAll(ctx, tracked, canvas, bgMode);
    
    // Limpiar trayectorias viejas (solo ocasionalmente)
    if (frameCounter % 30 === 0) {
        const activeIds = new Set(tracked.map(p => p.trackId));
        for (const [id, traj] of trajectories.entries()) {
            if (!activeIds.has(id)) {
                if (traj.length > 5) {
                    traj.splice(0, 5);
                } else {
                    trajectories.delete(id);
                }
            }
        }
    }
    
    stats.personCount = tracked.length;
    stats.processTime = Math.round(performance.now() - startTime);
    
    const now = Date.now();
    stats.fps = Math.round(1000 / (now - lastFrameTime));
    lastFrameTime = now;
    
    // Actualizar stats solo cada 10 frames
    if (frameCounter % 10 === 0) {
        updateStats();
    }
    
    animationId = requestAnimationFrame(processFrame);
}

// ──────────────────────────────────────────────
// DETECCIÓN YOLO Y PROCESAMIENTO OPTIMIZADO
// ──────────────────────────────────────────────

async function detectPersons(canvas) {
    const input = preprocessImageOptimized(canvas);
    
    const results = await session.run({ images: input });
    const output = results.output0.data;
    
    const detections = [];
    const numDetections = 8400;
    const scaleX = canvas.width / CONFIG.INPUT_SIZE;
    const scaleY = canvas.height / CONFIG.INPUT_SIZE;
    
    // Optimización: procesar solo hasta MAX_DETECTIONS con mayor confianza
    for (let i = 0; i < numDetections && detections.length < CONFIG.MAX_DETECTIONS; i++) {
        const personConf = output[4 * numDetections + i];
        
        if (personConf > CONFIG.CONFIDENCE) {
            const x = output[i];
            const y = output[numDetections + i];
            const w = output[2 * numDetections + i];
            const h = output[3 * numDetections + i];
            
            detections.push({
                x1: Math.max(0, (x - w / 2) * scaleX),
                y1: Math.max(0, (y - h / 2) * scaleY),
                x2: Math.min(canvas.width, (x + w / 2) * scaleX),
                y2: Math.min(canvas.height, (y + h / 2) * scaleY),
                score: personConf
            });
        }
    }
    
    return applyNMSOptimized(detections);
}

// Optimización: Usar OffscreenCanvas y reutilizar buffer
function preprocessImageOptimized(canvas) {
    const inputSize = CONFIG.INPUT_SIZE;
    
    // Redimensionar usando OffscreenCanvas (más rápido que pixel a pixel)
    offscreenCtx.drawImage(canvas, 0, 0, inputSize, inputSize);
    const imageData = offscreenCtx.getImageData(0, 0, inputSize, inputSize);
    const data = imageData.data;
    
    // Conversión optimizada usando el buffer pre-alocado
    const pixelCount = inputSize * inputSize;
    const channelSize = pixelCount;
    
    for (let i = 0; i < pixelCount; i++) {
        const srcIdx = i * 4;
        preprocessBuffer[i] = data[srcIdx] / 255.0;  // R
        preprocessBuffer[channelSize + i] = data[srcIdx + 1] / 255.0;  // G
        preprocessBuffer[channelSize * 2 + i] = data[srcIdx + 2] / 255.0;  // B
    }
    
    return new ort.Tensor('float32', preprocessBuffer, [1, 3, inputSize, inputSize]);
}

// Optimización: NMS más eficiente con early termination
function applyNMSOptimized(detections) {
    if (detections.length === 0) return [];
    if (detections.length === 1) return detections;
    
    // Ordenar por score (descendente)
    detections.sort((a, b) => b.score - a.score);
    
    const selected = [];
    const suppressed = new Array(detections.length).fill(false);
    
    for (let i = 0; i < detections.length; i++) {
        if (suppressed[i]) continue;
        
        selected.push(detections[i]);
        
        // Early termination si ya tenemos suficientes
        if (selected.length >= 20) break;
        
        const box1 = detections[i];
        
        for (let j = i + 1; j < detections.length; j++) {
            if (suppressed[j]) continue;
            
            const box2 = detections[j];
            const iou = calculateIoUFast(box1, box2);
            
            if (iou > CONFIG.IOU_THRESHOLD) {
                suppressed[j] = true;
            }
        }
    }
    
    return selected;
}

// Optimización: Cálculo de IoU más rápido
function calculateIoUFast(box1, box2) {
    const x1 = Math.max(box1.x1, box2.x1);
    const y1 = Math.max(box1.y1, box2.y1);
    const x2 = Math.min(box1.x2, box2.x2);
    const y2 = Math.min(box1.y2, box2.y2);
    
    if (x2 < x1 || y2 < y1) return 0;
    
    const intersection = (x2 - x1) * (y2 - y1);
    const area1 = (box1.x2 - box1.x1) * (box1.y2 - box1.y1);
    const area2 = (box2.x2 - box2.x1) * (box2.y2 - box2.y1);
    const union = area1 + area2 - intersection;
    
    return intersection / union;
}

function simpleTracking(detections) {
    const tracked = [];
    const usedLastIds = new Set();
    const MATCH_THRESHOLD = 200;  // Aumentado para mejor tracking
    
    detections.forEach(det => {
        let bestMatch = null;
        let bestDist = Infinity;
        const detCenter = { x: (det.x1 + det.x2) / 2, y: (det.y1 + det.y2) / 2 };
        
        lastDetections.forEach((lastDet, idx) => {
            if (usedLastIds.has(idx)) return;
            
            const lastCenter = { x: (lastDet.x1 + lastDet.x2) / 2, y: (lastDet.y1 + lastDet.y2) / 2 };
            const dx = detCenter.x - lastCenter.x;
            const dy = detCenter.y - lastCenter.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            
            if (dist < bestDist && dist < MATCH_THRESHOLD) {
                bestDist = dist;
                bestMatch = idx;
            }
        });
        
        let trackId;
        if (bestMatch !== null) {
            trackId = lastDetections[bestMatch].trackId;
            usedLastIds.add(bestMatch);
        } else {
            trackId = trackIdCounter++;
        }
        
        tracked.push({ ...det, trackId });
    });
    
    lastDetections = tracked;
    lastTracked = tracked;
    return tracked;
}

// Event listeners
elements.startBtn.addEventListener('click', startWebcam);
elements.stopBtn.addEventListener('click', stopWebcam);
elements.clearBtn.addEventListener('click', () => {
    trajectories.clear();
    trackIdCounter = 0;
    updateStatus('🗑️ Trayectorias limpiadas', 'success');
});

// Cargar modelo al inicio
loadModel();