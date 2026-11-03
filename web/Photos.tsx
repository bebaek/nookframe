import { useEffect, useId, useRef, useState } from 'react';
import { CameraCapture } from './CameraCapture';
export interface DraftPhoto { key: string; file: File; id?: string; url?: string; resized?: boolean; error?: string }
export function PhotoPreviews({ photos }: { photos?: { id: string; url: string }[] }) {
  if (!photos?.length) return null;
  return <div className="photo-previews">{photos.map((photo, i) => <a key={`${photo.id}-${i}`} href={photo.url} target="_blank" rel="noreferrer"><img src={photo.url} alt={`Attached photo ${i + 1}; open full size`} loading="lazy" /></a>)}</div>;
}
export function PhotoPicker({ photos, disabled, uploading, add, remove, retry }: {
  photos: DraftPhoto[]; disabled: boolean; uploading: boolean;
  add: (files: File[]) => void; remove: (key: string) => void; retry: () => void;
}) {
  const menuId = useId();
  const menu = useRef<HTMLDivElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const camera = useRef<HTMLInputElement>(null);
  const [cameraOpen, setCameraOpen] = useState(false);
  const blocked = disabled || uploading || photos.length >= 4;
  useEffect(() => { if (blocked) setCameraOpen(false); }, [blocked]);
  const select = (input: HTMLInputElement) => { add(Array.from(input.files ?? [])); input.value = ''; };
  return <section className="photo-picker" aria-label="Photo attachments">
    <input hidden ref={picker} type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif" multiple onChange={e => select(e.currentTarget)} />
    <input hidden ref={camera} type="file" accept="image/*" capture="environment" onChange={e => select(e.currentTarget)} />
    <button type="button" className="secondary composer-menu-toggle" aria-label="Message options" popoverTarget={menuId}>+</button>
    <div id={menuId} ref={menu} popover="auto" className="composer-menu" aria-label="Message options">
      <button type="button" className="secondary" disabled={blocked} onClick={() => { menu.current?.hidePopover(); picker.current?.click(); }}>Attach photos</button>
      <button type="button" className="secondary camera-button" disabled={blocked} onClick={() => { menu.current?.hidePopover(); setCameraOpen(true); }}>Camera</button>
    </div>
    {(photos.length > 0 || uploading) && <div className="composer-attachments">
    {photos.some(p => p.error) && <button type="button" disabled={disabled || uploading} onClick={retry}>Retry uploads</button>}
    {photos.length > 0 && <><div className="photo-previews">{photos.map(photo => <div className="draft-photo" key={photo.key}>
      {photo.url ? <img src={photo.url} alt={photo.file.name || 'Attached photo'} /> : <span>{photo.file.name || 'Photo'}<br />{photo.error || 'Processing…'}</span>}
      {photo.resized && <small>Resized to fit within 2048 × 2048 pixels.</small>}
      <button type="button" aria-label={`Remove ${photo.file.name || 'photo'}`} disabled={disabled} onClick={() => remove(photo.key)}>×</button>
    </div>)}</div><small>Photos are converted to JPEG and stripped of metadata. Originals are not retained. Unsent uploads expire after 24 hours.</small></>}
    {uploading && <p role="status">Uploading and processing photos…</p>}
    </div>}
    {cameraOpen && !blocked && <CameraCapture attach={file => add([file])} close={() => setCameraOpen(false)} fallback={() => { setCameraOpen(false); camera.current?.click(); }} />}
  </section>;
}
