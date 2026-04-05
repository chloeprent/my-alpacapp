// ============================================
// Supabase config (same anon key as main app)
// ============================================
const SUPABASE_URL = 'YOUR_SUPABASE_URL';
const SUPABASE_ANON_KEY = 'YOUR_SUPABASE_ANON_KEY';

// ============================================
// Browser/platform detection
// ============================================
function getBrowserInfo() {
  const ua = navigator.userAgent;
  let browserName = 'Unknown', browserVersion = '', osName = 'Unknown', osVersion = '';

  // Browser detection
  if (ua.includes('Firefox/')) {
    browserName = 'Firefox';
    browserVersion = ua.match(/Firefox\/([\d.]+)/)?.[1] || '';
  } else if (ua.includes('Edg/')) {
    browserName = 'Edge';
    browserVersion = ua.match(/Edg\/([\d.]+)/)?.[1] || '';
  } else if (ua.includes('Chrome/') && !ua.includes('Edg/')) {
    browserName = 'Chrome';
    browserVersion = ua.match(/Chrome\/([\d.]+)/)?.[1] || '';
  } else if (ua.includes('Safari/') && !ua.includes('Chrome/')) {
    browserName = 'Safari';
    browserVersion = ua.match(/Version\/([\d.]+)/)?.[1] || '';
  }

  // OS detection
  if (ua.includes('Windows NT')) {
    osName = 'Windows';
    const ntVer = ua.match(/Windows NT ([\d.]+)/)?.[1] || '';
    const winMap = { '10.0': '10/11', '6.3': '8.1', '6.2': '8', '6.1': '7' };
    osVersion = winMap[ntVer] || ntVer;
  } else if (ua.includes('Mac OS X')) {
    osName = 'macOS';
    osVersion = (ua.match(/Mac OS X ([\d_]+)/)?.[1] || '').replace(/_/g, '.');
  } else if (ua.includes('Android')) {
    osName = 'Android';
    osVersion = ua.match(/Android ([\d.]+)/)?.[1] || '';
  } else if (ua.includes('iPhone') || ua.includes('iPad')) {
    osName = 'iOS';
    osVersion = (ua.match(/OS ([\d_]+)/)?.[1] || '').replace(/_/g, '.');
  } else if (ua.includes('Linux')) {
    osName = 'Linux';
  } else if (ua.includes('CrOS')) {
    osName = 'ChromeOS';
  }

  // Device type
  const isMobile = /Android|iPhone|iPod/i.test(ua);
  const isTablet = /iPad|Android(?!.*Mobile)/i.test(ua);
  const deviceType = isTablet ? 'tablet' : isMobile ? 'mobile' : 'desktop';

  return {
    user_agent: ua,
    browser_name: browserName,
    browser_version: browserVersion,
    os_name: osName,
    os_version: osVersion,
    screen_resolution: `${screen.width}x${screen.height}`,
    viewport_size: `${window.innerWidth}x${window.innerHeight}`,
    device_type: deviceType,
    extension_platform: 'firefox',
    extension_version: browser.runtime.getManifest().version,
  };
}

// ============================================
// State
// ============================================
let screenshotDataUrl = null;
let pageUrl = '';
let currentTool = 'draw';
let annotationColor = '#ff0000';
let isDrawing = false;
let startX = 0, startY = 0;
let annotations = []; // history for undo
let screenshotImg = null;

// Pending text annotation position (for inline text input)
let pendingTextPos = null;

// ============================================
// Autosave draft to browser.storage.local
// ============================================
let saveTimeout = null;

function saveDraft(immediate) {
  if (!browser?.storage?.local) return;
  if (saveTimeout) clearTimeout(saveTimeout);
  const doSave = () => {
    const draft = {
      currentStep: getCurrentStep(),
      screenshotDataUrl,
      pageUrl,
      annotations,
      description: inputDescription?.value || '',
      currentTool,
      annotationColor,
    };
    browser.storage.local.set({ bugReportDraft: draft });
  };
  if (immediate) { doSave(); } else { saveTimeout = setTimeout(doSave, 300); }
}

function clearDraft() {
  if (browser?.storage?.local) browser.storage.local.remove('bugReportDraft');
}

function getCurrentStep() {
  if (!stepCapture.classList.contains('hidden')) return 'capture';
  if (!stepAnnotate.classList.contains('hidden')) return 'annotate';
  if (!stepSubmit.classList.contains('hidden')) return 'submit';
  if (!stepDone.classList.contains('hidden')) return 'done';
  return 'capture';
}

