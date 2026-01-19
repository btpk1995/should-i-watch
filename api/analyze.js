import Anthropic from '@anthropic-ai/sdk';
import { YoutubeTranscriptApi } from 'youtube-transcript-api';

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
  const url = `https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails&id=${videoId}&key=${YOUTUBE_API_KEY}`;
  const response = await fetch(url);
  const data = await response.json();

  if (!data.items || data.items.length === 0) {
    throw new Error('Video not found');
  }

  const video = data.items[0];
  return {
    title: video.snippet.title,
    duration: parseDuration(video.contentDetails.duration),
    description: video.snippet.description
  };
}

async function getTranscript(videoId) {
  try {
    const transcriptList = await YoutubeTranscriptApi.listTranscripts(videoId);

    // Try to get English transcript first
    let transcript;
    try {
      transcript = await transcriptList.findTranscript(['en', 'en-US', 'en-GB']);
    } catch {
      // Fall back to any available transcript
      const available = transcriptList.transcripts;
      if (available && available.length > 0) {
        transcript = available[0];
      }
    }

    if (!transcript) {
      throw new Error('No transcript available');
    }

    const data = await transcript.fetch();

    return data.map(item => ({
      text: item.text,
      offset: item.start * 1000,
      duration: item.duration * 1000
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

async function analyzeWithClaude(transcriptText) {
  const prompt = `You are analyzing a YouTube video transcript to help viewers decide if it's worth watching.

Here is the transcript with timestamps:

${transcriptText}

Please analyze this transcript and provide:

1. A brief summary (2-3 sentences) of what this video is about and who would find it valuable.

2. The top 10 most important topics or key points discussed in the video. For each topic:
   - Give it a concise, descriptive title (5-8 words)
   - Write a brief description (1-2 sentences) explaining what is discussed
   - Identify the timestamp (in seconds) where this topic begins

Order the topics by their appearance in the video (chronologically), not by importance.

Respond ONLY with valid JSON in this exact format:
{
  "summary": "Your 2-3 sentence summary here",
  "topics": [
    {
      "title": "Topic Title Here",
      "description": "Brief description of what is discussed",
      "timestamp": 0
    }
  ]
}

Important:
- Extract EXACTLY 10 topics (or fewer if the video doesn't have 10 distinct topics)
- Timestamps should be in seconds (integers)
- Make titles specific and informative, not generic like "Introduction" unless that's truly what it is
- Focus on substantive content, not intros/outros unless they contain important information`;

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 2000,
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

  parsed.topics = parsed.topics.map(topic => ({
    ...topic,
    timestampFormatted: formatTimestamp(topic.timestamp)
  }));

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
    const analysis = await analyzeWithClaude(fullText);

    return res.status(200).json({
      videoId,
      title: videoInfo.title,
      duration: formatDuration(videoInfo.duration || totalDuration),
      summary: analysis.summary,
      topics: analysis.topics
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
