import type { ModerationVerdict } from './provider.js';

export interface ModerationDecision {
  flagged: boolean;
  /** Categories that crossed their threshold, whether or not the provider flagged the text. */
  categories: string[];
}

/**
 * Per-category thresholds. Severe categories are acted on at a lower score; ordinary
 * categories need a high score before content is hidden, so borderline discussion is not
 * removed. The provider's own `flagged` result is always honoured as a floor.
 */
const CATEGORY_THRESHOLDS: Record<string, number> = {
  'sexual/minors': 0.2,
  'hate/threatening': 0.45,
  'harassment/threatening': 0.5,
  harassment: 0.7,
  'self-harm/intent': 0.45,
  'self-harm/instructions': 0.45,
  'sexual/violence': 0.55,
  'violence/graphic': 0.55,
  'illicit/violent': 0.55,
};

const DEFAULT_THRESHOLD = 0.75;

export const decideModeration = (verdict: ModerationVerdict): ModerationDecision => {
  const categories = Object.entries(verdict.scores)
    .filter(([category, score]) => {
      const threshold = CATEGORY_THRESHOLDS[category] ?? DEFAULT_THRESHOLD;
      return Number.isFinite(score) && score >= threshold;
    })
    .map(([category]) => category);

  return {
    flagged: verdict.flagged || categories.length > 0,
    categories,
  };
};

export const categoryThresholds = CATEGORY_THRESHOLDS;