// ============================================
// DOM refs
// ============================================
const stepCapture = document.getElementById('step-capture');
const stepAnnotate = document.getElementById('step-annotate');
const stepSubmit = document.getElementById('step-submit');
const stepDone = document.getElementById('step-done');

const btnCapture = document.getElementById('btn-capture');
const btnNext = document.getElementById('btn-next');
const btnSubmit = document.getElementById('btn-submit');
const btnAnother = document.getElementById('btn-another');
const btnUndo = document.getElementById('btn-undo');
const btnClear = document.getElementById('btn-clear');
const btnBackAnnotate = document.getElementById('btn-back-annotate');

const canvas = document.getElementById('annotation-canvas');
const ctx = canvas.getContext('2d');
const colorPicker = document.getElementById('annotation-color');

const inputName = document.getElementById('input-name');
const inputEmail = document.getElementById('input-email');
const inputDescription = document.getElementById('input-description');
const previewImg = document.getElementById('preview-img');
const submitStatus = document.getElementById('submit-status');
const doneEmail = document.getElementById('done-email');

// Text input overlay elements
const textInputOverlay = document.getElementById('text-input-overlay');
const textInputField = document.getElementById('text-input-field');
const textInputCancel = document.getElementById('text-input-cancel');
const textInputOk = document.getElementById('text-input-ok');

// ============================================
// Step navigation
// ============================================
function showStep(step) {
  [stepCapture, stepAnnotate, stepSubmit, stepDone].forEach(s => s.classList.add('hidden'));
  step.classList.remove('hidden');
}

// ============================================
// Capture screenshot
// ============================================
btnCapture.addEventListener('click', async () => {
  try {
    btnCapture.disabled = true;
    btnCapture.textContent = 'Capturing...';

    // Get current tab URL
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    pageUrl = tab?.url || '';

    // Capture visible tab
    screenshotDataUrl = await browser.tabs.captureVisibleTab(null, { format: 'png' });

    // Load into canvas
    screenshotImg = new Image();
    screenshotImg.onload = () => {
      setupCanvas();
      showStep(stepAnnotate);
      saveDraft(true);
    };
    screenshotImg.src = screenshotDataUrl;
  } catch (err) {
    btnCapture.textContent = 'Capture Screenshot';
    btnCapture.disabled = false;
    console.error('Capture failed:', err);
  }
});

// ============================================
// Dynamic canvas sizing
// ============================================
function setupCanvas() {
  if (!screenshotImg) return;
  const container = document.getElementById('canvas-container');
  const maxW = container.clientWidth || 388;
  const scale = Math.min(1, maxW / screenshotImg.width);
  canvas.width = screenshotImg.width * scale;
  canvas.height = screenshotImg.height * scale;
  redrawCanvas();
}

// Recalculate on orientation change or resize
window.addEventListener('resize', () => {
  if (screenshotImg && !stepAnnotate.classList.contains('hidden')) {
    setupCanvas();
  }
});

// ============================================
// Annotation tools
// ============================================
document.querySelectorAll('.tool[data-tool]').forEach(btn => {
  btn.addEventListener('click', () => {
    currentTool = btn.dataset.tool;
    document.querySelectorAll('.tool[data-tool]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    saveDraft();
  });
});

colorPicker.addEventListener('input', (e) => {
  annotationColor = e.target.value;
  saveDraft();
});

// ============================================
// Canvas drawing
// ============================================
function redrawCanvas() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (screenshotImg) {
    ctx.drawImage(screenshotImg, 0, 0, canvas.width, canvas.height);
  }
  annotations.forEach(drawAnnotation);
}

function drawAnnotation(a) {
  ctx.strokeStyle = a.color;
  ctx.fillStyle = a.color;
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  switch (a.type) {
    case 'draw':
      if (a.points.length < 2) return;
      ctx.beginPath();
      ctx.moveTo(a.points[0].x, a.points[0].y);
      for (let i = 1; i < a.points.length; i++) {
        ctx.lineTo(a.points[i].x, a.points[i].y);
      }
      ctx.stroke();
      break;

    case 'arrow':
      drawArrow(ctx, a.x1, a.y1, a.x2, a.y2, a.color);
      break;

    case 'text':
      ctx.font = 'bold 14px sans-serif';
      // Background for readability
      const metrics = ctx.measureText(a.text);
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(a.x - 2, a.y - 14, metrics.width + 4, 18);
      ctx.fillStyle = a.color;
      ctx.fillText(a.text, a.x, a.y);
      break;

    case 'rect':
      ctx.strokeRect(a.x, a.y, a.w, a.h);
      break;
  }
}

