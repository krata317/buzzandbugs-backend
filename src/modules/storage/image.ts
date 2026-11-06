import sharp from 'sharp';
import { AppError } from '../../lib/errors.js';
import { AVATAR_OUTPUT_DIMENSION, MAX_AVATAR_INPUT_DIMENSION } from '../../config/constants.js';

export type SupportedImageType = 'image/jpeg' | 'image/png' | 'image/webp';

export const detectImageType = (buffer: Buffer): SupportedImageType | null => {
  if (buffer.length < 12) return null;

  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  return null;
};

export interface ProcessedImage {
  buffer: Buffer;
  width: number;
  height: number;
  mimeType: 'image/webp';
}

/**
 * Validates the real file signature, rejects oversized dimensions, applies EXIF orientation,
 * strips all metadata and re-encodes to a square WebP.
 */
export const processAvatar = async (input: Buffer): Promise<ProcessedImage> => {
  const detected = detectImageType(input);
  if (!detected) {
    throw new AppError('UNSUPPORTED_MEDIA_TYPE', 'Only JPEG, PNG and WebP images are supported');
  }

  let metadata: sharp.Metadata;
  try {
    metadata = await sharp(input, { failOn: 'error' }).metadata();
  } catch {
    throw new AppError('UNPROCESSABLE_ENTITY', 'The image could not be read');
  }

  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  if (width === 0 || height === 0) {
    throw new AppError('UNPROCESSABLE_ENTITY', 'The image could not be read');
  }
  if (width > MAX_AVATAR_INPUT_DIMENSION || height > MAX_AVATAR_INPUT_DIMENSION) {
    throw new AppError(
      'UNPROCESSABLE_ENTITY',
      `Images must be at most ${MAX_AVATAR_INPUT_DIMENSION}x${MAX_AVATAR_INPUT_DIMENSION} pixels`,
    );
  }

  const output = await sharp(input, { failOn: 'error' })
    .rotate()
    .resize(AVATAR_OUTPUT_DIMENSION, AVATAR_OUTPUT_DIMENSION, { fit: 'cover', position: 'centre' })
    .webp({ quality: 82, effort: 4 })
    .toBuffer({ resolveWithObject: true });

  return {
    buffer: output.data,
    width: output.info.width,
    height: output.info.height,
    mimeType: 'image/webp',
  };
};
