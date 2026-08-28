import { contextBridge, ipcRenderer, webFrame } from 'electron';
import { CHANNELS } from '../shared/ipc.ts';
import type { Request, Response, Snapshot } from '../shared/ipc.ts';

/**
 * The renderer's entire capability surface: receive snapshots, send requests.
 * No node, no fs, no direct tmux — every side effect goes through main.
 */
const api = {
  onSnapshot(callback: (snapshot: Snapshot) => void): () => void {
    const handler = (_event: unknown, snapshot: Snapshot): void => callback(snapshot);
    ipcRenderer.on(CHANNELS.snapshot, handler);
    return () => ipcRenderer.off(CHANNELS.snapshot, handler);
  },
  invoke(request: Request): Promise<Response> {
    return ipcRenderer.invoke(CHANNELS.invoke, request) as Promise<Response>;
  },
  /**
   * The window's zoom factor, for the one measurement that must not scale with
   * it — see `renderer/zoom.ts`. Read on demand rather than pushed: there is no
   * zoom event, so the renderer asks whenever the viewport changes.
   */
  zoomFactor(): number {
    return webFrame.getZoomFactor();
  },
};

contextBridge.exposeInMainWorld('fleetwood', api);

export type FleetwoodApi = typeof api;
