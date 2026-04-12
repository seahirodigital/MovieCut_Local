/**
 * Movie AutoCut - app.js
 * ======================
 * Python バックエンド (server.py) と連携して動作する
 * 音声波形解析・音量急変検出・動画切り出し・圧縮をFFmpeg経由で実行
 */

// ===== API設定 =====
const API_BASE = window.location.origin;
const WS_URL = `ws://${window.location.host}/ws/progress`;

// ===== グローバル状態 =====
let currentFilePath = null;
let waveformData = null;
let clips = [];
let selectedClipIndex = -1;
let videoElement = null;
let canvasElement = null;
let isDragging = false;
let isResizing = false;
let resizeDirection = null;
let dragStartX = 0;
let zoomLevel = 1;
let scrollOffset = 0;
let dragMoved = false;
let checkedClips = new Set();
let processedClips = new Set();
let undoStack = [];
let maxUndoSteps = 50;
let isWaveformDragging = false;
let waveformDragStartX = 0;
let waveformDragStartScroll = 0;
let isProcessing = false;
let hoveredClipIndex = -1;
let waveformAmplitudeScale = 1.0;
let detectedSpikes = [];
let playbackSpeed = 1.0;
let clipSliderSyncFrame = null;
let clipPlaybackMonitor = null;
let currentPlaybackClipIndex = -1;
let currentWorkspaceMode = 'editor';
let reviewApprovedClips = new Set();
let isSidePanelOpen = false;
let isMerging = false;
let lastExportedFilePaths = [];
let exportUiState = {
  active: false,
  button: null,
  originalHtml: '',
  originalTitle: '',
  totalClips: 0,
  currentClip: 0,
  stage: '',
  stopping: false
};

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

// 圧縮機能用
let compressVideoDuration = 0;
let isCompressing = false;

// WebSocket接続
let ws = null;
let wsReconnectTimer = null;

// ===== WebSocket接続 =====
function connectWebSocket() {
  if (ws && ws.readyState === WebSocket.OPEN) return;

  try {
    ws = new WebSocket(WS_URL);

    ws.onopen = () => {
      console.log('✅ WebSocket接続成功');
      document.getElementById('serverStatus').style.display = 'none';
      if (wsReconnectTimer) {
        clearInterval(wsReconnectTimer);
        wsReconnectTimer = null;
      }
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        handleServerMessage(data);
      } catch (e) {
        console.warn('WebSocketメッセージのパース失敗:', e);
      }
    };

    ws.onclose = () => {
      console.log('⚠️ WebSocket切断');
      ws = null;
      // 再接続タイマー
      if (!wsReconnectTimer) {
        wsReconnectTimer = setInterval(() => {
          connectWebSocket();
        }, 3000);
      }
    };

    ws.onerror = () => {
      document.getElementById('serverStatus').style.display = 'block';
    };
  } catch (e) {
    console.error('WebSocket接続エラー:', e);
    document.getElementById('serverStatus').style.display = 'block';
  }
}

function handleServerMessage(data) {
  switch (data.type) {
    case 'progress':
      updateProgress(data.message, data.percent);
      break;
    case 'export_progress':
      updateProgress(data.message, data.percent);
      handleExportProgressMessage(data);
      break;
    case 'compress_progress':
      updateCompressProgress(data.message, data.percent);
      break;
    case 'clip_done':
      handleExportProgressMessage(data);
      addMessage(data.message, 'success');
      break;
    case 'error':
      addMessage(data.message, 'error');
      break;
    case 'pong':
      break;
  }
}

// WebSocket keepalive
setInterval(() => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send('ping');
  }
}, 15000);


function getVideoBitrateSelection() {
  const bitrateInput = document.getElementById('bitrateInput');
  return (bitrateInput && bitrateInput.value) ? bitrateInput.value : '2500';
}

function isActiveExportStopButton(button) {
  return !!button && exportUiState.active && exportUiState.button === button;
}

function formatActiveExportButtonLabel() {
  const totalClips = Math.max(0, exportUiState.totalClips || 0);
  const currentClip = totalClips > 0 ? Math.min(totalClips, Math.max(1, exportUiState.currentClip || 1)) : 0;
  const countText = totalClips > 0 ? `${currentClip}/${totalClips}` : '';
  const stageText = exportUiState.stage || '書き出し中';

  if (exportUiState.button && exportUiState.button.classList.contains('btn-small')) {
    return exportUiState.stopping ? '⏳' : '⏹';
  }

  const prefix = exportUiState.stopping ? '⏳ 停止中' : '⏹ 停止';
  return [prefix, countText, stageText].filter(Boolean).join(' | ');
}

function renderActiveExportButton() {
  if (!exportUiState.active || !exportUiState.button) return;

  if (!exportUiState.button.classList.contains('btn-small')) {
    exportUiState.button.classList.remove('btn-secondary', 'btn-danger');
    exportUiState.button.classList.add('btn-primary');
  }
  exportUiState.button.disabled = false;
  exportUiState.button.innerHTML = formatActiveExportButtonLabel();

  if (exportUiState.button.classList.contains('btn-small')) {
    const totalClips = Math.max(1, exportUiState.totalClips || 1);
    const currentClip = Math.min(totalClips, Math.max(1, exportUiState.currentClip || 1));
    exportUiState.button.title = `${currentClip}/${totalClips} ${exportUiState.stage || '書き出し中'}`;
  }
}

function beginExportButtonState(button, totalClips, stageText) {
  if (!button) return;

  exportUiState = {
    active: true,
    button,
    originalHtml: button.innerHTML,
    originalTitle: button.title || '',
    totalClips: totalClips || 0,
    currentClip: totalClips > 0 ? 1 : 0,
    stage: stageText || '書き出し準備中',
    stopping: false
  };
  renderActiveExportButton();
}

function updateExportButtonState(patch = {}) {
  if (!exportUiState.active) return;
  exportUiState = { ...exportUiState, ...patch };
  renderActiveExportButton();
}

function resetExportButtonState() {
  if (!exportUiState.button) {
    exportUiState = {
      active: false,
      button: null,
      originalHtml: '',
      originalTitle: '',
      totalClips: 0,
      currentClip: 0,
      stage: '',
      stopping: false
    };
    return;
  }

  exportUiState.button.innerHTML = exportUiState.originalHtml;
  exportUiState.button.title = exportUiState.originalTitle;
  exportUiState.button.disabled = false;
  exportUiState = {
    active: false,
    button: null,
    originalHtml: '',
    originalTitle: '',
    totalClips: 0,
    currentClip: 0,
    stage: '',
    stopping: false
  };
}

function updateLastExportedFiles(results = []) {
  lastExportedFilePaths = results
    .filter((result) => result && result.success && result.path)
    .map((result) => result.path);
  refreshMergeSectionState();
}

function refreshMergeSectionState() {
  const mergeStatus = document.getElementById('mergeStatus');
  const mergeLastExportsBtn = document.getElementById('mergeLastExportsBtn');
  const mergeSelectVideosBtn = document.getElementById('mergeSelectVideosBtn');

  if (mergeStatus) {
    if (lastExportedFilePaths.length >= 2) {
      mergeStatus.textContent = `直前の細切れ出力: ${lastExportedFilePaths.length}本を結合できます`;
    } else if (lastExportedFilePaths.length === 1) {
      mergeStatus.textContent = '直前の細切れ出力が1本だけなので、結合には2本以上必要です';
    } else {
      mergeStatus.textContent = 'まだ細切れ出力結果がありません';
    }
  }

  if (mergeLastExportsBtn) {
    mergeLastExportsBtn.disabled = isMerging || isProcessing || lastExportedFilePaths.length < 2;
  }
  if (mergeSelectVideosBtn) {
    mergeSelectVideosBtn.disabled = isMerging || isProcessing;
  }
}

async function requestExportStop() {
  if (!exportUiState.active || exportUiState.stopping) return;

  updateExportButtonState({ stopping: true, stage: '停止要求を送信中' });

  try {
    const response = await fetch(`${API_BASE}/api/export-stop`, { method: 'POST' });
    const data = await response.json();

    if (!response.ok || !data.success) {
      updateExportButtonState({ stopping: false, stage: '停止要求に失敗' });
      addMessage(data.error || '書き出し停止に失敗しました', 'error');
      return;
    }

    updateExportButtonState({ stage: '停止処理中' });
    addMessage('書き出し停止を要求しました', 'warning');
  } catch (error) {
    updateExportButtonState({ stopping: false, stage: '停止要求に失敗' });
    addMessage(`書き出し停止エラー: ${error.message}`, 'error');
  }
}

function handleExportProgressMessage(data) {
  const phaseMap = {
    encoding: 'FFmpeg書き出し中',
    clip_done: 'クリップ保存完了',
    stopping: '停止処理中',
    cancelled: '停止完了',
    complete: '全クリップ完了'
  };

  updateExportButtonState({
    currentClip: Number.isFinite(data.current_clip) ? data.current_clip : exportUiState.currentClip,
    totalClips: Number.isFinite(data.total_clips) ? data.total_clips : exportUiState.totalClips,
    stage: phaseMap[data.phase] || data.message || exportUiState.stage,
    stopping: data.phase === 'stopping' ? true : exportUiState.stopping
  });
}

async function openMultipleVideoFilesDialog() {
  const response = await fetch(`${API_BASE}/api/dialog/open-files`, { cache: 'no-store' });
  const data = await response.json();

  if (!response.ok || data.error) {
    throw new Error(data.error || '動画選択ダイアログを開けませんでした');
  }

  if (!data.success || !Array.isArray(data.paths) || data.paths.length === 0) {
    return [];
  }

  return data.paths;
}

function isSupportedVideoPath(path) {
  return /\.(mp4|mov|avi|mkv|wmv|flv|webm|m4v|ts|mts)$/i.test(String(path || '').trim());
}

function isAbsoluteDroppedPath(path) {
  return String(path || '').startsWith('/') || /^[A-Za-z]:[\\/]/.test(String(path || ''));
}

function decodeDroppedPath(path) {
  try {
    return decodeURIComponent(path);
  } catch (error) {
    return path;
  }
}

