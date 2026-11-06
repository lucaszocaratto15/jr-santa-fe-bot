import type { TMessage } from '@/common/chat/chatLib';

/** Default to the current reply, never a whole conversation or a tool result. */
export function authorizedExcerpt(items: TMessage[], selection = ''): string {
  const reply = items.findLast((item) => item.type === 'text' && item.position === 'left' && !item.hidden);
  const text = reply?.type === 'text' ? reply.content.content : '';
  const selected = selection.trim();
  return (selected && text.includes(selected) ? selected : text).slice(0, 4000);
}
