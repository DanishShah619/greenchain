import {area} from '@turf/area';
import {kinks} from '@turf/kinks';
export function validateBoundary(value){
  if(!value||value.type!=='Polygon'||!Array.isArray(value.coordinates)||value.coordinates.length!==1)throw new Error('Use one GeoJSON polygon without holes.');
  const ring=value.coordinates[0];
  if(!Array.isArray(ring)||ring.length<4||ring.length>65)throw new Error('A boundary needs 3–64 corners and a closing point.');
  for(const point of ring){
    if(!Array.isArray(point)||point.length!==2||!point.every(Number.isFinite)||point[0]<68||point[0]>98||point[1]<6||point[1]>38)throw new Error('Use longitude/latitude coordinates in the India demo region.');
  }
  const first=ring[0],last=ring.at(-1);
  if(first[0]!==last[0]||first[1]!==last[1])throw new Error('The polygon ring must be closed.');
  if(new Set(ring.slice(0,-1).map(point=>point.join(','))).size!==ring.length-1)throw new Error('Boundary corners must be distinct.');
  const boundary={type:'Polygon',coordinates:[ring.map(point=>[...point])]};
  const feature={type:'Feature',properties:{},geometry:boundary};
  if(kinks(feature).features.length)throw new Error('Boundary edges cannot cross or touch each other.');
  // Reject a corner doubling back along the previous segment, including collinear overlaps.
  for(let i=0;i<ring.length-1;i++){
    const a=ring[(i+ring.length-2)%(ring.length-1)],b=ring[i],c=ring[(i+1)%(ring.length-1)];
    const cross=(b[0]-a[0])*(c[1]-b[1])-(b[1]-a[1])*(c[0]-b[0]);
    if(Math.abs(cross)<1e-14&&(b[0]-a[0])*(c[0]-b[0])+(b[1]-a[1])*(c[1]-b[1])<=0)throw new Error('Boundary edges cannot double back.');
  }
  const hectares=area(feature)/10000;
  if(hectares<0.01||hectares>10000)throw new Error('Calculated area must be between 0.01 and 10,000 hectares.');
  return {boundary,areaHectares:hectares.toFixed(4)};
}
