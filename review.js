const API_BASE = window.location.origin;

let reviewItems = [];
let currentReviewIndex = -1;
let videoElement = null;
let canvasElement = null;
let waveformData = null;
let zoomLevel = 1;
let scrollOffset = 0;
let isWaveformDragging = false;
let waveformDragStartX = 0;
let waveformDragStartScroll = 0;
let waveformDragMoved = false;
let waveformAmplitudeScale = 1.0;
let playbackSpeed = 1.0;
let isSidePanelOpen = false;
let reviewSyncFrame = null;
let activeWaveformToken = 0;
let reviewUndoStack = [];
let movingReviewPaths = new Set();
const maxUndoSteps = 50;
let progressHideTimer = null;
let reviewApproveDirPath = 'OKフォルダ';
let reviewRejectDirPath = '削除フォルダ';
let reviewApprovedMovedCount = 0;
let reviewRejectedMovedCount = 0;
let reviewUndoInFlight = false;

function isPlaybackToggleKey(event) {
  return event.code === 'Space'
    || event.key === ' '
    || event.key === 'Spacebar'
    || event.key === ']'
    || event.code === 'BracketRight'
    || event.code === 'Backslash'
    || event.code === 'IntlYen'
    || event.key === '\\'
    || event.key === '¥';
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00.0';
  const mins = Math.floor(seconds / 60);
  const secs = (seconds % 60).toFixed(1);
  return `${mins}:${secs.padStart(4, '0')}`;
}

function getBaseName(filePath) {
  const normalized = String(filePath || '').replace(/\\/g, '/');
  return normalized.split('/').pop() || filePath || '';
}

