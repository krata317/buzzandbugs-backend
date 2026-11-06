import { AppError } from './errors.js';

export interface RichTextNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: RichTextNode[];
  text?: string;
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
}

export interface ValidatedRichText {
  doc: RichTextNode;
  text: string;
  mentionIds: string[];
}

const MAX_TEXT_LENGTH = 20_000;
const MAX_NODES = 2_000;
const MAX_DEPTH = 12;
const FONT_SIZES = new Set(Array.from({ length: 23 }, (_, index) => `${index + 10}px`));

const MARK_NAMES = new Set(['bold', 'italic', 'underline', 'link', 'fontSize']);
const BLOCK_NODES = new Set([
  'paragraph',
  'bulletList',
  'listItem',
  'hardBreak',
  'mention',
  'text',
]);

const invalid = (message: string): never => {
  throw new AppError('VALIDATION_ERROR', message, { details: { field: 'content' } });
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const validateLinkHref = (href: unknown): string => {
  if (typeof href !== 'string' || href.length === 0 || href.length > 2048) {
    return invalid('Link marks require a valid href');
  }
  let parsed: URL;
  try {
    parsed = new URL(href);
  } catch {
    return invalid('Link href must be an absolute URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return invalid('Only http and https links are allowed');
  }
  return parsed.toString();
};

const validateMarks = (
  marks: unknown,
): Array<{ type: string; attrs?: Record<string, unknown> }> => {
  if (marks === undefined) return [];
  if (!Array.isArray(marks)) return invalid('Marks must be an array');
  const seen = new Set<string>();
  const output: Array<{ type: string; attrs?: Record<string, unknown> }> = [];

  for (const mark of marks) {
    if (!isPlainObject(mark)) return invalid('Each mark must be an object');
    const type = mark.type;
    if (typeof type !== 'string' || !MARK_NAMES.has(type)) {
      return invalid(`Unsupported mark type: ${String(type)}`);
    }
    if (seen.has(type)) return invalid(`Duplicate mark: ${type}`);
    seen.add(type);

    if (type === 'link') {
      const attrs = isPlainObject(mark.attrs) ? mark.attrs : {};
      output.push({ type, attrs: { href: validateLinkHref(attrs.href) } });
      continue;
    }

    if (type === 'fontSize') {
      const attrs = isPlainObject(mark.attrs) ? mark.attrs : {};
      const size = attrs.size;
      if (typeof size !== 'string' || !FONT_SIZES.has(size)) {
        return invalid('fontSize marks require a size between 10px and 32px');
      }
      output.push({ type, attrs: { size } });
      continue;
    }

    if (mark.attrs !== undefined) {
      if (!isPlainObject(mark.attrs) || Object.keys(mark.attrs).length > 0) {
        return invalid(`${type} marks do not accept attributes`);
      }
    }
    output.push({ type });
  }

  return output;
};

interface WalkState {
  nodeCount: number;
  textLength: number;
  mentionIds: Set<string>;
  text: string[];
}

const walkInline = (node: RichTextNode, state: WalkState): RichTextNode => {
  if (node.type === 'text') {
    if (typeof node.text !== 'string') return invalid('Text nodes require a text string');
    state.textLength += node.text.length;
    if (state.textLength > MAX_TEXT_LENGTH) {
      return invalid(`Content exceeds ${MAX_TEXT_LENGTH} characters`);
    }
    if (node.content !== undefined) return invalid('Text nodes cannot have content');
    state.text.push(node.text);
    return { type: 'text', text: node.text, marks: validateMarks(node.marks) };
  }

  if (node.type === 'hardBreak') {
    if (node.content !== undefined) return invalid('hardBreak nodes cannot have content');
    state.text.push('\n');
    return { type: 'hardBreak' };
  }

  if (node.type === 'mention') {
    const attrs = isPlainObject(node.attrs) ? node.attrs : {};
    const id = attrs.id;
    if (typeof id !== 'string' || id.length === 0 || id.length > 64) {
      return invalid('Mention nodes require a user id');
    }
    if (node.content !== undefined) return invalid('Mention nodes cannot have content');
    state.mentionIds.add(id);
    state.text.push('@');
    return { type: 'mention', attrs: { id } };
  }

  return invalid(`Node type "${node.type}" is not allowed inside a paragraph`);
};

const walkNode = (node: unknown, depth: number, state: WalkState): RichTextNode => {
  if (!isPlainObject(node)) return invalid('Each content node must be an object');
  const type = node.type;
  if (typeof type !== 'string' || !BLOCK_NODES.has(type)) {
    return invalid(`Unsupported node type: ${String(type)}`);
  }
  if (depth > MAX_DEPTH) return invalid('Content is nested too deeply');

  state.nodeCount += 1;
  if (state.nodeCount > MAX_NODES) return invalid('Content contains too many nodes');

  const content = node.content;
  if (content !== undefined && !Array.isArray(content)) {
    return invalid('Node content must be an array');
  }

  switch (type) {
    case 'paragraph': {
      const children = (content ?? []).map((child) => walkInline(child as RichTextNode, state));
      const paragraph: RichTextNode = { type: 'paragraph' };
      if (children.length > 0) paragraph.content = children;
      state.text.push('\n');
      return paragraph;
    }
    case 'bulletList': {
      const items = content ?? [];
      if (items.length === 0) return invalid('Bullet lists must contain at least one item');
      const children = items.map((item) => walkNode(item, depth + 1, state));
      return { type: 'bulletList', content: children };
    }
    case 'listItem': {
      const items = content ?? [];
      if (items.length === 0) return invalid('List items must contain a paragraph');
      const children = items.map((item) => {
        const child = item as RichTextNode;
        if (child?.type !== 'paragraph') {
          return invalid('List items may only contain paragraphs');
        }
        return walkNode(item, depth + 1, state);
      });
      return { type: 'listItem', content: children };
    }
    case 'text':
    case 'hardBreak':
    case 'mention':
      return walkInline(node as unknown as RichTextNode, state);
    default:
      return invalid(`Unsupported node type: ${type}`);
  }
};

export const validateRichText = (input: unknown): ValidatedRichText => {
  if (!isPlainObject(input)) return invalid('Content must be a rich-text document object');
  if (input.type !== 'doc') return invalid('Content document must have type "doc"');
  if (!Array.isArray(input.content)) return invalid('Content document must have a content array');

  const state: WalkState = { nodeCount: 0, textLength: 0, mentionIds: new Set(), text: [] };
  const children = input.content.map((node) => {
    const child = node as Record<string, unknown>;
    if (child.type === 'text' || child.type === 'hardBreak' || child.type === 'mention') {
      return invalid('Inline nodes must be wrapped in a paragraph');
    }
    return walkNode(node, 1, state);
  });

  return {
    doc: { type: 'doc', content: children },
    text: state.text
      .join('')
      .replace(/\n{3,}/g, '\n\n')
      .trim(),
    mentionIds: [...state.mentionIds],
  };
};

export const richTextToPlainText = (doc: unknown): string => {
  const state: WalkState = { nodeCount: 0, textLength: 0, mentionIds: new Set(), text: [] };
  const visit = (node: unknown): void => {
    if (!isPlainObject(node)) return;
    if (typeof node.text === 'string') state.text.push(node.text);
    if (node.type === 'hardBreak') state.text.push('\n');
    if (node.type === 'mention') state.text.push('@');
    if (node.type === 'paragraph') state.text.push('\n');
    if (Array.isArray(node.content)) node.content.forEach(visit);
  };
  visit(doc);
  return state.text
    .join('')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
};

export const buildExcerpt = (text: string, maxLength = 280): string => {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= maxLength) return collapsed;
  return `${collapsed.slice(0, maxLength - 1).trimEnd()}…`;
};

/** Replaces mention labels with the current display name, keeping only the stored user id. */
export const hydrateMentions = (
  doc: RichTextNode | null,
  resolve: (userId: string) => { displayName: string; username: string | null } | null,
): RichTextNode | null => {
  if (!doc) return null;
  const clone = structuredClone(doc) as RichTextNode;
  const visit = (node: RichTextNode): void => {
    if (node.type === 'mention') {
      const id = typeof node.attrs?.id === 'string' ? node.attrs.id : '';
      const user = id ? resolve(id) : null;
      node.attrs = {
        id,
        label: user?.displayName ?? null,
        username: user?.username ?? null,
        deleted: !user,
      };
    }
    node.content?.forEach(visit);
  };
  visit(clone);
  return clone;
};