function drawArrow(ctx, x1, y1, x2, y2, color) {
  const headLen = 10;
  const angle = Math.atan2(y2 - y1, x2 - x1);

  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();

  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - headLen * Math.cos(angle - Math.PI / 6), y2 - headLen * Math.sin(angle - Math.PI / 6));
  ctx.lineTo(x2 - headLen * Math.cos(angle + Math.PI / 6), y2 - headLen * Math.sin(angle + Math.PI / 6));
  ctx.closePath();
  ctx.fill();
}

function getCanvasPos(e) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (e.clientX - rect.left) * (canvas.width / rect.width),
    y: (e.clientY - rect.top) * (canvas.height / rect.height)
  };
}

// Current in-progress annotation
let currentAnnotation = null;

// ============================================
// Pointer events (unified mouse + touch)
// ============================================
canvas.addEventListener('pointerdown', (e) => {
  isDrawing = true;
  const pos = getCanvasPos(e);
  startX = pos.x;
  startY = pos.y;

  if (currentTool === 'draw') {
    currentAnnotation = { type: 'draw', color: annotationColor, points: [pos] };
  } else if (currentTool === 'text') {
    pendingTextPos = pos;
    showTextInput();
    isDrawing = false;
  }
});

canvas.addEventListener('pointermove', (e) => {
  if (!isDrawing) return;
  const pos = getCanvasPos(e);

  if (currentTool === 'draw' && currentAnnotation) {
    currentAnnotation.points.push(pos);
    redrawCanvas();
    drawAnnotation(currentAnnotation);
  } else if (currentTool === 'arrow' || currentTool === 'rect') {
    redrawCanvas();
    if (currentTool === 'arrow') {
      drawArrow(ctx, startX, startY, pos.x, pos.y, annotationColor);
    } else {
      ctx.strokeStyle = annotationColor;
      ctx.lineWidth = 2;
      ctx.strokeRect(startX, startY, pos.x - startX, pos.y - startY);
    }
  }
});

canvas.addEventListener('pointerup', (e) => {
  if (!isDrawing) return;
  isDrawing = false;
  const pos = getCanvasPos(e);

  if (currentTool === 'draw' && currentAnnotation) {
    annotations.push(currentAnnotation);
    currentAnnotation = null;
  } else if (currentTool === 'arrow') {
    annotations.push({ type: 'arrow', color: annotationColor, x1: startX, y1: startY, x2: pos.x, y2: pos.y });
  } else if (currentTool === 'rect') {
    annotations.push({ type: 'rect', color: annotationColor, x: startX, y: startY, w: pos.x - startX, h: pos.y - startY });
  }
  redrawCanvas();
  saveDraft();
});

canvas.addEventListener('pointerleave', () => {
  if (isDrawing && currentTool === 'draw' && currentAnnotation) {
    annotations.push(currentAnnotation);
    currentAnnotation = null;
    isDrawing = false;
    redrawCanvas();
    saveDraft();
  }
});

canvas.addEventListener('pointercancel', () => {
  if (isDrawing && currentTool === 'draw' && currentAnnotation) {
    annotations.push(currentAnnotation);
    currentAnnotation = null;
    isDrawing = false;
    redrawCanvas();
    saveDraft();
  }
});

// ============================================
// Inline text input (replaces prompt())
// ============================================
function showTextInput() {
  textInputField.value = '';
  textInputOverlay.classList.remove('hidden');
  textInputField.focus();
}

function hideTextInput() {
  textInputOverlay.classList.add('hidden');
  pendingTextPos = null;
}

function commitTextAnnotation() {
  const text = textInputField.value.trim();
  if (text && pendingTextPos) {
    annotations.push({ type: 'text', color: annotationColor, x: pendingTextPos.x, y: pendingTextPos.y, text });
    redrawCanvas();
    saveDraft();
  }
  hideTextInput();
}

textInputOk.addEventListener('click', commitTextAnnotation);
textInputCancel.addEventListener('click', hideTextInput);
textInputField.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    commitTextAnnotation();
  } else if (e.key === 'Escape') {
    hideTextInput();
  }
});

// ============================================
// Undo / Clear
// ============================================
btnUndo.addEventListener('click', () => {
  annotations.pop();
  redrawCanvas();
  saveDraft();
});

btnClear.addEventListener('click', () => {
  annotations = [];
  redrawCanvas();
  saveDraft();
});

// ============================================
// Navigate between annotate and submit
// ============================================
btnNext.addEventListener('click', () => {
  // Export annotated canvas as preview
  previewImg.src = canvas.toDataURL('image/png');
  showStep(stepSubmit);
  saveDraft(true);
});