function getParentPath(filePath) {
  const rawPath = String(filePath || '');
  const usesBackslash = rawPath.includes('\\') && !rawPath.includes('/');
  const normalized = rawPath.replace(/\\/g, '/');
  const lastSlash = normalized.lastIndexOf('/');
  if (lastSlash <= 0) return '';
  const parentPath = normalized.slice(0, lastSlash);
  return usesBackslash ? parentPath.replace(/\//g, '\\') : parentPath;
}

function applyReviewPlatformCopy() {
  const filePathsLabel = document.querySelector('label[for="reviewFilePathsInput"]');
  if (filePathsLabel) {
    filePathsLabel.textContent = '📂 動画ファイルのパス （入力欄をダブルクリック→ファイル選択ダイアログで複数選択）';
  }

  const filePathsInput = document.getElementById('reviewFilePathsInput');
  if (filePathsInput) {
    filePathsInput.placeholder = 'ダブルクリックでファイル選択ダイアログを開く / 手入力する場合は改行区切りで入力';
  }

  const sideNote = document.querySelector('.side-panel-note');
  if (sideNote) {
    sideNote.innerHTML = `
      <strong>高速判定ページについて</strong>
      ここでは既に小分け済みの複数動画をまとめて読み込み、レビュー直下のカードで使える動画かどうかを高速に判定します。OK は <code>${reviewApproveDirPath}</code>、✕ は <code>${reviewRejectDirPath}</code> へ移動し、カードは一覧から消えます。間違えたときは <code>戻る</code> または <code>Ctrl+Z</code> で 1 件ずつ元に戻せます。
    `;
  }

  const subtitle = document.querySelector('.subtitle');
  if (subtitle) {
    subtitle.textContent = '既に小分け済みの複数動画を一括で読み込み、1本ずつ OK / 削除 を指定フォルダへ移動しながら高速判定します。';
  }

  const filePathsHelp = document.getElementById('reviewFilePathsHelp');
  if (filePathsHelp) {
    filePathsHelp.textContent = '複数選択で参照や入力欄のダブルクリックで動画を選ぶと、そのまま自動で読み込みます。読み込み開始は手入力後や再読み込みしたいときに使えます。';
  }

  const shortcutHelp = document.getElementById('reviewShortcutHelp');
  if (shortcutHelp) {
    shortcutHelp.innerHTML = `Backspace / Delete / ✕ は <code>${reviewRejectDirPath}</code> へ移動、Enter / OK は <code>${reviewApproveDirPath}</code> へ移動、Ctrl+Z / 戻る は 1 件戻す、Space / ] / \\ は再生/停止、← → は 3 秒移動、D/S は再生速度変更です。`;
  }

  const approveDirHelp = document.getElementById('reviewApproveDirHelp');
  if (approveDirHelp) {
    approveDirHelp.innerHTML = `OK を押した動画は <code>${reviewApproveDirPath}</code> へ移動します。`;
  }

  const rejectDirHelp = document.getElementById('reviewRejectDirHelp');
  if (rejectDirHelp) {
    rejectDirHelp.innerHTML = `✕ を押した動画は <code>${reviewRejectDirPath}</code> へ移動します。`;
  }
}

async function loadAppConfig() {
  try {
    const response = await fetch(`${API_BASE}/api/app-config`, { cache: 'no-store' });
    if (!response.ok) return;
    const data = await response.json();
    if (data.review_ok_dir) {
      reviewApproveDirPath = data.review_ok_dir;
    }
    if (data.review_reject_dir) {
      reviewRejectDirPath = data.review_reject_dir;
    }
  } catch (error) {
    console.warn('アプリ設定の取得に失敗しました:', error);
  }

  syncReviewDestinationInputs();
  applyReviewPlatformCopy();
}

function getCurrentReviewItem() {
  return reviewItems[currentReviewIndex] || null;
}

function findReviewIndexByPath(filePath) {
  return reviewItems.findIndex((item) => item.path === filePath);
}

function updateProgress(text, percent) {
  const container = document.getElementById('progressContainer');
  const textElement = document.getElementById('progressText');
  const percentElement = document.getElementById('progressPercent');
  const fillElement = document.getElementById('progressFill');
  if (!container || !textElement || !percentElement || !fillElement) return;
  if (progressHideTimer) {
    clearTimeout(progressHideTimer);
    progressHideTimer = null;
  }
  container.style.display = 'block';
  textElement.textContent = text;
  percentElement.textContent = `${Math.round(percent)}%`;
  fillElement.style.width = `${clamp(percent, 0, 100)}%`;
}

function hideProgress(delay = 400) {
  const container = document.getElementById('progressContainer');
  if (!container) return;
  if (progressHideTimer) clearTimeout(progressHideTimer);
  progressHideTimer = window.setTimeout(() => {
    container.style.display = 'none';
    progressHideTimer = null;
  }, delay);
}

function addMessage(text, type = 'info') {
  const messageArea = document.getElementById('messageArea');
  if (!messageArea) return;
  const message = document.createElement('div');
  message.className = `message message-${type}`;
  const time = new Date().toLocaleTimeString();
  message.textContent = `[${time}] ${text}`;
  messageArea.appendChild(message);
  while (messageArea.children.length > 120) {
    messageArea.removeChild(messageArea.firstChild);
  }
  messageArea.scrollTop = messageArea.scrollHeight;
}

function parseFilePaths(rawText) {
  const seen = new Set();
  return String(rawText || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .map((line) => line.replace(/^"(.*)"$/, '$1'))
    .filter((line) => !!line)
    .filter((line) => {
      if (seen.has(line)) return false;
      seen.add(line);
      return true;
    });
}

function refreshPathsTextarea() {
  const textarea = document.getElementById('reviewFilePathsInput');
  if (!textarea) return;
  textarea.value = reviewItems.map((item) => item.path).join('\n');
}

function syncReviewDestinationInputs() {
  const approveInput = document.getElementById('reviewApproveDirInput');
  const rejectInput = document.getElementById('reviewRejectDirInput');

  if (approveInput) approveInput.value = reviewApproveDirPath;
  if (rejectInput) rejectInput.value = reviewRejectDirPath;
}

function getReviewApproveTargetDir() {
  const input = document.getElementById('reviewApproveDirInput');
  return (input && input.value.trim()) || reviewApproveDirPath;
}

function getReviewRejectTargetDir() {
  const input = document.getElementById('reviewRejectDirInput');
  return (input && input.value.trim()) || reviewRejectDirPath;
}

async function openReviewDirectoryDialog(inputId, successLabel) {
  const input = document.getElementById(inputId);
  if (!input) return;

  try {
    const response = await fetch(`${API_BASE}/api/dialog/open-directory`, { cache: 'no-store' });
    const data = await response.json();

    if (data.success && data.path) {
      input.value = data.path;
      addMessage(`${successLabel}: ${data.path}`, 'success');
      return;
    }

    if (data.error) {
      addMessage(`${successLabel}を開けませんでした: ${data.error}`, 'warning');
    }
  } catch (error) {
    addMessage(`${successLabel}を開けませんでした。直接パスを入力するか、参照ボタンを押してください`, 'warning');
  }
}

function toggleSidePanel(forceOpen) {
  const panel = document.getElementById('sidePanel');
  const overlay = document.getElementById('sidePanelOverlay');
  const menuBtn = document.getElementById('navMenuBtn');
  if (!panel || !overlay || !menuBtn) return;

  const nextOpen = typeof forceOpen === 'boolean' ? forceOpen : !isSidePanelOpen;
  isSidePanelOpen = nextOpen;

  overlay.hidden = !nextOpen;
  overlay.classList.toggle('open', nextOpen);
  panel.classList.toggle('open', nextOpen);
  menuBtn.classList.toggle('active', nextOpen);
  document.body.classList.toggle('side-panel-open', nextOpen);
  panel.setAttribute('aria-hidden', nextOpen ? 'false' : 'true');
  menuBtn.setAttribute('aria-expanded', nextOpen ? 'true' : 'false');
}

function updatePlaybackSpeedDisplay() {
  const displayElement = document.getElementById('playbackSpeedDisplay');
  if (!displayElement) return;

  displayElement.textContent = `${playbackSpeed.toFixed(1)}x`;

  if (playbackSpeed === 1.0) {
    displayElement.style.background = 'linear-gradient(90deg,#38bdf8 0%,#22c55e 100%)';
  } else if (playbackSpeed < 2.0) {
    displayElement.style.background = 'linear-gradient(90deg,#60a5fa 0%,#34d399 100%)';
  } else if (playbackSpeed < 3.0) {
    displayElement.style.background = 'linear-gradient(90deg,#f59e0b 0%,#22c55e 100%)';
  } else {
    displayElement.style.background = 'linear-gradient(90deg,#ef4444 0%,#f59e0b 100%)';
  }

  displayElement.style.webkitBackgroundClip = 'text';
  displayElement.style.webkitTextFillColor = 'transparent';
  displayElement.style.backgroundClip = 'text';
}

function updateOverviewPopup() {
  const thumb = document.getElementById('overviewThumb');
  if (!thumb || !videoElement || !Number.isFinite(videoElement.duration) || videoElement.duration <= 0) return;

  const duration = videoElement.duration;
  const viewDuration = duration / zoomLevel;
  const maxScroll = Math.max(0, duration - viewDuration);
  const widthPercent = clamp((viewDuration / duration) * 100, 0, 100);
  const leftPercent = maxScroll <= 0 ? 0 : clamp((scrollOffset / duration) * 100, 0, 100 - widthPercent);

  thumb.style.width = `${widthPercent}%`;
  thumb.style.left = `${leftPercent}%`;
}

function drawCurrentTimeIndicator() {
  if (!canvasElement || !videoElement || !Number.isFinite(videoElement.duration) || videoElement.duration <= 0) return;

  const ctx = canvasElement.getContext('2d');
  const width = canvasElement.width;
  const height = canvasElement.height;
  const viewDuration = videoElement.duration / zoomLevel;
  const currentTime = clamp(videoElement.currentTime || 0, 0, videoElement.duration);

  if (currentTime < scrollOffset || currentTime > scrollOffset + viewDuration) return;

  const x = ((currentTime - scrollOffset) / viewDuration) * width;

  ctx.save();
  ctx.strokeStyle = 'rgba(34, 197, 94, 0.98)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(x, 0);
  ctx.lineTo(x, height);
  ctx.stroke();

  ctx.fillStyle = 'rgba(34, 197, 94, 0.98)';
  ctx.beginPath();
  ctx.moveTo(x, 0);
  ctx.lineTo(x - 10, 14);
  ctx.lineTo(x + 10, 14);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawTimelineGrid() {
  if (!canvasElement || !videoElement || !Number.isFinite(videoElement.duration) || videoElement.duration <= 0) return;

  const ctx = canvasElement.getContext('2d');
  const width = canvasElement.width;
  const height = canvasElement.height;
  const duration = videoElement.duration;
  const viewDuration = duration / zoomLevel;
  const viewStart = clamp(scrollOffset, 0, Math.max(0, duration - viewDuration));

  let smallInterval = 5;
  let mediumInterval = 15;
  let largeInterval = 60;

  if (viewDuration <= 20) {
    smallInterval = 1;
    mediumInterval = 5;
    largeInterval = 10;
  } else if (viewDuration <= 60) {
    smallInterval = 2;
    mediumInterval = 10;
    largeInterval = 30;
  } else if (viewDuration <= 180) {
    smallInterval = 5;
    mediumInterval = 30;
    largeInterval = 60;
  }

  ctx.strokeStyle = 'rgba(148, 163, 184, 0.28)';
  ctx.lineWidth = 1;
  for (let t = Math.floor(viewStart / smallInterval) * smallInterval; t <= viewStart + viewDuration; t += smallInterval) {
    if (t < 0 || t > duration) continue;
    const x = ((t - viewStart) / viewDuration) * width;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }

  ctx.strokeStyle = 'rgba(148, 163, 184, 0.48)';
  ctx.lineWidth = 2;
  for (let t = Math.floor(viewStart / mediumInterval) * mediumInterval; t <= viewStart + viewDuration; t += mediumInterval) {
    if (t < 0 || t > duration) continue;
    const x = ((t - viewStart) / viewDuration) * width;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();

    ctx.fillStyle = 'rgba(2, 6, 23, 0.82)';
    ctx.fillRect(x + 4, 4, 72, 22);
    ctx.fillStyle = 'rgba(248, 250, 252, 0.96)';
    ctx.font = 'bold 18px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.fillText(formatTime(t), x + 10, 20);
  }

  ctx.strokeStyle = 'rgba(14, 165, 233, 0.66)';
  ctx.lineWidth = 3;
  for (let t = Math.floor(viewStart / largeInterval) * largeInterval; t <= viewStart + viewDuration; t += largeInterval) {
    if (t < 0 || t > duration) continue;
    const x = ((t - viewStart) / viewDuration) * width;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }
}

function drawTimeline() {
  if (!canvasElement) return;
  const ctx = canvasElement.getContext('2d');
  const width = canvasElement.width = Math.max(600, canvasElement.offsetWidth * 2);
  const height = canvasElement.height = 160;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = 'rgba(15, 23, 42, 0.96)';
  ctx.fillRect(0, 0, width, height);
  drawTimelineGrid();
  drawCurrentTimeIndicator();
  updateOverviewPopup();
}

function drawWaveform() {
  if (!canvasElement) return;
  const ctx = canvasElement.getContext('2d');
  const width = canvasElement.width = Math.max(600, canvasElement.offsetWidth * 2);
  const height = canvasElement.height = 160;
  ctx.clearRect(0, 0, width, height);

  if (!videoElement || !Number.isFinite(videoElement.duration) || videoElement.duration <= 0) {
    drawTimeline();
    return;
  }

  if (!Array.isArray(waveformData) || waveformData.length === 0) {
    drawTimeline();
    return;
  }

  const duration = videoElement.duration;
  const viewDuration = duration / zoomLevel;
  const viewStart = clamp(scrollOffset, 0, Math.max(0, duration - viewDuration));
  const totalPoints = waveformData.length;
  const startIndex = Math.floor((viewStart / duration) * totalPoints);
  const endIndex = Math.ceil(((viewStart + viewDuration) / duration) * totalPoints);
  const viewData = waveformData.slice(startIndex, Math.max(startIndex + 1, endIndex));

  ctx.fillStyle = 'rgba(15, 23, 42, 0.96)';
  ctx.fillRect(0, 0, width, height);

  const centerY = height / 2;
  const maxAmplitude = (height * 0.42) * waveformAmplitudeScale;
  const gradient = ctx.createLinearGradient(0, 0, 0, height);
  gradient.addColorStop(0, 'rgba(14, 165, 233, 0.14)');
  gradient.addColorStop(0.5, 'rgba(34, 197, 94, 0.18)');
  gradient.addColorStop(1, 'rgba(14, 165, 233, 0.14)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);

  ctx.beginPath();
  for (let x = 0; x < width; x += 1) {
    const dataIndex = Math.floor((x / width) * viewData.length);
    const point = viewData[dataIndex];
    if (!point) continue;
    const amplitude = Math.min(Math.abs(point.max || 0) * maxAmplitude, height / 2 - 6);
    const y = centerY - amplitude;
    if (x === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  for (let x = width - 1; x >= 0; x -= 1) {
    const dataIndex = Math.floor((x / width) * viewData.length);
    const point = viewData[dataIndex];
    if (!point) continue;
    const amplitude = Math.min(Math.abs(point.min || 0) * maxAmplitude, height / 2 - 6);
    const y = centerY + amplitude;
    ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fillStyle = 'rgba(56, 189, 248, 0.34)';
  ctx.strokeStyle = 'rgba(34, 197, 94, 0.8)';
  ctx.lineWidth = 1.4;
  ctx.fill();
  ctx.stroke();

  ctx.strokeStyle = 'rgba(148, 163, 184, 0.25)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, centerY);
  ctx.lineTo(width, centerY);
  ctx.stroke();

  drawTimelineGrid();
  drawCurrentTimeIndicator();
  updateOverviewPopup();
}

function handleWheel(e) {
  if (!e.shiftKey || !videoElement || !Number.isFinite(videoElement.duration) || videoElement.duration <= 0) return;
  e.preventDefault();

  const rect = canvasElement.getBoundingClientRect();
  const ratio = rect.width > 0 ? clamp((e.clientX - rect.left) / rect.width, 0, 1) : 0.5;
  const duration = videoElement.duration;
  const timeAtCursor = scrollOffset + ratio * (duration / zoomLevel);
  const nextZoom = clamp(zoomLevel * (e.deltaY > 0 ? 0.9 : 1.1), 1, 200);

  zoomLevel = nextZoom;
  const nextViewDuration = duration / zoomLevel;
  scrollOffset = clamp(timeAtCursor - ratio * nextViewDuration, 0, Math.max(0, duration - nextViewDuration));

  if (waveformData && waveformData.length > 0) drawWaveform();
  else drawTimeline();
}

function handleWaveformMouseDown(e) {
  if (!videoElement || !Number.isFinite(videoElement.duration) || videoElement.duration <= 0) return;
  isWaveformDragging = true;
  waveformDragMoved = false;
  waveformDragStartX = e.clientX;
  waveformDragStartScroll = scrollOffset;
  canvasElement.style.cursor = 'grabbing';
  const overviewPopup = document.getElementById('overviewPopup');
  if (overviewPopup) overviewPopup.style.display = 'block';
  updateOverviewPopup();
  e.preventDefault();
}

function handleMouseMove(e) {
  if (!isWaveformDragging || !videoElement || !Number.isFinite(videoElement.duration) || videoElement.duration <= 0) return;
  const rect = canvasElement.getBoundingClientRect();
  if (!rect.width) return;

  const deltaX = e.clientX - waveformDragStartX;
  if (Math.abs(deltaX) > 3) waveformDragMoved = true;

  const viewDuration = videoElement.duration / zoomLevel;
  const timeDelta = (deltaX / rect.width) * viewDuration;
  scrollOffset = clamp(
    waveformDragStartScroll - timeDelta,
    0,
    Math.max(0, videoElement.duration - viewDuration)
  );

  if (waveformData && waveformData.length > 0) drawWaveform();
  else drawTimeline();
}

function handleMouseUp() {
  if (!isWaveformDragging) return;
  isWaveformDragging = false;
  canvasElement.style.cursor = 'grab';
  const overviewPopup = document.getElementById('overviewPopup');
  if (overviewPopup) overviewPopup.style.display = 'none';
}

function handleCanvasClick(e) {
  if (!videoElement || !Number.isFinite(videoElement.duration) || videoElement.duration <= 0) return;
  if (waveformDragMoved) {
    waveformDragMoved = false;
    return;
  }

  const rect = canvasElement.getBoundingClientRect();
  if (!rect.width) return;

  const viewDuration = videoElement.duration / zoomLevel;
  const ratio = clamp((e.clientX - rect.left) / rect.width, 0, 1);
  const nextTime = clamp(scrollOffset + ratio * viewDuration, 0, videoElement.duration);
  const item = getCurrentReviewItem();
  if (item) item.previewTime = nextTime;
  videoElement.currentTime = nextTime;
  syncReviewCards();
}

function updateClipPreviewSliderFill(slider) {
  if (!slider) return;
  const min = Number(slider.min) || 0;
  const max = Number(slider.max) || 0;
  const value = Number(slider.value) || 0;
  const percent = max > min ? ((value - min) / (max - min)) * 100 : 0;
  slider.style.setProperty('--clip-progress', `${clamp(percent, 0, 100)}%`);
}

function updateSummaryLabels() {
  const fileCountValue = document.getElementById('reviewFileCountValue');
  const approvedCountValue = document.getElementById('reviewApprovedCountValue');
  const rejectedCountValue = document.getElementById('reviewRejectedCountValue');
  const currentValue = document.getElementById('reviewCurrentValue');
  if (fileCountValue) fileCountValue.textContent = String(reviewItems.length);
  if (approvedCountValue) {
    approvedCountValue.textContent = String(reviewApprovedMovedCount);
  }
  if (rejectedCountValue) rejectedCountValue.textContent = String(reviewRejectedMovedCount);
  if (currentValue) {
    const currentNumber = currentReviewIndex >= 0 ? currentReviewIndex + 1 : 0;
    currentValue.textContent = reviewItems.length === 0 ? '0 / 0' : `${currentNumber} / ${reviewItems.length}`;
  }
}

function updateReviewSummary() {
  const summary = document.getElementById('reviewSummary');
  if (!summary) return;

  const currentLabel = reviewItems.length === 0
    ? '未選択'
    : `${currentReviewIndex >= 0 ? currentReviewIndex + 1 : 0} / ${reviewItems.length}`;

  summary.innerHTML =
    `<span class="review-summary-chip">現在 ${currentLabel}</span>` +
    `<span class="review-summary-chip">残り ${reviewItems.length}</span>` +
    `<span class="review-summary-chip">OK移動 ${reviewApprovedMovedCount}</span>` +
    `<span class="review-summary-chip">削除移動 ${reviewRejectedMovedCount}</span>`;
}

function updateCurrentReviewInfo() {
  const nameElement = document.getElementById('currentReviewFileName');
  const metaElement = document.getElementById('currentReviewFileMeta');
  if (!nameElement || !metaElement) return;

  const item = getCurrentReviewItem();
  if (!item) {
    nameElement.textContent = '動画を読み込んでください';
    metaElement.textContent = '複数の分割済み動画を選ぶと、ここに現在の動画情報が表示されます。';
    return;
  }

  const statusText = movingReviewPaths.has(item.path)
    ? '移動中'
    : (reviewUndoInFlight ? '更新中' : '未処理');
  nameElement.textContent = item.name;
  metaElement.textContent =
    `パス: ${item.path} | 長さ: ${formatTime(item.duration)} | サイズ: ${item.fileSizeMb.toFixed(2)} MB | 状態: ${statusText}`;
}

function updateNavigationButtons() {
  const prevBtn = document.getElementById('reviewPrevBtn');
  const undoBtn = document.getElementById('reviewUndoBtn');
  const nextBtn = document.getElementById('reviewNextBtn');
  if (prevBtn) prevBtn.disabled = reviewItems.length === 0 || currentReviewIndex <= 0;
  if (undoBtn) undoBtn.disabled = reviewUndoInFlight || reviewUndoStack.length === 0;
  if (nextBtn) nextBtn.disabled = reviewItems.length === 0 || currentReviewIndex >= reviewItems.length - 1;
}

function scrollReviewCardIntoView(index, behavior = 'smooth') {
  const carousel = document.getElementById('reviewClipCarousel');
  if (!carousel) return;
  const card = carousel.querySelector(`.review-clip-card[data-index="${index}"]`);
  if (!card) return;
  card.scrollIntoView({ behavior, block: 'nearest', inline: 'center' });
}

function syncReviewCards() {
  const carousel = document.getElementById('reviewClipCarousel');
  if (!carousel) return;

  const currentItem = getCurrentReviewItem();
  if (currentItem && videoElement && Number.isFinite(videoElement.currentTime)) {
    currentItem.previewTime = clamp(videoElement.currentTime, 0, currentItem.duration || videoElement.duration || 0);
  }

  carousel.querySelectorAll('.review-clip-card').forEach((card) => {
    const index = Number(card.dataset.index);
    const item = reviewItems[index];
    if (!item) return;

    const isSelected = index === currentReviewIndex;
    const currentTime = isSelected && videoElement
      ? clamp(videoElement.currentTime || 0, 0, item.duration || videoElement.duration || 0)
      : clamp(item.previewTime || 0, 0, item.duration || 0);

    card.classList.toggle('selected', isSelected);
    card.classList.toggle('disabled', movingReviewPaths.has(item.path) || reviewUndoInFlight);
    card.classList.toggle('playback-active', isSelected && !!videoElement && !videoElement.paused);

    const slider = card.querySelector('.clip-preview-slider');
    const currentLabel = card.querySelector('.clip-current-time');
    const statusBadge = card.querySelector('[data-role="status"]');

    if (slider) {
      slider.max = String(item.duration || 0);
      slider.value = String(currentTime);
      slider.disabled = movingReviewPaths.has(item.path) || reviewUndoInFlight;
      updateClipPreviewSliderFill(slider);
    }

    if (currentLabel) currentLabel.textContent = formatTime(currentTime);
    if (statusBadge) {
      statusBadge.textContent = movingReviewPaths.has(item.path)
        ? '移動中'
        : (reviewUndoInFlight ? '更新中' : '未処理');
      statusBadge.className = 'clip-item-badge';
      statusBadge.dataset.role = 'status';
    }
  });
}

function startReviewSyncLoop() {
  stopReviewSyncLoop();
  const tick = () => {
    syncReviewCards();
    if (waveformData && waveformData.length > 0) drawWaveform();
    else drawTimeline();
    reviewSyncFrame = window.requestAnimationFrame(tick);
  };
  reviewSyncFrame = window.requestAnimationFrame(tick);
}

function stopReviewSyncLoop() {
  if (reviewSyncFrame) {
    window.cancelAnimationFrame(reviewSyncFrame);
    reviewSyncFrame = null;
  }
  syncReviewCards();
  if (waveformData && waveformData.length > 0) drawWaveform();
  else drawTimeline();
}

function renderReviewCards() {
  const carousel = document.getElementById('reviewClipCarousel');
  if (!carousel) return;

  carousel.innerHTML = '';
  if (reviewItems.length === 0) {
    carousel.innerHTML = '<div class="review-empty">分割済みの小さな動画を複数読み込むと、ここで OK と削除を高速に判定できます。</div>';
    updateSummaryLabels();
    updateReviewSummary();
    updateNavigationButtons();
    return;
  }

  reviewItems.forEach((item, index) => {
    const isMoving = movingReviewPaths.has(item.path);
    const isBusy = isMoving || reviewUndoInFlight;
    const card = document.createElement('div');
    card.className = 'clip-item review-clip-card';
    if (index === currentReviewIndex) card.classList.add('selected');
    if (isBusy) card.classList.add('disabled');
    card.dataset.index = String(index);

    const indexBadge = document.createElement('div');
    indexBadge.className = 'review-card-index';
    indexBadge.textContent = String(index + 1);

    const titleDiv = document.createElement('div');
    titleDiv.className = 'clip-item-title';

    const nameElement = document.createElement('strong');
    nameElement.className = 'clip-item-name';
    nameElement.textContent = item.name;

    const rangeElement = document.createElement('span');
    rangeElement.className = 'clip-item-range';
    rangeElement.textContent = getParentPath(item.path) || item.path;

    titleDiv.appendChild(nameElement);
    titleDiv.appendChild(rangeElement);

    const metaDiv = document.createElement('div');
    metaDiv.className = 'clip-item-meta';

    const durationElement = document.createElement('span');
    durationElement.className = 'clip-item-duration';
    durationElement.textContent = formatTime(item.duration);

    const sizeElement = document.createElement('span');
    sizeElement.className = 'clip-item-badge';
    sizeElement.textContent = `${item.fileSizeMb.toFixed(2)} MB`;

    const statusElement = document.createElement('span');
    statusElement.className = 'clip-item-badge';
    statusElement.dataset.role = 'status';
    statusElement.textContent = isMoving ? '移動中' : (reviewUndoInFlight ? '更新中' : '未処理');

    metaDiv.appendChild(durationElement);
    metaDiv.appendChild(sizeElement);
    metaDiv.appendChild(statusElement);

    const actionsDiv = document.createElement('div');
    actionsDiv.className = 'review-card-actions';

    const playButton = document.createElement('button');
    playButton.type = 'button';
    playButton.className = 'btn-small';
    playButton.style.background = '#8b5cf6';
    playButton.title = 'この動画を再生';
    playButton.textContent = '▶';
    playButton.disabled = isBusy;
    playButton.addEventListener('click', (e) => {
      e.stopPropagation();
      playReviewItem(index);
    });

    const approveButton = document.createElement('button');
    approveButton.type = 'button';
    approveButton.className = 'review-action-btn ok';
    approveButton.textContent = isMoving ? '移動中' : 'OK';
    approveButton.disabled = isBusy;
    approveButton.addEventListener('click', (e) => {
      e.stopPropagation();
      approveReviewItem(index);
    });

    const deleteButton = document.createElement('button');
    deleteButton.type = 'button';
    deleteButton.className = 'review-action-btn delete';
    deleteButton.textContent = isMoving ? '移動中' : '✕';
    deleteButton.disabled = isBusy;
    deleteButton.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteReviewItem(item.path);
    });

    actionsDiv.appendChild(approveButton);
    actionsDiv.appendChild(playButton);
    actionsDiv.appendChild(deleteButton);

    const sliderWrap = document.createElement('div');
    sliderWrap.className = 'clip-slider-wrap';

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.className = 'clip-preview-slider';
    slider.min = '0';
    slider.max = String(item.duration || 0);
    slider.step = '0.05';
    slider.value = String(index === currentReviewIndex && videoElement ? videoElement.currentTime || 0 : item.previewTime || 0);
    slider.disabled = isBusy;
    updateClipPreviewSliderFill(slider);

    const sliderStatus = document.createElement('div');
    sliderStatus.className = 'clip-slider-status';

    const startLabel = document.createElement('span');
    startLabel.textContent = '0:00.0';

    const currentLabel = document.createElement('span');
    currentLabel.className = 'clip-current-time';
    currentLabel.textContent = formatTime(Number(slider.value));

    const endLabel = document.createElement('span');
    endLabel.textContent = formatTime(item.duration);

    sliderStatus.appendChild(startLabel);
    sliderStatus.appendChild(currentLabel);
    sliderStatus.appendChild(endLabel);

    slider.addEventListener('click', (e) => {
      e.stopPropagation();
    });

    slider.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      if (currentReviewIndex !== index) {
        item.previewTime = Number(slider.value) || 0;
        selectReviewItem(index, { previewTime: item.previewTime, behavior: 'smooth' });
      }
    });

    slider.addEventListener('input', (e) => {
      e.stopPropagation();
      const nextTime = clamp(Number(e.target.value) || 0, 0, item.duration || 0);
      item.previewTime = nextTime;
      if (currentReviewIndex !== index) {
        selectReviewItem(index, { previewTime: nextTime, behavior: 'auto' });
      } else if (videoElement) {
        videoElement.currentTime = nextTime;
      }
      syncReviewCards();
    });

    sliderWrap.appendChild(slider);
    sliderWrap.appendChild(sliderStatus);

    card.appendChild(indexBadge);
    card.appendChild(titleDiv);
    card.appendChild(metaDiv);
    card.appendChild(actionsDiv);
    card.appendChild(sliderWrap);

    card.addEventListener('click', (e) => {
      if (e.target.closest('button') || e.target.closest('.clip-preview-slider')) return;
      selectReviewItem(index, { behavior: 'smooth' });
    });

    carousel.appendChild(card);
  });

  updateSummaryLabels();
  updateReviewSummary();
  updateNavigationButtons();
  syncReviewCards();
}

function clearCurrentVideo() {
  stopReviewSyncLoop();
  waveformData = null;
  scrollOffset = 0;
  const markers = document.getElementById('segmentMarkers');
  if (markers) markers.innerHTML = '';
  if (videoElement) {
    videoElement.pause();
    videoElement.dataset.filePath = '';
    videoElement.removeAttribute('src');
    videoElement.load();
  }
  drawTimeline();
}

async function releaseVideoHandle(filePath) {
  if (!videoElement) return;
  if (!filePath || videoElement.dataset.filePath !== filePath) return;

  stopReviewSyncLoop();

  try {
    videoElement.pause();
  } catch (error) {}

  await new Promise((resolve) => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      videoElement.removeEventListener('emptied', finish);
      videoElement.removeEventListener('abort', finish);
      resolve();
    };

    videoElement.addEventListener('emptied', finish, { once: true });
    videoElement.addEventListener('abort', finish, { once: true });
    videoElement.removeAttribute('src');
    videoElement.dataset.filePath = '';
    videoElement.load();

    window.setTimeout(finish, 260);
  });
}

async function fetchVideoInfo(filePath) {
  const formData = new FormData();
  formData.append('file_path', filePath);

  const response = await fetch(`${API_BASE}/api/video-info`, {
    method: 'POST',
    body: formData,
  });

  const data = await response.json();
  if (!response.ok || data.error) {
    throw new Error(data.error || '動画情報の取得に失敗しました');
  }
  return data;
}

async function loadWaveformForCurrent(item, token) {
  waveformData = null;
  return Promise.resolve({ item, token });
}

function loadVideoElement(item, token, preferredTime) {
  if (!videoElement) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const onLoadedMetadata = () => {
      cleanup();
      if (token !== activeWaveformToken) {
        resolve();
        return;
      }

      if (Number.isFinite(videoElement.duration) && videoElement.duration > 0) {
        item.duration = videoElement.duration;
      }

      const maxTime = Math.max(0, item.duration - 0.05);
      const nextTime = clamp(
        Number.isFinite(preferredTime) ? preferredTime : (item.previewTime || 0),
        0,
        maxTime
      );

      videoElement.dataset.filePath = item.path;
      videoElement.playbackRate = playbackSpeed;
      item.previewTime = nextTime;
      if (nextTime > 0) {
        try {
          videoElement.currentTime = nextTime;
        } catch (error) {}
      }

      scrollOffset = clamp(scrollOffset, 0, Math.max(0, item.duration - item.duration / zoomLevel));
      updateCurrentReviewInfo();
      if (waveformData && waveformData.length > 0) drawWaveform();
      else drawTimeline();
      syncReviewCards();
      resolve();
    };

    const onError = () => {
      cleanup();
      reject(new Error(`${item.name} の読み込みに失敗しました`));
    };

    const cleanup = () => {
      videoElement.removeEventListener('loadedmetadata', onLoadedMetadata);
      videoElement.removeEventListener('error', onError);
    };

    stopReviewSyncLoop();
    videoElement.pause();
    videoElement.addEventListener('loadedmetadata', onLoadedMetadata);
    videoElement.addEventListener('error', onError);
    videoElement.src = `${API_BASE}/api/video?path=${encodeURIComponent(item.path)}`;
    videoElement.load();
  });
}

