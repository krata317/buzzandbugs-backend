import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';

export interface ModerationVerdict {
  flagged: boolean;
  categories: Record<string, boolean>;
  scores: Record<string, number>;
}

export interface ModerationProvider {
  readonly name: string;
  isConfigured(): boolean;
  check(input: { title: string; body: string }): Promise<ModerationVerdict>;
}

export class ModerationProviderError extends Error {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = 'ModerationProviderError';
  }
}

interface OpenAiModerationResponse {
  results?: Array<{
    flagged?: boolean;
    categories?: Record<string, boolean>;
    category_scores?: Record<string, number>;
  }>;
}

const OPENAI_MODERATION_URL = 'https://api.openai.com/v1/moderations';

export const openAiModerationProvider: ModerationProvider = {
  name: 'openai',

  isConfigured(): boolean {
    return Boolean(env.OPENAI_API_KEY);
  },

  async check({ title, body }): Promise<ModerationVerdict> {
    if (!env.OPENAI_API_KEY) {
      throw new ModerationProviderError('OpenAI moderation is not configured');
    }

    const input = `${title}\n\n${body}`.slice(0, 20_000);

    let response: Response;
    try {
      response = await fetch(OPENAI_MODERATION_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify({ model: env.OPENAI_MODERATION_MODEL, input }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      logger.warn({ err: error }, 'moderation provider request failed');
      throw new ModerationProviderError('Moderation provider is unreachable', { cause: error });
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      logger.warn(
        { status: response.status, detail: detail.slice(0, 300) },
        'moderation provider error',
      );
      throw new ModerationProviderError(`Moderation provider returned ${response.status}`);
    }

    const payload = (await response.json()) as OpenAiModerationResponse;
    const result = payload.results?.[0];
    if (!result) {
      throw new ModerationProviderError('Moderation provider returned no results');
    }

    return {
      flagged: Boolean(result.flagged),
      categories: result.categories ?? {},
      scores: result.category_scores ?? {},
    };
  },
};

let provider: ModerationProvider = openAiModerationProvider;

export const getModerationProvider = (): ModerationProvider => provider;

export const setModerationProviderForTests = (next: ModerationProvider): void => {
  provider = next;
};
