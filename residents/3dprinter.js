import { initResidentPage, showToast } from '../shared/resident-shell.js';

const STORAGE_KEY = 'aap_3dprinter_projects_v1';
const PRINTER_PROFILE = {
  name: 'Flashforge Adventurer 5M Pro',
  buildVolume: { x: 220, y: 220, z: 220 },
  nozzleMm: 0.4,
  material: 'PLA',
  safeDefaults: { nozzleC: 210, bedC: 60, speedMmS: 120 },
};

const STAGES = ['discover', 'brainstorm', 'model', 'print', 'history'];
const STAGE_LABELS = {
  discover: 'Discover',
  brainstorm: 'Brainstorm',
  model: 'Model',
  print: 'Print',
  history: 'History',
};

const DISCOVERY_CATEGORIES = [
  'Utility',
  'Art/Decor',
  'Toys/Games',
  'Gifts',
  'Organization',
  'Repair/Replacement',
  'Educational/STEM',
  'Seasonal/Holiday',
  'Surprise me',
];

const QUESTION_BANK = {
  Utility: [
    { id: 'problem', prompt: 'What daily annoyance should this solve?', options: ['Desk clutter', 'Cable mess', 'Kitchen helper', 'Tool organization'], open: true },
    { id: 'size', prompt: 'How big should it be?', options: ['Pocket-sized', 'Palm-sized', 'Desk-sized', 'No preference'] },
    { id: 'strength', prompt: 'What matters most?', options: ['Fast print', 'Strong part', 'Looks clean', 'Balanced'] },
  ],
  'Repair/Replacement': [
    { id: 'broken', prompt: 'What broke?', options: ['Handle/knob', 'Clip/latch', 'Bracket/mount', 'Other'], open: true },
    { id: 'dims', prompt: 'Do you know rough dimensions?', options: ['Exact mm', 'Approximate', 'Can measure later', 'No'] },
    { id: 'fit', prompt: 'How important is fit tolerance?', options: ['Critical fit', 'Moderate', 'Loose fit', 'Not sure'] },
  ],
  Gifts: [
    { id: 'forWho', prompt: 'Who is it for?', options: ['Kid', 'Friend', 'Family', 'Coworker'], open: true },
    { id: 'style', prompt: 'Preferred style?', options: ['Minimal', 'Cute', 'Geeky', 'Playful'] },
    { id: 'speed', prompt: 'Gift deadline?', options: ['Today', 'This week', 'No rush', 'Unknown'] },
  ],
  default: [
    { id: 'goal', prompt: 'What do you want this print to do?', options: ['Solve a problem', 'Look cool', 'Teach something', 'Just for fun'], open: true },
    { id: 'risk', prompt: 'Pick your first-print style', options: ['Safest first print', 'Balanced', 'Creative', 'Most ambitious'] },
    { id: 'size', prompt: 'Preferred size range?', options: ['Small', 'Medium', 'Large', 'Unsure'] },
  ],
};

let appState = {
  stage: 'discover',
  selectedCategory: '',
  questions: [],
  qIndex: 0,
  answers: {},
  ideas: [],
  selectedIdea: null,
  brainstormSeed: '',
  preferences: { strengthVsSpeed: 50, aestheticsVsUtility: 50, materialVsDurability: 50 },
  concepts: [],
  selectedConceptId: '',
  modelSpec: null,
  validation: null,
  printPlan: null,
  currentJob: null,
  projects: [],
};

let progressTimer = null;

function esc(value) {
  const node = document.createElement('div');
  node.textContent = String(value ?? '');
  return node.innerHTML;
}

function loadProjects() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
  } catch {
    return [];
  }
}

function saveProjects(projects) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(projects));
}

function nowIso() {
  return new Date().toISOString();
}

function difficultyFromPrefs() {
  const p = appState.preferences;
  if (p.strengthVsSpeed > 70 && p.materialVsDurability > 65) return 'hard';
  if (p.strengthVsSpeed < 35) return 'easy';
  return 'medium';
}

function estimateFromScale(dimensions) {
  const vol = (dimensions.x * dimensions.y * dimensions.z) / 1000;
  return {
    estimated_time_min: Math.max(35, Math.round(vol * 0.75)),
    estimated_filament_g: Math.max(12, Math.round(vol * 0.18)),
  };
}

function selectQuestions(category) {
  const source = QUESTION_BANK[category] || QUESTION_BANK.default;
  const count = Math.min(5, Math.max(3, source.length));
  return source.slice(0, count);
}

function confidenceScore() {
  const answered = Object.keys(appState.answers).length;
  const max = Math.max(1, appState.questions.length);
  const completeFactor = answered / max;
  const textBonus = appState.answers.__textCount ? 0.1 : 0;
  return Math.min(0.95, Number((completeFactor * 0.85 + textBonus).toFixed(2)));
}