btnBackAnnotate.addEventListener('click', () => {
  showStep(stepAnnotate);
  saveDraft(true);
});

// ============================================
// Load saved reporter info
// ============================================
const savedName = localStorage.getItem('bugReporter_name') || '';
const savedEmail = localStorage.getItem('bugReporter_email') || '';
inputName.value = savedName;
inputEmail.value = savedEmail;

// ============================================
// Submit bug report
// ============================================
btnSubmit.addEventListener('click', async () => {
  const name = inputName.value.trim();
  const email = inputEmail.value.trim();
  const description = inputDescription.value.trim();

  if (!name || !email || !description) {
    showStatus('Please fill in all fields.', 'error');
    return;
  }

  // Save reporter info
  localStorage.setItem('bugReporter_name', name);
  localStorage.setItem('bugReporter_email', email);

  btnSubmit.disabled = true;
  btnSubmit.textContent = 'Submitting...';
  showStatus('Uploading screenshot...', 'info');

  try {
    // 1. Export annotated canvas to blob
    const blob = await new Promise(resolve => {
      canvas.toBlob(resolve, 'image/png');
    });

    // 2. Upload to Supabase Storage
    const filename = `bug-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`;
    const uploadRes = await fetch(`${SUPABASE_URL}/storage/v1/object/bug-screenshots/${filename}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        'apikey': SUPABASE_ANON_KEY,
        'Content-Type': 'image/png',
      },
      body: blob,
    });

    if (!uploadRes.ok) {
      throw new Error(`Upload failed: ${uploadRes.status}`);
    }

    const screenshotUrl = `${SUPABASE_URL}/storage/v1/object/public/bug-screenshots/${filename}`;

    // 3. Insert bug report row
    showStatus('Saving report...', 'info');
    const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/bug_reports`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        'apikey': SUPABASE_ANON_KEY,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify({
        reporter_name: name,
        reporter_email: email,
        description: description,
        screenshot_url: screenshotUrl,
        page_url: pageUrl,
        ...getBrowserInfo(),
      }),
    });

    if (!insertRes.ok) {
      throw new Error(`Save failed: ${insertRes.status}`);
    }

    // 4. Done!
    clearDraft();
    doneEmail.textContent = email;
    showStep(stepDone);

  } catch (err) {
    console.error('Submit error:', err);
    showStatus(`Error: ${err.message}. Please try again.`, 'error');
    btnSubmit.disabled = false;
    btnSubmit.textContent = 'Submit Bug Report';
  }
});

function showStatus(msg, type) {
  submitStatus.textContent = msg;
  submitStatus.className = type;
  submitStatus.classList.remove('hidden');
}

// ============================================
// Report another bug
// ============================================
btnAnother.addEventListener('click', () => {
  screenshotDataUrl = null;
  annotations = [];
  currentAnnotation = null;
  inputDescription.value = '';
  submitStatus.classList.add('hidden');
  btnSubmit.disabled = false;
  btnSubmit.textContent = 'Submit Bug Report';
  btnCapture.disabled = false;
  btnCapture.textContent = 'Capture Screenshot';
  clearDraft();
  showStep(stepCapture);
});

// ============================================
// Restore draft on popup open
// ============================================
if (browser?.storage?.local) {
  browser.storage.local.get('bugReportDraft').then(({ bugReportDraft: draft }) => {
    if (!draft || !draft.screenshotDataUrl) return;

    // Restore state
    screenshotDataUrl = draft.screenshotDataUrl;
    pageUrl = draft.pageUrl || '';
    annotations = draft.annotations || [];
    currentTool = draft.currentTool || 'draw';
    annotationColor = draft.annotationColor || '#ff0000';

    // Restore UI elements
    colorPicker.value = annotationColor;
    if (draft.description) inputDescription.value = draft.description;

    // Update active tool button
    document.querySelectorAll('.tool[data-tool]').forEach(b => {
      b.classList.toggle('active', b.dataset.tool === currentTool);
    });

    // Load screenshot and redraw canvas
    screenshotImg = new Image();
    screenshotImg.onload = () => {
      setupCanvas();

      // Navigate to saved step
      if (draft.currentStep === 'submit') {
        previewImg.src = canvas.toDataURL('image/png');
        showStep(stepSubmit);
      } else if (draft.currentStep === 'annotate') {
        showStep(stepAnnotate);
      }
      // Don't restore to 'done' — that means it was already submitted
    };
    screenshotImg.src = screenshotDataUrl;
  });
}

// ============================================
// Autosave on description input (debounced)
// ============================================
inputDescription.addEventListener('input', () => saveDraft());
