'use client';
import {useEffect,useState} from 'react';
type InstallEvent=Event&{prompt:()=>Promise<void>;userChoice:Promise<{outcome:string}>};
export function PwaControls(){
  const [prompt,setPrompt]=useState<InstallEvent|null>(null),[installed,setInstalled]=useState(false),[status,setStatus]=useState('Checking offline readiness…'),[update,setUpdate]=useState<ServiceWorker|null>(null),[help,setHelp]=useState(false);
  useEffect(()=>{
    setInstalled(window.matchMedia('(display-mode: standalone)').matches);
    const offer=(event:Event)=>{event.preventDefault();setPrompt(event as InstallEvent);};
    const accepted=()=>{setInstalled(true);setPrompt(null);};
    window.addEventListener('beforeinstallprompt',offer);window.addEventListener('appinstalled',accepted);
    if(process.env.NODE_ENV!=='production'){setStatus('Offline app shell is available in the built PWA preview.');}
    else if(!('serviceWorker'in navigator)){setStatus('This browser does not support offline app loading.');}
    else{
      let active=true;
      navigator.serviceWorker.register('/sw.js',{scope:'/',updateViaCache:'none'}).then(registration=>{
        if(!active)return;
        if(registration.waiting)setUpdate(registration.waiting);
        registration.addEventListener('updatefound',()=>{
          const worker=registration.installing;
          worker?.addEventListener('statechange',()=>{if(active&&worker.state==='installed'&&navigator.serviceWorker.controller)setUpdate(worker);});
        });
        return navigator.serviceWorker.ready;
      }).then(()=>{if(active)setStatus('App ready for offline reload.');}).catch(()=>{if(active)setStatus('Offline setup failed. Reconnect and reload to retry.');});
      return()=>{active=false;window.removeEventListener('beforeinstallprompt',offer);window.removeEventListener('appinstalled',accepted);};
    }
    return()=>{window.removeEventListener('beforeinstallprompt',offer);window.removeEventListener('appinstalled',accepted);};
  },[]);
  async function install(){if(prompt){await prompt.prompt();await prompt.userChoice;setPrompt(null);}else setHelp(true);}
  function activate(){navigator.serviceWorker.addEventListener('controllerchange',()=>window.location.reload(),{once:true});update?.postMessage({type:'ACTIVATE_UPDATE'});}
  return <section className="pwa-bar" aria-label="App installation and offline readiness"><span role="status">{status}</span><div>{!installed&&<button className="text-button" onClick={install}>Install app</button>}{update&&<button className="text-button" onClick={activate}>Load update</button>}</div>{help&&<p>In Chrome or Edge, use the browser menu → Install GreenChain. On iPhone or iPad, use Share → Add to Home Screen. Installation options depend on your browser.</p>}{update&&<p>An update is ready. Save your current draft before loading it.</p>}</section>;
}