async function selectReviewItem(index, options = {}) {
  if (index < 0 || index >= reviewItems.length) return;

  const item = reviewItems[index];
  const preferredTime = Number.isFinite(options.previewTime) ? options.previewTime : (item.previewTime || 0);
  const sameItemLoaded = currentReviewIndex === index && videoElement && videoElement.dataset.filePath === item.path;

  currentReviewIndex = index;
  updateSummaryLabels();
  updateReviewSummary();
  updateCurrentReviewInfo();
  renderReviewCards();
  scrollReviewCardIntoView(index, options.behavior || 'smooth');

  if (sameItemLoaded) {
    if (Number.isFinite(preferredTime) && videoElement) {
      videoElement.currentTime = clamp(preferredTime, 0, item.duration || videoElement.duration || 0);
    }
    if (options.autoplay && videoElement.paused) {
      try {
        await videoElement.play();
      } catch (error) {}
    }
    return;
  }

  const token = ++activeWaveformToken;
  waveformData = null;

  try {
    await loadVideoElement(item, token, preferredTime);
    if (token !== activeWaveformToken) return;

    if (options.autoplay) {
      try {
        await videoElement.play();
      } catch (error) {}
    }
  } catch (error) {
    if (token !== activeWaveformToken) return;
    waveformData = null;
    drawTimeline();
    addMessage(error.message, 'error');
  }
}

