'use strict';

// ─── Global state ───
const state = {
  imgCount: 2,
  fps:      12,
  editMode: 'inpaint',
  animSrc:  null,
  editSrc:  null,
};

// ─── Key storage ───
const K = { r: 'aistudio_r8', s: 'aistudio_sa', o: 'aistudio_oa' };

function getKeys() {
  return {
    replicate: localStorage.getItem(K.r) || '',
    stability: localStorage.getItem(K.s) || '',
    openai:    localStorage.getItem(K.o) || '',
  };
}

function saveSettings() {
  const r = v('replicateKeyInput');
  const s = v('stabilityKeyInput');
  const o = v('openaiKeyInput');
  if (r) localStorage.setItem(K.r, r);
  if (s) localStorage.setItem(K.s, s);
  if (o) localStorage.setItem(K.o, o);
  closeSettings();
  toast('API keys saved!', 'success');
}

function openSettings() {
  const keys = getKeys();
  document.getElementById('replicateKeyInput').value = keys.replicate;
  document.getElementById('stabilityKeyInput').value = keys.stability;
  document.getElementById('openaiKeyInput').value    = keys.openai;
  document.getElementById('settingsModal').classList.remove('hidden');
}

function closeSettings() {
  document.getElementById('settingsModal').classList.add('hidden');
}

function toggleVis(id) {
  const el = document.getElementById(id);
  el.type = el.type === 'password' ? 'text' : 'password';
}

function v(id) { return document.getElementById(id).value.trim(); }

// ─── Toast ───
let toastTimer;
function toast(msg, type = 'info') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `toast ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 4500);
}

// ─── Tab nav ───
document.querySelectorAll('.nav-item').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
  });
});

document.getElementById('settingsBtn').addEventListener('click', openSettings);
document.getElementById('settingsModal').addEventListener('click', e => {
  if (e.target === e.currentTarget) closeSettings();
});

// ─── Chip helper ───
function selectChip(groupId, clicked) {
  document.querySelectorAll(`#${groupId} .chip`).forEach(c => c.classList.remove('active'));
  clicked.classList.add('active');
}

