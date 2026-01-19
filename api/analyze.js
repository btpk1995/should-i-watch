import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
const SUPADATA_API_KEY = process.env.SUPADATA_API_KEY;

function formatTimestamp(seconds) {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  if (hrs > 0) {
    return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function formatDuration(totalSeconds) {
  return formatTimestamp(totalSeconds);
}

function parseDuration(duration) {
  const match = duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return 0;
  const hours = parseInt(match[1] || 0);
  const minutes = parseInt(match[2] || 0);
  const seconds = parseInt(match[3] || 0);
  return hours * 3600 + minutes * 60 + seconds;
}

async function getVideoInfo(videoId) {
  const url = `https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails,statistics&id=${videoId}&key=${YOUTUBE_API_KEY}`;
  const response = await fetch(url);
  const data = await response.json();

  if (!data.items || data.items.length === 0) {
    throw new Error('Video not found');
  }

  const video = data.items[0];
  return {
    title: video.snippet.title,
    channelTitle: video.snippet.channelTitle,
    duration: parseDuration(video.contentDetails.duration),
    viewCount: video.statistics?.viewCount || '0',
    publishedAt: video.snippet.publishedAt,
    description: video.snippet.description
  };
}

function decodeHtmlEntities(text) {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/\n/g, ' ');
}

async function getTranscript(videoId) {
  // Try multiple methods to get transcript
  const errors = [];

  // Method 1: Supadata API (most reliable)
  if (SUPADATA_API_KEY) {
    try {
      const transcript = await getTranscriptViaSupadata(videoId);
      if (transcript && transcript.length > 0) {
        return transcript;
      }
    } catch (e) {
      errors.push(`Supadata: ${e.message}`);
    }
  }

  // Method 2: YouTube Innertube API (fallback)
  try {
    const transcript = await getTranscriptViaInnertube(videoId);
    if (transcript && transcript.length > 0) {
      return transcript;
    }
  } catch (e) {
    errors.push(`Innertube: ${e.message}`);
  }

  // Method 3: Direct timedtext API (fallback)
  try {
    const transcript = await getTranscriptViaTimedText(videoId);
    if (transcript && transcript.length > 0) {
      return transcript;
    }
  } catch (e) {
    errors.push(`TimedText: ${e.message}`);
  }

  console.error('All transcript methods failed:', errors.join('; '));
  throw new Error('This video does not have captions available.');
}

async function getTranscriptViaSupadata(videoId) {
  console.log('Fetching transcript via Supadata for:', videoId);

  const response = await fetch(`https://api.supadata.ai/v1/youtube/transcript?videoId=${videoId}&text=false`, {
    headers: {
      'x-api-key': SUPADATA_API_KEY,
    }
  });

  console.log('Supadata response status:', response.status);

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    console.error('Supadata error:', errorData);
    throw new Error(errorData.message || `Supadata API error: ${response.status}`);
  }

  const data = await response.json();
  console.log('Supadata data keys:', Object.keys(data));

  if (!data.content) {
    throw new Error('No content field in Supadata response');
  }

  if (!Array.isArray(data.content)) {
    throw new Error('Supadata content is not an array');
  }

  if (data.content.length === 0) {
    throw new Error('Supadata content array is empty');
  }

  // Convert Supadata format to our format
  // Supadata returns offset/duration in milliseconds already
  return data.content.map(item => ({
    text: item.text || '',
    offset: item.offset || 0,
    duration: item.duration || 2000
  }));
}

async function getTranscriptViaInnertube(videoId) {
  // Use YouTube's innertube API to get player response
  const innertubeResponse = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    },
    body: JSON.stringify({
      context: {
        client: {
          hl: 'en',
          gl: 'US',
          clientName: 'WEB',
          clientVersion: '2.20240101.00.00',
        }
      },
      videoId: videoId
    })
  });

  const playerData = await innertubeResponse.json();

  if (playerData.playabilityStatus?.status === 'ERROR') {
    throw new Error('Video not available');
  }

  const captionTracks = playerData.captions?.playerCaptionsTracklistRenderer?.captionTracks;

  if (!captionTracks || captionTracks.length === 0) {
    throw new Error('No caption tracks in player response');
  }

  // Prefer English captions
  let track = captionTracks.find(t => t.languageCode === 'en' || t.languageCode?.startsWith('en'));
  if (!track) {
    track = captionTracks[0];
  }

  const captionUrl = track.baseUrl;
  if (!captionUrl) {
    throw new Error('No caption URL');
  }

  // Fetch caption XML
  const captionResponse = await fetch(captionUrl);
  const captionXml = await captionResponse.text();

  return parseTranscriptXml(captionXml);
}

async function getTranscriptViaTimedText(videoId) {
  // Try direct timedtext API with different language codes
  const langs = ['en', 'en-US', 'en-GB', 'a.en'];

  for (const lang of langs) {
    try {
      const url = `https://www.youtube.com/api/timedtext?v=${videoId}&lang=${lang}&fmt=srv3`;
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        }
      });

      if (response.ok) {
        const xml = await response.text();
        if (xml && xml.includes('<text')) {
          return parseTranscriptXml(xml);
        }
      }
    } catch (e) {
      continue;
    }
  }

  throw new Error('TimedText API failed for all language codes');
}

function parseTranscriptXml(xml) {
  // Parse XML captions - handle both formats
  const textMatches = [...xml.matchAll(/<text[^>]*start="([\d.]+)"[^>]*(?:dur="([\d.]+)")?[^>]*>([^<]*)<\/text>/g)];

  if (textMatches.length === 0) {
    throw new Error('No caption text found in XML');
  }

  return textMatches.map(match => ({
    text: decodeHtmlEntities(match[3]),
    offset: parseFloat(match[1]) * 1000,
    duration: parseFloat(match[2] || '2') * 1000
  }));
}

