'use client';
import {catchError,type ErrorInfo} from 'next/error';
/**
 * Keeps one workspace panel's failure inside that panel: the rest of the page keeps working. The fallback names the panel only;
 * it never shows or logs the error, whose message can carry data. "Try again" re-renders the panel without reloading the page
 * (reset, not retry: these panels fetch their own data on the client, and the static export has no server data to re-fetch).
 */
function PanelFallback({name}:{name:string},{reset}:ErrorInfo){
  return <section className="card panel-error" role="alert">
    <h2>{name} could not be shown</h2>
    <p>Something in this panel went wrong. The rest of the workspace still works. Try again, or refresh the page.</p>
    <button type="button" className="secondary" onClick={()=>reset()}>Try again</button>
  </section>;
}
export const PanelBoundary=catchError(PanelFallback);