async function playReviewItem(index) {
  if (index < 0 || index >= reviewItems.length) return;
  if (currentReviewIndex !== index || !videoElement || videoElement.dataset.filePath !== reviewItems[index].path) {
    await selectReviewItem(index, { autoplay: true, behavior: 'smooth' });
    return;
  }

  try {
    await videoElement.play();
  } catch (error) {}
}

async function loadReviewFiles(paths) {
  const normalizedPaths = parseFilePaths(paths.join('\n'));
  if (normalizedPaths.length === 0) {
    addMessage('読み込む動画ファイルパスがありません', 'warning');
    return;
  }

  activeWaveformToken += 1;
  reviewUndoStack = [];
  reviewUndoInFlight = false;
  reviewItems = [];
  movingReviewPaths = new Set();
  reviewApprovedMovedCount = 0;
  reviewRejectedMovedCount = 0;
  currentReviewIndex = -1;
  clearCurrentVideo();
  renderReviewCards();
  updateCurrentReviewInfo();

  updateProgress('動画情報を読み込み中...', 0);

  const loadedItems = [];
  for (let i = 0; i < normalizedPaths.length; i += 1) {
    const filePath = normalizedPaths[i];
    const percent = ((i + 1) / normalizedPaths.length) * 100;
    updateProgress(`動画情報を読み込み中... (${i + 1}/${normalizedPaths.length})`, percent);

    try {
      const info = await fetchVideoInfo(filePath);
      loadedItems.push({
        path: info.file_path || filePath,
        name: info.file_name || getBaseName(filePath),
        duration: Number(info.duration) || 0,
        fileSizeMb: Number(info.file_size_mb) || 0,
        approved: false,
        previewTime: 0,
        waveform: null,
        waveformLoaded: false,
      });
    } catch (error) {
      addMessage(`${getBaseName(filePath)} を読み込めませんでした: ${error.message}`, 'warning');
    }
  }

  reviewItems = loadedItems;
  refreshPathsTextarea();
  renderReviewCards();
  updateCurrentReviewInfo();

  if (reviewItems.length === 0) {
    hideProgress(250);
    addMessage('読み込める動画がありませんでした', 'warning');
    return;
  }

  addMessage(`${reviewItems.length} 本の動画を読み込みました`, 'success');
  await selectReviewItem(0, { behavior: 'auto' });
}

