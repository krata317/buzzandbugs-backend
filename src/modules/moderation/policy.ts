import type { ModerationVerdict } from './provider.js';

export interface ModerationDecision {
  flagged: boolean;
  /** Categories that crossed their threshold, whether or not the provider flagged the text. */
  categories: string[];
}

/**
 * Per-category thresholds, all strictly below 0.4 so that reported content is reviewed at the
 * first sign of harm rather than only at high confidence. The scale is graded by severity: the
 * categories that describe an explicit threat or the involvement of a minor act first, and the
 * general-purpose categories sit at the top of the band. The provider's own `flagged` result is
 * always honoured as a floor.
 */
const CATEGORY_THRESHOLDS = {
  'sexual/minors': 0.15,
  'hate/threatening': 0.2,
  'harassment/threatening': 0.22,
  'self-harm/intent': 0.24,
  'self-harm/instructions': 0.26,
  'illicit/violent': 0.28,
  'sexual/violence': 0.3,
  'violence/graphic': 0.32,
  harassment: 0.36,
} as const satisfies Record<string, number>;

/** Applies to any category the provider reports that is not named above. */
const DEFAULT_THRESHOLD = 0.38;

/** Widened view used for lookups by the provider's own category names. */
const THRESHOLDS_BY_CATEGORY: Record<string, number> = CATEGORY_THRESHOLDS;

export const decideModeration = (verdict: ModerationVerdict): ModerationDecision => {
  const categories = Object.entries(verdict.scores)
    .filter(([category, score]) => {
      const threshold = THRESHOLDS_BY_CATEGORY[category] ?? DEFAULT_THRESHOLD;
      return Number.isFinite(score) && score >= threshold;
    })
    .map(([category]) => category);

  return {
    flagged: verdict.flagged || categories.length > 0,
    categories,
  };
};

export const categoryThresholds = CATEGORY_THRESHOLDS;
export const defaultThreshold = DEFAULT_THRESHOLD;
