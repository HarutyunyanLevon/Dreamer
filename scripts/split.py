"""Split a js/ts file into modules by line ranges: python split.py <src> <outdir> <spec.json> [--ext mjs] [--dry]
spec: {"module/path": {"ranges": [[a,b],...], "prelude": "text", "wrap": null}} (module paths relative to outdir, no ext).
Auto-computes top-level declarations, cross-module imports/exports. Relative imports use ext."""
import re,sys,json,os
src,outdir,spec=sys.argv[1:4]; ext=(sys.argv[sys.argv.index('--ext')+1] if '--ext' in sys.argv else 'mjs'); dry='--dry' in sys.argv
L=open(src,encoding='utf8').read().split('\n'); spec=json.load(open(spec))
decl_re=re.compile(r'^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\*?|const|let|class|type|interface|enum)\s+(\w+)')
body={}; owner={}
cov=set()
for m,d in spec.items():
    out=[]
    for a,b in d['ranges']:
        out+=L[a-1:b]; cov.update(range(a,b+1))
    body[m]=out
    for l in out:
        mm=decl_re.match(l)
        if mm: owner[mm.group(1)]=m
        for mm in re.finditer(r';\s*(?:const|let)\s+(\w+)',l): owner[mm.group(1)]=m
        for mm in re.finditer(r'^(?:export\s+)?(?:const|let)\s+\{([^}]*)\}',l):
            for n in mm.group(1).split(','): owner[n.strip().split(':')[-1].strip()]=m
unc=[i for i in range(1,len(L)+1) if i not in cov and L[i-1].strip() and not L[i-1].lstrip().startswith(('//','*','/*'))]
if unc: print('UNCOVERED',unc[:30])
words=lambda t:set(re.findall(r'[A-Za-z_$][\w$]*',t))
used={m:words('\n'.join(re.sub(r'//.*','',x) for x in b)) for m,b in body.items()}
exports={m:set() for m in spec}; imports={m:{} for m in spec}
for m in spec:
    for n in used[m]:
        o=owner.get(n)
        if o and o!=m:
            exports[o].add(n); imports[m].setdefault(o,set()).add(n)
def rel(a,b):
    r=os.path.relpath(b,os.path.dirname(a) or '.').replace(chr(92),'/')
    return (r if r.startswith('.') else './'+r)+'.'+ext
for m in spec:
    lines=[]
    pre=spec[m].get('prelude','')
    if pre: lines.append(pre)
    for o,ns in sorted(imports[m].items()):
        ns=ns-set(spec[m].get('skip',[]))
        if ns: lines.append('import { %s } from "%s";'%(', '.join(sorted(ns)),rel(m,o)))
    txt=[]
    for l in body[m]:
        mm=decl_re.match(l)
        if mm and mm.group(1) in exports[m] and not l.startswith('export'): l='export '+l
        for n in exports[m]: l=re.sub(r'; (const|let) '+n+r'\b',r'; export \1 '+n,l)
        txt.append(l)
    w=spec[m].get('wrap')
    if w:
        tn=[x for l in txt for x in re.findall(r'^  const (\w+Tool) = tool\(',l)]
        txt=['export function %s(s, c) {'%w,'  const { T, tid, live, hitLimit, requestTool, send } = c;']+txt+['  return [%s];'%', '.join(tn),'}']
    s='\n'.join(lines)+'\n\n'+'\n'.join(txt).strip('\n')+'\n'
    print(m,len(s.split('\n')),'lines; imports',{o:len(n) for o,n in imports[m].items()})
    if not dry:
        p=os.path.join(outdir,m+'.'+ext); os.makedirs(os.path.dirname(p),exist_ok=True); open(p,'w',encoding='utf8',newline='\n').write(s)
# report assigned shared lets
for n,o in owner.items():
    for m in spec:
        if m!=o and n in imports[m].get(o,()) and re.search(r'(?<![\w.])'+n+r'\s*(=(?!=)|\+\+|--|\+=)','\n'.join(body[m])): print('REASSIGNED ACROSS MODULES',n,'owner',o,'by',m)
