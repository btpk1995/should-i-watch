(function() {
  'use strict';

  const form = document.getElementById('analyze-form');
  const urlInput = document.getElementById('video-url');
  const analyzeBtn = document.getElementById('analyze-btn');
  const errorMessage = document.getElementById('error-message');
  const results = document.getElementById('results');
  const loadingOverlay = document.getElementById('loading-overlay');
  const videoThumbnail = document.getElementById('video-thumbnail');
  const videoLink = document.getElementById('video-link');
  const videoTitle = document.getElementById('video-title');
  const channelName = document.getElementById('channel-name');
  const channelInitial = document.getElementById('channel-initial');
  const likeCount = document.getElementById('like-count');
  const videoDuration = document.getElementById('video-duration');
  const viewCount = document.getElementById('view-count');
  const publishDate = document.getElementById('publish-date');
  const tldrEl = document.getElementById('tldr');
  const keyTopicsEl = document.getElementById('key-topics');
  const summaryTextEl = document.getElementById('summary-text');
  const chaptersListEl = document.getElementById('chapters-list');
  const keyTakeawaysEl = document.getElementById('key-takeaways');
  const shouldWatchEl = document.getElementById('should-watch');

  function extractVideoId(url) {
    const patterns = [
      /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/v\/)([a-zA-Z0-9_-]{11})/,
      /youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/
    ];

    for (const pattern of patterns) {
      const match = url.match(pattern);
      if (match) return match[1];
    }
    return null;
  }

  function formatTimestamp(seconds) {
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    if (hrs > 0) {
      return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  }

  function showError(message) {
    errorMessage.textContent = message;
    errorMessage.classList.add('visible');
    results.classList.add('hidden');
  }

  function hideError() {
    errorMessage.classList.remove('visible');
  }

  function setLoading(loading) {
    analyzeBtn.disabled = loading;
    analyzeBtn.classList.toggle('loading', loading);
    loadingOverlay.classList.toggle('visible', loading);
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  function renderMarkdown(text) {
    return escapeHtml(text).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  }

  function renderResults(data) {
    const videoId = data.videoId;
    const youtubeUrl = `https://www.youtube.com/watch?v=${videoId}`;

    // Video header
    videoThumbnail.src = `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`;
    videoThumbnail.onerror = function() {
      this.src = `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;
    };
    videoLink.href = youtubeUrl;
    videoTitle.textContent = data.title || 'Video Analysis';

    // Channel info
    const channel = data.channelTitle || 'Unknown Channel';
    channelName.textContent = channel;
    channelInitial.textContent = channel.charAt(0).toUpperCase();

    // Stats
    likeCount.textContent = data.viewCount || '0';
    videoDuration.textContent = data.duration || '';
    viewCount.textContent = data.viewCount || '0';
    publishDate.textContent = data.publishedAt || '';

    // TLDR
    tldrEl.innerHTML = renderMarkdown(data.tldr || '');

    // Summary text (same as TLDR for now)
    summaryTextEl.innerHTML = renderMarkdown(data.tldr || '');

    // Key Topics
    keyTopicsEl.innerHTML = '';
    if (data.keyTopics && data.keyTopics.length > 0) {
      data.keyTopics.forEach(topic => {
        const li = document.createElement('li');
        li.innerHTML = renderMarkdown(topic);
        keyTopicsEl.appendChild(li);
      });
    }

    // Chapters / Timeline
    chaptersListEl.innerHTML = '';
    if (data.chapters && data.chapters.length > 0) {
      data.chapters.forEach(chapter => {
        const chapterEl = document.createElement('a');
        chapterEl.className = 'chapter-item';
        chapterEl.href = `${youtubeUrl}&t=${chapter.timestamp}s`;
        chapterEl.target = '_blank';
        chapterEl.rel = 'noopener';
        chapterEl.innerHTML = `
          <span class="chapter-time">${chapter.timestampFormatted || formatTimestamp(chapter.timestamp)}</span>
          <span class="chapter-title">${escapeHtml(chapter.title)}</span>
        `;
        chaptersListEl.appendChild(chapterEl);
      });
    }

    // Key Takeaways / Highlights
    keyTakeawaysEl.innerHTML = '';
    if (data.keyTakeaways && data.keyTakeaways.length > 0) {
      data.keyTakeaways.forEach(takeaway => {
        const li = document.createElement('li');
        li.innerHTML = renderMarkdown(takeaway);
        keyTakeawaysEl.appendChild(li);
      });
    }

    // Should Watch / Verdict
    shouldWatchEl.innerHTML = renderMarkdown(data.shouldWatch || '');

    results.classList.remove('hidden');

    // Scroll to results
    results.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  async function analyzeVideo(url) {
    const videoId = extractVideoId(url);
    if (!videoId) {
      throw new Error('Invalid YouTube URL. Please enter a valid youtube.com or youtu.be link.');
    }

    const response = await fetch('/api/analyze.js', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ url, videoId })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Failed to analyze video');
    }

    return data;
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    const url = urlInput.value.trim();
    if (!url) return;

    hideError();
    setLoading(true);
    results.classList.add('hidden');

    try {
      const data = await analyzeVideo(url);
      renderResults(data);
    } catch (error) {
      showError(error.message);
    } finally {
      setLoading(false);
    }
  });

  urlInput.addEventListener('paste', (e) => {
    setTimeout(() => {
      const url = urlInput.value.trim();
      if (url && extractVideoId(url)) {
        form.dispatchEvent(new Event('submit'));
      }
    }, 100);
  });
})();
