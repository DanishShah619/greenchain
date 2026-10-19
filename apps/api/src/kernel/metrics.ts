type Labels=Record<string,string>;
type Kind='counter'|'gauge';
type Family={kind:Kind;help:string;samples:Map<string,{labels:Labels;value:number}>};
const NAME=/^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const labelKey=(labels:Labels)=>Object.keys(labels).sort().map(k=>`${k}=${labels[k]}`).join('\u0000');
const escapeValue=(value:string)=>value.replace(/\\/g,'\\\\').replace(/\n/g,'\\n').replace(/"/g,'\\"');
/**
 * A tiny in-process metrics registry that renders the Prometheus text exposition format.
 * Label values must come from small fixed sets (statuses, error codes) so cardinality stays bounded; never ids or user data.
 */
export class Metrics {
  private readonly families=new Map<string,Family>();
  declare(name:string,kind:Kind,help:string){
    if(!NAME.test(name))throw new Error(`Invalid metric name ${name}`);
    if(!this.families.has(name))this.families.set(name,{kind,help,samples:new Map()});
    return this;
  }
  private family(name:string,kind:Kind){
    const family=this.families.get(name);
    if(!family)throw new Error(`Metric ${name} is not declared`);
    if(family.kind!==kind)throw new Error(`Metric ${name} is a ${family.kind}`);
    return family;
  }
  inc(name:string,labels:Labels={},by=1){
    if(by<0)throw new Error('A counter cannot decrease');
    const family=this.family(name,'counter'),key=labelKey(labels),sample=family.samples.get(key);
    if(sample)sample.value+=by;else family.samples.set(key,{labels,value:by});
  }
  set(name:string,value:number,labels:Labels={}){
    if(!Number.isFinite(value))throw new Error(`Metric ${name} value must be finite`);
    this.family(name,'gauge').samples.set(labelKey(labels),{labels,value});
  }
  /** Prometheus text format 0.0.4. */
  render():string{
    const lines:string[]=[];
    for(const [name,family] of this.families){
      lines.push(`# HELP ${name} ${family.help.replace(/\\/g,'\\\\').replace(/\n/g,'\\n')}`,`# TYPE ${name} ${family.kind}`);
      for(const {labels,value} of family.samples.values()){
        const pairs=Object.keys(labels).sort().map(k=>`${k}="${escapeValue(labels[k])}"`);
        lines.push(`${name}${pairs.length?`{${pairs.join(',')}}`:''} ${value}`);
      }
    }
    return lines.join('\n')+'\n';
  }
}