async function handleBrowseFiles() {
  try {
    const response = await fetch(`${API_BASE}/api/dialog/open-files`);
    const data = await response.json();
    if (!response.ok || data.error) {
      throw new Error(data.error || '動画選択ダイアログを開けませんでした');
    }
    if (!data.success || !Array.isArray(data.paths) || data.paths.length === 0) {
      addMessage('動画選択はキャンセルされました', 'info');
      return;
    }
    const textarea = document.getElementById('reviewFilePathsInput');
    if (textarea) textarea.value = data.paths.join('\n');
    addMessage(`${data.paths.length} 本の動画を選択しました。自動で読み込みます`, 'success');
    await loadReviewFiles(data.paths);
  } catch (error) {
    addMessage(error.message, 'error');
  }
}

function handleLoadFiles() {
  const textarea = document.getElementById('reviewFilePathsInput');
  const paths = parseFilePaths(textarea ? textarea.value : '');
  return loadReviewFiles(paths);
}

function handleClearFiles() {
  activeWaveformToken += 1;
  reviewUndoStack = [];
  reviewUndoInFlight = false;
  reviewItems = [];
  movingReviewPaths = new Set();
  reviewApprovedMovedCount = 0;
  reviewRejectedMovedCount = 0;
  currentReviewIndex = -1;
  refreshPathsTextarea();
  clearCurrentVideo();
  renderReviewCards();
  updateCurrentReviewInfo();
  addMessage('入力済みの動画一覧をクリアしました', 'info');
}