function normalizeDroppedPath(value) {
  let path = String(value || '').trim();
  if (!path || path.startsWith('#')) {
    return '';
  }

  if (path.startsWith('file://')) {
    try {
      const url = new URL(path);
      path = url.pathname;
    } catch (error) {
      path = path.replace(/^file:\/\/localhost/i, '').replace(/^file:\/\//i, '');
    }
  }

  return decodeDroppedPath(path).trim();
}

function addDroppedPathCandidates(paths, text) {
  String(text || '')
    .split(/\r?\n/)
    .map((line) => normalizeDroppedPath(line))
    .filter((path) => path && isAbsoluteDroppedPath(path) && isSupportedVideoPath(path))
    .forEach((path) => paths.push(path));
}

function readDroppedString(item) {
  return new Promise((resolve) => {
    item.getAsString((value) => resolve(value || ''));
  });
}

function getDroppedVideoFileMetadata(dataTransfer) {
  if (!dataTransfer || !dataTransfer.files) {
    return [];
  }

  return Array.from(dataTransfer.files)
    .filter((file) => file && isSupportedVideoPath(file.name))
    .map((file) => ({
      name: file.name,
      size: file.size,
      lastModified: file.lastModified || null
    }));
}

async function resolveDroppedVideoPathsByMetadata(dataTransfer) {
  const fileMetadata = getDroppedVideoFileMetadata(dataTransfer);
  if (fileMetadata.length === 0) {
    return [];
  }

  const formData = new FormData();
  formData.append('file_metadata_json', JSON.stringify(fileMetadata));

  const response = await fetch(`${API_BASE}/api/resolve-dropped-files`, {
    method: 'POST',
    body: formData
  });
  const data = await response.json();

  if (!response.ok || !data.success) {
    throw new Error(data.error || 'ドロップした動画ファイルのパス解決に失敗しました');
  }

  if (Array.isArray(data.ambiguous) && data.ambiguous.length > 0) {
    addMessage(`${data.ambiguous.length}件は同名ファイルが複数あり、自動判定できませんでした`, 'warning');
  }
  if (Array.isArray(data.unresolved) && data.unresolved.length > 0) {
    addMessage(`${data.unresolved.length}件は既知フォルダ内で見つかりませんでした`, 'warning');
  }

  return Array.isArray(data.paths) ? data.paths : [];
}

async function getDroppedVideoPaths(dataTransfer) {
  const paths = [];

  if (!dataTransfer) {
    return paths;
  }

  ['text/uri-list', 'text/plain'].forEach((type) => {
    addDroppedPathCandidates(paths, dataTransfer.getData(type));
  });

  if (dataTransfer.items) {
    const stringItems = Array.from(dataTransfer.items).filter((item) => item.kind === 'string');
    for (const item of stringItems) {
      addDroppedPathCandidates(paths, await readDroppedString(item));
    }
  }

  if (dataTransfer.files) {
    Array.from(dataTransfer.files).forEach((file) => {
      addDroppedPathCandidates(paths, file.path || '');
    });
  }

  const directPaths = Array.from(new Set(paths));
  if (directPaths.length > 0) {
    return directPaths;
  }

  return resolveDroppedVideoPathsByMetadata(dataTransfer);
}

function setDropTargetActive(target, active) {
  if (!target) return;

  target.style.outline = active ? '2px solid #38bdf8' : '';
  target.style.outlineOffset = active ? '3px' : '';
  target.style.backgroundColor = active ? 'rgba(56,189,248,0.08)' : '';
}

async function handleFilePathDrop(event) {
  event.preventDefault();
  event.stopPropagation();
  setDropTargetActive(event.currentTarget, false);

  let paths = [];
  try {
    paths = await getDroppedVideoPaths(event.dataTransfer);
  } catch (error) {
    addMessage(error.message || 'ドロップした動画ファイルのパス解決に失敗しました', 'error');
    return;
  }

  if (paths.length === 0) {
    addMessage('動画パスを取得できませんでした。Finderからパス文字列または file:// 形式でドロップしてください。', 'warning');
    return;
  }

  const filePathInput = document.getElementById('filePathInput');
  if (!filePathInput) {
    return;
  }

  filePathInput.value = paths[0];
  addMessage(`ドロップした動画を読み込みます: ${paths[0]}`, 'success');
  if (paths.length > 1) {
    addMessage(`${paths.length}本の動画を受け取りました。通常読み込みでは先頭の1本を使います。`, 'info');
  }
  await handleFileLoad();
}

async function handleMergeDrop(event) {
  event.preventDefault();
  event.stopPropagation();
  setDropTargetActive(event.currentTarget, false);

  let paths = [];
  try {
    paths = await getDroppedVideoPaths(event.dataTransfer);
  } catch (error) {
    addMessage(error.message || 'ドロップした動画ファイルのパス解決に失敗しました', 'error');
    return;
  }

  if (paths.length < 2) {
    addMessage('動画結合には2本以上の動画パスをドロップしてください。', 'warning');
    return;
  }

  addMessage(`${paths.length}本の動画をドロップで受け取りました`, 'success');
  await mergeVideoFiles(paths, {
    button: document.getElementById('mergeSelectVideosBtn'),
    mergeMode: 'auto',
    startMessage: `ドロップした ${paths.length} 本の動画を結合しています...`
  });
}

function setupVideoPathDropTarget(target, dropHandler) {
  if (!target) return;

  ['dragenter', 'dragover'].forEach((eventName) => {
    target.addEventListener(eventName, (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = 'copy';
      }
      setDropTargetActive(target, true);
    });
  });

  ['dragleave', 'dragend'].forEach((eventName) => {
    target.addEventListener(eventName, (event) => {
      event.preventDefault();
      event.stopPropagation();
      setDropTargetActive(target, false);
    });
  });

  target.addEventListener('drop', dropHandler, { capture: true });
}

