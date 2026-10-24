import { useEffect, useRef, useState } from 'react';

function cameraError(error: unknown) {
  const name = error instanceof DOMException ? error.name : '';
  if (name === 'NotAllowedError') return 'Camera permission was denied. Allow camera access in your browser and system settings, then try again.';
  if (name === 'NotFoundError') return 'No camera was found. Connect a camera or attach an existing photo.';
  if (name === 'NotReadableError') return 'The camera is busy or unavailable. Close other camera apps and try again.';
  return 'Could not access the camera. Check camera permissions or attach an existing photo.';
}

export function CameraCapture({ attach, close, fallback }: { attach: (file: File) => void; close: () => void; fallback: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const [device, setDevice] = useState('');
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [attempt, setAttempt] = useState(0);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [photo, setPhoto] = useState<File>();
  const [preview, setPreview] = useState('');
  const [capturing, setCapturing] = useState(false);
  const alive = useRef(false);
  useEffect(() => {
    alive.current = true;
    const element = dialog.current;
    const opener = document.activeElement;
    element?.showModal();
    return () => {
      alive.current = false;
      element?.close();
      if (opener instanceof HTMLElement && opener.isConnected && !opener.closest('[hidden]')) opener.focus();
    };
  }, []);
  useEffect(() => {
    if (!photo) { setPreview(''); return; }
    const url = URL.createObjectURL(photo);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [photo]);
  useEffect(() => {
    let cancelled = false;
    let stream: MediaStream | undefined;
    const stop = () => { cancelled = true; stream?.getTracks().forEach(track => track.stop()); };
    setReady(false); setError('');
    if (photo) return;
    async function start() {
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
        setError('Live camera capture requires HTTPS and a supported browser. You can still attach a photo.');
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: device ? { deviceId: { exact: device } } : { facingMode: { ideal: 'environment' } } });
        if (cancelled) { stream.getTracks().forEach(track => track.stop()); return; }
        if (video.current) {
          video.current.srcObject = stream;
          await video.current.play();
        }
        const available = await navigator.mediaDevices.enumerateDevices();
        if (!cancelled) setDevices(available.filter(item => item.kind === 'videoinput'));
      } catch (cause) {
        stream?.getTracks().forEach(track => track.stop());
        if (!cancelled) { setReady(false); setError(cameraError(cause)); }
      }
    }
    window.addEventListener('pagehide', stop);
    void start();
    return () => {
      window.removeEventListener('pagehide', stop);
      stop();
      if (video.current) video.current.srcObject = null;
    };
  }, [device, attempt, photo]);
  function capture() {
    const source = video.current;
    if (!source?.videoWidth || !source.videoHeight || capturing) return;
    setCapturing(true);
    try {
      const canvas = document.createElement('canvas');
      const scale = Math.min(1, 2048 / Math.max(source.videoWidth, source.videoHeight));
      canvas.width = Math.round(source.videoWidth * scale); canvas.height = Math.round(source.videoHeight * scale);
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Canvas unavailable');
      context.drawImage(source, 0, 0, canvas.width, canvas.height);
      canvas.toBlob(blob => {
        if (!alive.current) return;
        setCapturing(false);
        if (blob) setPhoto(new File([blob], 'camera-photo.jpg', { type: 'image/jpeg' }));
        else setError('Could not capture a photo. Please try again.');
      }, 'image/jpeg', 0.92);
    } catch {
      setCapturing(false); setError('Could not capture a photo. Please try again.');
    }
  }
  return <dialog ref={dialog} className="camera-dialog" aria-labelledby="camera-title" onCancel={event => { event.preventDefault(); close(); }}>
    <h2 id="camera-title">Take a photo</h2>
    {photo ? <img className="camera-preview" src={preview} alt="Captured photo" /> : <>
      <video className="camera-preview" ref={video} autoPlay muted playsInline onLoadedData={() => setReady(true)} />
      {devices.length > 1 && <label>Camera<select value={device} disabled={capturing} onChange={event => setDevice(event.target.value)}><option value="">Default camera</option>{devices.map((item, index) => <option key={item.deviceId} value={item.deviceId}>{item.label || `Camera ${index + 1}`}</option>)}</select></label>}
      {!ready && !error && <p role="status">Waiting for camera access…</p>}
    </>}
    {error && <p role="alert">{error}</p>}
    <div className="photo-buttons">
      {photo ? <><button type="button" onClick={() => { attach(photo); close(); }}>Attach photo</button><button type="button" onClick={() => setPhoto(undefined)}>Retake</button></> : <button type="button" disabled={!ready || capturing || !!error} onClick={capture}>Capture photo</button>}
      {error && <button type="button" onClick={() => setAttempt(value => value + 1)}>Try again</button>}
      <button type="button" onClick={fallback}>Use photo picker</button>
      <button type="button" onClick={close}>Cancel</button>
    </div>
  </dialog>;
}