function pushReviewUndoEntry(entry) {
  reviewUndoStack.push(entry);
  if (reviewUndoStack.length > maxUndoSteps) {
    reviewUndoStack.shift();
  }
}

async function handleUndoMove() {
  if (reviewUndoInFlight) return;
  if (reviewUndoStack.length === 0) {
    addMessage('戻せる OK / 削除 はありません', 'warning');
    return;
  }
  if (movingReviewPaths.size > 0) {
    addMessage('移動処理が終わってから戻してください', 'warning');
    return;
  }

  const snapshot = reviewUndoStack[reviewUndoStack.length - 1];
  reviewUndoInFlight = true;
  renderReviewCards();
  updateCurrentReviewInfo();

  try {
    const formData = new FormData();
    formData.append('moved_file_path', snapshot.movedToPath);
    formData.append('original_path', snapshot.originalPath);

    const response = await fetch(`${API_BASE}/api/review/restore-file`, {
      method: 'POST',
      body: formData,
    });

    const data = await response.json();
    if (!response.ok || data.error || data.success === false) {
      throw new Error(data.error || '動画の復元に失敗しました');
    }

    reviewUndoStack.pop();
    if (snapshot.successCountKey === 'approve') {
      reviewApprovedMovedCount = Math.max(0, reviewApprovedMovedCount - 1);
    }
    if (snapshot.successCountKey === 'reject') {
      reviewRejectedMovedCount = Math.max(0, reviewRejectedMovedCount - 1);
    }

    const restoredItem = {
      ...snapshot.item,
      path: data.restored_path || snapshot.originalPath,
    };

    reviewItems.unshift(restoredItem);
    refreshPathsTextarea();
    await selectReviewItem(0, {
      behavior: 'auto',
      previewTime: Number.isFinite(restoredItem.previewTime) ? restoredItem.previewTime : 0,
    });
    addMessage(`${restoredItem.name} を元の場所へ戻して先頭に復帰しました`, 'success');
  } catch (error) {
    addMessage(error.message || '動画の復元に失敗しました', 'error');
  } finally {
    reviewUndoInFlight = false;
    renderReviewCards();
    updateCurrentReviewInfo();
  }
}