function generateIdeaPack() {
  const category = appState.selectedCategory || 'Utility';
  const riskBias = appState.answers.risk || 'Safest first print';
  const safeFirst = /safe|first/i.test(riskBias);
  const templates = [
    { title: 'Cable Dock Clip', value: 'Stops cable slip on desk edges', dims: { x: 48, y: 20, z: 16 }, risks: ['Bed adhesion on narrow base'] },
    { title: 'Snap Lid Organizer', value: 'Sorts tiny parts with quick-open lid', dims: { x: 84, y: 64, z: 28 }, risks: ['Hinge tolerance can be tight'] },
    { title: 'Phone Stand Fold', value: 'Adjustable angle stand for desk use', dims: { x: 96, y: 70, z: 84 }, risks: ['Overhang near hinge bracket'] },
    { title: 'Wall Hook Compact', value: 'Small hook for keys or tools', dims: { x: 40, y: 30, z: 55 }, risks: ['Layer split if wall too thin'] },
    { title: 'Desk Name Totem', value: 'Personalized display block', dims: { x: 100, y: 24, z: 32 }, risks: ['Tiny text may blur at draft quality'] },
  ];

  const ideas = templates.map((t, idx) => {
    const est = estimateFromScale(t.dims);
    return {
      id: `${category.toLowerCase().replace(/\W+/g, '-')}-${idx + 1}`,
      rank: idx + 1,
      title: category === 'Surprise me' ? `Surprise: ${t.title}` : `${category}: ${t.title}`,
      summary: t.value,
      estimated_time_min: est.estimated_time_min,
      estimated_filament_g: est.estimated_filament_g,
      difficulty: idx === 0 || safeFirst ? 'easy' : idx > 3 ? 'hard' : 'medium',
      risk_notes: t.risks,
      best_first: idx === 0 || safeFirst,
    };
  });
  appState.ideas = ideas;
}

function refineIdeas(mode) {
  appState.ideas = appState.ideas.map((idea) => {
    const next = { ...idea };
    if (mode === 'Make simpler') {
      next.difficulty = 'easy';
      next.estimated_time_min = Math.max(20, Math.round(next.estimated_time_min * 0.8));
      next.risk_notes = ['Reduced geometry complexity for first-print success'];
    } else if (mode === 'More creative') {
      next.summary = `${next.summary} with stylized accents`;
      next.difficulty = next.difficulty === 'easy' ? 'medium' : 'hard';
    } else if (mode === 'Faster print') {
      next.estimated_time_min = Math.max(18, Math.round(next.estimated_time_min * 0.7));
      next.estimated_filament_g = Math.max(8, Math.round(next.estimated_filament_g * 0.85));
    } else if (mode === 'Stronger') {
      next.risk_notes = ['Use thicker walls (>=2.0mm)', 'Lower speed for stronger layer bonding'];
    } else if (mode === 'Smaller') {
      next.estimated_time_min = Math.max(16, Math.round(next.estimated_time_min * 0.75));
      next.estimated_filament_g = Math.max(6, Math.round(next.estimated_filament_g * 0.7));
      next.summary = `${next.summary} in a compact footprint`;
    }
    return next;
  });
  render();
}

function generateConcepts() {
  const seed = appState.brainstormSeed || appState.selectedIdea?.title || 'Utility part';
  const base = appState.selectedIdea?.estimated_time_min || 90;
  const diff = difficultyFromPrefs();
  appState.concepts = [
    {
      id: 'conservative',
      lane: 'Conservative',
      name: `${seed} - Safe Start`,
      intended_use: 'Highest chance first success with minimal supports',
      dimensions_mm: { x: 90, y: 70, z: 40 },
      material: 'PLA',
      difficulty: 'easy',
      estimated_time_min: Math.round(base * 0.8),
      estimated_filament_g: 26,
      risks: ['Low risk: keep bridges short'],
      confidence: 0.93,
    },
    {
      id: 'balanced',
      lane: 'Balanced',
      name: `${seed} - Balanced Utility`,
      intended_use: 'Tradeoff between aesthetics and function',
      dimensions_mm: { x: 110, y: 80, z: 48 },
      material: 'PLA/PETG',
      difficulty: diff,
      estimated_time_min: base,
      estimated_filament_g: 34,
      risks: ['Mild overhang at decorative edges'],
      confidence: 0.85,
    },
    {
      id: 'ambitious',
      lane: 'Ambitious',
      name: `${seed} - Creative Variant`,
      intended_use: 'Higher novelty with more complex geometry',
      dimensions_mm: { x: 130, y: 92, z: 60 },
      material: 'PLA',
      difficulty: 'hard',
      estimated_time_min: Math.round(base * 1.35),
      estimated_filament_g: 49,
      risks: ['Support-heavy zones', 'Fine details near nozzle limit'],
      confidence: 0.69,
    },
  ];
}

