import axios from 'axios';
import Anthropic from '@anthropic-ai/sdk';
import { NewsApiArticle, NewsItem } from '../types';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

/**
 * Fetches macro news (Trump, Fed, regulations, economy) from NewsAPI.
 */
export async function fetchMacroNews(limit = 10): Promise<NewsApiArticle[]> {
  if (!process.env.NEWSAPI_KEY) {
    throw new Error('NEWSAPI_KEY not set');
  }

  try {
    const res = await axios.get('https://newsapi.org/v2/everything', {
      params: {
        q: '(Trump OR "Federal Reserve" OR Fed OR "interest rates" OR SEC OR "crypto regulation" OR inflation OR recession) AND (crypto OR bitcoin OR ethereum OR cryptocurrency)',
        language: 'en',
        sortBy: 'publishedAt',
        pageSize: limit,
        apiKey: process.env.NEWSAPI_KEY,
      },
      timeout: 10_000,
    });

    return (res.data?.articles ?? []) as NewsApiArticle[];
  } catch (e) {
    throw new Error(`NewsAPI fetchMacroNews: ${(e as Error).message}`);
  }
}

interface ClaudeAnalysis {
  relevant: boolean;
  sentiment: 'bullish' | 'bearish' | 'neutral';
  summary: string;
  related_symbols: string[];
}

/**
 * Sends a macro news headline + description to Claude for crypto-impact analysis.
 * Returns null if the article is not relevant for crypto.
 */
export async function analyzeWithClaude(article: NewsApiArticle): Promise<ClaudeAnalysis | null> {
  const prompt = `You are a crypto market analyst. Evaluate the following macro news headline and decide its potential impact on cryptocurrency markets.

Headline: ${article.title}
Description: ${article.description ?? 'N/A'}

Respond in JSON (no markdown) with these exact fields:
{
  "relevant": true/false,         // Is this relevant for crypto markets?
  "sentiment": "bullish" | "bearish" | "neutral",
  "summary": "1-2 sentence impact explanation",
  "related_symbols": ["BTCUSDT", "ETHUSDT"]  // Only major coins affected, empty array if all or none
}`;

  try {
    const message = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001', // fast + cheap for batch analysis
      max_tokens: 256,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = message.content[0].type === 'text' ? message.content[0].text : '';
    const parsed = JSON.parse(text) as ClaudeAnalysis;

    if (!parsed.relevant) return null;
    return parsed;
  } catch (e) {
    // Don't fail the whole pipeline on a single Claude error
    console.error(`Claude analyzeWithClaude error: ${(e as Error).message}`);
    return null;
  }
}

/**
 * Full macro news pipeline: fetch → Claude analysis → NewsItem format.
 */
export async function fetchAndAnalyzeMacroNews(): Promise<NewsItem[]> {
  const articles = await fetchMacroNews(10);
  const results: NewsItem[] = [];

  for (const article of articles) {
    // Skip articles without title or url
    if (!article.title || !article.url) continue;

    const analysis = await analyzeWithClaude(article);
    if (!analysis) continue;

    results.push({
      source: 'newsapi',
      title: article.title,
      url: article.url,
      sentiment: analysis.sentiment,
      impact_summary: analysis.summary,
      related_symbols: analysis.related_symbols,
      published_at: article.publishedAt,
    });

    // Small delay to avoid Claude rate limits
    await new Promise((r) => setTimeout(r, 300));
  }

  return results;
}