async function approveReviewItem(index) {
  if (index < 0 || index >= reviewItems.length) return;
  const targetDir = getReviewApproveTargetDir().trim();
  await moveReviewItem(reviewItems[index].path, {
    targetDirectory: targetDir,
    actionLabel: 'OK',
    successCountKey: 'approve',
  });
}

async function deleteReviewItem(targetPath) {
  const targetDir = getReviewRejectTargetDir().trim();
  await moveReviewItem(targetPath, {
    targetDirectory: targetDir,
    actionLabel: '削除',
    successCountKey: 'reject',
  });
}

async function moveReviewItem(targetPath, options = {}) {
  if (!targetPath || movingReviewPaths.has(targetPath) || reviewUndoInFlight) return;

  const targetDirectory = String(options.targetDirectory || '').trim();
  if (!targetDirectory) {
    addMessage(`${options.actionLabel || '移動'}先フォルダを設定してください`, 'warning');
    return;
  }

  const initialIndex = findReviewIndexByPath(targetPath);
  if (initialIndex < 0) return;
  const item = reviewItems[initialIndex];
  const itemSnapshot = {
    ...item,
    previewTime: initialIndex === currentReviewIndex && videoElement
      ? clamp(videoElement.currentTime || 0, 0, item.duration || videoElement.duration || 0)
      : (Number.isFinite(item.previewTime) ? item.previewTime : 0),
  };
  movingReviewPaths.add(targetPath);
  renderReviewCards();
  updateCurrentReviewInfo();

  try {
    await releaseVideoHandle(targetPath);

    const formData = new FormData();
    formData.append('file_path', targetPath);
    formData.append('target_directory', targetDirectory);

    const response = await fetch(`${API_BASE}/api/review/move-file`, {
      method: 'POST',
      body: formData,
    });

    const data = await response.json();
    const resolvedIndex = findReviewIndexByPath(targetPath);
    if (resolvedIndex < 0) {
      movingReviewPaths.delete(targetPath);
      renderReviewCards();
      updateCurrentReviewInfo();
      return;
    }

    const movingCurrent = resolvedIndex === currentReviewIndex;
    const movingBeforeCurrent = resolvedIndex < currentReviewIndex;
    const alreadyMissing = data.already_missing === true;

    if (!response.ok || data.error) {
      throw new Error(data.error || '動画の移動に失敗しました');
    }
    if (!alreadyMissing && !data.moved_to_path) {
      throw new Error('移動先ファイルの情報取得に失敗しました');
    }

    if (!alreadyMissing) {
      if (options.successCountKey === 'approve') reviewApprovedMovedCount += 1;
      if (options.successCountKey === 'reject') reviewRejectedMovedCount += 1;
      pushReviewUndoEntry({
        actionLabel: options.actionLabel || '移動',
        successCountKey: options.successCountKey || '',
        originalPath: targetPath,
        movedToPath: data.moved_to_path,
        item: itemSnapshot,
      });
    }

    const resolvedTargetDir = data.target_directory || targetDirectory;
    const moveMessage = alreadyMissing
      ? `${item.name} は既に存在しなかったため、カードを除去しました`
      : `${item.name} を ${options.actionLabel}先 ${resolvedTargetDir} へ移動しました`;

    reviewItems.splice(resolvedIndex, 1);
    movingReviewPaths.delete(targetPath);
    refreshPathsTextarea();

    if (reviewItems.length === 0) {
      currentReviewIndex = -1;
      clearCurrentVideo();
      renderReviewCards();
      updateCurrentReviewInfo();
      addMessage(
        `${moveMessage}。判定対象は空です`,
        alreadyMissing ? 'warning' : 'success'
      );
      return;
    }

    if (movingCurrent) {
      currentReviewIndex = -1;
      clearCurrentVideo();
      renderReviewCards();
      updateCurrentReviewInfo();
      addMessage(moveMessage, alreadyMissing ? 'warning' : 'success');
      await selectReviewItem(Math.min(resolvedIndex, reviewItems.length - 1), { behavior: 'auto' });
      return;
    }

    if (movingBeforeCurrent) {
      currentReviewIndex = Math.max(0, currentReviewIndex - 1);
    }

    renderReviewCards();
    updateCurrentReviewInfo();
    addMessage(moveMessage, alreadyMissing ? 'warning' : 'success');
  } catch (error) {
    movingReviewPaths.delete(targetPath);
    renderReviewCards();
    updateCurrentReviewInfo();
    addMessage(error.message, 'error');
  }
}

function moveReviewFocus(direction) {
  if (reviewItems.length === 0) return;
  const nextIndex = clamp(currentReviewIndex + direction, 0, reviewItems.length - 1);
  if (nextIndex === currentReviewIndex) return;
  selectReviewItem(nextIndex, { behavior: 'smooth' });
}

function handleKeyDown(e) {
  if (e.key === 'Escape' && isSidePanelOpen) {
    e.preventDefault();
    toggleSidePanel(false);
    return;
  }

  const target = e.target;
  const tagName = target && target.tagName ? target.tagName.toLowerCase() : '';
  const isTypingTarget = target && (target.isContentEditable || tagName === 'input' || tagName === 'textarea' || tagName === 'select');
  if (isTypingTarget) return;

  if ((e.key === 'z' || e.key === 'Z') && reviewUndoStack.length > 0) {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      handleUndoMove();
    }
    return;
  }

  if (reviewUndoInFlight) return;
  if (currentReviewIndex < 0 || !videoElement) return;

  if (isPlaybackToggleKey(e)) {
    e.preventDefault();
    if (!e.repeat) {
      if (videoElement.paused) {
        videoElement.play().catch(() => {});
      } else {
        videoElement.pause();
      }
    }
    return;
  }

  switch (e.key) {
    case 'Enter':
      e.preventDefault();
      if (!e.repeat) {
        approveReviewItem(currentReviewIndex);
      }
      break;
    case 'ArrowLeft':
      e.preventDefault();
      videoElement.currentTime = Math.max(0, (videoElement.currentTime || 0) - 3);
      break;
    case 'ArrowRight':
      e.preventDefault();
      videoElement.currentTime = Math.min(videoElement.duration || 0, (videoElement.currentTime || 0) + 3);
      break;
    case 'Backspace':
    case 'Delete':
      e.preventDefault();
      if (reviewItems[currentReviewIndex]) {
        deleteReviewItem(reviewItems[currentReviewIndex].path);
      }
      break;
    case 'd':
    case 'D':
      e.preventDefault();
      playbackSpeed = clamp(Math.round((playbackSpeed + 0.1) * 10) / 10, 1.0, 3.0);
      videoElement.playbackRate = playbackSpeed;
      updatePlaybackSpeedDisplay();
      addMessage(`再生速度を ${playbackSpeed.toFixed(1)}x にしました`, 'info');
      break;
    case 's':
    case 'S':
      e.preventDefault();
      playbackSpeed = clamp(Math.round((playbackSpeed - 0.1) * 10) / 10, 1.0, 3.0);
      videoElement.playbackRate = playbackSpeed;
      updatePlaybackSpeedDisplay();
      addMessage(`再生速度を ${playbackSpeed.toFixed(1)}x にしました`, 'info');
      break;
  }
}

