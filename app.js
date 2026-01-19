(function() {
  'use strict';

  const form = document.getElementById('analyze-form');
  const urlInput = document.getElementById('video-url');
  const analyzeBtn = document.getElementById('analyze-btn');
  const errorMessage = document.getElementById('error-message');
  const results = document.getElementById('results');
  const videoThumbnail = document.getElementById('video-thumbnail');
  const videoLink = document.getElementById('video-link');
  const videoTitle = document.getElementById('video-title');
  const videoDuration = document.getElementById('video-duration');
  const summaryEl = document.getElementById('summary');
  const topicsList = document.getElementById('topics-list');

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
  }

  function renderResults(data) {
    const videoId = data.videoId;

    videoThumbnail.src = `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`;
    videoThumbnail.onerror = function() {
      this.src = `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;
    };
    videoLink.href = `https://www.youtube.com/watch?v=${videoId}`;
    videoTitle.textContent = data.title || 'Video Analysis';
    videoDuration.textContent = data.duration || '';
    summaryEl.textContent = data.summary;

    topicsList.innerHTML = '';
    data.topics.forEach((topic, index) => {
      const card = document.createElement('div');
      card.className = 'topic-card';

      const timestampUrl = `https://www.youtube.com/watch?v=${videoId}&t=${Math.floor(topic.timestamp)}s`;

      card.innerHTML = `
        <div class="topic-rank">${index + 1}</div>
        <div class="topic-content">
          <div class="topic-header">
            <span class="topic-title">${escapeHtml(topic.title)}</span>
            <a href="${timestampUrl}" target="_blank" rel="noopener" class="topic-timestamp">
              ${topic.timestampFormatted || formatTimestamp(topic.timestamp)}
            </a>
          </div>
          <p class="topic-description">${escapeHtml(topic.description)}</p>
        </div>
      `;

      topicsList.appendChild(card);
    });

    results.classList.remove('hidden');
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  async function analyzeVideo(url) {
    const videoId = extractVideoId(url);
    if (!videoId) {
      throw new Error('Invalid YouTube URL. Please enter a valid youtube.com or youtu.be link.');
    }

    const response = await fetch('/api/analyze', {
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