// ─── Edit mode ───
function setEditMode(mode, btn) {
  state.editMode = mode;
  document.querySelectorAll('.edit-mode-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById('editPromptWrap').style.display =
    mode === 'inpaint' ? 'flex' : 'none';
}

// ─── Upload zones ───
function setupUpload(zoneId, fileId, previewId, innerId, stateKey) {
  const zone    = document.getElementById(zoneId);
  const input   = document.getElementById(fileId);
  const preview = document.getElementById(previewId);
  const inner   = document.getElementById(innerId);

  zone.addEventListener('click', () => input.click());
  input.addEventListener('change', () => { if (input.files[0]) load(input.files[0]); });
  zone.addEventListener('dragover',  e => { e.preventDefault(); zone.classList.add('drag-over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
  zone.addEventListener('drop', e => {
    e.preventDefault();
    zone.classList.remove('drag-over');
    const f = e.dataTransfer.files[0];
    if (f && f.type.startsWith('image/')) load(f);
  });

  function load(file) {
    const reader = new FileReader();
    reader.onload = ev => {
      state[stateKey] = ev.target.result;
      preview.src = ev.target.result;
      preview.classList.remove('hidden');
      inner.classList.add('hidden');
    };
    reader.readAsDataURL(file);
  }
}

setupUpload('animUploadZone', 'animImageFile', 'animPreview', 'animUploadInner', 'animSrc');
setupUpload('editUploadZone', 'editImageFile', 'editPreview', 'editUploadInner', 'editSrc');

// ─── Replicate API ───
async function replicateCreate(model, input, apiKey) {
  const versioned = model.includes(':');
  const url = versioned
    ? 'https://api.replicate.com/v1/predictions'
    : `https://api.replicate.com/v1/models/${model}/predictions`;

  const body = versioned
    ? { version: model.split(':')[1], input }
    : { input };

  const res = await fetch(url, {
    method:  'POST',
    headers: {
      Authorization:  `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Prefer:         'wait=30',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `Replicate error ${res.status}: ${res.statusText}`);
  }

  const pred = await res.json();
  if (pred.status === 'succeeded') return pred;
  if (pred.status === 'failed')   throw new Error(pred.error || 'Generation failed');
  return poll(pred.id, apiKey);
}

async function poll(id, apiKey, timeout = 360_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    await sleep(2500);
    const res = await fetch(`https://api.replicate.com/v1/predictions/${id}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) continue;
    const pred = await res.json();
    if (pred.status === 'succeeded') return pred;
    if (pred.status === 'failed')   throw new Error(pred.error || 'Generation failed');
  }
  throw new Error('Timed out — the generation took too long. Please try again.');
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function firstOutput(pred) {
  const o = pred.output;
  return Array.isArray(o) ? o[0] : o;
}

// ─── Loading / Error UI ───
function showLoading(panelId, label, sub) {
  document.getElementById(panelId).innerHTML = `
    <div class="loading-box">
      <div class="spinner"></div>
      <p class="loading-label">${label}</p>
      ${sub ? `<p class="loading-sub">${sub}</p>` : ''}
      <div class="progress-track"><div class="progress-fill"></div></div>
    </div>`;
}

function showError(panelId, msg) {
  document.getElementById(panelId).innerHTML =
    `<div class="error-box">⚠️ <span>${msg}</span></div>`;
}

function setLoading(btnId, loading, original) {
  const btn = document.getElementById(btnId);
  btn.disabled = loading;
  btn.innerHTML = loading ? '<span class="spin-sm"></span>Working…' : original;
}

// ─── IMAGE GENERATION ───
async function generateImage() {
  const prompt = v('imgPrompt');
  if (!prompt) { toast('Please enter a prompt', 'error'); return; }

  const keys = getKeys();
  if (!keys.replicate && !keys.stability && !keys.openai) {
    toast('Add an API key in Settings first', 'error'); openSettings(); return;
  }

  const orig = '<span class="btn-spark">✦</span> Generate Images';
  setLoading('generateImgBtn', true, orig);
  showLoading('imgOutput', 'Generating images…');

  try {
    const styleMap = {
      realistic: 'photorealistic, hyperrealistic, ultra detailed, 8k uhd, sharp focus',
      cinematic: 'cinematic, dramatic lighting, film grain, anamorphic lens, movie still',
      artistic:  'fine art, painterly, masterpiece, highly detailed illustration',
      anime:     'anime illustration, studio quality, vibrant colors, highly detailed',
      '3d':      '3D render, octane render, volumetric lighting, subsurface scattering, physically based rendering',
    };

    const style    = v('imgStyle');
    const aspect   = v('imgAspect') || '1:1';
    const steps    = Number(v('imgSteps') || 8);
    const count    = state.imgCount;
    const negParts = v('imgNegPrompt');
    const negPrompt = negParts || 'blurry, distorted, low quality, ugly, watermark, text, logo, nsfw';
    const full     = `${prompt}, ${styleMap[style] || ''}`;

    let urls = [];

    if (keys.replicate) {
      const jobs = Array.from({ length: count }, () =>
        replicateCreate('black-forest-labs/flux-schnell', {
          prompt:               full,
          aspect_ratio:         aspect,
          num_inference_steps:  steps,
          output_format:        'webp',
          output_quality:       90,
        }, keys.replicate)
      );
      const preds = await Promise.all(jobs);
      urls = preds.map(firstOutput).filter(Boolean);

    } else if (keys.stability) {
      const [w, h] = aspectToSize(aspect);
      const jobs = Array.from({ length: count }, () =>
        stabilityGen(full, negPrompt, w, h, steps, keys.stability)
      );
      const results = await Promise.all(jobs);
      urls = results.flat().filter(Boolean);

    } else if (keys.openai) {
      const size = openaiSize(aspect);
      const jobs = Array.from({ length: count }, () =>
        openaiGen(prompt, size, keys.openai)
      );
      const results = await Promise.all(jobs);
      urls = results.flat().filter(Boolean);
    }

    if (!urls.length) throw new Error('No images were returned by the API');

    document.getElementById('imgOutput').innerHTML =
      `<div class="img-grid">${urls.map(imgCard).join('')}</div>`;

    toast(`${urls.length} image${urls.length > 1 ? 's' : ''} generated!`, 'success');

  } catch (err) {
    console.error(err);
    showError('imgOutput', err.message);
    toast(err.message, 'error');
  } finally {
    setLoading('generateImgBtn', false, orig);
  }
}

function imgCard(url, i) {
  const safe = encodeURI(url);
  return `<div class="img-card">
    <img src="${url}" alt="Generated image ${i+1}" loading="lazy">
    <div class="img-actions">
      <button class="card-btn" onclick="dlMedia('${safe}','ai-image-${i+1}.webp')">↓ Download</button>
      <button class="card-btn" onclick="sendToAnimate('${safe}')">✨ Animate</button>
    </div>
  </div>`;
}

function aspectToSize(ratio) {
  return ({ '1:1':[1024,1024], '16:9':[1344,768], '9:16':[768,1344], '4:3':[1152,896] })[ratio] || [1024,1024];
}

async function stabilityGen(prompt, neg, w, h, steps, key) {
  const res = await fetch('https://api.stability.ai/v1/generation/stable-diffusion-xl-1024-v1-0/text-to-image', {
    method:  'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      text_prompts: [{ text: prompt, weight: 1 }, { text: neg, weight: -1 }],
      cfg_scale: 7, height: h, width: w, steps, samples: 1,
    }),
  });
  if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.message || `Stability AI ${res.status}`); }
  const data = await res.json();
  return data.artifacts.map(a => `data:image/png;base64,${a.base64}`);
}

function openaiSize(ratio) {
  return ({ '1:1':'1024x1024', '16:9':'1792x1024', '9:16':'1024x1792' })[ratio] || '1024x1024';
}

async function openaiGen(prompt, size, key) {
  const res = await fetch('https://api.openai.com/v1/images/generations', {
    method:  'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'dall-e-3', prompt, n: 1, size, response_format: 'url' }),
  });
  if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error?.message || `OpenAI ${res.status}`); }
  const data = await res.json();
  return data.data.map(d => d.url);
}

// ─── IMAGE → ANIMATION ───
async function animateImage() {
  if (!state.animSrc) { toast('Upload an image first', 'error'); return; }

  const keys = getKeys();
  if (!keys.replicate) { toast('Replicate API key required — add it in Settings', 'error'); openSettings(); return; }

  const orig = '<span class="btn-spark">✨</span> Animate Image';
  setLoading('animateBtn', true, orig);
  showLoading('animOutput', 'Animating your image…', 'This usually takes 1–3 minutes');

  try {
    const pred = await replicateCreate(
      'stability-ai/stable-video-diffusion',
      {
        input_image:      state.animSrc,
        motion_bucket_id: Number(document.getElementById('motionBucket').value),
        fps_id:           state.fps,
        num_frames:       Number(v('animFrames') || 25),
        decoding_t:       7,
        output_format:    'mp4',
      },
      keys.replicate
    );

    const url = firstOutput(pred);
    if (!url) throw new Error('No video output returned');

    document.getElementById('animOutput').innerHTML = `
      <div class="video-box">
        <video controls autoplay loop playsinline>
          <source src="${url}" type="video/mp4">
        </video>
        <div class="video-actions">
          <button class="action-btn" onclick="dlMedia('${encodeURI(url)}','animation.mp4')">↓ Download MP4</button>
        </div>
      </div>`;

    toast('Animation ready!', 'success');

  } catch (err) {
    console.error(err);
    showError('animOutput', err.message);
    toast(err.message, 'error');
  } finally {
    setLoading('animateBtn', false, orig);
  }
}

// ─── TEXT → VIDEO ───
async function generateVideo() {
  const prompt = v('videoPrompt');
  if (!prompt) { toast('Please enter a video prompt', 'error'); return; }

  const keys = getKeys();
  if (!keys.replicate) { toast('Replicate API key required — add it in Settings', 'error'); openSettings(); return; }

  const orig = '<span class="btn-spark">🎬</span> Generate Video';
  setLoading('videoBtn', true, orig);
  showLoading('videoOutput', 'Generating your video…', 'This usually takes 2–5 minutes');

  try {
    const model    = v('videoModel');
    const aspect   = v('videoAspect') || '16:9';
    const guidance = Number(document.getElementById('guidanceScale').value);

    const inputMap = {
      'minimax/video-01':          { prompt, prompt_optimizer: true },
      'wan-video/wan2.1-t2v-480p': { prompt, guidance_scale: guidance, num_inference_steps: 30 },
      'luma/photon':               { prompt, aspect_ratio: aspect },
    };

    const pred = await replicateCreate(model, inputMap[model] ?? { prompt }, keys.replicate);
    const url  = firstOutput(pred);
    if (!url) throw new Error('No video output returned');

    document.getElementById('videoOutput').innerHTML = `
      <div class="video-box">
        <video controls autoplay playsinline>
          <source src="${url}" type="video/mp4">
          Your browser does not support HTML5 video.
        </video>
        <div class="video-actions">
          <button class="action-btn" onclick="dlMedia('${encodeURI(url)}','ai-video.mp4')">↓ Download MP4</button>
        </div>
      </div>`;

    toast('Video generated!', 'success');

  } catch (err) {
    console.error(err);
    showError('videoOutput', err.message);
    toast(err.message, 'error');
  } finally {
    setLoading('videoBtn', false, orig);
  }
}

// ─── IMAGE EDITING ───
async function editImage() {
  if (!state.editSrc) { toast('Upload an image first', 'error'); return; }

  const keys = getKeys();
  if (!keys.replicate) { toast('Replicate API key required — add it in Settings', 'error'); openSettings(); return; }

  const orig = '<span class="btn-spark">🖼️</span> Apply Edit';
  setLoading('editBtn', true, orig);
  showLoading('editOutput', 'Processing your image…');

  try {
    let model, input;

    switch (state.editMode) {
      case 'upscale':
        model = 'nightmareai/real-esrgan:f121d640bd286e1fdc67f9799164c1d5be36ff74576ee11c803ae5b665dd46aa';
        input = { image: state.editSrc, scale: 4, face_enhance: false };
        break;

      case 'remove-bg':
        model = 'cjwbw/rembg:fb8af171cfa1616ddcf1242c093f9c46bcada5ad4cf6f2fbe8b81b330ec5c003';
        input = { image: state.editSrc };
        break;

      case 'restore':
        model = 'tencentarc/gfpgan:0fbacf7afc6998f1c4b3d2b771e69eb58c1741c0fd3c4db4bdb58090be8c7516';
        input = { img: state.editSrc, version: 'v1.4', scale: 2 };
        break;

      case 'inpaint':
      default: {
        const p = v('editPrompt');
        if (!p) { toast('Enter a repaint instruction', 'error'); setLoading('editBtn', false, orig); return; }
        model = 'stability-ai/stable-diffusion-inpainting:95b7223104132402a9ae91cc677285bc5eb997834bd2349fa486f53910fd68b3';
        input = { image: state.editSrc, prompt: p, num_inference_steps: 25, guidance_scale: 7.5 };
        break;
      }
    }

    const pred = await replicateCreate(model, input, keys.replicate);
    const url  = firstOutput(pred);
    if (!url) throw new Error('No output returned');

    document.getElementById('editOutput').innerHTML = `
      <div class="before-after">
        <div class="ba-card">
          <div class="ba-label">Before</div>
          <img src="${state.editSrc}" alt="Original image">
        </div>
        <div class="ba-card">
          <div class="ba-label">After</div>
          <img src="${url}" alt="Edited image" loading="lazy">
          <div class="ba-footer">
            <button class="action-btn" onclick="dlMedia('${encodeURI(url)}','edited.png')">↓ Download</button>
          </div>
        </div>
      </div>`;

    toast('Edit applied!', 'success');

  } catch (err) {
    console.error(err);
    showError('editOutput', err.message);
    toast(err.message, 'error');
  } finally {
    setLoading('editBtn', false, orig);
  }
}

// ─── Cross-tab: send generated image to animate tab ───
async function sendToAnimate(url) {
  try {
    const blob   = await fetch(url).then(r => r.blob());
    const reader = new FileReader();
    reader.onload = ev => {
      state.animSrc = ev.target.result;
      const preview = document.getElementById('animPreview');
      const inner   = document.getElementById('animUploadInner');
      preview.src = ev.target.result;
      preview.classList.remove('hidden');
      inner.classList.add('hidden');
    };
    reader.readAsDataURL(blob);
    document.querySelector('[data-tab="img-animate"]').click();
    toast('Image loaded in Animation tab!', 'info');
  } catch {
    toast('Could not load image — download and upload manually', 'error');
  }
}

// ─── Download helper ───
async function dlMedia(url, filename) {
  try {
    const blob = await fetch(url).then(r => r.blob());
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  } catch {
    window.open(url, '_blank');
  }
}

// ─── First-run hint ───
window.addEventListener('DOMContentLoaded', () => {
  const k = getKeys();
  if (!k.replicate && !k.stability && !k.openai) {
    setTimeout(() => toast('Welcome! Open Settings to add your API keys and get started.', 'info'), 700);
  }
});