function init() {
  videoElement = document.getElementById('videoPlayer');
  canvasElement = document.getElementById('waveformCanvas');
  if (!videoElement) return;

  applyReviewPlatformCopy();
  loadAppConfig();

  const navMenuBtn = document.getElementById('navMenuBtn');
  const sidePanelOverlay = document.getElementById('sidePanelOverlay');
  const sidePanelCloseBtn = document.getElementById('sidePanelCloseBtn');
  const reviewBrowseFilesBtn = document.getElementById('reviewBrowseFilesBtn');
  const reviewLoadFilesBtn = document.getElementById('reviewLoadFilesBtn');
  const reviewClearFilesBtn = document.getElementById('reviewClearFilesBtn');
  const reviewApproveDirInput = document.getElementById('reviewApproveDirInput');
  const reviewRejectDirInput = document.getElementById('reviewRejectDirInput');
  const reviewBrowseApproveDirBtn = document.getElementById('reviewBrowseApproveDirBtn');
  const reviewBrowseRejectDirBtn = document.getElementById('reviewBrowseRejectDirBtn');
  const reviewPrevBtn = document.getElementById('reviewPrevBtn');
  const reviewUndoBtn = document.getElementById('reviewUndoBtn');
  const reviewNextBtn = document.getElementById('reviewNextBtn');
  const reviewFilePathsInput = document.getElementById('reviewFilePathsInput');

  if (navMenuBtn) navMenuBtn.addEventListener('click', () => toggleSidePanel());
  if (sidePanelOverlay) sidePanelOverlay.addEventListener('click', () => toggleSidePanel(false));
  if (sidePanelCloseBtn) sidePanelCloseBtn.addEventListener('click', () => toggleSidePanel(false));
  if (reviewBrowseFilesBtn) reviewBrowseFilesBtn.addEventListener('click', handleBrowseFiles);
  if (reviewLoadFilesBtn) reviewLoadFilesBtn.addEventListener('click', handleLoadFiles);
  if (reviewClearFilesBtn) reviewClearFilesBtn.addEventListener('click', handleClearFiles);
  if (reviewApproveDirInput) {
    reviewApproveDirInput.title = 'ダブルクリックでフォルダ選択ダイアログを開く';
    reviewApproveDirInput.addEventListener('dblclick', (e) => {
      e.preventDefault();
      openReviewDirectoryDialog('reviewApproveDirInput', 'OK移動先');
    });
  }
  if (reviewRejectDirInput) {
    reviewRejectDirInput.title = 'ダブルクリックでフォルダ選択ダイアログを開く';
    reviewRejectDirInput.addEventListener('dblclick', (e) => {
      e.preventDefault();
      openReviewDirectoryDialog('reviewRejectDirInput', '✕移動先');
    });
  }
  if (reviewBrowseApproveDirBtn) {
    reviewBrowseApproveDirBtn.addEventListener('click', () => openReviewDirectoryDialog('reviewApproveDirInput', 'OK移動先'));
  }
  if (reviewBrowseRejectDirBtn) {
    reviewBrowseRejectDirBtn.addEventListener('click', () => openReviewDirectoryDialog('reviewRejectDirInput', '✕移動先'));
  }
  if (reviewPrevBtn) reviewPrevBtn.addEventListener('click', () => moveReviewFocus(-1));
  if (reviewUndoBtn) reviewUndoBtn.addEventListener('click', () => {
    handleUndoMove();
  });
  if (reviewNextBtn) reviewNextBtn.addEventListener('click', () => moveReviewFocus(1));

  if (reviewFilePathsInput) {
    reviewFilePathsInput.addEventListener('dblclick', (e) => {
      e.preventDefault();
      handleBrowseFiles();
    });
    reviewFilePathsInput.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        handleLoadFiles();
      }
    });
  }

  videoElement.playbackRate = playbackSpeed;
  videoElement.addEventListener('timeupdate', () => {
    const item = getCurrentReviewItem();
    if (!item) return;
    item.previewTime = clamp(videoElement.currentTime || 0, 0, item.duration || videoElement.duration || 0);
    syncReviewCards();
  });
  videoElement.addEventListener('seeked', () => {
    syncReviewCards();
    if (waveformData && waveformData.length > 0) drawWaveform();
    else drawTimeline();
  });
  videoElement.addEventListener('loadedmetadata', () => {
    const item = getCurrentReviewItem();
    if (item && Number.isFinite(videoElement.duration) && videoElement.duration > 0) {
      item.duration = videoElement.duration;
    }
    syncReviewCards();
    if (waveformData && waveformData.length > 0) drawWaveform();
    else drawTimeline();
    updateCurrentReviewInfo();
  });
  videoElement.addEventListener('play', startReviewSyncLoop);
  videoElement.addEventListener('pause', stopReviewSyncLoop);
  videoElement.addEventListener('ended', stopReviewSyncLoop);

  if (canvasElement) {
    canvasElement.addEventListener('wheel', handleWheel, { passive: false });
    canvasElement.addEventListener('mousedown', handleWaveformMouseDown);
    canvasElement.addEventListener('click', handleCanvasClick);
  }

  document.addEventListener('mousemove', handleMouseMove);
  document.addEventListener('mouseup', handleMouseUp);
  document.addEventListener('keydown', handleKeyDown);
  window.addEventListener('resize', () => {
    if (waveformData && waveformData.length > 0) drawWaveform();
    else drawTimeline();
    syncReviewCards();
  });

  updatePlaybackSpeedDisplay();
  updateSummaryLabels();
  updateReviewSummary();
  updateCurrentReviewInfo();
  renderReviewCards();
  drawTimeline();

  addMessage('高速判定ページを開きました。複数の小さな動画を読み込むと、OK と削除を横スクロールで素早く判定できます。', 'info');
  addMessage('ショートカット: Space・]・\\ 再生 / Enter OK移動 / Ctrl+Z・戻る 1件復元 / ←→ 3秒移動 / Backspace・Delete 削除移動 / D・S 速度変更', 'info');
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