function createModelSpec() {
  const selected = appState.concepts.find((c) => c.id === appState.selectedConceptId);
  if (!selected) return null;
  const dimensions = { ...selected.dimensions_mm };
  const spec = {
    project_goal: selected.intended_use,
    object_type: selected.name,
    dimensions_mm: dimensions,
    key_features: ['Print-ready baseline geometry', 'Tolerance-first mating surfaces', 'Nozzle-friendly detail sizing'],
    critical_constraints: [
      `Must fit ${PRINTER_PROFILE.buildVolume.x}x${PRINTER_PROFILE.buildVolume.y}x${PRINTER_PROFILE.buildVolume.z} build volume`,
      'First layer footprint must be stable',
      'Avoid tiny unsupported fins',
    ],
    fit_tolerances_mm: 0.3,
    material_preference: 'PLA',
    strength_profile: selected.difficulty === 'hard' ? 'high' : selected.difficulty === 'easy' ? 'low' : 'medium',
    aesthetic_style: appState.preferences.aestheticsVsUtility > 55 ? 'clean decorative' : 'utility-first',
    print_priority: appState.preferences.strengthVsSpeed > 60 ? 'quality' : appState.preferences.strengthVsSpeed < 40 ? 'speed' : 'balance',
    reference_images: [],
    assembly_parts: [],
  };
  appState.modelSpec = spec;
  runValidation();
}

function runValidation() {
  const spec = appState.modelSpec;
  if (!spec) return;
  const warnings = [];
  const critical = [];
  const d = spec.dimensions_mm;
  if (d.x > PRINTER_PROFILE.buildVolume.x || d.y > PRINTER_PROFILE.buildVolume.y || d.z > PRINTER_PROFILE.buildVolume.z) {
    critical.push({ reason: 'bed_fit', message: 'Model exceeds Adventurer 5M Pro build volume', action: 'Scale model down to <= 220mm axis', confidence: 0.98 });
  }
  if (spec.fit_tolerances_mm < 0.15) {
    warnings.push({ reason: 'tolerance_tight', message: 'Tolerance is very tight for typical PLA shrink behavior', action: 'Use 0.25-0.35mm tolerance', confidence: 0.84 });
  }
  if (spec.strength_profile === 'high' && spec.print_priority === 'speed') {
    warnings.push({ reason: 'strength_speed_tradeoff', message: 'High strength with speed priority can reduce layer adhesion', action: 'Switch print priority to balance or quality', confidence: 0.8 });
  }
  appState.validation = {
    pass: critical.length === 0,
    critical,
    warnings,
    min_wall_mm: spec.strength_profile === 'high' ? 2.0 : 1.6,
    support_recommendation: spec.strength_profile === 'low' ? 'auto' : 'strong',
  };
}

function preparePrint() {
  if (!appState.modelSpec) return;
  runValidation();
  const v = appState.validation;
  const d = appState.modelSpec.dimensions_mm;
  const est = estimateFromScale(d);
  const quality = appState.printPlan?.quality || 'standard';
  const qualityMultiplier = quality === 'draft' ? 0.72 : quality === 'fine' ? 1.35 : 1;
  appState.printPlan = {
    material: appState.printPlan?.material || 'PLA',
    quality,
    support: appState.printPlan?.support || 'auto',
    estimatedTimeMin: Math.round(est.estimated_time_min * qualityMultiplier),
    estimatedFilamentG: est.estimated_filament_g,
    canStart: Boolean(v?.pass),
  };
}

function createProjectSnapshot(status = 'draft') {
  return {
    id: crypto.randomUUID(),
    title: appState.modelSpec?.object_type || appState.selectedIdea?.title || 'Untitled print project',
    category: appState.selectedCategory || 'Utility',
    status,
    created_at: nowIso(),
    updated_at: nowIso(),
    model_spec: appState.modelSpec,
    validation: appState.validation,
    print_plan: appState.printPlan,
    print_job: appState.currentJob,
  };
}

function persistProject(project) {
  const projects = loadProjects();
  projects.unshift(project);
  saveProjects(projects.slice(0, 50));
  appState.projects = projects;
}

