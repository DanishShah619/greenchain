export type Boundary={type:'Polygon';coordinates:number[][][]};
export function validateBoundary(value:unknown):{boundary:Boundary;areaHectares:string};
