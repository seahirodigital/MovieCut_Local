(() => {
  if (globalThis.__movieAutoCutMacReviewPatchApplied) return;
  globalThis.__movieAutoCutMacReviewPatchApplied = true;

  function getCurrentPatchedItem() {
    if (!Array.isArray(reviewItems) || currentReviewIndex < 0 || currentReviewIndex >= reviewItems.length) {
      return null;
    }
    return reviewItems[currentReviewIndex] || null;
  }

  function applyWaveformToActiveView(item, token) {
    if (!item || token !== activeWaveformToken) return;

    const currentItem = getCurrentPatchedItem();
    if (!currentItem || currentItem.path !== item.path) return;

    waveformData = Array.isArray(item.waveform) ? item.waveform : [];

    if (waveformData.length > 0) {
      drawWaveform();
    } else {
      drawTimeline();
    }

    updateCurrentReviewInfo();
    syncReviewCards();
  }

  async function fetchWaveformForItem(item) {
    if (!item || !item.path) {
      return { waveform: [] };
    }

    if (item.waveformLoaded) {
      return {
        waveform: Array.isArray(item.waveform) ? item.waveform : [],
        duration: item.duration || 0,
      };
    }

    if (!item.waveformPromise) {
      addMessage(`🎵 ${item.name} の波形を読み込み中...`, 'info');

      item.waveformPromise = (async () => {
        const params = new URLSearchParams({ file_path: item.path });
        const response = await fetch(`${API_BASE}/api/analyze`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: params.toString(),
        });

        const data = await response.json();
        if (!response.ok || data?.success === false) {
          throw new Error(data?.error || '波形データの取得に失敗しました');
        }

        item.waveform = Array.isArray(data.waveform) ? data.waveform : [];
        item.waveformLoaded = true;

        if (Number.isFinite(data.duration) && data.duration > 0) {
          item.duration = data.duration;
        }

        return data;
      })()
        .catch((error) => {
          item.waveformLoaded = false;
          item.waveform = null;
          throw error;
        })
        .finally(() => {
          item.waveformPromise = null;
        });
    }

    return item.waveformPromise;
  }

  loadWaveformForCurrent = async function (item, token) {
    if (!item) {
      waveformData = null;
      drawTimeline();
      return { item, token, waveform: [] };
    }

    try {
      const data = await fetchWaveformForItem(item);
      applyWaveformToActiveView(item, token);
      return { item, token, waveform: data.waveform || [] };
    } catch (error) {
      if (token === activeWaveformToken) {
        waveformData = null;
        drawTimeline();
        addMessage(`${item.name} の波形を読み込めませんでした: ${error.message}`, 'warning');
      }
      return { item, token, waveform: [], error };
    }
  };

  const originalSelectReviewItem = selectReviewItem;
  selectReviewItem = async function (index, options = {}) {
    await originalSelectReviewItem(index, options);

    const item = reviewItems[index];
    if (!item) return;

    const token = activeWaveformToken;
    await loadWaveformForCurrent(item, token);
  };
})();