function prepareTranscriptForAnalysis(transcript) {
  let fullText = '';
  const segments = [];

  for (const item of transcript) {
    const timestamp = Math.floor(item.offset / 1000);
    segments.push({
      timestamp,
      text: item.text
    });
    fullText += `[${formatTimestamp(timestamp)}] ${item.text}\n`;
  }

  const totalDuration = transcript.length > 0
    ? Math.floor((transcript[transcript.length - 1].offset + transcript[transcript.length - 1].duration) / 1000)
    : 0;

  return { fullText, segments, totalDuration };
}

function formatViewCount(count) {
  const num = parseInt(count);
  if (num >= 1000000) {
    return (num / 1000000).toFixed(1) + 'M';
  } else if (num >= 1000) {
    return (num / 1000).toFixed(1) + 'K';
  }
  return num.toString();
}

function formatDate(dateString) {
  const date = new Date(dateString);
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

async function analyzeWithClaude(transcriptText, videoInfo) {
  const prompt = `You are analyzing a YouTube video transcript to help viewers decide if it's worth watching.

Video Title: ${videoInfo.title}
Channel: ${videoInfo.channelTitle}
Duration: ${formatDuration(videoInfo.duration)}

Here is the transcript with timestamps:

${transcriptText}

Analyze this transcript and respond with ONLY valid JSON in this exact format:

{
  "tldr": "2-3 sentences capturing: 1) What the video is about, 2) Main purpose/value to viewer, 3) Who should watch (target audience)",
  "keyTopics": [
    "Standalone insight written as a complete thought",
    "Action-oriented phrasing covering major themes"
  ],
  "chapters": [
    {
      "timestamp": 0,
      "title": "Chapter title"
    }
  ],
  "keyTakeaways": [
    "Specific lesson, quote, stat, or framework",
    "What viewers should remember or do"
  ],
  "shouldWatch": "Brief recommendation: who should watch and who can skip"
}

Important rules:
- tldr: 2-3 concise sentences for a 30-second read
- keyTopics: 5-8 bullet points covering all major themes chronologically
- chapters: 6-12 timestamped chapters covering all major sections (timestamps in seconds)
- keyTakeaways: 3-7 numbered actionable insights - the most valuable 20% of content
- shouldWatch: Clear "watch/don't watch" signal with target audience
- Keep everything concise but complete
- Write for speed reading (short sentences)
- Bold key phrases using **text** markdown`;

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 2500,
    messages: [
      {
        role: 'user',
        content: prompt
      }
    ]
  });

  const responseText = message.content[0].text;

  const jsonMatch = responseText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('Failed to parse AI response');
  }

  const parsed = JSON.parse(jsonMatch[0]);

  // Ensure all required fields exist with defaults
  const result = {
    tldr: parsed.tldr || '',
    keyTopics: Array.isArray(parsed.keyTopics) ? parsed.keyTopics : [],
    chapters: Array.isArray(parsed.chapters) ? parsed.chapters : [],
    keyTakeaways: Array.isArray(parsed.keyTakeaways) ? parsed.keyTakeaways : [],
    shouldWatch: parsed.shouldWatch || ''
  };

  // Format chapter timestamps
  if (result.chapters.length > 0) {
    result.chapters = result.chapters.map(chapter => ({
      ...chapter,
      timestampFormatted: formatTimestamp(chapter.timestamp || 0)
    }));
  }

  return result;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { videoId } = req.body;

  if (!videoId) {
    return res.status(400).json({ error: 'Video ID is required' });
  }

  if (!/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    return res.status(400).json({ error: 'Invalid video ID format' });
  }

  try {
    // Get video info from YouTube API
    const videoInfo = await getVideoInfo(videoId);

    // Get transcript
    const transcript = await getTranscript(videoId);

    if (!transcript || transcript.length === 0) {
      return res.status(400).json({
        error: 'No transcript available for this video. The video may not have captions.'
      });
    }

    const { fullText, totalDuration } = prepareTranscriptForAnalysis(transcript);
    console.log('Transcript prepared, calling Claude...');

    const analysis = await analyzeWithClaude(fullText, videoInfo);
    console.log('Claude analysis complete, keys:', Object.keys(analysis));

    // Ensure response has all required fields with proper defaults
    const response = {
      videoId,
      title: videoInfo.title || 'Unknown Title',
      channelTitle: videoInfo.channelTitle || 'Unknown Channel',
      duration: formatDuration(videoInfo.duration || totalDuration),
      viewCount: formatViewCount(videoInfo.viewCount || '0'),
      publishedAt: formatDate(videoInfo.publishedAt || new Date().toISOString()),
      tldr: analysis.tldr || '',
      keyTopics: Array.isArray(analysis.keyTopics) ? analysis.keyTopics : [],
      chapters: Array.isArray(analysis.chapters) ? analysis.chapters : [],
      keyTakeaways: Array.isArray(analysis.keyTakeaways) ? analysis.keyTakeaways : [],
      shouldWatch: analysis.shouldWatch || ''
    };

    console.log('Sending response with keys:', Object.keys(response));
    return res.status(200).json(response);
  } catch (error) {
    console.error('Analysis error:', error);

    if (error.message?.includes('captions') || error.message?.includes('transcript') || error.message?.includes('No captions')) {
      return res.status(400).json({ error: 'This video does not have captions available.' });
    }

    if (error.message?.includes('not found') || error.message?.includes('unavailable')) {
      return res.status(404).json({ error: error.message });
    }

    return res.status(500).json({
      error: 'Failed to analyze video. Please try again.'
    });
  }
}
