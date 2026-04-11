(() => {
  if (globalThis.__movieAutoCutMacAppPatchApplied) return;
  globalThis.__movieAutoCutMacAppPatchApplied = true;

  let macTopActionButtonsLocked = false;

  function getMacMergeTargets() {
    if (typeof getCheckedExportIndexes !== 'function') {
      return [];
    }
    return getCheckedExportIndexes();
  }

  function getMacMergeButton() {
    return document.getElementById('mergeLastExportsBtn');
  }

  function getMacParentDirectory(filePath) {
    const normalizedPath = String(filePath || '').trim();
    if (!normalizedPath) {
      return '';
    }

    const separatorIndex = Math.max(normalizedPath.lastIndexOf('/'), normalizedPath.lastIndexOf('\\'));
    if (separatorIndex <= 0) {
      return '';
    }

    return normalizedPath.slice(0, separatorIndex);
  }

  function syncMacOutputDirectoryWithCurrentFile(force = false) {
    const outputDirInput = document.getElementById('outputDirInput');
    const targetFilePath = currentFilePath || (document.getElementById('filePathInput') || {}).value || '';
    const parentDirectory = getMacParentDirectory(targetFilePath);

    if (!outputDirInput || !parentDirectory) {
      return;
    }

    if (force || !outputDirInput.value.trim()) {
      outputDirInput.value = parentDirectory;
    }
  }

  function applyMacDefaultDetectSettings() {
    const durationThresholdInput = document.getElementById('durationThreshold');
    const clipDurationInput = document.getElementById('clipDuration');

    if (durationThresholdInput) {
      durationThresholdInput.value = '23';
    }

    if (clipDurationInput && (!clipDurationInput.value || clipDurationInput.value === '32.0' || clipDurationInput.value === '32')) {
      clipDurationInput.value = '35';
    }
  }

  function selectAllMacDetectedClips() {
    if (!Array.isArray(clips) || clips.length === 0) {
      return;
    }

    checkedClips.clear();
    for (let index = 0; index < clips.length; index += 1) {
      if (!processedClips.has(index)) {
        checkedClips.add(index);
      }
    }

    if (typeof renderClips === 'function') {
      renderClips();
    }
    if (typeof updateClipList === 'function') {
      updateClipList();
    }
  }

  function clearMacMergeProcessedTargets(targetIndexes) {
    if (!Array.isArray(targetIndexes) || targetIndexes.length === 0) {
      return;
    }

    targetIndexes.forEach((index) => {
      processedClips.delete(index);
    });

    if (typeof renderClips === 'function') {
      renderClips();
    }
    if (typeof updateClipList === 'function') {
      updateClipList();
    }
  }

  async function requestMacExportMergeWorkDir(baseDir, sourceFilePath) {
    const params = new URLSearchParams({
      base_dir: baseDir || '',
      source_file_path: sourceFilePath || ''
    });

    const response = await fetch(`${API_BASE}/api/mac/create-export-merge-workdir`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString()
    });
    const data = await response.json();

    if (!response.ok || !data.success || !data.path) {
      throw new Error(data.error || 'Mac 一時作業フォルダの作成に失敗しました');
    }

    return data;
  }

  async function cleanupMacExportMergeWorkDir(workDir, baseDir) {
    if (!workDir) return { success: true, removed: false };

    const params = new URLSearchParams({
      work_dir: workDir,
      base_dir: baseDir || ''
    });

    const response = await fetch(`${API_BASE}/api/mac/remove-export-merge-workdir`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString()
    });
    const data = await response.json();

    if (!response.ok || !data.success) {
      throw new Error(data.error || 'Mac 一時作業フォルダの削除に失敗しました');
    }

    return data;
  }

  async function promoteMacExportMergeOutput(sourcePath, baseDir) {
    const params = new URLSearchParams({
      source_path: sourcePath || '',
      base_dir: baseDir || ''
    });

    const response = await fetch(`${API_BASE}/api/mac/promote-export-merge-output`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString()
    });
    const data = await response.json();

    if (!response.ok || !data.success || !data.output_path) {
      throw new Error(data.error || '最終出力ファイルの確定に失敗しました');
    }

    return data;
  }

  function updateMacMergeSectionState() {
    const button = getMacMergeButton();
    const status = document.getElementById('mergeStatus');
    const targetIndexes = getMacMergeTargets();
    const targetCount = targetIndexes.length;

    if (status) {
      if (isMerging) {
        status.textContent = '書き出したクリップを1本に統合しています...';
      } else if (exportUiState.active) {
        status.textContent = '選択クリップを書き出し中です。もう一度押すと停止します。';
      } else if (isProcessing) {
        status.textContent = '選択クリップを書き出し準備中です...';
      } else if (targetCount >= 2) {
        status.textContent = `チェック済み ${targetCount} 本を、現在のビットレート設定で書き出してから1本に統合します`;
      } else if (targetCount === 1) {
        status.textContent = 'チェック済み 1 本を、現在のビットレート設定でそのまま最終出力します';
      } else {
        status.textContent = 'プレビュー & タイムライン編集で書き出したいクリップをチェックしてください';
      }
    }

    if (!button) {
      return;
    }

    if (exportUiState.active && exportUiState.button === button) {
      renderActiveExportButton();
      button.disabled = false;
      return;
    }

    button.disabled = macTopActionButtonsLocked || isProcessing || isMerging || targetCount === 0;
  }

  async function handleMacExportAndMerge() {
    const button = getMacMergeButton();
    if (!button) return null;

    if (isActiveExportStopButton(button)) {
      await requestExportStop();
      return null;
    }

    if (isMerging) {
      addMessage('書出し後、統合はすでに進行中です', 'warning');
      return null;
    }

    if (isProcessing) {
      addMessage('別の書き出し処理が進行中です', 'warning');
      return null;
    }

    if (!currentFilePath || !Array.isArray(clips) || clips.length === 0) {
      addMessage('先に動画を読み込み、統合したいクリップを選択してください', 'warning');
      return null;
    }

    const targetIndexes = getMacMergeTargets();
    if (targetIndexes.length === 0) {
      addMessage('書出し後、統合するクリップをチェックしてください', 'warning');
      return null;
    }

    const progressContainer = document.getElementById('progressContainer');
    const outputDirInput = document.getElementById('outputDirInput');
    const originalOutputDirValue = outputDirInput ? outputDirInput.value : '';
    const shouldUseWorkDir = targetIndexes.length >= 2;
    let finalOutputDir = outputDirInput ? outputDirInput.value.trim() : '';
    let workDir = '';
    let finalOutputPath = '';
    isProcessing = true;
    updateMacMergeSectionState();

    try {
      if (shouldUseWorkDir) {
        const workDirInfo = await requestMacExportMergeWorkDir(finalOutputDir, currentFilePath);
        workDir = workDirInfo.path || '';
        finalOutputDir = workDirInfo.base_dir || finalOutputDir;
        if (outputDirInput) {
          outputDirInput.value = workDir;
        }
      }

      const exportResult = await exportClipIndexes(targetIndexes, {
        button,
        busyHtml: '書き出し準備中',
        startMessage: `選択した ${targetIndexes.length} 本を現在のビットレート設定で書き出しています...`,
        successMessage: `${targetIndexes.length} 本の選択クリップを書き出しました`,
        emptyMessage: '書出し後、統合するクリップをチェックしてください',
        showProgress: true,
        openFolder: false
      });

      if (!exportResult) {
        return null;
      }

      finalOutputDir = finalOutputDir || exportResult.output_dir || originalOutputDirValue || '';
      if (outputDirInput && finalOutputDir) {
        outputDirInput.value = finalOutputDir;
      }

      if (exportResult.cancelled) {
        addMessage('書き出し停止のため統合は実行していません', 'warning');
        updateProgress('書出し後、統合を停止しました', 0);
        return exportResult;
      }

      const exportedPaths = Array.isArray(exportResult.results)
        ? exportResult.results
            .filter((result) => result && result.success && result.path)
            .map((result) => result.path)
        : [];

      if (exportedPaths.length > 0 && exportedPaths.length < targetIndexes.length) {
        addMessage(`選択した ${targetIndexes.length} 本のうち、書き出せた ${exportedPaths.length} 本だけで続行します`, 'warning');
      }

      if (exportedPaths.length === 0) {
        addMessage('統合用の出力ファイルを作成できませんでした', 'error');
        return null;
      }

      if (exportedPaths.length === 1) {
        if (shouldUseWorkDir && workDir && finalOutputDir) {
          const promoted = await promoteMacExportMergeOutput(exportedPaths[0], finalOutputDir);
          finalOutputPath = promoted.output_path;
          try {
            await cleanupMacExportMergeWorkDir(workDir, finalOutputDir);
          } catch (error) {
            addMessage(`一時書き出しフォルダを削除できませんでした: ${error.message}`, 'warning');
          }
        } else {
          finalOutputPath = exportedPaths[0];
        }

        lastExportedFilePaths = finalOutputPath ? [finalOutputPath] : [];
        addMessage('統合対象が1本のため、そのまま最終出力として完了しました', 'success');
        addMessage(`📁 保存先: ${finalOutputPath}`, 'info');
        fetch(`${API_BASE}/api/open-folder?path=${encodeURIComponent(finalOutputPath)}`).catch(() => {});
        updateProgress('書出し後、統合が完了しました', 100);
        return {
          success: true,
          output_path: finalOutputPath,
          file_count: 1,
          merge_method: 'single',
        };
      }

      isProcessing = false;
      updateMacMergeSectionState();

      const mergeResult = await mergeVideoFiles(exportedPaths, {
        button,
        mergeMode: 'copy',
        startMessage: `書き出した ${exportedPaths.length} 本を1本に統合しています...`
      });

      if (mergeResult) {
        finalOutputPath = mergeResult.output_path || '';
        lastExportedFilePaths = finalOutputPath ? [finalOutputPath] : [];
        if (workDir && finalOutputDir) {
          try {
            await cleanupMacExportMergeWorkDir(workDir, finalOutputDir);
          } catch (error) {
            addMessage(`一時書き出しフォルダを削除できませんでした: ${error.message}`, 'warning');
          }
        }
        addMessage('書出し後、統合が完了しました', 'success');
      }

      return mergeResult;
    } finally {
      if (outputDirInput) {
        outputDirInput.value = finalOutputDir || originalOutputDirValue;
      }
      clearMacMergeProcessedTargets(targetIndexes);
      isProcessing = false;
      updateMacMergeSectionState();

      if (progressContainer && !isMerging) {
        window.setTimeout(() => {
          if (!isProcessing && !isMerging) {
            progressContainer.style.display = 'none';
          }
        }, 2000);
      }
    }
  }

  function setupMacMergeUi() {
    applyMacDefaultDetectSettings();
    syncMacOutputDirectoryWithCurrentFile();

    const status = document.getElementById('mergeStatus');
    const section = status ? status.closest('.card') : null;
    if (section) {
      const title = section.querySelector('.section-title');
      const helpText = section.querySelector('.help-text');
      if (title) {
        title.textContent = '🔗 書出し後、統合';
      }
      if (helpText) {
        helpText.textContent = '💡 プレビュー & タイムライン編集でチェックしたクリップを、現在のビットレート設定で書き出してから1本の動画にまとめます。';
      }
    }

    const selectVideosButton = document.getElementById('mergeSelectVideosBtn');
    if (selectVideosButton) {
      selectVideosButton.remove();
    }

    let button = getMacMergeButton();
    if (!button) {
      return;
    }

    if (button.dataset.macExportMergeBound !== '1') {
      const replacement = button.cloneNode(true);
      replacement.dataset.macExportMergeBound = '1';
      button.replaceWith(replacement);
      button = replacement;
      button.addEventListener('click', handleMacExportAndMerge);
    }

    button.innerHTML = '書出し後、統合';
    button.title = 'チェック済みクリップを書き出してから1本に統合します';

    const originalHandleFileLoad = handleFileLoad;
    handleFileLoad = async function handleFileLoadForMac(...args) {
      const filePathInput = document.getElementById('filePathInput');
      const pendingFilePath = filePathInput ? filePathInput.value.trim() : '';

      if (pendingFilePath) {
        const outputDirInput = document.getElementById('outputDirInput');
        if (outputDirInput && !outputDirInput.value.trim()) {
          const parentDirectory = getMacParentDirectory(pendingFilePath);
          if (parentDirectory) {
            outputDirInput.value = parentDirectory;
          }
        }
      }

      const result = await originalHandleFileLoad.apply(this, args);
      syncMacOutputDirectoryWithCurrentFile();
      return result;
    };

    const originalApplyDetectedClips = applyDetectedClips;
    applyDetectedClips = function applyDetectedClipsForMac(...args) {
      const result = originalApplyDetectedClips.apply(this, args);
      if (result) {
        selectAllMacDetectedClips();
      }
      return result;
    };

    const originalUpdateClipList = updateClipList;
    updateClipList = function updateClipListForMac(...args) {
      const result = originalUpdateClipList.apply(this, args);
      updateMacMergeSectionState();
      return result;
    };

    const originalUpdateLastExportedFiles = updateLastExportedFiles;
    updateLastExportedFiles = function updateLastExportedFilesForMac(...args) {
      const result = originalUpdateLastExportedFiles.apply(this, args);
      updateMacMergeSectionState();
      return result;
    };

    refreshMergeSectionState = updateMacMergeSectionState;

    const originalSetTopActionButtonsDisabled = setTopActionButtonsDisabled;
    setTopActionButtonsDisabled = function setTopActionButtonsDisabledForMac(disabled) {
      macTopActionButtonsLocked = !!disabled;
      originalSetTopActionButtonsDisabled(disabled);
      if (!disabled) {
        updateMacMergeSectionState();
      }
    };

    updateMacMergeSectionState();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setupMacMergeUi);
  } else {
    setupMacMergeUi();
  }
})();