async function mergeVideoFiles(filePaths, options = {}) {
  if (isMerging) {
    addMessage('動画結合はすでに進行中です', 'warning');
    return null;
  }

  if (isProcessing) {
    addMessage('書き出し中は動画結合を開始できません', 'warning');
    return null;
  }

  if (!Array.isArray(filePaths) || filePaths.length < 2) {
    addMessage('動画結合には2本以上の動画が必要です', 'warning');
    return null;
  }

  const button = options.button || null;
  const originalHtml = button ? button.innerHTML : '';
  const outputDir = document.getElementById('outputDirInput').value.trim() || '';
  const progressContainer = document.getElementById('progressContainer');

  isMerging = true;
  refreshMergeSectionState();

  if (button) {
    button.innerHTML = '結合中...';
    button.disabled = true;
  }

  if (progressContainer) {
    progressContainer.style.display = 'block';
  }
  updateProgress(`動画 ${filePaths.length} 本を結合中...`, 5);
  addMessage(options.startMessage || `動画 ${filePaths.length} 本を結合しています...`, 'info');

  try {
    const params = new URLSearchParams({
      file_paths_json: JSON.stringify(filePaths),
      output_dir: outputDir,
      merge_mode: options.mergeMode || 'auto'
    });

    const response = await fetch(`${API_BASE}/api/merge-videos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString()
    });
    const data = await response.json();

    if (!response.ok || !data.success) {
      addMessage(data.error || '動画結合に失敗しました', 'error');
      return null;
    }

    addMessage(`🎞️ ${data.file_count}本の動画を1本に結合しました`, 'success');
    addMessage(`📁 保存先: ${data.output_path}`, 'info');
    addMessage(`⚙️ 結合方式: ${data.merge_method === 'copy' ? 'コピー結合' : '再エンコード結合'}`, 'info');
    fetch(`${API_BASE}/api/open-folder?path=${encodeURIComponent(data.output_path)}`).catch(() => {});
    updateProgress('動画結合が完了しました', 100);
    return data;
  } catch (error) {
    addMessage(`動画結合エラー: ${error.message}`, 'error');
    return null;
  } finally {
    isMerging = false;
    if (button) {
      button.innerHTML = originalHtml;
      button.disabled = false;
    }
    refreshMergeSectionState();
    setTimeout(() => {
      if (!isProcessing) {
        document.getElementById('progressContainer').style.display = 'none';
      }
    }, 2000);
  }
}


async function openOutputDirectoryDialog() {
  const outputDirInput = document.getElementById('outputDirInput');
  if (!outputDirInput) return;

  try {
    const resp = await fetch(`${API_BASE}/api/dialog/open-directory`, { cache: 'no-store' });
    const data = await resp.json();

    if (data.success && data.path) {
      outputDirInput.value = data.path;
      addMessage(`保存先: ${data.path}`, 'success');
      return;
    }

    if (data.error) {
      addMessage(`保存先フォルダを開けませんでした: ${data.error}`, 'warning');
    }
  } catch (e) {
    addMessage('保存先フォルダを開けませんでした。直接パスを入力するか、参照ボタンを再度押してください', 'warning');
  }
}

function toggleAutoDetectSettings(forceOpen) {
  const autoDetectSection = document.getElementById('autoDetectSection');
  const settingsToggleBtn = document.getElementById('settingsToggleBtn');
  if (!autoDetectSection || !settingsToggleBtn) return;

  const shouldOpen = typeof forceOpen === 'boolean' ? forceOpen : autoDetectSection.hidden;
  autoDetectSection.hidden = !shouldOpen;
  settingsToggleBtn.classList.toggle('active', shouldOpen);
  settingsToggleBtn.setAttribute('aria-expanded', shouldOpen ? 'true' : 'false');

  if (shouldOpen) {
    autoDetectSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

function toggleSidePanel(forceOpen) {
  const navMenuBtn = document.getElementById('navMenuBtn');
  const sidePanel = document.getElementById('sidePanel');
  const sidePanelOverlay = document.getElementById('sidePanelOverlay');
  if (!navMenuBtn || !sidePanel || !sidePanelOverlay) return;

  const shouldOpen = typeof forceOpen === 'boolean' ? forceOpen : !isSidePanelOpen;
  isSidePanelOpen = shouldOpen;

  if (shouldOpen) {
    sidePanelOverlay.hidden = false;
    requestAnimationFrame(() => {
      sidePanel.classList.add('open');
      sidePanelOverlay.classList.add('open');
      navMenuBtn.classList.add('active');
    });
  } else {
    sidePanel.classList.remove('open');
    sidePanelOverlay.classList.remove('open');
    navMenuBtn.classList.remove('active');
    window.setTimeout(() => {
      if (!isSidePanelOpen) {
        sidePanelOverlay.hidden = true;
      }
    }, 260);
  }

  navMenuBtn.setAttribute('aria-expanded', shouldOpen ? 'true' : 'false');
  sidePanel.setAttribute('aria-hidden', shouldOpen ? 'false' : 'true');
  document.body.classList.toggle('side-panel-open', shouldOpen);
}

function updateWorkspaceModeUI() {
  const clipEditSection = document.getElementById('clipEditSection');
  const reviewSection = document.getElementById('reviewSection');
  const workspaceModeBadge = document.getElementById('workspaceModeBadge');
  const workspaceModeDescription = document.getElementById('workspaceModeDescription');
  const sideNavButtons = document.querySelectorAll('.side-nav-btn[data-view-mode]');
  const isReviewMode = currentWorkspaceMode === 'review';

  if (clipEditSection) {
    clipEditSection.hidden = isReviewMode;
  }
  if (reviewSection) {
    reviewSection.hidden = !isReviewMode;
  }
  if (workspaceModeBadge) {
    workspaceModeBadge.textContent = isReviewMode ? '高速判定' : 'メイン編集';
  }
  if (workspaceModeDescription) {
    workspaceModeDescription.textContent = isReviewMode
      ? '横スクロールの判定カードで OK / 削除 を高速に振り分けるビューです。'
      : '既存のクリップ編集と一括出力を行う通常ビューです。';
  }

  sideNavButtons.forEach((button) => {
    button.classList.toggle('active', button.dataset.viewMode === currentWorkspaceMode);
  });
}

function setWorkspaceMode(mode, options = {}) {
  if (mode !== 'editor' && mode !== 'review') return;

  currentWorkspaceMode = mode;
  updateWorkspaceModeUI();
  updateReviewClipList();

  if (mode === 'review' && clips.length > 0) {
    const targetIndex = selectedClipIndex >= 0 && clips[selectedClipIndex] ? selectedClipIndex : 0;
    focusReviewClip(targetIndex, {
      syncVideo: options.syncVideo !== false,
      scrollReview: true,
      behavior: options.behavior || 'smooth'
    });
  }

  if (options.closePanel !== false) {
    toggleSidePanel(false);
  }

  if (!options.silent) {
    addMessage(mode === 'review' ? '高速判定ビューに切り替えました' : 'メイン編集ビューに切り替えました', 'info');
  }
}


// ===== 初期化 =====
function init() {
  videoElement = document.getElementById('videoPlayer');
  canvasElement = document.getElementById('waveformCanvas');

  // 再生速度の初期化
  playbackSpeed = 1.0;
  if (videoElement) {
    videoElement.playbackRate = playbackSpeed;
    videoElement.addEventListener('timeupdate', syncClipPreviewSliders);
    videoElement.addEventListener('seeked', syncClipPreviewSliders);
    videoElement.addEventListener('loadedmetadata', syncClipPreviewSliders);
    videoElement.addEventListener('play', startClipPreviewSyncLoop);
    videoElement.addEventListener('pause', stopClipPreviewSyncLoop);
    videoElement.addEventListener('ended', stopClipPreviewSyncLoop);
    videoElement.addEventListener('pause', clearCurrentPlaybackClip);
    videoElement.addEventListener('ended', clearCurrentPlaybackClip);
  }
  updatePlaybackSpeedDisplay();

  // WebSocket接続
  connectWebSocket();

  // ファイル選択: ダブルクリック→エクスプローラーを開く（シングルクリックは手入力用）
  const filePathInput = document.getElementById('filePathInput');
  const outputDirInput = document.getElementById('outputDirInput');
  const browseOutputDirBtn = document.getElementById('browseOutputDirBtn');
  const navMenuBtn = document.getElementById('navMenuBtn');
  const sidePanelCloseBtn = document.getElementById('sidePanelCloseBtn');
  const sidePanelOverlay = document.getElementById('sidePanelOverlay');
  const settingsToggleBtn = document.getElementById('settingsToggleBtn');
  const closeSettingsBtn = document.getElementById('closeSettingsBtn');
  const reviewPrevBtn = document.getElementById('reviewPrevBtn');
  const reviewNextBtn = document.getElementById('reviewNextBtn');
  const mergeLastExportsBtn = document.getElementById('mergeLastExportsBtn');
  const mergeSelectVideosBtn = document.getElementById('mergeSelectVideosBtn');
  const filePathDropTarget = filePathInput ? filePathInput.closest('.top-control-card') || filePathInput : null;
  const mergeDropTarget = mergeSelectVideosBtn ? mergeSelectVideosBtn.closest('section') : null;

  filePathInput.title = 'ダブルクリックでファイル選択ダイアログを開く';
  outputDirInput.title = 'ダブルクリックでフォルダ選択ダイアログを開く';

  filePathInput.title = 'ダブルクリックでファイル選択ダイアログを開く';
  outputDirInput.title = 'ダブルクリックでフォルダ選択ダイアログを開く';
  filePathInput.placeholder = '動画ファイルをドロップ / ダブルクリックで選択 / 直接パスを入力してEnter';
  outputDirInput.placeholder = 'ダブルクリックで保存先フォルダを選択 / 空欄で動画と同じフォルダ';
  setupVideoPathDropTarget(filePathDropTarget, handleFilePathDrop);
  setupVideoPathDropTarget(mergeDropTarget, handleMergeDrop);

  filePathInput.addEventListener('dblclick', async () => {
    try {
      const resp = await fetch(`${API_BASE}/api/dialog/open-file`);
      const data = await resp.json();
      if (data.success && data.path) {
        filePathInput.value = data.path;
        handleFileLoad();
      }
    } catch(e) {
      addMessage('ダイアログを開けませんでした。直接パスを入力してください', 'warning');
    }
  });

  outputDirInput.addEventListener('dblclick', openOutputDirectoryDialog);
  if (browseOutputDirBtn) {
    browseOutputDirBtn.addEventListener('click', openOutputDirectoryDialog);
  }
  if (navMenuBtn) {
    navMenuBtn.addEventListener('click', () => toggleSidePanel());
  }
  if (sidePanelCloseBtn) {
    sidePanelCloseBtn.addEventListener('click', () => toggleSidePanel(false));
  }
  if (sidePanelOverlay) {
    sidePanelOverlay.addEventListener('click', () => toggleSidePanel(false));
  }
  if (settingsToggleBtn) {
    settingsToggleBtn.addEventListener('click', () => toggleAutoDetectSettings());
  }
  if (closeSettingsBtn) {
    closeSettingsBtn.addEventListener('click', () => toggleAutoDetectSettings(false));
  }
  document.querySelectorAll('.side-nav-btn[data-view-mode]').forEach((button) => {
    button.addEventListener('click', () => {
      setWorkspaceMode(button.dataset.viewMode);
    });
  });
  if (reviewPrevBtn) {
    reviewPrevBtn.addEventListener('click', () => moveReviewFocus(-1));
  }
  if (reviewNextBtn) {
    reviewNextBtn.addEventListener('click', () => moveReviewFocus(1));
  }

  // ファイル読み込みボタン
  document.getElementById('loadFileBtn').addEventListener('click', handleFileLoad);
  document.getElementById('filePathInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleFileLoad();
  });

  // 自動検出設定
  document.getElementById('loudThreshold').addEventListener('input', updateThresholdDisplays);
  document.getElementById('analyzeBtn').addEventListener('click', handleAnalyze);
  document.getElementById('autoExportBtn').addEventListener('click', handleAutoExport);

  // クリップ操作
  document.getElementById('downloadSegmentsBtn').addEventListener('click', handleDownloadSegments);
  document.getElementById('addClipBtn').addEventListener('click', handleAddClip);
  document.getElementById('selectAllClipsBtn').addEventListener('click', handleSelectAllClips);
  document.getElementById('deselectAllClipsBtn').addEventListener('click', handleDeselectAllClips);
  document.getElementById('deleteClipBtn').addEventListener('click', handleDeleteClip);
  document.getElementById('timelineAddBtn').addEventListener('click', handleAddClip);
  document.getElementById('timelineRemoveBtn').addEventListener('click', handleDeleteClip);

  if (mergeLastExportsBtn) {
    mergeLastExportsBtn.addEventListener('click', async () => {
      await mergeVideoFiles(lastExportedFilePaths, {
        button: mergeLastExportsBtn,
        mergeMode: 'copy',
        startMessage: `直前に出力した ${lastExportedFilePaths.length} 本を1本に結合しています...`
      });
    });
  }

  if (mergeSelectVideosBtn) {
    mergeSelectVideosBtn.addEventListener('click', async () => {
      try {
        const selectedPaths = await openMultipleVideoFilesDialog();
        if (!selectedPaths || selectedPaths.length === 0) {
          addMessage('結合する動画の選択をキャンセルしました', 'info');
          return;
        }

        addMessage(`${selectedPaths.length} 本の動画を選択しました`, 'success');
        await mergeVideoFiles(selectedPaths, {
          button: mergeSelectVideosBtn,
          mergeMode: 'auto',
          startMessage: `選択した ${selectedPaths.length} 本の動画を結合しています...`
        });
      } catch (error) {
        addMessage(error.message, 'error');
      }
    });
  }

  // キャンバス操作
  canvasElement.addEventListener('click', handleCanvasClick);
  canvasElement.addEventListener('wheel', handleWheel, { passive: false });
  canvasElement.addEventListener('mousedown', handleWaveformMouseDown);

  // グローバルマウス/キー操作
  document.addEventListener('mousemove', handleMouseMove);
  document.addEventListener('mouseup', handleMouseUp);
  document.addEventListener('keydown', handleKeyDown);
  document.addEventListener('keyup', handleKeyUp);

  // 圧縮機能のイベントリスナー
  const compressFileInput = document.getElementById('compressFileInput');
  const startCompressBtn = document.getElementById('startCompressBtn');
  const compressResetRangeBtn = document.getElementById('compressResetRangeBtn');

  if (compressFileInput) {
    // 圧縮セクションのファイル選択を無効化し、テキスト入力に変更する案内を表示
    // 圧縮もメインのファイルパスを使う
  }
  if (startCompressBtn) {
    startCompressBtn.addEventListener('click', handleCompress);
    startCompressBtn.disabled = true;
  }
  if (compressResetRangeBtn) {
    compressResetRangeBtn.addEventListener('click', () => {
      const sliderElement = document.getElementById('compressTrimSlider');
      if (sliderElement && sliderElement.noUiSlider && compressVideoDuration > 0) {
        sliderElement.noUiSlider.set([0, compressVideoDuration]);
        addMessage('時間範囲を全範囲にリセットしました', 'success');
      }
    });
  }

  // 波形振幅調整
  document.getElementById('waveformScale').addEventListener('input', (e) => {
    waveformAmplitudeScale = parseFloat(e.target.value);
    document.getElementById('waveformScaleValue').textContent = waveformAmplitudeScale.toFixed(1);
    if (waveformData && waveformData.length > 0) {
      drawWaveform();
    }
  });

  document.getElementById('resetWaveformScale').addEventListener('click', () => {
    waveformAmplitudeScale = 1.0;
    document.getElementById('waveformScale').value = '1.0';
    document.getElementById('waveformScaleValue').textContent = '1.0';
    if (waveformData && waveformData.length > 0) {
      drawWaveform();
    }
    addMessage('波形スケールをリセットしました', 'success');
  });

  updateWorkspaceModeUI();
  updateReviewClipList();
  refreshMergeSectionState();

  addMessage('Movie_AutoCut (Python Backend) へようこそ', 'info');
  addMessage('📂 動画ファイルのパスを入力して「読み込み」を押してください', 'info');
  addMessage('💡 保存先は動画と同じフォルダが初期設定です', 'info');
}


// ===== ファイル読み込み（Python API経由） =====
async function handleFileLoad() {
  const filePath = document.getElementById('filePathInput').value.trim();
  if (!filePath) {
    addMessage('動画ファイルのパスを入力してください', 'error');
    return;
  }

  currentFilePath = filePath;
  addMessage(`ファイルを読み込み中: ${filePath}`, 'info');

  // 変数をリセット
  waveformData = null;
  clips = [];
  checkedClips.clear();
  processedClips.clear();
  reviewApprovedClips.clear();
  selectedClipIndex = -1;
  clearClipPlaybackMonitor();
  detectedSpikes = [];
  renderClips();
  updateClipList();
  drawTimeline();

  try {
    // 動画情報取得
    const infoResp = await fetch(`${API_BASE}/api/video-info`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `file_path=${encodeURIComponent(filePath)}`
    });
    const info = await infoResp.json();

    if (!info.success) {
      addMessage(`エラー: ${info.error}`, 'error');
      return;
    }

    addMessage(`動画情報: ${info.file_name} (${info.file_size_mb} MB, ${formatTime(info.duration)})`, 'success');

    // サーバー経由で動画をブラウザにロード
    const videoUrl = `${API_BASE}/api/video?path=${encodeURIComponent(filePath)}`;
    if (videoElement.src) {
      URL.revokeObjectURL(videoElement.src);
    }
    videoElement.src = videoUrl;
    videoElement.load();

    videoElement.addEventListener('loadedmetadata', async () => {
      addMessage(`動画の長さ: ${formatTime(videoElement.duration)}`, 'success');
      drawTimeline();

      document.getElementById('clipEditSection').style.display = 'block';
      document.getElementById('downloadSegmentsBtn').style.display = 'inline-block';

      // 圧縮セクションのスライダー初期化
      compressVideoDuration = videoElement.duration;
      initializeCompressSlider();
      const startCompressBtn = document.getElementById('startCompressBtn');
      if (startCompressBtn) startCompressBtn.disabled = false;

      // 音声波形解析をPython APIで実行
      addMessage('🎵 音声波形をPython+FFmpegで解析しています...', 'info');
      document.getElementById('progressContainer').style.display = 'block';
      updateProgress('音声解析準備中...', 0);

      await analyzeAudioFromServer(filePath);
    }, { once: true });

    videoElement.addEventListener('error', (e) => {
      console.error('❌ 動画読み込みエラー:', e);
      addMessage('動画の読み込みに失敗しました (サーバー経由の再生)', 'error');
    }, { once: true });

  } catch (e) {
    addMessage(`サーバー通信エラー: ${e.message}`, 'error');
    addMessage('⚠️ server.py が起動しているか確認してください', 'warning');
  }
}


// ===== 音声波形解析（Python API版） =====
async function analyzeAudioFromServer(filePath) {
  try {
    const resp = await fetch(`${API_BASE}/api/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `file_path=${encodeURIComponent(filePath)}`
    });
    const data = await resp.json();

    if (!data || data.success === false) {
      addMessage(`音声解析エラー: ${data?.error || '音声解析に失敗しました'}`, 'error');
      document.getElementById('progressContainer').style.display = 'none';
      return;
    }

    // 波形データを格納
    waveformData = data.waveform;
    addMessage(`✅ 音声解析完了: ${data.total_points}ポイント`, 'success');

    // 波形を描画
    drawWaveform();

    // 自動検出を実行
    if (videoElement && videoElement.duration && waveformData.length > 0) {
      addMessage('🔍 音量急変を自動検出中...', 'info');
      await detectSpikesFromServer(filePath);
    }

    setTimeout(() => {
      document.getElementById('progressContainer').style.display = 'none';
    }, 2000);

  } catch (e) {
    addMessage(`音声解析エラー: ${e.message}`, 'error');
    document.getElementById('progressContainer').style.display = 'none';
  }
}


