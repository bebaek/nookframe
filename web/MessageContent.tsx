import { useState } from 'react';
import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ResponseImage } from '../shared/protocol';

export function inlineImageUrl(url: string) {
  return /^\/(?:photos|response-images)\/[a-f0-9]{64}$/.test(url) || /^\/artifacts\/[a-f0-9]{64}\/[a-f0-9]{64}\/(?:preview|full)$/.test(url);
}
function safeLink(url: string) {
  return /^(?:https?:\/\/|mailto:)/i.test(url) || inlineImageUrl(url) || /^\/artifacts\/[a-f0-9]{64}\/[a-f0-9]{64}\/download$/.test(url) ? url : '';
}
function ImagePreview({ url, description }: { url: string; description: string }) {
  const [status, setStatus] = useState<'loading' | 'loaded' | 'failed'>('loading');
  if (!inlineImageUrl(url)) return safeLink(url) ? <a href={url} target="_blank" rel="noreferrer">{description || 'External image'} (external image)</a> : <span>{description || 'Image unavailable'}</span>;
  return <span className="response-image">
    {status !== 'failed' && <a href={url.startsWith('/artifacts/') ? url.replace(/\/preview$/, '/full') : url} target="_blank" rel="noreferrer" aria-label={`Open full size: ${description}`}><img src={url} alt={description} loading="lazy" onLoad={() => setStatus('loaded')} onError={() => setStatus('failed')} /></a>}
    {status === 'loading' && <small className="image-loading" role="status">Loading image…</small>}
    {status === 'failed' && <small>{description}: image unavailable</small>}
  </span>;
}
export function ResponseImages({ images }: { images?: ResponseImage[] }) {
  return images?.length ? <div className="response-images">{images.map(image => <ImagePreview key={image.id} url={image.url} description={image.description || 'Response image'} />)}</div> : null;
}
// Stable component identities preserve image loading state during streaming updates.
const markdownComponents: Components = {
    table: ({ children }) => <div className="markdown-table" role="region" aria-label="Markdown table" tabIndex={0}><table>{children}</table></div>,
    a: ({ href, children }) => href ? <a href={href} target="_blank" rel="noreferrer">{children}</a> : <span>{children}</span>,
    img: ({ src, alt }) => <ImagePreview key={typeof src === 'string' ? src : ''} url={typeof src === 'string' ? src : ''} description={alt || 'Response image'} />,
};
export function MessageContent({ text }: { text: string }) {
  return <div className="markdown"><Markdown remarkPlugins={[remarkGfm]} skipHtml urlTransform={safeLink} components={markdownComponents}>{text}</Markdown></div>;
}
