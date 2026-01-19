import Anthropic from '@anthropic-ai/sdk';
import TranscriptClient from 'youtube-transcript-api';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;

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

async function getTranscript(videoId) {
  try {
    const client = new TranscriptClient();
    await client.ready;

    const transcript = await client.getTranscript(videoId);

    if (!transcript || transcript.length === 0) {
      throw new Error('No transcript available');
    }

    return transcript.map(item => ({
      text: item.text,
      offset: (item.start || 0) * 1000,
      duration: (item.duration || 0) * 1000
    }));
  } catch (error) {
    console.error('Transcript fetch error:', error.message);
    throw new Error('This video does not have captions available.');
  }
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

  // Format chapter timestamps
  if (parsed.chapters) {
    parsed.chapters = parsed.chapters.map(chapter => ({
      ...chapter,
      timestampFormatted: formatTimestamp(chapter.timestamp)
    }));
  }

  return parsed;
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
    const analysis = await analyzeWithClaude(fullText, videoInfo);

    return res.status(200).json({
      videoId,
      title: videoInfo.title,
      channelTitle: videoInfo.channelTitle,
      duration: formatDuration(videoInfo.duration || totalDuration),
      viewCount: formatViewCount(videoInfo.viewCount),
      publishedAt: formatDate(videoInfo.publishedAt),
      tldr: analysis.tldr,
      keyTopics: analysis.keyTopics,
      chapters: analysis.chapters,
      keyTakeaways: analysis.keyTakeaways,
      shouldWatch: analysis.shouldWatch
    });
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