// ===== 音量急変検出（Python API版） =====
async function detectSpikesFromServer(filePath) {
  const loudThreshold = parseInt(document.getElementById('loudThreshold').value);
  const durationThreshold = parseFloat(document.getElementById('durationThreshold').value);
  const minGap = parseFloat(document.getElementById('minGap').value);
  const clipDuration = parseFloat(document.getElementById('clipDuration').value);

  try {
    const params = new URLSearchParams({
      file_path: filePath,
      loud_threshold_db: loudThreshold,
      duration_sec: durationThreshold,
      min_gap: minGap,
      clip_duration: clipDuration
    });

    const resp = await fetch(`${API_BASE}/api/detect-spikes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString()
    });
    const data = await resp.json();

    if (!data || data.success === false) {
      addMessage(`検出エラー: ${data.error}`, 'error');
      return data;
    }

    detectedSpikes = data.spikes || [];

    if (detectedSpikes.length > 0) {
      addMessage(`🎯 ${detectedSpikes.length}箇所の音量急変を検出しました`, 'success');
    } else {
      addMessage('⚠️ 音量急変が検出されませんでした。閾値を調整してください', 'warning');
    }

    return data;
  } catch (e) {
    addMessage(`検出エラー: ${e.message}`, 'error');
    return null;
  }
}

function setTopActionButtonsDisabled(disabled) {
  ['analyzeBtn', 'autoExportBtn', 'mergeLastExportsBtn', 'mergeSelectVideosBtn'].forEach((buttonId) => {
    const button = document.getElementById(buttonId);
    if (button) {
      if (disabled && isActiveExportStopButton(button)) {
        button.disabled = false;
        return;
      }
      button.disabled = disabled;
    }
  });
}

function applyDetectedClips(data) {
  if (!data || !Array.isArray(data.clips)) {
    return false;
  }

  clips = data.clips.map((clip) => ({ start: clip.start, end: clip.end }));
  checkedClips.clear();
  processedClips.clear();
  reviewApprovedClips.clear();
  selectedClipIndex = -1;

  addMessage(`${clips.length}個のクリップを作成しました`, 'success');

  renderClips();
  updateClipList();

  document.getElementById('downloadSegmentsBtn').style.display = 'inline-block';
  document.getElementById('clipEditSection').style.display = 'block';

  if (currentWorkspaceMode === 'review' && clips.length > 0) {
    selectedClipIndex = 0;
    if (videoElement) {
      videoElement.currentTime = clips[0].start;
    }
    renderClips();
    updateClipList();
    requestAnimationFrame(() => scrollReviewCardIntoView(0, 'auto'));
  }
  return true;
}


// ===== 自動検出ボタン（handleAnalyze） =====
async function handleAnalyze() {
  if (isProcessing) {
    addMessage('書き出し中は自動検出を開始できません', 'warning');
    return;
  }

  if (!currentFilePath) {
    addMessage('先に動画ファイルを読み込んでください', 'error');
    return;
  }

  const progressContainer = document.getElementById('progressContainer');

  setTopActionButtonsDisabled(true);
  progressContainer.style.display = 'block';
  updateProgress('検出中...', 10);

  addMessage('🔍 Python バックエンドで音量急変を検出しています...', 'info');

  try {
    const data = await detectSpikesFromServer(currentFilePath);
    applyDetectedClips(data);
    updateProgress('検出完了', 100);
  } finally {
    setTimeout(() => {
      setTopActionButtonsDisabled(false);
      progressContainer.style.display = 'none';
    }, 1000);
  }
}

async function handleAutoExport() {
  const autoExportBtn = document.getElementById('autoExportBtn');
  if (isActiveExportStopButton(autoExportBtn)) {
    await requestExportStop();
    return;
  }

  if (isProcessing) {
    addMessage('別の書き出し処理が進行中です', 'warning');
    return;
  }

  if (!currentFilePath) {
    addMessage('先に動画ファイルを読み込んでください', 'error');
    return;
  }

  const progressContainer = document.getElementById('progressContainer');
  const originalText = autoExportBtn.innerHTML;

  setTopActionButtonsDisabled(true);
  autoExportBtn.innerHTML = '🎬 自動出力 | 検出中...';
  isProcessing = true;
  refreshMergeSectionState();
  progressContainer.style.display = 'block';
  updateProgress('自動検出中...', 10);

  addMessage('🎬 自動出力を開始しました。自動検出から全クリップ書き出しまで連続で実行します', 'info');

  try {
    const data = await detectSpikesFromServer(currentFilePath);
    const hasDetectedClips = applyDetectedClips(data);

    if (!hasDetectedClips) {
      updateProgress('自動出力を停止しました', 0);
      return;
    }

    if (clips.length === 0) {
      addMessage('検出されたクリップがないため、自動出力は行いませんでした', 'warning');
      updateProgress('出力対象なし', 100);
      return;
    }

    updateProgress('書き出しを開始します...', 35);

    const exportIndexes = clips.map((_, index) => index);
    const exportResult = await exportClipIndexes(exportIndexes, {
      startMessage: `FFmpegで検出された${exportIndexes.length}個のクリップを自動出力しています...`,
      successMessage: `${exportIndexes.length}個の検出済みクリップを自動出力しました`,
      emptyMessage: '自動出力できるクリップがありません',
      showProgress: true,
      button: autoExportBtn,
      busyHtml: '🎬 自動出力 | 書き出し準備中'
    });

    if (exportResult && exportResult.cancelled) {
      updateProgress('書き出しを停止しました', 0);
    }
  } finally {
    resetExportButtonState();
    autoExportBtn.innerHTML = originalText;
    setTopActionButtonsDisabled(false);
    isProcessing = false;
    refreshMergeSectionState();

    setTimeout(() => {
      progressContainer.style.display = 'none';
    }, 2000);
  }
}
// ===== 動画圧縮（Python API + FFmpeg版） =====
async function handleCompress() {
  if (isCompressing) {
    addMessage('圧縮は進行中です', 'warning');
    return;
  }

  if (!currentFilePath) {
    addMessage('先に動画ファイルを読み込んでください', 'error');
    return;
  }

  const sliderElement = document.getElementById('compressTrimSlider');
  let startTime = 0;
  let endTime = compressVideoDuration;

  if (sliderElement && sliderElement.noUiSlider) {
    const values = sliderElement.noUiSlider.get(true);
    startTime = parseFloat(values[0]);
    endTime = parseFloat(values[1]);
  }

  if (endTime <= startTime) {
    addMessage('終了時間は開始時間より大きくしてください', 'error');
    return;
  }

  const resolution = document.getElementById('compressResolution').value;
  const bitrate = parseInt(document.getElementById('compressBitrate').value);
  const audioBitrate = parseInt(document.getElementById('compressAudioBitrate').value);
  const outputDir = document.getElementById('outputDirInput').value.trim() || '';

  const btn = document.getElementById('startCompressBtn');
  const originalText = btn.innerHTML;
  btn.innerHTML = '⏳ 圧縮中...';
  btn.disabled = true;
  isCompressing = true;

  const progressContainer = document.getElementById('compressProgressContainer');
  progressContainer.style.display = 'block';
  updateCompressProgress('圧縮準備中...', 0);

  addMessage(`🗜️ FFmpegで圧縮開始 (${formatTime(startTime)} - ${formatTime(endTime)}, ${resolution}p, ${bitrate}kbps)...`, 'info');

  try {
    const params = new URLSearchParams({
      file_path: currentFilePath,
      output_dir: outputDir,
      resolution: resolution,
      video_bitrate: bitrate,
      audio_bitrate: audioBitrate,
      start_time: startTime,
      end_time: endTime
    });

    const resp = await fetch(`${API_BASE}/api/compress`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString()
    });
    const data = await resp.json();

    if (data.success) {
      addMessage(`✅ 圧縮完了: ${data.original_size_mb}MB → ${data.compressed_size_mb}MB (${data.reduction_percent}% 削減)`, 'success');
      addMessage(`📁 保存先: ${data.output_path}`, 'info');

      // 結果表示
      const preview = document.getElementById('compressPreview');
      if (preview) {
        document.getElementById('originalFileSize').textContent = `${data.original_size_mb} MB`;
        document.getElementById('compressedFileSize').textContent = `${data.compressed_size_mb} MB (${data.reduction_percent}% 削減)`;
        preview.style.display = 'block';
      }

      updateCompressProgress('圧縮完了!', 100);

      // フォルダを開く
      if (data.output_path) {
        fetch(`${API_BASE}/api/open-folder?path=${encodeURIComponent(data.output_path)}`);
      }
    } else {
      addMessage(`圧縮エラー: ${data.error}`, 'error');
      updateCompressProgress('エラー', 0);
    }
  } catch (e) {
    addMessage(`サーバー通信エラー: ${e.message}`, 'error');
  } finally {
    isCompressing = false;
    btn.innerHTML = originalText;
    btn.disabled = false;

    setTimeout(() => {
      if (!isCompressing) {
        progressContainer.style.display = 'none';
      }
    }, 3000);
  }
}


// ===== キーボード操作 =====
function handleKeyDown(e) {
  if (e.key === 'Escape' && isSidePanelOpen) {
    e.preventDefault();
    toggleSidePanel(false);
    return;
  }

  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;

  // 再生/停止キー: repeatを無視してトグル（押しっぱなし対応）
  if (isPlaybackToggleKey(e)) {
    e.preventDefault();
    if (!e.repeat) {
      videoElement.paused ? videoElement.play() : videoElement.pause();
    }
    return;
  }

  switch (e.key) {
    case 'ArrowLeft':
      e.preventDefault();
      videoElement.currentTime = Math.max(0, videoElement.currentTime - 5);
      break;
    case 'ArrowRight':
      e.preventDefault();
      videoElement.currentTime = Math.min(videoElement.duration, videoElement.currentTime + 5);
      break;
    case 'Enter':
      if (currentWorkspaceMode === 'review' && selectedClipIndex >= 0 && clips[selectedClipIndex]) {
        e.preventDefault();
        if (!e.repeat) {
          approveReviewClip(selectedClipIndex);
        }
      }
      break;
    case 'p':
    case 'P':
      e.preventDefault();
      handleAddClip();
      break;
    case 'Backspace':
    case 'Delete':
      e.preventDefault();
      if (hoveredClipIndex !== -1) {
        deleteSingleClip(hoveredClipIndex);
        hoveredClipIndex = -1;
      } else {
        handleDeleteClip();
      }
      break;
    case 'z':
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        handleUndo();
      }
      break;
    case 'd':
    case 'D':
      e.preventDefault();
      if (playbackSpeed < 3.0) {
        playbackSpeed = Math.min(3.0, playbackSpeed + 0.1);
        playbackSpeed = Math.round(playbackSpeed * 10) / 10;
        videoElement.playbackRate = playbackSpeed;
        updatePlaybackSpeedDisplay();
        addMessage(`⚡ 再生速度: ${playbackSpeed.toFixed(1)}x`, 'info');
      } else {
        addMessage('⚡ 最大速度(3.0x)に達しています', 'warning');
      }
      break;
    case 's':
    case 'S':
      e.preventDefault();
      if (playbackSpeed > 1.0) {
        playbackSpeed = Math.max(1.0, playbackSpeed - 0.1);
        playbackSpeed = Math.round(playbackSpeed * 10) / 10;
        videoElement.playbackRate = playbackSpeed;
        updatePlaybackSpeedDisplay();
        addMessage(`🐢 再生速度: ${playbackSpeed.toFixed(1)}x`, 'info');
      } else {
        addMessage('🐢 通常速度(1.0x)です', 'warning');
      }
      break;
  }
}

function handleKeyUp(e) {}

function updatePlaybackSpeedDisplay() {
  const displayElement = document.getElementById('playbackSpeedDisplay');
  if (!displayElement) return;

  displayElement.textContent = playbackSpeed.toFixed(1) + 'x';

  if (playbackSpeed === 1.0) {
    displayElement.style.background = 'linear-gradient(90deg,#a78bfa 0%,#ec4899 100%)';
  } else if (playbackSpeed < 2.0) {
    displayElement.style.background = 'linear-gradient(90deg,#3b82f6 0%,#a78bfa 100%)';
  } else if (playbackSpeed < 3.0) {
    displayElement.style.background = 'linear-gradient(90deg,#10b981 0%,#3b82f6 100%)';
  } else {
    displayElement.style.background = 'linear-gradient(90deg,#ef4444 0%,#f59e0b 100%)';
  }

  displayElement.style.webkitBackgroundClip = 'text';
  displayElement.style.webkitTextFillColor = 'transparent';
  displayElement.style.backgroundClip = 'text';
}


// ===== Undo/Redo =====
function saveState() {
  undoStack.push({
    clips: JSON.parse(JSON.stringify(clips)),
    checkedClips: new Set(checkedClips),
    processedClips: new Set(processedClips),
    reviewApprovedClips: new Set(reviewApprovedClips),
    selectedClipIndex: selectedClipIndex
  });
  if (undoStack.length > maxUndoSteps) undoStack.shift();
}

function handleUndo() {
  if (undoStack.length === 0) {
    addMessage('これ以上元に戻せません', 'warning');
    return;
  }
  const state = undoStack.pop();
  clips = JSON.parse(JSON.stringify(state.clips));
  checkedClips = new Set(state.checkedClips);
  processedClips = new Set(state.processedClips || []);
  reviewApprovedClips = new Set(state.reviewApprovedClips || []);
  selectedClipIndex = state.selectedClipIndex;
  renderClips();
  updateClipList();
  if (currentWorkspaceMode === 'review' && selectedClipIndex >= 0 && clips[selectedClipIndex]) {
    requestAnimationFrame(() => scrollReviewCardIntoView(selectedClipIndex, 'smooth'));
  }
  addMessage('元に戻しました', 'success');
}


// ===== ズーム・スクロール =====
function handleWheel(e) {
  if (e.shiftKey) {
    e.preventDefault();
    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    zoomLevel = Math.max(1, Math.min(zoomLevel * delta, 200));

    if (videoElement && videoElement.duration) {
      const duration = videoElement.duration;
      const maxScroll = duration * (1 - 1 / zoomLevel);
      scrollOffset = Math.max(0, Math.min(scrollOffset, maxScroll));

      if (waveformData && waveformData.length > 0) {
        drawWaveform();
      } else {
        drawTimeline();
      }
      renderClips();
    }
    addMessage('ズーム: ' + Math.round(zoomLevel * 100) + '%', 'info');
  }
}

function handleWaveformMouseDown(e) {
  if (e.target.classList.contains('segment-marker') || e.target.classList.contains('resize-handle')) return;
  isWaveformDragging = true;
  waveformDragStartX = e.clientX;
  waveformDragStartScroll = scrollOffset;
  canvasElement.style.cursor = 'grabbing';
  document.getElementById('overviewPopup').style.display = 'block';
  updateOverviewPopup();
  e.preventDefault();
}

function handleMouseMove(e) {
  if (!videoElement || !videoElement.duration) return;

  const rect = canvasElement.getBoundingClientRect();
  const duration = videoElement.duration;
  const viewDuration = duration / zoomLevel;

  if (isWaveformDragging) {
    const pixelDelta = e.clientX - waveformDragStartX;
    const timeDelta = (pixelDelta / rect.width) * viewDuration;
    scrollOffset = waveformDragStartScroll - timeDelta;
    const maxScroll = duration * (1 - 1 / zoomLevel);
    scrollOffset = Math.max(0, Math.min(scrollOffset, maxScroll));

    if (waveformData && waveformData.length > 0) {
      drawWaveform();
    } else {
      drawTimeline();
    }
    renderClips();
    updateOverviewPopup();
    return;
  }

  const deltaX = e.clientX - dragStartX;
  const deltaTime = (deltaX / rect.width) * viewDuration;

  if (isDragging && selectedClipIndex >= 0) {
    if (Math.abs(deltaX) > 3) dragMoved = true;
    const clip = clips[selectedClipIndex];
    const clipDuration = clip.end - clip.start;
    let newStart = clip.start + deltaTime;
    newStart = Math.max(0, Math.min(newStart, duration - clipDuration));
    processedClips.delete(selectedClipIndex);
    reviewApprovedClips.delete(selectedClipIndex);
    clips[selectedClipIndex] = { start: newStart, end: newStart + clipDuration };
    if (videoElement) videoElement.currentTime = newStart;
    dragStartX = e.clientX;
    renderClips();
    updateClipList();
  } else if (isResizing && selectedClipIndex >= 0) {
    const clip = clips[selectedClipIndex];
    processedClips.delete(selectedClipIndex);
    reviewApprovedClips.delete(selectedClipIndex);
    if (resizeDirection === 'left') {
      let newStart = clip.start + deltaTime;
      newStart = Math.max(0, Math.min(newStart, clip.end - 0.5));
      clips[selectedClipIndex].start = newStart;
      if (videoElement) videoElement.currentTime = newStart;
    } else if (resizeDirection === 'right') {
      let newEnd = clip.end + deltaTime;
      newEnd = Math.max(clip.start + 0.5, Math.min(newEnd, duration));
      clips[selectedClipIndex].end = newEnd;
      if (videoElement) videoElement.currentTime = newEnd;
    }
    dragStartX = e.clientX;
    renderClips();
    updateClipList();
  }
}

function handleMouseUp(e) {
  if (isWaveformDragging) {
    isWaveformDragging = false;
    canvasElement.style.cursor = 'grab';
    document.getElementById('overviewPopup').style.display = 'none';
    return;
  }
  if (isDragging || isResizing) {
    if (isDragging && !dragMoved && selectedClipIndex >= 0) {
      videoElement.currentTime = clips[selectedClipIndex].start;
    }
    isDragging = false;
    isResizing = false;
    resizeDirection = null;
    dragMoved = false;
  }
}


// ===== 波形描画 =====
function drawWaveform() {
  const ctx = canvasElement.getContext('2d');
  const width = canvasElement.width = canvasElement.offsetWidth * 2;
  const height = canvasElement.height = 160;
  ctx.clearRect(0, 0, width, height);

  if (!waveformData || waveformData.length === 0) {
    drawTimeline();
    return;
  }
  if (!videoElement || !videoElement.duration) return;

  const duration = videoElement.duration;
  const viewDuration = duration / zoomLevel;
  const viewStart = scrollOffset;

  // 背景
  ctx.fillStyle = 'rgba(30, 41, 59, 0.8)';
  ctx.fillRect(0, 0, width, height);

  // 波形データの表示範囲を計算
  const totalPoints = waveformData.length;
  const startIndex = Math.floor((viewStart / duration) * totalPoints);
  const endIndex = Math.ceil(((viewStart + viewDuration) / duration) * totalPoints);
  const viewData = waveformData.slice(startIndex, endIndex);

  if (viewData.length === 0) {
    drawTimelineGrid();
    return;
  }

  const centerY = height / 2;
  const maxAmplitude = (height * 0.4) * waveformAmplitudeScale;

  // 背景グラデーション
  const gradient = ctx.createLinearGradient(0, 0, 0, height);
  gradient.addColorStop(0, 'rgba(139, 92, 246, 0.1)');
  gradient.addColorStop(0.5, 'rgba(139, 92, 246, 0.2)');
  gradient.addColorStop(1, 'rgba(139, 92, 246, 0.1)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);

  // Min/Maxを使った波形描画
  ctx.fillStyle = 'rgba(139, 92, 246, 0.5)';
  ctx.strokeStyle = 'rgba(139, 92, 246, 0.8)';
  ctx.lineWidth = 1;

  ctx.beginPath();
  ctx.moveTo(0, centerY);

  // 上側の波形(max値)
  for (let x = 0; x < width; x++) {
    const dataIndex = Math.floor((x / width) * viewData.length);
    const point = viewData[dataIndex];
    if (!point) continue;
    const amplitude = point.max || 0;
    const scaledAmplitude = Math.min(Math.abs(amplitude) * maxAmplitude, height / 2 - 5);
    const y = centerY - scaledAmplitude;
    if (x === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }

  // 下側の波形(min値)
  for (let x = width - 1; x >= 0; x--) {
    const dataIndex = Math.floor((x / width) * viewData.length);
    const point = viewData[dataIndex];
    if (!point) continue;
    const amplitude = point.min || 0;
    const scaledAmplitude = Math.min(Math.abs(amplitude) * maxAmplitude, height / 2 - 5);
    const y = centerY + scaledAmplitude;
    ctx.lineTo(x, y);
  }

  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // 中央線
  ctx.strokeStyle = 'rgba(148, 163, 184, 0.3)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, centerY);
  ctx.lineTo(width, centerY);
  ctx.stroke();

  drawTimelineGrid();
}

function drawTimelineGrid() {
  if (!videoElement || !videoElement.duration) return;

  const ctx = canvasElement.getContext('2d');
  const width = canvasElement.width;
  const height = canvasElement.height;
  const duration = videoElement.duration;
  const viewDuration = duration / zoomLevel;
  const viewStart = scrollOffset;

  // 5秒ごと
  ctx.strokeStyle = 'rgba(148, 163, 184, 0.3)';
  ctx.lineWidth = 1;
  const smallInterval = 5;
  for (let t = Math.floor(viewStart / smallInterval) * smallInterval; t <= viewStart + viewDuration; t += smallInterval) {
    if (t < 0 || t > duration) continue;
    const x = ((t - viewStart) / viewDuration) * width;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }

  // 30秒ごと + ラベル
  ctx.strokeStyle = 'rgba(148, 163, 184, 0.5)';
  ctx.lineWidth = 2;
  const mediumInterval = 30;
  for (let t = Math.floor(viewStart / mediumInterval) * mediumInterval; t <= viewStart + viewDuration; t += mediumInterval) {
    if (t < 0 || t > duration) continue;
    const x = ((t - viewStart) / viewDuration) * width;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
    ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
    ctx.fillRect(x + 2, 2, 60, 22);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
    ctx.font = 'bold 18px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.fillText(formatTime(t), x + 6, 18);
  }

  // 60秒ごと
  ctx.strokeStyle = 'rgba(236, 72, 153, 0.7)';
  ctx.lineWidth = 3;
  const largeInterval = 60;
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
  const ctx = canvasElement.getContext('2d');
  const width = canvasElement.width = canvasElement.offsetWidth * 2;
  const height = canvasElement.height = 160;
  ctx.clearRect(0, 0, width, height);
  if (!videoElement || !videoElement.duration) return;
  ctx.fillStyle = 'rgba(30, 41, 59, 0.8)';
  ctx.fillRect(0, 0, width, height);
  drawTimelineGrid();
}


// ===== 閾値表示 =====
function updateThresholdDisplays() {
  const loudValue = document.getElementById('loudThreshold').value;
  document.getElementById('loudThresholdValue').textContent = loudValue;
}


// ===== クリップ表示・操作 =====
function renderClips() {
  if (!videoElement || !videoElement.duration) return;

  const markersDiv = document.getElementById('segmentMarkers');
  markersDiv.innerHTML = '';
  const duration = videoElement.duration;
  const viewDuration = duration / zoomLevel;
  const viewStart = scrollOffset;
  const viewEnd = viewStart + viewDuration;
  const currentTime = Number.isFinite(videoElement.currentTime) ? videoElement.currentTime : 0;
  const activePlaybackIndex = getActivePlaybackClipIndex(currentTime);

  clips.forEach((clip, index) => {
    if (clip.end < viewStart || clip.start > viewEnd) return;
    const relativeStart = Math.max(0, clip.start - viewStart);
    const relativeEnd = Math.min(viewDuration, clip.end - viewStart);
    const startPercent = (relativeStart / viewDuration) * 100;
    const widthPercent = ((relativeEnd - relativeStart) / viewDuration) * 100;
    if (startPercent >= 100 || startPercent + widthPercent <= 0) return;

    const marker = document.createElement('div');
    marker.className = 'segment-marker';
    if (index === selectedClipIndex) marker.classList.add('selected');
    if (checkedClips.has(index)) marker.classList.add('checked');
    if (reviewApprovedClips.has(index)) marker.classList.add('approved');
    if (index === activePlaybackIndex) marker.classList.add('playback-active');
    marker.style.left = startPercent + '%';
    marker.style.width = widthPercent + '%';
    marker.dataset.index = index;

    const popup = document.createElement('div');
    popup.className = 'segment-info-popup';
    popup.innerHTML = `${formatTimeForPopup(clip.start)}<br>　│<br>${formatTimeForPopup(clip.end)} (${(clip.end - clip.start).toFixed(2)}秒)`;
    marker.appendChild(popup);

    const leftHandle = document.createElement('div');
    leftHandle.className = 'resize-handle left';
    leftHandle.dataset.direction = 'left';
    leftHandle.dataset.index = index;
    marker.appendChild(leftHandle);

    const rightHandle = document.createElement('div');
    rightHandle.className = 'resize-handle right';
    rightHandle.dataset.direction = 'right';
    rightHandle.dataset.index = index;
    marker.appendChild(rightHandle);

    marker.addEventListener('mousedown', handleMarkerMouseDown);
    marker.addEventListener('mouseenter', () => { hoveredClipIndex = index; });
    marker.addEventListener('mouseleave', () => { hoveredClipIndex = -1; });
    leftHandle.addEventListener('mousedown', handleResizeMouseDown);
    rightHandle.addEventListener('mousedown', handleResizeMouseDown);

    markersDiv.appendChild(marker);
  });
}

function handleMarkerMouseDown(e) {
  if (e.target.classList.contains('resize-handle')) return;
  const index = parseInt(e.currentTarget.dataset.index);
  if (processedClips.has(index)) {
    selectedClipIndex = index;
    renderClips();
    updateClipList();
    e.preventDefault();
    return;
  }
  if (e.ctrlKey || e.metaKey) {
    e.preventDefault();
    checkedClips.has(index) ? checkedClips.delete(index) : checkedClips.add(index);
    selectedClipIndex = index;
    renderClips();
    updateClipList();
    return;
  }
  checkedClips.has(index) ? checkedClips.delete(index) : checkedClips.add(index);
  selectedClipIndex = index;
  isDragging = true;
  dragMoved = false;
  dragStartX = e.clientX;
  renderClips();
  updateClipList();
  e.preventDefault();
}

function handleResizeMouseDown(e) {
  const index = parseInt(e.currentTarget.dataset.index);
  const direction = e.currentTarget.dataset.direction;
  selectedClipIndex = index;
  isResizing = true;
  resizeDirection = direction;
  dragStartX = e.clientX;
  e.stopPropagation();
  e.preventDefault();
}

function getClipPreviewTime(clip, currentTime) {
  return Math.min(clip.end, Math.max(clip.start, currentTime));
}

function getClipSignature(clip) {
  if (!clip) return '';
  return `${clip.start.toFixed(3)}-${clip.end.toFixed(3)}`;
}

function remapIndexedSet(sourceSet, removedIndexes) {
  const removed = Array.isArray(removedIndexes) ? [...removedIndexes].sort((a, b) => a - b) : [removedIndexes];
  const next = new Set();

  sourceSet.forEach((index) => {
    if (removed.includes(index)) return;
    const shift = removed.filter((removedIndex) => removedIndex < index).length;
    next.add(index - shift);
  });

  return next;
}

function remapSelectedIndex(sourceIndex, removedIndexes) {
  if (sourceIndex < 0) return -1;
  const removed = Array.isArray(removedIndexes) ? [...removedIndexes].sort((a, b) => a - b) : [removedIndexes];
  if (removed.includes(sourceIndex)) return -1;
  return sourceIndex - removed.filter((removedIndex) => removedIndex < sourceIndex).length;
}

function getCheckedExportIndexes() {
  return Array.from(checkedClips)
    .filter((index) => clips[index] && !processedClips.has(index))
    .sort((a, b) => a - b);
}

function getApiErrorMessage(resp, data, rawText) {
  if (data && typeof data.error === 'string' && data.error.trim()) {
    return data.error.trim();
  }

  if (data && typeof data.detail === 'string' && data.detail.trim()) {
    return data.detail.trim();
  }

  if (data && Array.isArray(data.detail) && data.detail.length > 0) {
    return data.detail.map((item) => item.msg || JSON.stringify(item)).join(' / ');
  }

  if (typeof rawText === 'string' && rawText.trim()) {
    return rawText.trim().slice(0, 300);
  }

  return `HTTP ${resp.status}${resp.statusText ? ' ' + resp.statusText : ''}`;
}

async function requestClipExport(params) {
  const endpoints = [
    `${API_BASE}/api/export-clips-async`,
    `${API_BASE}/api/export-clips`
  ];

  let lastErrorMessage = '';

  for (let i = 0; i < endpoints.length; i++) {
    const endpoint = endpoints[i];

    try {
      const resp = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString()
      });

      const rawText = await resp.text();
      let data = {};

      try {
        data = rawText ? JSON.parse(rawText) : {};
      } catch {
        data = {};
      }

      if (resp.ok && (data.success !== false || data.cancelled === true)) {
        return { data, fallbackUsed: i > 0 };
      }

      lastErrorMessage = getApiErrorMessage(resp, data, rawText);
    } catch (e) {
      lastErrorMessage = e.message;
    }
  }

  return {
    data: null,
    fallbackUsed: false,
    error: lastErrorMessage || '書き出しに失敗しました'
  };
}

function getActivePlaybackClipIndex(currentTime) {
  if (currentPlaybackClipIndex >= 0 && clips[currentPlaybackClipIndex]) {
    return currentPlaybackClipIndex;
  }

  if (videoElement && !videoElement.paused) {
    return clips.findIndex((clip) => currentTime >= clip.start && currentTime <= clip.end);
  }

  return -1;
}

function updateClipPreviewSliderFill(slider) {
  const min = parseFloat(slider.min);
  const max = parseFloat(slider.max);
  const value = parseFloat(slider.value);
  const progress = max > min ? ((value - min) / (max - min)) * 100 : 0;
  slider.style.setProperty('--clip-progress', `${progress}%`);
}

function syncClipPreviewSliders() {
  const clipContainers = ['clipList', 'reviewClipCarousel']
    .map((containerId) => document.getElementById(containerId))
    .filter(Boolean);
  if (clipContainers.length === 0) return;

  const currentTime = videoElement && Number.isFinite(videoElement.currentTime)
    ? videoElement.currentTime
    : 0;
  const activePlaybackIndex = getActivePlaybackClipIndex(currentTime);

  clipContainers.forEach((container) => {
    container.querySelectorAll('.clip-item').forEach((item) => {
      const index = parseInt(item.dataset.index, 10);
      const clip = clips[index];
      if (!clip) return;

      const slider = item.querySelector('.clip-preview-slider');
      const currentLabel = item.querySelector('.clip-current-time');
      const checkbox = item.querySelector('.clip-checkbox');
      const previewTime = getClipPreviewTime(clip, currentTime);
      const isActive = index === activePlaybackIndex;

      item.classList.toggle('selected', index === selectedClipIndex);
      item.classList.toggle('checked', checkedClips.has(index));
      item.classList.toggle('exported', processedClips.has(index));
      item.classList.toggle('approved', reviewApprovedClips.has(index));
      item.classList.toggle('playback-active', isActive);

      if (slider && document.activeElement !== slider) {
        slider.value = previewTime;
      }
      if (checkbox) {
        checkbox.checked = checkedClips.has(index);
        checkbox.disabled = processedClips.has(index);
      }
      if (slider) {
        updateClipPreviewSliderFill(slider);
      }
      if (currentLabel) {
        currentLabel.textContent = formatTime(previewTime);
      }
    });
  });
}

function startClipPreviewSyncLoop() {
  stopClipPreviewSyncLoop();

  const step = () => {
    syncClipPreviewSliders();
    if (!videoElement || videoElement.paused || videoElement.ended) {
      clipSliderSyncFrame = null;
      return;
    }
    clipSliderSyncFrame = requestAnimationFrame(step);
  };

  clipSliderSyncFrame = requestAnimationFrame(step);
}

function stopClipPreviewSyncLoop() {
  if (clipSliderSyncFrame !== null) {
    cancelAnimationFrame(clipSliderSyncFrame);
    clipSliderSyncFrame = null;
  }
  syncClipPreviewSliders();
}

function clearClipPlaybackMonitor() {
  if (clipPlaybackMonitor) {
    clearInterval(clipPlaybackMonitor);
    clipPlaybackMonitor = null;
  }
  currentPlaybackClipIndex = -1;
}

function clearCurrentPlaybackClip() {
  if (currentPlaybackClipIndex === -1) return;
  currentPlaybackClipIndex = -1;
  renderClips();
  syncClipPreviewSliders();
}

function updateOverviewPopup() {
  if (!videoElement || !videoElement.duration) return;
  const thumb = document.getElementById('overviewThumb');
  const totalDuration = videoElement.duration;
  const viewDuration = totalDuration / zoomLevel;
  const leftPercent = (scrollOffset / totalDuration) * 100;
  const widthPercent = (viewDuration / totalDuration) * 100;
  thumb.style.left = `${leftPercent}%`;
  thumb.style.width = `${widthPercent}%`;
}

function updateClipList() {
  const clipList = document.getElementById('clipList');
  clipList.innerHTML = '';
  if (clips.length === 0) {
    clipList.innerHTML = '<p style="grid-column:1/-1;text-align:center;color:#9ca3af;padding:20px">クリップがありません</p>';
    return;
  }
  clips.forEach((clip, index) => {
    const item = document.createElement('div');
    item.className = 'clip-item';
    item.dataset.index = index;
    if (index === selectedClipIndex) item.classList.add('selected');
    if (checkedClips.has(index)) item.classList.add('checked');

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'clip-checkbox';
    checkbox.checked = checkedClips.has(index);

    const titleDiv = document.createElement('div');
    titleDiv.className = 'clip-item-title';
    titleDiv.innerHTML = '<strong class="clip-item-name">クリップ ' + (index + 1) + '</strong><span class="clip-item-range">' + formatTime(clip.start) + ' → ' + formatTime(clip.end) + '</span>';

    const metaDiv = document.createElement('div');
    metaDiv.className = 'clip-item-meta';
    metaDiv.innerHTML = '<span class="clip-item-duration">' + formatTime(clip.end - clip.start) + '</span>';

    const actionsDiv = document.createElement('div');
    actionsDiv.className = 'clip-item-actions';
    actionsDiv.innerHTML = '<button class="btn-small" style="background:#8b5cf6;color:white" title="このクリップを再生" onclick="playClip(' + index + ')">▶</button><button class="btn-small" style="background:#ef4444;color:white" title="このクリップを削除" onclick="deleteSingleClip(' + index + ')">✕</button>';

    const sliderWrap = document.createElement('div');
    sliderWrap.className = 'clip-slider-wrap';

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.className = 'clip-preview-slider';
    slider.min = clip.start;
    slider.max = clip.end;
    slider.step = '0.05';
    slider.value = getClipPreviewTime(clip, videoElement ? videoElement.currentTime : clip.start);
    slider.dataset.index = index;

    const sliderStatus = document.createElement('div');
    sliderStatus.className = 'clip-slider-status';
    sliderStatus.innerHTML = '<span>' + formatTime(clip.start) + '</span><span class="clip-current-time">' + formatTime(parseFloat(slider.value)) + '</span><span>' + formatTime(clip.end) + '</span>';

    updateClipPreviewSliderFill(slider);

    slider.addEventListener('click', (e) => {
      e.stopPropagation();
    });
    slider.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      selectedClipIndex = index;
      renderClips();
      syncClipPreviewSliders();
    });
    slider.addEventListener('input', (e) => {
      e.stopPropagation();
      selectedClipIndex = index;
      clearClipPlaybackMonitor();
      if (videoElement) {
        videoElement.currentTime = parseFloat(e.target.value);
      }
      renderClips();
      updateClipPreviewSliderFill(slider);
      syncClipPreviewSliders();
    });

    sliderWrap.appendChild(slider);
    sliderWrap.appendChild(sliderStatus);

    item.appendChild(checkbox);
    item.appendChild(titleDiv);
    item.appendChild(metaDiv);
    item.appendChild(actionsDiv);
    item.appendChild(sliderWrap);

    item.addEventListener('click', (e) => {
      if (!e.target.closest('.btn-small') && !e.target.closest('.clip-preview-slider')) {
        checkedClips.has(index) ? checkedClips.delete(index) : checkedClips.add(index);
        selectedClipIndex = index;
        renderClips();
        updateClipList();
      }
    });
    clipList.appendChild(item);
  });
  syncClipPreviewSliders();
}

function deleteSingleClip(index) {
  saveState();
  clips.splice(index, 1);
  checkedClips.delete(index);
  const newChecked = new Set();
  checkedClips.forEach(i => {
    if (i > index) newChecked.add(i - 1);
    else if (i < index) newChecked.add(i);
  });
  checkedClips = newChecked;
  if (selectedClipIndex === index) selectedClipIndex = -1;
  else if (selectedClipIndex > index) selectedClipIndex--;
  renderClips();
  updateClipList();
  addMessage('クリップ ' + (index + 1) + ' を削除しました', 'success');
}

function playClip(index) {
  if (!videoElement || !clips[index]) return;
  clearClipPlaybackMonitor();
  currentPlaybackClipIndex = index;
  selectedClipIndex = index;
  videoElement.currentTime = clips[index].start;
  renderClips();
  syncClipPreviewSliders();
  videoElement.play();
  clipPlaybackMonitor = setInterval(() => {
    if (!clips[index] || videoElement.paused || videoElement.currentTime >= clips[index].end) {
      if (clips[index] && videoElement.currentTime >= clips[index].end) {
        currentPlaybackClipIndex = -1;
        videoElement.pause();
        renderClips();
        syncClipPreviewSliders();
      }
      clearInterval(clipPlaybackMonitor);
      clipPlaybackMonitor = null;
      return;
    }
  }, 100);
  addMessage('クリップ ' + (index + 1) + ' を再生中', 'info');
}

function handleAddClip() {
  if (!videoElement || !videoElement.duration) {
    addMessage('先に動画ファイルを読み込んでください', 'error');
    return;
  }
  saveState();
  const duration = videoElement.duration;
  const defaultDuration = parseFloat(document.getElementById('clipDuration').value) || 32;
  const newStart = videoElement.currentTime || 0;
  const newEnd = Math.min(newStart + defaultDuration, duration);
  clips.push({ start: newStart, end: newEnd });
  selectedClipIndex = clips.length - 1;
  renderClips();
  updateClipList();
  if (currentWorkspaceMode === 'review') {
    requestAnimationFrame(() => scrollReviewCardIntoView(selectedClipIndex, 'smooth'));
  }
  addMessage(formatTime(newStart) + ' にクリップを追加しました', 'success');
  document.getElementById('downloadSegmentsBtn').style.display = 'inline-block';
  document.getElementById('clipEditSection').style.display = 'block';
}

function handleDeleteClip() {
  if (checkedClips.size === 0) {
    addMessage('削除するクリップにチェックを入れてください', 'error');
    return;
  }
  saveState();
  const toDelete = Array.from(checkedClips).sort((a, b) => b - a);
  toDelete.forEach(index => clips.splice(index, 1));
  checkedClips.clear();
  selectedClipIndex = -1;
  renderClips();
  updateClipList();
  addMessage(toDelete.length + '個のクリップを削除しました', 'success');
}

function handleSelectAllClips() {
  if (clips.length === 0) {
    addMessage('クリップがありません', 'warning');
    return;
  }
  saveState();
  checkedClips.clear();
  for (let i = 0; i < clips.length; i++) {
    checkedClips.add(i);
  }
  renderClips();
  updateClipList();
  addMessage(`${clips.length}個のクリップを全選択しました`, 'success');
}

function handleDeselectAllClips() {
  if (checkedClips.size === 0) {
    addMessage('選択されているクリップがありません', 'warning');
    return;
  }
  saveState();
  const previousCount = checkedClips.size;
  checkedClips.clear();
  renderClips();
  updateClipList();
  addMessage(`${previousCount}個のクリップの選択を解除しました`, 'success');
}

function updateClipList() {
  const clipList = document.getElementById('clipList');
  clipList.innerHTML = '';

  if (clips.length === 0) {
    clipList.innerHTML = '<p style="grid-column:1/-1;text-align:center;color:#9ca3af;padding:20px">クリップがありません</p>';
    updateReviewClipList();
    return;
  }

  clips.forEach((clip, index) => {
    const isProcessed = processedClips.has(index);
    const isApproved = reviewApprovedClips.has(index);
    const item = document.createElement('div');
    item.className = 'clip-item';
    item.dataset.index = index;

    if (index === selectedClipIndex) item.classList.add('selected');
    if (checkedClips.has(index)) item.classList.add('checked');
    if (isProcessed) item.classList.add('exported');
    if (isApproved) item.classList.add('approved');

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'clip-checkbox';
    checkbox.checked = checkedClips.has(index);
    checkbox.disabled = isProcessed;

    const titleDiv = document.createElement('div');
    titleDiv.className = 'clip-item-title';
    titleDiv.innerHTML = '<strong class="clip-item-name">クリップ ' + (index + 1) + '</strong><span class="clip-item-range">' + formatTime(clip.start) + ' → ' + formatTime(clip.end) + '</span>';

    const metaDiv = document.createElement('div');
    metaDiv.className = 'clip-item-meta';
    metaDiv.innerHTML =
      '<span class="clip-item-duration">' + formatTime(clip.end - clip.start) + '</span>' +
      (isApproved ? '<span class="review-ok-badge">OK</span>' : '') +
      (isProcessed ? '<span class="clip-item-exported-badge">処理済</span>' : '');

    const actionsDiv = document.createElement('div');
    actionsDiv.className = 'clip-item-actions';
    actionsDiv.innerHTML =
      '<button class="btn-small" style="background:' + (isProcessed ? '#64748b' : '#10b981') + ';color:white" title="' + (isProcessed ? 'このクリップは処理済みです' : 'このクリップを単体出力') + '" onclick="exportSingleClip(' + index + ', this)" ' + (isProcessed ? 'disabled' : '') + '>💾</button>' +
      '<button class="btn-small" style="background:#8b5cf6;color:white" title="このクリップを再生" onclick="playClip(' + index + ')">▶</button>' +
      '<button class="btn-small" style="background:#ef4444;color:white" title="このクリップを削除" onclick="deleteSingleClip(' + index + ')">✕</button>';

    const sliderWrap = document.createElement('div');
    sliderWrap.className = 'clip-slider-wrap';

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.className = 'clip-preview-slider';
    slider.min = clip.start;
    slider.max = clip.end;
    slider.step = '0.05';
    slider.value = getClipPreviewTime(clip, videoElement ? videoElement.currentTime : clip.start);
    slider.dataset.index = index;

    const sliderStatus = document.createElement('div');
    sliderStatus.className = 'clip-slider-status';
    sliderStatus.innerHTML = '<span>' + formatTime(clip.start) + '</span><span class="clip-current-time">' + formatTime(parseFloat(slider.value)) + '</span><span>' + formatTime(clip.end) + '</span>';

    updateClipPreviewSliderFill(slider);

    slider.addEventListener('click', (e) => {
      e.stopPropagation();
    });
    slider.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      selectedClipIndex = index;
      renderClips();
      syncClipPreviewSliders();
    });
    slider.addEventListener('input', (e) => {
      e.stopPropagation();
      selectedClipIndex = index;
      clearClipPlaybackMonitor();
      if (videoElement) {
        videoElement.currentTime = parseFloat(e.target.value);
      }
      renderClips();
      updateClipPreviewSliderFill(slider);
      syncClipPreviewSliders();
    });

    sliderWrap.appendChild(slider);
    sliderWrap.appendChild(sliderStatus);

    item.appendChild(checkbox);
    item.appendChild(titleDiv);
    item.appendChild(metaDiv);
    item.appendChild(actionsDiv);
    item.appendChild(sliderWrap);

    item.addEventListener('click', (e) => {
      if (!e.target.closest('.btn-small') && !e.target.closest('.clip-preview-slider')) {
        selectedClipIndex = index;
        if (!isProcessed) {
          checkedClips.has(index) ? checkedClips.delete(index) : checkedClips.add(index);
        }
        renderClips();
        updateClipList();
      }
    });

    clipList.appendChild(item);
  });

  updateReviewClipList();
  syncClipPreviewSliders();
}

function updateReviewSummary() {
  const reviewSummary = document.getElementById('reviewSummary');
  if (!reviewSummary) return;

  const approvedCount = Array.from(reviewApprovedClips).filter((index) => clips[index]).length;
  const undecidedCount = Math.max(0, clips.length - approvedCount);
  const currentLabel = clips.length === 0 || selectedClipIndex < 0 || !clips[selectedClipIndex]
    ? '0 / 0'
    : `${selectedClipIndex + 1} / ${clips.length}`;

  reviewSummary.innerHTML =
    '<span class="review-summary-chip">現在 ' + currentLabel + '</span>' +
    '<span class="review-summary-chip">OK ' + approvedCount + '</span>' +
    '<span class="review-summary-chip">未判定 ' + undecidedCount + '</span>';
}

function updateReviewNavigation() {
  const reviewPrevBtn = document.getElementById('reviewPrevBtn');
  const reviewNextBtn = document.getElementById('reviewNextBtn');
  const hasClips = clips.length > 0;
  const currentIndex = selectedClipIndex >= 0 && clips[selectedClipIndex] ? selectedClipIndex : 0;

  if (reviewPrevBtn) {
    reviewPrevBtn.disabled = !hasClips || currentIndex <= 0;
  }
  if (reviewNextBtn) {
    reviewNextBtn.disabled = !hasClips || currentIndex >= clips.length - 1;
  }
}

function scrollReviewCardIntoView(index, behavior = 'smooth') {
  const reviewClipCarousel = document.getElementById('reviewClipCarousel');
  if (!reviewClipCarousel) return;

  const card = reviewClipCarousel.querySelector('.review-clip-card[data-index="' + index + '"]');
  if (card) {
    card.scrollIntoView({ behavior, inline: 'center', block: 'nearest' });
  }
}

function focusReviewClip(index, options = {}) {
  if (!clips[index]) return;

  selectedClipIndex = index;
  clearClipPlaybackMonitor();
  if (options.syncVideo !== false && videoElement) {
    videoElement.currentTime = clips[index].start;
  }

  renderClips();
  updateClipList();

  if (options.scrollReview) {
    requestAnimationFrame(() => scrollReviewCardIntoView(index, options.behavior || 'smooth'));
  }
}

function moveReviewFocus(direction) {
  if (clips.length === 0) {
    addMessage('クリップがありません', 'warning');
    return;
  }

  const currentIndex = selectedClipIndex >= 0 && clips[selectedClipIndex]
    ? selectedClipIndex
    : 0;
  const nextIndex = Math.max(0, Math.min(clips.length - 1, currentIndex + direction));

  focusReviewClip(nextIndex, {
    syncVideo: true,
    scrollReview: true,
    behavior: 'smooth'
  });
}

function approveReviewClip(index) {
  if (!clips[index]) return;

  const wasApproved = reviewApprovedClips.has(index);
  if (!wasApproved) {
    saveState();
    reviewApprovedClips.add(index);
    addMessage('クリップ ' + (index + 1) + ' を OK にしました', 'success');
  }

  const nextIndex = index < clips.length - 1 ? index + 1 : index;
  focusReviewClip(nextIndex, {
    syncVideo: true,
    scrollReview: true,
    behavior: 'smooth'
  });
}

function updateReviewClipList() {
  const reviewClipCarousel = document.getElementById('reviewClipCarousel');
  if (!reviewClipCarousel) return;

  reviewClipCarousel.innerHTML = '';

  if (clips.length === 0) {
    reviewClipCarousel.innerHTML = '<div class="review-empty">クリップがありません。自動検出または手動追加のあとに高速判定を使えます。</div>';
    updateReviewSummary();
    updateReviewNavigation();
    return;
  }

  clips.forEach((clip, index) => {
    const isProcessed = processedClips.has(index);
    const isApproved = reviewApprovedClips.has(index);

    const item = document.createElement('div');
    item.className = 'clip-item review-clip-card';
    item.dataset.index = index;
    if (index === selectedClipIndex) item.classList.add('selected');
    if (isApproved) item.classList.add('approved');
    if (isProcessed) item.classList.add('exported');

    const indexBadge = document.createElement('div');
    indexBadge.className = 'review-card-index';
    indexBadge.textContent = index + 1;

    const titleDiv = document.createElement('div');
    titleDiv.className = 'clip-item-title';
    titleDiv.innerHTML = '<strong class="clip-item-name">クリップ ' + (index + 1) + '</strong><span class="clip-item-range">' + formatTime(clip.start) + ' → ' + formatTime(clip.end) + '</span>';

    const metaDiv = document.createElement('div');
    metaDiv.className = 'clip-item-meta';
    metaDiv.innerHTML =
      '<span class="clip-item-duration">' + formatTime(clip.end - clip.start) + '</span>' +
      (isApproved ? '<span class="review-ok-badge">OK</span>' : '<span class="clip-item-exported-badge">未判定</span>') +
      (isProcessed ? '<span class="clip-item-exported-badge">処理済</span>' : '');

    const actionsDiv = document.createElement('div');
    actionsDiv.className = 'review-card-actions';

    const playButton = document.createElement('button');
    playButton.className = 'btn-small';
    playButton.type = 'button';
    playButton.style.background = '#8b5cf6';
    playButton.style.color = 'white';
    playButton.title = 'このクリップを再生';
    playButton.textContent = '▶';
    playButton.addEventListener('click', (e) => {
      e.stopPropagation();
      playClip(index);
    });

    const approveButton = document.createElement('button');
    approveButton.className = 'review-action-btn ok';
    approveButton.type = 'button';
    approveButton.title = 'このクリップを OK として次へ移動';
    approveButton.textContent = isApproved ? 'OK済' : 'OK';
    approveButton.addEventListener('click', (e) => {
      e.stopPropagation();
      approveReviewClip(index);
    });

    const deleteButton = document.createElement('button');
    deleteButton.className = 'review-action-btn delete';
    deleteButton.type = 'button';
    deleteButton.title = 'このクリップを削除';
    deleteButton.textContent = '✕';
    deleteButton.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteSingleClip(index);
    });

    actionsDiv.appendChild(approveButton);
    actionsDiv.appendChild(playButton);
    actionsDiv.appendChild(deleteButton);

    const sliderWrap = document.createElement('div');
    sliderWrap.className = 'clip-slider-wrap';

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.className = 'clip-preview-slider';
    slider.min = clip.start;
    slider.max = clip.end;
    slider.step = '0.05';
    slider.value = getClipPreviewTime(clip, videoElement ? videoElement.currentTime : clip.start);
    slider.dataset.index = index;

    const sliderStatus = document.createElement('div');
    sliderStatus.className = 'clip-slider-status';
    sliderStatus.innerHTML = '<span>' + formatTime(clip.start) + '</span><span class="clip-current-time">' + formatTime(parseFloat(slider.value)) + '</span><span>' + formatTime(clip.end) + '</span>';

    updateClipPreviewSliderFill(slider);

    slider.addEventListener('click', (e) => {
      e.stopPropagation();
    });
    slider.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      selectedClipIndex = index;
      renderClips();
      syncClipPreviewSliders();
    });
    slider.addEventListener('input', (e) => {
      e.stopPropagation();
      selectedClipIndex = index;
      clearClipPlaybackMonitor();
      if (videoElement) {
        videoElement.currentTime = parseFloat(e.target.value);
      }
      renderClips();
      updateClipPreviewSliderFill(slider);
      syncClipPreviewSliders();
    });

    sliderWrap.appendChild(slider);
    sliderWrap.appendChild(sliderStatus);

    item.appendChild(indexBadge);
    item.appendChild(titleDiv);
    item.appendChild(metaDiv);
    item.appendChild(actionsDiv);
    item.appendChild(sliderWrap);

    item.addEventListener('click', (e) => {
      if (!e.target.closest('button') && !e.target.closest('.clip-preview-slider')) {
        focusReviewClip(index, {
          syncVideo: true,
          scrollReview: true,
          behavior: 'smooth'
        });
      }
    });

    reviewClipCarousel.appendChild(item);
  });

  updateReviewSummary();
  updateReviewNavigation();
}

function deleteSingleClip(index) {
  if (!clips[index]) return;

  saveState();
  const deletedClipNumber = index + 1;
  const wasSelected = selectedClipIndex === index;
  clips.splice(index, 1);
  checkedClips = remapIndexedSet(checkedClips, index);
  processedClips = remapIndexedSet(processedClips, index);
  reviewApprovedClips = remapIndexedSet(reviewApprovedClips, index);
  selectedClipIndex = remapSelectedIndex(selectedClipIndex, index);

  if (wasSelected && clips.length > 0) {
    selectedClipIndex = Math.min(index, clips.length - 1);
  }

  renderClips();
  updateClipList();

  if (currentWorkspaceMode === 'review' && selectedClipIndex >= 0 && clips[selectedClipIndex]) {
    if (videoElement) {
      videoElement.currentTime = clips[selectedClipIndex].start;
    }
    requestAnimationFrame(() => scrollReviewCardIntoView(selectedClipIndex, 'smooth'));
  }

  addMessage('クリップ ' + deletedClipNumber + ' を削除しました', 'success');
}

async function exportClipIndexes(exportIndexes, options = {}) {
  if (!currentFilePath) {
    addMessage('先に動画ファイルを読み込んでください', 'error');
    return null;
  }

  if (!exportIndexes || exportIndexes.length === 0) {
    addMessage(options.emptyMessage || '書き出すクリップをチェックしてください', 'warning');
    return null;
  }

  const fps = parseInt(document.getElementById('fpsSelect').value, 10) || 30;
  const audioBitrate = parseInt(document.getElementById('audioBitrateInput').value, 10) || 128;
  const outputDir = document.getElementById('outputDirInput').value.trim() || '';
  const requestFilePath = currentFilePath;
  const requestTargets = exportIndexes
    .filter((index) => clips[index])
    .map((index) => ({
      index,
      signature: getClipSignature(clips[index]),
      clip: {
        start: clips[index].start,
        end: clips[index].end
      }
    }));

  if (requestTargets.length === 0) {
    addMessage(options.emptyMessage || '書き出せるクリップがありません', 'warning');
    return null;
  }

  const button = options.button || null;
  const originalHtml = button ? button.innerHTML : '';
  const progressContainer = document.getElementById('progressContainer');
  const requestVideoBitrate = getVideoBitrateSelection();

  if (button) {
    button.innerHTML = options.busyHtml || '書き出し準備中';
    button.disabled = false;
  }

  if (options.showProgress && progressContainer) {
    progressContainer.style.display = 'block';
  }

  if (button) {
    beginExportButtonState(button, requestTargets.length, '書き出し準備中');
  }

  addMessage(options.startMessage || `FFmpegで${requestTargets.length}個のクリップを書き出し中...`, 'info');

  try {
    const params = new URLSearchParams({
      file_path: requestFilePath,
      clips_json: JSON.stringify(requestTargets.map((target) => target.clip)),
      output_dir: outputDir,
      fps: fps,
      video_bitrate: requestVideoBitrate,
      audio_bitrate: audioBitrate
    });

    const { data, error, fallbackUsed } = await requestClipExport(params);

    if (!data || data.success === false) {
      addMessage(`書き出しエラー: ${error || data?.error || '書き出しに失敗しました'}`, 'error');
      return null;
    }

    if (fallbackUsed) {
      addMessage('旧書き出しAPIへ自動切り替えしました。サーバー再起動後は新APIを使います', 'info');
    }

    let successCount = 0;
    data.results.forEach((result, batchIndex) => {
      const target = requestTargets[batchIndex];
      const clipNumber = target ? target.index + 1 : batchIndex + 1;

      if (result.success) {
        successCount++;
        addMessage(`クリップ ${clipNumber}: ${result.filename} (${result.size_mb} MB)`, 'success');

        if (
          currentFilePath === requestFilePath &&
          target &&
          clips[target.index] &&
          getClipSignature(clips[target.index]) === target.signature
        ) {
          processedClips.add(target.index);
          checkedClips.delete(target.index);
        }
      } else {
        addMessage(`クリップ ${clipNumber}: ${result.error}`, 'error');
      }
    });

    if (currentFilePath === requestFilePath) {
      renderClips();
      updateClipList();
    }

    updateLastExportedFiles(data.results || []);

    if (data.output_dir) {
      addMessage(`📁 保存先: ${data.output_dir}`, 'info');
      if (options.openFolder !== false) {
        fetch(`${API_BASE}/api/open-folder?path=${encodeURIComponent(data.output_dir)}`).catch(() => {});
      }
    }

    if (data.cancelled) {
      addMessage(`${successCount}/${requestTargets.length}個のクリップを書き出したところで停止しました`, 'warning');
      return data;
    }

    addMessage(options.successMessage || `${successCount}/${requestTargets.length}個のクリップを書き出しました`, 'success');
    return data;
  } catch (e) {
    addMessage(`サーバー通信エラー: ${e.message}`, 'error');
    return null;
  } finally {
    resetExportButtonState();
    if (button) {
      button.innerHTML = originalHtml;
      button.disabled = false;
    }

    if (options.showProgress && progressContainer) {
      setTimeout(() => {
        progressContainer.style.display = 'none';
      }, 2000);
    }
  }
}

async function exportSingleClip(index, buttonElement) {
  if (isActiveExportStopButton(buttonElement)) {
    await requestExportStop();
    return;
  }

  if (!clips[index]) return;

  if (processedClips.has(index)) {
    addMessage(`クリップ ${index + 1} はすでに処理済みです`, 'info');
    return;
  }

  if (isProcessing) {
    addMessage('別の書き出し処理が進行中です', 'warning');
    return;
  }

  isProcessing = true;
  refreshMergeSectionState();

  try {
    await exportClipIndexes([index], {
      button: buttonElement,
      busyHtml: '保存準備中',
      startMessage: `クリップ ${index + 1} を単体出力中...`,
      successMessage: `クリップ ${index + 1} の単体出力が完了しました`
    });
  } finally {
    isProcessing = false;
    refreshMergeSectionState();
  }
}

async function handleDownloadSegments() {
  const btn = document.getElementById('downloadSegmentsBtn');
  if (isActiveExportStopButton(btn)) {
    await requestExportStop();
    return;
  }

  if (isProcessing) {
    addMessage('別の書き出し処理が進行中です', 'warning');
    return;
  }

  if (!clips || clips.length === 0 || !currentFilePath) {
    addMessage('出力するクリップがありません', 'error');
    return;
  }

  const exportIndexes = getCheckedExportIndexes();
  if (exportIndexes.length === 0) {
    addMessage(checkedClips.size === 0 ? '書き出すクリップをチェックしてください' : '処理済みを除くチェック済みクリップがありません', 'warning');
    return;
  }

  isProcessing = true;
  refreshMergeSectionState();

  try {
    await exportClipIndexes(exportIndexes, {
      button: btn,
      busyHtml: '書き出し準備中',
      startMessage: `FFmpegで${exportIndexes.length}個のチェック済みクリップを書き出し中...`,
      successMessage: `${exportIndexes.length}個のチェック済みクリップを書き出しました`,
      showProgress: true
    });
  } finally {
    isProcessing = false;
    refreshMergeSectionState();
  }
}

function handleDeleteClip() {
  if (checkedClips.size === 0) {
    addMessage('削除するクリップをチェックしてください', 'error');
    return;
  }

  saveState();
  const toDelete = Array.from(checkedClips).sort((a, b) => b - a);
  toDelete.forEach((index) => clips.splice(index, 1));
  checkedClips.clear();
  processedClips = remapIndexedSet(processedClips, toDelete);
  reviewApprovedClips = remapIndexedSet(reviewApprovedClips, toDelete);
  selectedClipIndex = remapSelectedIndex(selectedClipIndex, toDelete);
  renderClips();
  updateClipList();
  if (currentWorkspaceMode === 'review' && selectedClipIndex >= 0 && clips[selectedClipIndex]) {
    requestAnimationFrame(() => scrollReviewCardIntoView(selectedClipIndex, 'smooth'));
  }
  addMessage(toDelete.length + '個のクリップを削除しました', 'success');
}

function handleSelectAllClips() {
  if (clips.length === 0) {
    addMessage('クリップがありません', 'warning');
    return;
  }

  saveState();
  checkedClips.clear();
  for (let i = 0; i < clips.length; i++) {
    if (!processedClips.has(i)) {
      checkedClips.add(i);
    }
  }

  renderClips();
  updateClipList();

  if (checkedClips.size === 0) {
    addMessage('未処理のクリップがありません', 'warning');
    return;
  }

  addMessage(`${checkedClips.size}個の未処理クリップを全選択しました`, 'success');
}

function handleCanvasClick(e) {
  if (!videoElement || !videoElement.duration) return;
  // ドラッグスクロール中のクリックは無視
  if (isWaveformDragging) return;

  const rect = canvasElement.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const percent = x / rect.width;
  const viewDuration = videoElement.duration / zoomLevel;
  const time = Math.max(0, Math.min(scrollOffset + (percent * viewDuration), videoElement.duration));

  // fastSeekで高速シーク（対応ブラウザのみ）
  if (typeof videoElement.fastSeek === 'function') {
    videoElement.fastSeek(time);
  } else {
    videoElement.currentTime = time;
  }

  // シーク後に即時再生
  videoElement.play().catch(() => {});
}


// ===== 圧縮スライダー初期化 =====
function initializeCompressSlider() {
  const sliderElement = document.getElementById('compressTrimSlider');
  if (!sliderElement || compressVideoDuration <= 0) return;

  if (sliderElement.noUiSlider) {
    sliderElement.noUiSlider.destroy();
  }

  noUiSlider.create(sliderElement, {
    start: [0, compressVideoDuration],
    connect: true,
    range: { min: 0, max: compressVideoDuration },
    step: 0.1,
    tooltips: [
      { to: (value) => formatTime(value), from: (value) => Number(value) },
      { to: (value) => formatTime(value), from: (value) => Number(value) }
    ]
  });

  sliderElement.noUiSlider.on('update', (values) => {
    const [start, end] = values.map(v => parseFloat(v));
    document.getElementById('compressStartTimeDisplay').textContent = formatTime(start);
    document.getElementById('compressEndTimeDisplay').textContent = formatTime(end);
    const duration = end - start;
    document.getElementById('compressRangeDuration').textContent = `${duration.toFixed(1)}秒`;
  });

  document.getElementById('compressResetRangeBtn').disabled = false;
}


// ===== ユーティリティ関数 =====
function formatTime(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = (seconds % 60).toFixed(1);
  return mins + ':' + secs.padStart(4, '0');
}

function formatTimeForFilename(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return String(mins).padStart(2, '0') + '-' + String(secs).padStart(2, '0');
}

function formatTimeForPopup(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return String(mins).padStart(2, '0') + ':' + String(secs).padStart(2, '0');
}

function updateProgress(text, percent) {
  document.getElementById('progressText').textContent = text;
  document.getElementById('progressPercent').textContent = Math.round(percent) + '%';
  document.getElementById('progressFill').style.width = percent + '%';
}

function addMessage(text, type) {
  const message = document.createElement('div');
  message.className = 'message message-' + type;
  const time = new Date().toLocaleTimeString();
  message.textContent = '[' + time + '] ' + text;
  const messageArea = document.getElementById('messageArea');
  messageArea.appendChild(message);
  messageArea.scrollTop = messageArea.scrollHeight;
}

function updateCompressProgress(text, percent) {
  const textElement = document.getElementById('compressProgressText');
  const percentElement = document.getElementById('compressProgressPercent');
  const fillElement = document.getElementById('compressProgressFill');
  if (textElement) textElement.textContent = text;
  if (percentElement) percentElement.textContent = Math.round(percent) + '%';
  if (fillElement) fillElement.style.width = percent + '%';
}


// ===== 初期化実行 =====
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
