'use client';
import {useState} from 'react';
import {validateBoundary,type Boundary} from '@greenchain/geometry';
export function BoundaryEditor({value,onChange}:{value?:Boundary;onChange:(boundary:Boundary|undefined)=>void}){
  const points=value?.coordinates[0].slice(0,-1)??[];
  const [lat,setLat]=useState('23.4000'),[lon,setLon]=useState('88.5000'),[error,setError]=useState('');
  const center=value?.coordinates[0][0]??[88.5,23.4],span=0.004;
  const toScreen=(point:number[])=>[(point[0]-center[0])/span*320+80,240-(point[1]-center[1])/span*240];
  function setPoints(next:number[][]){if(!next.length){onChange(undefined);return;}onChange({type:'Polygon',coordinates:[[...next,next[0]]]});setError('');}
  let area='';try{if(value)area=validateBoundary(value).areaHectares;}catch{}
  return <section className="boundary-editor"><h3>Plot boundary · offline coordinate grid</h3><p className="help">Tap the grid to add corners in order, or enter longitude and latitude below. This is a schematic grid, not a satellite map. The server validates the boundary and calculates area.</p>
    <svg viewBox="0 0 320 260" role="img" aria-label="Plot coordinate grid; use the coordinate inputs to add corners with a keyboard" onClick={event=>{if(points.length>=64){setError('Maximum 64 corners.');return;}const rect=event.currentTarget.getBoundingClientRect(),x=(event.clientX-rect.left)/rect.width*320,y=(event.clientY-rect.top)/rect.height*260;setPoints([...points,[Number((center[0]+(x-80)/320*span).toFixed(7)),Number((center[1]+(240-y)/240*span).toFixed(7))]]);}}>
      <defs><pattern id="plot-grid" width="32" height="26" patternUnits="userSpaceOnUse"><path d="M 32 0 L 0 0 0 26" fill="none" stroke="#cad9c7"/></pattern></defs><rect width="320" height="260" fill="url(#plot-grid)"/>
      <polygon points={points.map(toScreen).map(p=>p.join(',')).join(' ')} fill="#63855c44" stroke="#256348" strokeWidth="2"/>{points.map((point,index)=>{const [x,y]=toScreen(point);return <g key={index}><circle cx={x} cy={y} r="4" fill="#256348"/><text x={x+7} y={y-5} fontSize="10">{index+1}</text></g>;})}
    </svg><div className="coordinate-inputs"><label>Longitude<input type="number" min="68" max="98" step="0.0000001" value={lon} onChange={e=>setLon(e.target.value)}/></label><label>Latitude<input type="number" min="6" max="38" step="0.0000001" value={lat} onChange={e=>setLat(e.target.value)}/></label></div>
    <div className="form-actions"><button type="button" className="secondary" onClick={()=>{if(!lon||!lat||!Number.isFinite(Number(lon))||!Number.isFinite(Number(lat))){setError('Enter valid coordinates.');return;}if(points.length>=64){setError('Maximum 64 corners.');return;}setPoints([...points,[Number(lon),Number(lat)]]);}}>Add corner</button><button type="button" className="secondary" disabled={!points.length} onClick={()=>setPoints(points.slice(0,-1))}>Undo corner</button></div>
    <button type="button" className="text-button" onClick={()=>setPoints([[88.5,23.4],[88.501,23.4],[88.501,23.401],[88.5,23.401]])}>Use a synthetic sample boundary</button>
    <button type="button" className="text-button" onClick={()=>setPoints([[88.5,23.4],[88.502,23.4],[88.502,23.402],[88.5,23.402]])}>Use a larger synthetic sample (~4.5 ha)</button>
    <p className="help">{points.length} corners · {area?`${area} ha (spherical estimate)`:'Add at least three valid corners.'}</p>{points.length>0&&<details><summary>Boundary coordinates</summary><ol>{points.map((point,index)=><li key={index}>{point[0]}, {point[1]}</li>)}</ol></details>}<p role="status" className="status">{error}</p>
  </section>;
}