function startPrintJob() {
  preparePrint();
  if (!appState.printPlan?.canStart) {
    showToast('Print cannot start until validation checks pass.', 'warning');
    return;
  }
  appState.currentJob = {
    id: crypto.randomUUID(),
    status: 'queued',
    progress_pct: 0,
    eta_seconds: appState.printPlan.estimatedTimeMin * 60,
    error_message: null,
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  updateJobStatus('preparing');
  startJobSimulation();
  render();
}

function updateJobStatus(nextStatus) {
  if (!appState.currentJob) return;
  appState.currentJob.status = nextStatus;
  appState.currentJob.updated_at = nowIso();
}

function startJobSimulation() {
  if (progressTimer) clearInterval(progressTimer);
  progressTimer = setInterval(() => {
    const job = appState.currentJob;
    if (!job || job.status === 'paused' || job.status === 'failed' || job.status === 'cancelled' || job.status === 'completed') return;
    if (job.status === 'queued') updateJobStatus('preparing');
    else if (job.status === 'preparing') updateJobStatus('printing');
    else if (job.status === 'printing') {
      job.progress_pct = Math.min(100, job.progress_pct + 4);
      job.eta_seconds = Math.max(0, job.eta_seconds - 45);
      if (job.progress_pct >= 100) {
        updateJobStatus('completed');
        const project = createProjectSnapshot('completed');
        project.print_job = { ...job };
        persistProject(project);
        showToast('Print completed successfully.', 'success');
      }
    }
    render();
  }, 1500);
}

function stopJobSimulation() {
  if (progressTimer) {
    clearInterval(progressTimer);
    progressTimer = null;
  }
}

function setStage(stage) {
  appState.stage = stage;
  render();
}

function renderStageTabs() {
  return `
    <div class="flex flex-wrap gap-2 mb-4">
      ${STAGES.map((stage) => `
        <button data-action="stage" data-stage="${stage}"
          class="px-3 py-1.5 rounded-aap border text-sm ${appState.stage === stage ? 'bg-aap-dark text-white border-aap-dark' : 'bg-white border-aap-border text-aap-dark hover:bg-aap-cream'}">
          ${STAGE_LABELS[stage]}
        </button>
      `).join('')}
    </div>
  `;
}

function renderDiscover() {
  const q = appState.questions[appState.qIndex];
  const progress = appState.questions.length ? `${Math.min(appState.qIndex + 1, appState.questions.length)} of ${appState.questions.length}` : '';
  return `
    <div class="space-y-4">
      <div class="rounded-aap border border-aap-border bg-aap-cream p-3 text-sm text-aap-dark">
        No idea yet? Start here. Answer a few practical questions and get 5 ranked print ideas.
      </div>
      <div>
        <h3 class="font-semibold mb-2">Step 0.1 Category Selection</h3>
        <div class="flex flex-wrap gap-2">
          ${DISCOVERY_CATEGORIES.map((cat) => `<button data-action="pick-category" data-category="${esc(cat)}" class="px-3 py-1.5 rounded-aap border text-sm ${appState.selectedCategory === cat ? 'bg-aap-dark text-white border-aap-dark' : 'bg-white border-aap-border hover:bg-aap-cream'}">${esc(cat)}</button>`).join('')}
        </div>
      </div>
      ${appState.selectedCategory ? `
        <div class="rounded-aap border border-aap-border p-3 bg-white">
          <div class="flex items-center justify-between mb-2">
            <h3 class="font-semibold">Step 0.2 Adaptive Questions</h3>
            <span class="text-xs text-aap-text-muted">Question ${progress || '0 of 0'}</span>
          </div>
          ${q ? `
            <p class="mb-2 text-sm">${esc(q.prompt)}</p>
            <div class="flex flex-wrap gap-2 mb-2">
              ${(q.options || []).map((opt) => `<button data-action="answer-chip" data-value="${esc(opt)}" class="px-3 py-1.5 text-sm rounded-aap border border-aap-border bg-aap-cream hover:bg-white">${esc(opt)}</button>`).join('')}
            </div>
            ${q.open ? '<textarea id="openAnswer" rows="2" class="w-full rounded-aap border border-aap-border p-2 text-sm" placeholder="Optional details"></textarea>' : ''}
            <div class="mt-2 flex gap-2">
              <button data-action="answer-next" class="px-3 py-1.5 rounded-aap bg-aap-dark text-white text-sm">Next</button>
              <button data-action="skip-question" class="px-3 py-1.5 rounded-aap border border-aap-border text-sm">Skip</button>
            </div>
          ` : `
            <p class="text-sm text-aap-text-muted">Questions complete.</p>
            <button data-action="build-ideas" class="mt-2 px-3 py-1.5 rounded-aap bg-aap-dark text-white text-sm">Show me ideas</button>
          `}
        </div>
      ` : ''}
      ${appState.ideas.length ? `
        <div class="rounded-aap border border-aap-border p-3 bg-white">
          <div class="flex items-center justify-between mb-2">
            <h3 class="font-semibold">Step 0.3 AI Idea Pack</h3>
            <span class="text-xs text-aap-text-muted">Confidence: ${Math.round(confidenceScore() * 100)}%</span>
          </div>
          <div class="grid md:grid-cols-2 gap-3">
            ${appState.ideas.map((idea) => `
              <div class="rounded-aap border border-aap-border p-3 ${appState.selectedIdea?.id === idea.id ? 'bg-aap-cream' : 'bg-white'}">
                <div class="flex items-center justify-between mb-1">
                  <div class="font-semibold text-sm">${esc(idea.title)}</div>
                  ${idea.best_first ? '<span class="text-xs px-2 py-0.5 rounded-full bg-green-100 text-green-700">Best first print</span>' : ''}
                </div>
                <p class="text-sm text-aap-text-muted mb-2">${esc(idea.summary)}</p>
                <div class="text-xs text-aap-text-muted">Time ${idea.estimated_time_min}m | Filament ${idea.estimated_filament_g}g | ${idea.difficulty}</div>
                <div class="text-xs mt-1">Risk: ${esc(idea.risk_notes.join(', '))}</div>
                <button data-action="pick-idea" data-id="${idea.id}" class="mt-2 px-3 py-1.5 rounded-aap border border-aap-border text-xs">Select</button>
              </div>
            `).join('')}
          </div>
          <div class="mt-3">
            <h4 class="text-sm font-semibold mb-2">Step 0.4 Refinement Controls</h4>
            <div class="flex flex-wrap gap-2">
              ${['Make simpler', 'More creative', 'Faster print', 'Stronger', 'Smaller'].map((mode) => `<button data-action="refine-ideas" data-mode="${mode}" class="px-2.5 py-1 rounded-aap border border-aap-border text-xs">${mode}</button>`).join('')}
            </div>
            <button data-action="develop-idea" class="mt-3 px-3 py-1.5 rounded-aap bg-aap-amber text-white text-sm">Develop this idea</button>
          </div>
        </div>
      ` : ''}
    </div>
  `;
}

function renderBrainstorm() {
  const strengthBias = appState.preferences.strengthVsSpeed < 40
    ? 'Speed-first'
    : appState.preferences.strengthVsSpeed > 60
      ? 'Strength-first'
      : 'Balanced';
  const styleBias = appState.preferences.aestheticsVsUtility < 40
    ? 'Utility-first'
    : appState.preferences.aestheticsVsUtility > 60
      ? 'Aesthetic-first'
      : 'Balanced';
  const materialBias = appState.preferences.materialVsDurability < 40
    ? 'Low-material'
    : appState.preferences.materialVsDurability > 60
      ? 'Durability-first'
      : 'Balanced';

  return `
    <div class="space-y-4">
      <div class="rounded-aap border border-aap-border p-3 bg-white">
        <h3 class="font-semibold mb-2">Stage 1: Brainstorm</h3>
        <label class="text-sm block mb-1">Idea seed</label>
        <textarea id="brainstormSeed" rows="2" class="w-full rounded-aap border border-aap-border p-2 text-sm">${esc(appState.brainstormSeed)}</textarea>
        <div class="grid md:grid-cols-3 gap-3 mt-3 text-sm">
          <label>
            <span class="font-semibold">Speed <span class="text-aap-text-muted">vs</span> Strength</span>
            <input id="prefStrength" type="range" min="0" max="100" value="${appState.preferences.strengthVsSpeed}" class="w-full mt-1">
            <div class="flex justify-between text-xs text-aap-text-muted mt-1">
              <span>More Speed</span><span>More Strength</span>
            </div>
            <div class="text-xs mt-1">Current: ${strengthBias}</div>
          </label>
          <label>
            <span class="font-semibold">Utility <span class="text-aap-text-muted">vs</span> Aesthetics</span>
            <input id="prefStyle" type="range" min="0" max="100" value="${appState.preferences.aestheticsVsUtility}" class="w-full mt-1">
            <div class="flex justify-between text-xs text-aap-text-muted mt-1">
              <span>More Utility</span><span>More Aesthetics</span>
            </div>
            <div class="text-xs mt-1">Current: ${styleBias}</div>
          </label>
          <label>
            <span class="font-semibold">Low Material <span class="text-aap-text-muted">vs</span> Durability</span>
            <input id="prefMaterial" type="range" min="0" max="100" value="${appState.preferences.materialVsDurability}" class="w-full mt-1">
            <div class="flex justify-between text-xs text-aap-text-muted mt-1">
              <span>Use Less Material</span><span>More Durable</span>
            </div>
            <div class="text-xs mt-1">Current: ${materialBias}</div>
          </label>
        </div>
        <button data-action="generate-concepts" class="mt-3 px-3 py-1.5 rounded-aap bg-aap-dark text-white text-sm">Generate 3 concept directions</button>
      </div>
      ${appState.concepts.length ? `
        <div class="grid md:grid-cols-3 gap-3">
          ${appState.concepts.map((c) => `
            <div class="rounded-aap border border-aap-border p-3 ${appState.selectedConceptId === c.id ? 'bg-aap-cream' : 'bg-white'}">
              <div class="text-xs uppercase text-aap-text-muted">${c.lane}</div>
              <h4 class="font-semibold">${esc(c.name)}</h4>
              <p class="text-sm text-aap-text-muted">${esc(c.intended_use)}</p>
              <div class="text-xs mt-1">Size: ${c.dimensions_mm.x}x${c.dimensions_mm.y}x${c.dimensions_mm.z}mm</div>
              <div class="text-xs">Material: ${esc(c.material)} | ${esc(c.difficulty)}</div>
              <div class="text-xs">Estimate: ${c.estimated_time_min}m / ${c.estimated_filament_g}g</div>
              <div class="text-xs">Risk: ${esc(c.risks.join(', '))}</div>
              <div class="text-xs text-aap-text-muted">Confidence ${Math.round(c.confidence * 100)}%</div>
              <button data-action="select-concept" data-id="${c.id}" class="mt-2 px-3 py-1.5 rounded-aap border border-aap-border text-xs">Select + lock constraints</button>
            </div>
          `).join('')}
        </div>
      ` : ''}
    </div>
  `;
}

function renderModel() {
  const spec = appState.modelSpec;
  return `
    <div class="space-y-4">
      <div class="rounded-aap border border-aap-border p-3 bg-white">
        <h3 class="font-semibold mb-2">Stage 2: Model Specification Contract</h3>
        <button data-action="finalize-spec" class="px-3 py-1.5 rounded-aap bg-aap-dark text-white text-sm">Finalize structured intent JSON</button>
        ${spec ? `
          <div class="grid md:grid-cols-2 gap-3 mt-3">
            <label class="text-sm">X mm <input id="dimX" type="number" class="w-full mt-1 rounded-aap border border-aap-border p-2" value="${spec.dimensions_mm.x}"></label>
            <label class="text-sm">Y mm <input id="dimY" type="number" class="w-full mt-1 rounded-aap border border-aap-border p-2" value="${spec.dimensions_mm.y}"></label>
            <label class="text-sm">Z mm <input id="dimZ" type="number" class="w-full mt-1 rounded-aap border border-aap-border p-2" value="${spec.dimensions_mm.z}"></label>
            <label class="text-sm">Tolerance mm <input id="tolMm" step="0.05" type="number" class="w-full mt-1 rounded-aap border border-aap-border p-2" value="${spec.fit_tolerances_mm}"></label>
          </div>
          <button data-action="rerun-validation" class="mt-2 px-3 py-1.5 rounded-aap border border-aap-border text-sm">Validate + Slice readiness</button>
          <pre class="mt-3 p-3 rounded-aap bg-aap-dark text-white text-xs overflow-auto">${esc(JSON.stringify(spec, null, 2))}</pre>
        ` : '<p class="text-sm text-aap-text-muted mt-2">Pick and lock a concept first.</p>'}
      </div>
      ${appState.validation ? `
        <div class="rounded-aap border border-aap-border p-3 bg-white">
          <h3 class="font-semibold mb-2">Stage 3: Printability</h3>
          <div class="text-sm mb-2">${appState.validation.pass ? 'Validation pass: Start Print can be enabled.' : 'Validation blocked: fix critical issues first.'}</div>
          ${appState.validation.critical.map((i) => `<div class="text-sm p-2 rounded-aap bg-red-50 border border-red-200 mb-2"><strong>${esc(i.reason)}</strong>: ${esc(i.message)}. Fix: ${esc(i.action)} (${Math.round(i.confidence * 100)}%)</div>`).join('')}
          ${appState.validation.warnings.map((i) => `<div class="text-sm p-2 rounded-aap bg-amber-50 border border-amber-200 mb-2"><strong>${esc(i.reason)}</strong>: ${esc(i.message)}. Suggestion: ${esc(i.action)} (${Math.round(i.confidence * 100)}%)</div>`).join('')}
          <button data-action="fix-issues" class="px-3 py-1.5 rounded-aap border border-aap-border text-sm">Fix printability issues</button>
        </div>
      ` : ''}
    </div>
  `;
}

function renderPrint() {
  const job = appState.currentJob;
  const plan = appState.printPlan;
  return `
    <div class="space-y-4">
      <div class="rounded-aap border border-aap-border p-3 bg-white">
        <h3 class="font-semibold mb-2">Stage 4: Slice + Print Orchestration</h3>
        <div class="grid md:grid-cols-3 gap-3">
          <label class="text-sm">Material
            <select id="printMaterial" class="w-full mt-1 rounded-aap border border-aap-border p-2">
              <option ${plan?.material === 'PLA' ? 'selected' : ''}>PLA</option>
              <option ${plan?.material === 'PETG' ? 'selected' : ''}>PETG</option>
            </select>
          </label>
          <label class="text-sm">Quality
            <select id="printQuality" class="w-full mt-1 rounded-aap border border-aap-border p-2">
              <option value="draft" ${plan?.quality === 'draft' ? 'selected' : ''}>Draft</option>
              <option value="standard" ${!plan || plan?.quality === 'standard' ? 'selected' : ''}>Standard</option>
              <option value="fine" ${plan?.quality === 'fine' ? 'selected' : ''}>Fine</option>
            </select>
          </label>
          <label class="text-sm">Supports
            <select id="printSupport" class="w-full mt-1 rounded-aap border border-aap-border p-2">
              <option value="off" ${plan?.support === 'off' ? 'selected' : ''}>Off</option>
              <option value="auto" ${!plan || plan?.support === 'auto' ? 'selected' : ''}>Auto</option>
              <option value="strong" ${plan?.support === 'strong' ? 'selected' : ''}>Strong</option>
            </select>
          </label>
        </div>
        <button data-action="prepare-print" class="mt-3 px-3 py-1.5 rounded-aap border border-aap-border text-sm">Prepare print</button>
        ${plan ? `<div class="text-sm mt-2">Estimate: ${plan.estimatedTimeMin}m, ${plan.estimatedFilamentG}g, ${plan.canStart ? 'Validation pass' : 'Validation blocked'}</div>` : ''}
        <button data-action="start-print" class="mt-2 px-3 py-1.5 rounded-aap ${plan?.canStart ? 'bg-aap-dark text-white' : 'bg-gray-200 text-gray-500 cursor-not-allowed'} text-sm" ${plan?.canStart ? '' : 'disabled'}>Start Print</button>
      </div>
      <div class="rounded-aap border border-aap-border p-3 bg-white">
        <h3 class="font-semibold mb-2">Job Lifecycle</h3>
        <div class="text-sm">queued -> preparing -> printing -> paused -> completed -> failed -> cancelled</div>
        ${job ? `
          <div class="mt-2 text-sm">
            <div>Status: <strong>${esc(job.status)}</strong></div>
            <div>Progress: ${job.progress_pct}%</div>
            <div>ETA: ${Math.round(job.eta_seconds / 60)}m</div>
            ${job.error_message ? `<div class="text-red-600">${esc(job.error_message)}</div>` : ''}
          </div>
          <div class="mt-2 flex gap-2">
            <button data-action="pause-job" class="px-3 py-1.5 rounded-aap border border-aap-border text-sm">Pause</button>
            <button data-action="resume-job" class="px-3 py-1.5 rounded-aap border border-aap-border text-sm">Resume</button>
            <button data-action="cancel-job" class="px-3 py-1.5 rounded-aap border border-red-300 text-red-600 text-sm">Cancel</button>
          </div>
        ` : '<p class="text-sm text-aap-text-muted">No active job.</p>'}
      </div>
    </div>
  `;
}

function renderHistory() {
  const projects = loadProjects();
  appState.projects = projects;
  return `
    <div class="rounded-aap border border-aap-border p-3 bg-white">
      <h3 class="font-semibold mb-2">Stage 5: History</h3>
      ${projects.length === 0 ? '<p class="text-sm text-aap-text-muted">No print projects yet.</p>' : `
        <div class="space-y-2">
          ${projects.map((p) => `
            <div class="rounded-aap border border-aap-border p-3">
              <div class="font-semibold text-sm">${esc(p.title)}</div>
              <div class="text-xs text-aap-text-muted">${esc(p.category)} | ${esc(p.status)} | ${new Date(p.updated_at).toLocaleString()}</div>
              ${p.print_job ? `<div class="text-xs mt-1">Job ${esc(p.print_job.status)} at ${p.print_job.progress_pct || 0}%</div>` : ''}
              <div class="mt-2 flex gap-2">
                <button data-action="reprint-history" data-id="${p.id}" class="px-3 py-1 rounded-aap border border-aap-border text-xs">Reprint</button>
                <button data-action="iterate-history" data-id="${p.id}" class="px-3 py-1 rounded-aap border border-aap-border text-xs">Iterate from this version</button>
              </div>
            </div>
          `).join('')}
        </div>
      `}
    </div>
  `;
}

function render() {
  const root = document.getElementById('printerApp');
  if (!root) return;
  let stageHtml = '';
  if (appState.stage === 'discover') stageHtml = renderDiscover();
  if (appState.stage === 'brainstorm') stageHtml = renderBrainstorm();
  if (appState.stage === 'model') stageHtml = renderModel();
  if (appState.stage === 'print') stageHtml = renderPrint();
  if (appState.stage === 'history') stageHtml = renderHistory();

  root.innerHTML = `
    ${renderStageTabs()}
    <div class="rounded-aap border border-aap-border bg-white p-3 mb-4 text-sm">
      <strong>Printer Profile:</strong> ${PRINTER_PROFILE.name} (${PRINTER_PROFILE.buildVolume.x}x${PRINTER_PROFILE.buildVolume.y}x${PRINTER_PROFILE.buildVolume.z}mm, ${PRINTER_PROFILE.nozzleMm}mm nozzle, ${PRINTER_PROFILE.material} baseline)
    </div>
    ${stageHtml}
  `;
  wireEvents(root);
}

function wireEvents(root) {
  root.querySelectorAll('[data-action="stage"]').forEach((btn) => btn.addEventListener('click', () => setStage(btn.dataset.stage)));

  root.querySelectorAll('[data-action="pick-category"]').forEach((btn) => btn.addEventListener('click', () => {
    appState.selectedCategory = btn.dataset.category;
    appState.questions = selectQuestions(appState.selectedCategory);
    appState.qIndex = 0;
    appState.answers = {};
    appState.ideas = [];
    render();
  }));

  root.querySelectorAll('[data-action="answer-chip"]').forEach((btn) => btn.addEventListener('click', () => {
    const q = appState.questions[appState.qIndex];
    if (!q) return;
    appState.answers[q.id] = btn.dataset.value;
    render();
  }));

  root.querySelector('[data-action="answer-next"]')?.addEventListener('click', () => {
    const q = appState.questions[appState.qIndex];
    if (!q) return;
    const open = root.querySelector('#openAnswer');
    if (open?.value?.trim()) {
      appState.answers[`${q.id}_notes`] = open.value.trim();
      appState.answers.__textCount = Math.min(2, Number(appState.answers.__textCount || 0) + 1);
    }
    const earlyExit = confidenceScore() >= 0.8 && appState.qIndex >= 1;
    if (earlyExit || appState.qIndex >= appState.questions.length - 1) {
      generateIdeaPack();
    } else {
      appState.qIndex += 1;
    }
    render();
  });

  root.querySelector('[data-action="skip-question"]')?.addEventListener('click', () => {
    if (appState.qIndex >= appState.questions.length - 1) generateIdeaPack();
    else appState.qIndex += 1;
    render();
  });

  root.querySelector('[data-action="build-ideas"]')?.addEventListener('click', () => {
    generateIdeaPack();
    render();
  });

  root.querySelectorAll('[data-action="pick-idea"]').forEach((btn) => btn.addEventListener('click', () => {
    appState.selectedIdea = appState.ideas.find((i) => i.id === btn.dataset.id) || null;
    render();
  }));

  root.querySelectorAll('[data-action="refine-ideas"]').forEach((btn) => btn.addEventListener('click', () => refineIdeas(btn.dataset.mode)));

  root.querySelector('[data-action="develop-idea"]')?.addEventListener('click', () => {
    if (!appState.selectedIdea) {
      showToast('Pick an idea first.', 'warning');
      return;
    }
    appState.brainstormSeed = appState.selectedIdea.title;
    appState.stage = 'brainstorm';
    render();
  });

  root.querySelector('[data-action="generate-concepts"]')?.addEventListener('click', () => {
    appState.brainstormSeed = (root.querySelector('#brainstormSeed')?.value || '').trim();
    appState.preferences = {
      strengthVsSpeed: Number(root.querySelector('#prefStrength')?.value || 50),
      aestheticsVsUtility: Number(root.querySelector('#prefStyle')?.value || 50),
      materialVsDurability: Number(root.querySelector('#prefMaterial')?.value || 50),
    };
    generateConcepts();
    render();
  });

  root.querySelectorAll('[data-action="select-concept"]').forEach((btn) => btn.addEventListener('click', () => {
    appState.selectedConceptId = btn.dataset.id;
    appState.stage = 'model';
    createModelSpec();
    render();
  }));

  root.querySelector('[data-action="finalize-spec"]')?.addEventListener('click', () => {
    createModelSpec();
    if (!appState.modelSpec) showToast('Select a concept first.', 'warning');
    else showToast('Structured intent JSON created.', 'success');
    render();
  });

  root.querySelector('[data-action="rerun-validation"]')?.addEventListener('click', () => {
    if (!appState.modelSpec) return;
    appState.modelSpec.dimensions_mm = {
      x: Number(root.querySelector('#dimX')?.value || appState.modelSpec.dimensions_mm.x),
      y: Number(root.querySelector('#dimY')?.value || appState.modelSpec.dimensions_mm.y),
      z: Number(root.querySelector('#dimZ')?.value || appState.modelSpec.dimensions_mm.z),
    };
    appState.modelSpec.fit_tolerances_mm = Number(root.querySelector('#tolMm')?.value || appState.modelSpec.fit_tolerances_mm);
    runValidation();
    render();
  });

  root.querySelector('[data-action="fix-issues"]')?.addEventListener('click', () => {
    if (!appState.modelSpec) return;
    const d = appState.modelSpec.dimensions_mm;
    d.x = Math.min(d.x, PRINTER_PROFILE.buildVolume.x);
    d.y = Math.min(d.y, PRINTER_PROFILE.buildVolume.y);
    d.z = Math.min(d.z, PRINTER_PROFILE.buildVolume.z);
    appState.modelSpec.fit_tolerances_mm = Math.max(0.25, appState.modelSpec.fit_tolerances_mm);
    if (appState.modelSpec.strength_profile === 'high' && appState.modelSpec.print_priority === 'speed') {
      appState.modelSpec.print_priority = 'balance';
    }
    runValidation();
    showToast('Applied safe default fixes.', 'success');
    render();
  });

  root.querySelector('[data-action="prepare-print"]')?.addEventListener('click', () => {
    appState.printPlan = {
      material: root.querySelector('#printMaterial')?.value || 'PLA',
      quality: root.querySelector('#printQuality')?.value || 'standard',
      support: root.querySelector('#printSupport')?.value || 'auto',
    };
    preparePrint();
    render();
  });

  root.querySelector('[data-action="start-print"]')?.addEventListener('click', startPrintJob);

  root.querySelector('[data-action="pause-job"]')?.addEventListener('click', () => {
    updateJobStatus('paused');
    render();
  });
  root.querySelector('[data-action="resume-job"]')?.addEventListener('click', () => {
    updateJobStatus('printing');
    render();
  });
  root.querySelector('[data-action="cancel-job"]')?.addEventListener('click', () => {
    if (!appState.currentJob) return;
    updateJobStatus('cancelled');
    const project = createProjectSnapshot('cancelled');
    project.print_job = { ...appState.currentJob };
    persistProject(project);
    stopJobSimulation();
    render();
  });

  root.querySelectorAll('[data-action="reprint-history"]').forEach((btn) => btn.addEventListener('click', () => {
    const project = appState.projects.find((p) => p.id === btn.dataset.id);
    if (!project) return;
    appState.modelSpec = project.model_spec;
    appState.validation = project.validation;
    appState.printPlan = project.print_plan;
    appState.stage = 'print';
    showToast('Loaded project for reprint.', 'info');
    render();
  }));

  root.querySelectorAll('[data-action="iterate-history"]').forEach((btn) => btn.addEventListener('click', () => {
    const project = appState.projects.find((p) => p.id === btn.dataset.id);
    if (!project) return;
    appState.modelSpec = project.model_spec;
    appState.stage = 'model';
    showToast('Loaded previous version for iteration.', 'info');
    render();
  }));
}

document.addEventListener('DOMContentLoaded', async () => {
  await initResidentPage({
    activeTab: 'devices',
    requiredRole: 'resident',
    onReady: () => {
      appState.projects = loadProjects();
      render();
    },
  });
});
