import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { execSync } from 'child_process';
import { readFileSync, unlinkSync, existsSync, readdirSync } from 'fs';
import Anthropic from '@anthropic-ai/sdk';
import { config } from 'dotenv';

config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = 3000;

const YT_DLP_PATH = '/Users/bryantay/Library/Python/3.9/bin/yt-dlp';

app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

function formatTimestamp(seconds) {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  if (hrs > 0) {
    return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function parseVTT(vttContent) {
  const transcript = [];
  const lines = vttContent.split('\n');
  let currentTime = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Match timestamp line: 00:00:00.000 --> 00:00:00.000
    const timeMatch = line.match(/(\d{2}):(\d{2}):(\d{2})\.(\d{3})\s*-->/);
    if (timeMatch) {
      const hours = parseInt(timeMatch[1]);
      const minutes = parseInt(timeMatch[2]);
      const seconds = parseInt(timeMatch[3]);
      currentTime = hours * 3600 + minutes * 60 + seconds;

      // Get the text on the next line(s)
      let text = '';
      for (let j = i + 1; j < lines.length && lines[j].trim() !== ''; j++) {
        const textLine = lines[j].trim();
        if (!textLine.match(/^\d{2}:\d{2}/) && textLine !== 'WEBVTT') {
          // Remove HTML tags and formatting
          const cleanText = textLine
            .replace(/<[^>]+>/g, '')
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&nbsp;/g, ' ')
            .trim();
          if (cleanText) {
            text += (text ? ' ' : '') + cleanText;
          }
        }
      }

      if (text) {
        transcript.push({
          text,
          offset: currentTime * 1000,
          duration: 0
        });
      }
    }
  }

  return transcript;
}

function parseJSON3(jsonContent) {
  const subData = JSON.parse(jsonContent);
  const transcript = [];

  for (const event of subData.events || []) {
    if (event.segs && event.tStartMs !== undefined) {
      const text = event.segs
        .map(seg => seg.utf8 || '')
        .join('')
        .trim();

      if (text && text !== '\n') {
        transcript.push({
          text: text.replace(/\n/g, ' '),
          offset: event.tStartMs,
          duration: event.dDurationMs || 0
        });
      }
    }
  }

  return transcript;
}

async function getTranscript(videoId) {
  const tmpFile = `/tmp/yt-${videoId}-${Date.now()}`;

  try {
    // Get video title and duration first
    const infoJson = execSync(
      `${YT_DLP_PATH} -j "https://www.youtube.com/watch?v=${videoId}" 2>/dev/null`,
      { timeout: 15000 }
    );
    const info = JSON.parse(infoJson.toString());
    const title = info.title || null;
    const duration = info.duration || 0;

    // Try to get subtitles - first try json3, then vtt
    let transcript = [];
    let subFile = null;

    // Try vtt format (most common)
    try {
      execSync(
        `${YT_DLP_PATH} --write-auto-sub --sub-lang en --skip-download --sub-format vtt -o "${tmpFile}" "https://www.youtube.com/watch?v=${videoId}" 2>&1`,
        { timeout: 30000 }
      );

      const expectedFile = `${tmpFile}.en.vtt`;
      if (existsSync(expectedFile)) {
        const content = readFileSync(expectedFile, 'utf-8');
        transcript = parseVTT(content);
        unlinkSync(expectedFile);
      }
    } catch (e) {
      console.error('vtt fetch error:', e.message);
    }

    // If vtt didn't work, try json3 format
    if (transcript.length === 0) {
      try {
        execSync(
          `${YT_DLP_PATH} --write-auto-sub --sub-lang en --skip-download --sub-format json3 -o "${tmpFile}" "https://www.youtube.com/watch?v=${videoId}" 2>&1`,
          { timeout: 30000 }
        );

        const expectedFile = `${tmpFile}.en.json3`;
        if (existsSync(expectedFile)) {
          const content = readFileSync(expectedFile, 'utf-8');
          transcript = parseJSON3(content);
          unlinkSync(expectedFile);
        }
      } catch (e) {
        console.error('json3 fetch error:', e.message);
      }
    }

    if (transcript.length === 0) {
      throw new Error('No captions available');
    }

    // Deduplicate consecutive identical entries
    const deduped = [];
    for (const item of transcript) {
      if (deduped.length === 0 || deduped[deduped.length - 1].text !== item.text) {
        deduped.push(item);
      }
    }

    return { transcript: deduped, title, duration };

  } catch (error) {
    console.error('yt-dlp error:', error.message);
    throw new Error('No captions available for this video');
  }
}

function prepareTranscriptForAnalysis(transcript) {
  let fullText = '';

  for (const item of transcript) {
    const timestamp = Math.floor(item.offset / 1000);
    fullText += `[${formatTimestamp(timestamp)}] ${item.text}\n`;
  }

  const totalDuration = transcript.length > 0
    ? Math.floor((transcript[transcript.length - 1].offset + transcript[transcript.length - 1].duration) / 1000)
    : 0;

  return { fullText, totalDuration };
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
    messages: [{ role: 'user', content: prompt }]
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

app.post('/api/analyze', async (req, res) => {
  const { videoId } = req.body;

  if (!videoId) {
    return res.status(400).json({ error: 'Video ID is required' });
  }

  if (!/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    return res.status(400).json({ error: 'Invalid video ID format' });
  }

  try {
    console.log(`Analyzing video: ${videoId}`);
    console.time('transcript');

    const { transcript, title, duration } = await getTranscript(videoId);

    console.timeEnd('transcript');

    if (!transcript || transcript.length === 0) {
      return res.status(400).json({
        error: 'No transcript available for this video. The video may not have captions.'
      });
    }

    console.log(`Transcript fetched: ${transcript.length} segments`);

    const { fullText, totalDuration } = prepareTranscriptForAnalysis(transcript);

    console.log('Analyzing with Claude...');
    console.time('claude');
    const analysis = await analyzeWithClaude(fullText);
    console.timeEnd('claude');

    console.log('Analysis complete!');

    return res.json({
      videoId,
      title: title,
      duration: formatTimestamp(duration || totalDuration),
      summary: analysis.summary,
      topics: analysis.topics
    });
  } catch (error) {
    console.error('Analysis error:', error.message);

    if (error.message?.includes('captions') || error.message?.includes('No captions')) {
      return res.status(400).json({ error: error.message });
    }

    return res.status(500).json({
      error: error.message || 'Failed to analyze video. Please try again.'
    });
  }
});

app.listen(PORT, () => {
  console.log(`
  YouTube Video Analyzer running at:

  → http://localhost:${PORT}

  Paste a YouTube URL to analyze!
  `);
});
